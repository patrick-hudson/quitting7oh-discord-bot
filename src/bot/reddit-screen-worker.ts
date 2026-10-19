// Reddit sourcing screen worker. Reads what the reddit poller already
// collected (RedditPost/RedditComment — no extra Reddit API calls), so it
// works the same for live content and Arctic Shift backfill.
//
// Each tick, per guild with the screen on:
//   1. Label every unscreened item from redditScreenSubreddits newer than
//      redditScreenSince, in batches, with the cheap screen model
//      (src/lib/reddit-screen.ts). One RedditScreenItem row per item, so
//      nothing is ever paid for twice.
//   2. Fold medium+ sourcing / promotion / taper flags into RedditScreenUser
//      rows (the mod queue). Serious flags schedule an assessment; a user a
//      mod dismissed or was watching is reopened by a new serious flag.
//   3. Post crisis signals to the alert channel right away.
//   4. Run due whole-history assessments with the verdict model and alert on
//      new ban/warn recommendations.
//
// Never bans, removes, or messages a reddit user: app-only OAuth can't, and
// a recovery sub can't afford a false positive on someone who's struggling.
// Same polling model as the other workers: non-overlapping ticks, failures
// retried on a later tick.

import Anthropic from "@anthropic-ai/sdk";
import { Client, EmbedBuilder } from "discord.js";
import { Prisma, type Guild } from "@prisma/client";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import {
  ASSESS_LABELS,
  FLAG_LABELS,
  ScreenRefusalError,
  assessUser,
  classifyItems,
  type ScreenHistoryItem,
  type ScreenInputItem,
  type ScreenItemResult,
  type ScreenLabel,
  type ScreenVerdict,
} from "@/lib/reddit-screen";
import { SCREEN_RECO } from "@/components/reddit-screen-meta";

const POLL_MS = 60_000;
const BATCH_SIZE = 20; // items per classifier call
const MAX_ITEMS_PER_TICK = 200; // per guild — bounds spend on a big backlog
const MAX_ASSESS_PER_TICK = 5; // per guild
const ASSESS_COOLDOWN_MS = 60 * 60_000; // min gap between verdicts per user
const ASSESS_RETRY_MS = 30 * 60_000;
const MAX_HISTORY_ITEMS = 1500;

const EXCLUDED_AUTHORS = ["automoderator", "[deleted]"];

export function runRedditScreenWorker(client: Client) {
  console.log(`[reddit-screen] polling every ${POLL_MS}ms`);
  let warnedNoKey = false;
  let running = false;
  setInterval(async () => {
    if (running) return;
    if (!env.anthropicApiKey()) {
      if (!warnedNoKey) {
        console.warn("[reddit-screen] ANTHROPIC_API_KEY not set — screening paused.");
        warnedNoKey = true;
      }
      return;
    }
    running = true;
    try {
      await tick(client);
    } catch (err) {
      console.error("[reddit-screen] tick failed:", err);
    } finally {
      running = false;
    }
  }, POLL_MS);
}

async function tick(client: Client) {
  const guilds = await prisma.guild.findMany({
    where: {
      redditScreenEnabled: true,
      redditScreenSubreddits: { isEmpty: false },
      redditScreenSince: { not: null },
    },
  });
  if (guilds.length === 0) return;
  const anthropic = new Anthropic({ apiKey: env.anthropicApiKey() });

  for (const g of guilds) {
    try {
      await screenNewItems(client, anthropic, g);
    } catch (err) {
      console.error(`[reddit-screen] screening failed for ${g.name}:`, err);
      audit(
        g.id,
        "redditscreen.failed",
        `Reddit screen pass failed — will retry next tick: ${(err as Error).message?.slice(0, 200)}`,
        { error: (err as Error).message?.slice(0, 500) },
        "error"
      );
    }
    try {
      await runDueAssessments(client, anthropic, g);
    } catch (err) {
      console.error(`[reddit-screen] assessments failed for ${g.name}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Stage 1 + 2: label new items, update the user queue
// ---------------------------------------------------------------------------

type Unscreened = {
  fid: string;
  kind: "post" | "comment";
  subreddit: string;
  author: string;
  postTitle: string;
  body: string;
  permalink: string;
  createdAt: Date;
};

async function screenNewItems(client: Client, anthropic: Anthropic, g: Guild) {
  const subs = g.redditScreenSubreddits.map((s) => s.toLowerCase());
  const since = g.redditScreenSince!;
  const items = await prisma.$queryRaw<Unscreened[]>`
    SELECT * FROM (
      SELECT 't3_' || id AS fid, 'post' AS kind, subreddit, author,
             title AS "postTitle", body, permalink, "createdAt"
      FROM "RedditPost"
      WHERE "guildId" = ${g.id} AND subreddit = ANY(${subs}) AND "createdAt" >= ${since}
      UNION ALL
      SELECT 't1_' || id AS fid, 'comment' AS kind, subreddit, author,
             "postTitle", body, permalink, "createdAt"
      FROM "RedditComment"
      WHERE "guildId" = ${g.id} AND subreddit = ANY(${subs}) AND "createdAt" >= ${since}
    ) x
    WHERE lower(x.author) <> ALL(${EXCLUDED_AUTHORS})
      AND NOT EXISTS (SELECT 1 FROM "RedditScreenItem" s WHERE s.id = x.fid)
    ORDER BY x."createdAt" ASC
    LIMIT ${MAX_ITEMS_PER_TICK}
  `;
  if (items.length === 0) return;

  const model = env.aiScreenModel();
  const tally: Record<string, number> = {};
  const crisisItems: Array<Unscreened & { note: string }> = [];
  // author (lower) → { display casing, medium+ flag count, any serious flag }
  const flagged = new Map<string, { display: string; count: number; serious: boolean }>();
  let inputTokens = 0;
  let outputTokens = 0;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const input: ScreenInputItem[] = batch.map((it, j) => ({
      ref: String(j + 1),
      kind: it.kind,
      author: it.author,
      subreddit: it.subreddit,
      postTitle: it.postTitle,
      body: it.body,
      createdAt: it.createdAt,
    }));

    let results: Map<string, ScreenItemResult>;
    try {
      const res = await classifyItems(anthropic, { model, notes: g.redditScreenNotes, items: input });
      results = res.results;
      inputTokens += res.inputTokens;
      outputTokens += res.outputTokens;
    } catch (err) {
      // A refusal would recur on every retry — record the batch as unscreened
      // and move on. Anything else (rate limit, outage) stops this guild's
      // pass; the unwritten items are picked up next tick.
      if (!(err instanceof ScreenRefusalError)) throw err;
      console.warn(`[reddit-screen] batch declined for ${g.name}: ${err.message}`);
      results = new Map();
    }

    await prisma.redditScreenItem.createMany({
      data: batch.map((it, j) => {
        const r = results.get(String(j + 1));
        const label: ScreenLabel | "error" = r?.label ?? "error";
        tally[label] = (tally[label] ?? 0) + 1;
        if (r?.crisis) crisisItems.push({ ...it, note: r.crisisNote || r.evidence });
        if (r && FLAG_LABELS.includes(r.label) && r.confidence !== "low") {
          const key = it.author.toLowerCase();
          const f = flagged.get(key) ?? { display: it.author, count: 0, serious: false };
          f.count++;
          if (ASSESS_LABELS.includes(r.label)) f.serious = true;
          flagged.set(key, f);
        }
        return {
          id: it.fid,
          guildId: g.id,
          subreddit: it.subreddit,
          kind: it.kind,
          author: it.author,
          label,
          confidence: r?.confidence ?? "low",
          recoveryIntent: r?.recoveryIntent ?? false,
          reason: r?.reason ?? "The classifier returned no result for this item.",
          evidence: r?.evidence ?? "",
          crisis: r?.crisis ?? false,
          crisisNote: r?.crisis ? (r.crisisNote ?? null) : null,
          permalink: it.permalink,
          itemCreatedAt: it.createdAt,
          model,
        };
      }),
      skipDuplicates: true,
    });
  }

  const now = new Date();
  for (const [username, f] of flagged) {
    await recordFlags(g.id, username, f, now);
  }

  const flaggedTotal = FLAG_LABELS.reduce((n, l) => n + (tally[l] ?? 0), 0);
  console.log(
    `[reddit-screen] screened ${items.length} item(s) for ${g.name}: ${Object.entries(tally)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ")}`
  );
  audit(
    g.id,
    "redditscreen.screened",
    `Screened ${items.length} reddit item(s) — ${flaggedTotal} flagged, ${flagged.size} user(s) queued${
      crisisItems.length ? `, ⚠ ${crisisItems.length} crisis signal(s)` : ""
    }`,
    { counts: tally, users: [...flagged.keys()], model, inputTokens, outputTokens },
    crisisItems.length ? "warn" : "ok"
  );

  if (crisisItems.length > 0 && g.redditScreenAlertChannelId) {
    await sendCrisisAlert(client, g, crisisItems).catch((err) =>
      console.warn(`[reddit-screen] crisis alert failed for ${g.name}:`, err)
    );
  }
}

async function recordFlags(
  guildId: string,
  username: string,
  f: { display: string; count: number; serious: boolean },
  now: Date
) {
  const existing = await prisma.redditScreenUser.findUnique({
    where: { guildId_username: { guildId, username } },
  });
  // Next assessment no sooner than the cool-down after the last verdict.
  const dueAt =
    existing?.verdictAt && now.getTime() - existing.verdictAt.getTime() < ASSESS_COOLDOWN_MS
      ? new Date(existing.verdictAt.getTime() + ASSESS_COOLDOWN_MS)
      : now;

  if (!existing) {
    await prisma.redditScreenUser.create({
      data: {
        guildId,
        username,
        displayName: f.display,
        flagCount: f.count,
        lastFlaggedAt: now,
        assessDueAt: f.serious ? now : null,
      },
    });
    return;
  }

  const reopen =
    f.serious && (existing.status === "dismissed" || existing.status === "watching");
  await prisma.redditScreenUser.update({
    where: { id: existing.id },
    data: {
      displayName: f.display,
      flagCount: { increment: f.count },
      lastFlaggedAt: now,
      ...(f.serious && existing.status !== "banned"
        ? {
            // Keep an earlier pending due time rather than pushing it back.
            assessDueAt:
              existing.assessDueAt && existing.assessDueAt < dueAt ? existing.assessDueAt : dueAt,
          }
        : {}),
      ...(reopen ? { status: "open", decidedBy: null, decidedAt: null } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Stage 3: whole-history assessments
// ---------------------------------------------------------------------------

async function runDueAssessments(client: Client, anthropic: Anthropic, g: Guild) {
  const due = await prisma.redditScreenUser.findMany({
    where: { guildId: g.id, assessDueAt: { lte: new Date() }, status: { not: "banned" } },
    orderBy: { assessDueAt: "asc" },
    take: MAX_ASSESS_PER_TICK,
  });
  for (const u of due) {
    await assessOne(client, anthropic, g, u.id, u.username);
  }
}

async function assessOne(
  client: Client,
  anthropic: Anthropic,
  g: Guild,
  rowId: string,
  username: string
) {
  const where = {
    guildId: g.id,
    author: { equals: username, mode: "insensitive" as const },
  };
  const [posts, comments] = await Promise.all([
    prisma.redditPost.findMany({ where, orderBy: { createdAt: "desc" }, take: MAX_HISTORY_ITEMS }),
    prisma.redditComment.findMany({ where, orderBy: { createdAt: "desc" }, take: MAX_HISTORY_ITEMS }),
  ]);
  const labels = new Map(
    (
      await prisma.redditScreenItem.findMany({
        where: { guildId: g.id, author: { equals: username, mode: "insensitive" } },
        select: { id: true, label: true },
      })
    ).map((s) => [s.id, s.label])
  );

  const merged = [
    ...posts.map((p) => ({
      fid: `t3_${p.id}`,
      kind: "post" as const,
      subreddit: p.subreddit,
      postTitle: p.title,
      body: p.body,
      createdAt: p.createdAt,
      score: p.score,
      permalink: p.permalink,
    })),
    ...comments.map((c) => ({
      fid: `t1_${c.id}`,
      kind: "comment" as const,
      subreddit: c.subreddit,
      postTitle: c.postTitle,
      body: c.body,
      createdAt: c.createdAt,
      score: c.score,
      permalink: c.permalink,
    })),
  ]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .slice(-MAX_HISTORY_ITEMS);

  const permalinkByRef = new Map<string, string>();
  const dateByRef = new Map<string, string>();
  const history: ScreenHistoryItem[] = merged.map((m, i) => {
    const ref = String(i + 1);
    permalinkByRef.set(ref, m.permalink);
    dateByRef.set(ref, m.createdAt.toISOString().slice(0, 10));
    return { ...m, ref, label: labels.get(m.fid) };
  });

  if (history.length === 0) {
    await prisma.redditScreenUser.update({
      where: { id: rowId },
      data: { assessDueAt: null, assessError: "No collected history for this user." },
    });
    return;
  }

  const model = env.aiScreenAssessModel();
  try {
    const res = await assessUser(anthropic, {
      model,
      notes: g.redditScreenNotes,
      username,
      history,
    });
    const link = (e: ScreenVerdict["evidence"][number]) => ({
      ...e,
      permalink: e.ref ? permalinkByRef.get(e.ref) : undefined,
      date: e.ref ? dateByRef.get(e.ref) : undefined,
    });
    const verdict: ScreenVerdict = {
      ...res.verdict,
      evidence: res.verdict.evidence.map(link),
      mitigating: res.verdict.mitigating.map(link),
    };

    const row = await prisma.redditScreenUser.update({
      where: { id: rowId },
      data: {
        verdict: verdict as unknown as Prisma.InputJsonValue,
        recommendation: verdict.recommendation,
        confidence: verdict.confidence,
        verdictAt: new Date(),
        assessDueAt: null,
        assessError: null,
        model,
        itemsAnalyzed: res.itemsAnalyzed,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
      },
    });
    console.log(`[reddit-screen] u/${username} (${g.name}): ${verdict.recommendation}`);
    audit(
      g.id,
      "redditscreen.assessed",
      `Sourcing screen: u/${row.displayName} — ${SCREEN_RECO[verdict.recommendation].label} (${verdict.confidence} confidence)${
        verdict.crisisFlag ? " ⚠ crisis flag" : ""
      }`,
      {
        username,
        recommendation: verdict.recommendation,
        confidence: verdict.confidence,
        crisisFlag: verdict.crisisFlag,
        itemsAnalyzed: res.itemsAnalyzed,
        model,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
      },
      verdict.crisisFlag ? "warn" : "ok"
    );

    const alertable = verdict.recommendation === "ban" || verdict.recommendation === "warn";
    if (
      g.redditScreenAlertChannelId &&
      alertable &&
      row.status === "open" &&
      row.alertedRecommendation !== verdict.recommendation
    ) {
      try {
        await sendVerdictAlert(client, g, row.displayName, row.flagCount, verdict);
        await prisma.redditScreenUser.update({
          where: { id: rowId },
          data: { alertedRecommendation: verdict.recommendation },
        });
      } catch (err) {
        console.warn(`[reddit-screen] verdict alert failed for u/${username}:`, err);
      }
    }
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    console.error(`[reddit-screen] assessment of u/${username} failed:`, err);
    await prisma.redditScreenUser.update({
      where: { id: rowId },
      data: {
        // A refusal won't change on retry; anything else backs off and retries.
        assessDueAt:
          err instanceof ScreenRefusalError ? null : new Date(Date.now() + ASSESS_RETRY_MS),
        assessError: message.slice(0, 2000),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Discord alerts (private mod channel)
// ---------------------------------------------------------------------------

function portalLink(guildId: string): string | null {
  const base = (process.env.NEXTAUTH_URL ?? "").replace(/\/$/, "");
  return base ? `${base}/dashboard/${guildId}/reddit-screening` : null;
}

async function alertChannel(client: Client, channelId: string) {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    throw new Error(`channel ${channelId} not a sendable text channel`);
  }
  return channel;
}

async function sendVerdictAlert(
  client: Client,
  g: Guild,
  displayName: string,
  flagCount: number,
  v: ScreenVerdict
) {
  const channel = await alertChannel(client, g.redditScreenAlertChannelId!);
  const evidence = v.evidence
    .slice(0, 3)
    .map((e) =>
      e.permalink ? `• [“${truncate(e.quote, 140)}”](${e.permalink})` : `• “${truncate(e.quote, 140)}”`
    )
    .join("\n");
  const portal = portalLink(g.id);
  const embed = new EmbedBuilder()
    .setColor(v.recommendation === "ban" ? 0xef4444 : 0xf59e0b)
    .setTitle(truncate(`u/${displayName} — ${SCREEN_RECO[v.recommendation].label} recommended`, 256))
    .setURL(`https://www.reddit.com/user/${encodeURIComponent(displayName)}`)
    .setDescription(
      truncate(
        `${v.summary}${evidence ? `\n\n${evidence}` : ""}${
          portal ? `\n\n[Review in the portal](${portal})` : ""
        }`,
        3500
      )
    )
    .addFields(
      { name: "Confidence", value: v.confidence, inline: true },
      { name: "Flags", value: String(flagCount), inline: true }
    )
    .setFooter({ text: "AI sourcing screen · a mod decides" })
    .setTimestamp(new Date());
  await channel.send({ embeds: [embed] });
}

async function sendCrisisAlert(
  client: Client,
  g: Guild,
  items: Array<Unscreened & { note: string }>
) {
  const channel = await alertChannel(client, g.redditScreenAlertChannelId!);
  const lines = items
    .slice(0, 10)
    .map((it) => `• u/${it.author} — [${truncate(it.note, 200)}](${it.permalink})`)
    .join("\n");
  const embed = new EmbedBuilder()
    .setColor(0x60a5fa)
    .setTitle(`⚠ Possible crisis signal${items.length > 1 ? "s" : ""} on reddit`)
    .setDescription(
      truncate(
        `These may need a caring response, not moderation:\n\n${lines}${
          items.length > 10 ? `\n…and ${items.length - 10} more in the portal.` : ""
        }`,
        3500
      )
    )
    .setFooter({ text: "AI sourcing screen" })
    .setTimestamp(new Date());
  await channel.send({ embeds: [embed] });
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
