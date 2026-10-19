// Reddit sourcing screen: configure which subreddits are screened, then work
// the queue of flagged users — each with the AI's whole-history assessment
// (ban / warn / support / no action), evidence links, and a draft message.
// Mods make the call on reddit and record it here. Crisis signals get their
// own section up top. Worker: src/bot/reddit-screen-worker.ts.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireGuildAccess } from "@/lib/authz";
import { listTextChannels } from "@/lib/discord-rest";
import { redditOauthEnabled } from "@/lib/reddit";
import { env } from "@/lib/env";
import { LocalTime } from "@/components/LocalTime";
import {
  RedditScreenConfig,
  RedditScreenQueue,
  type QueueUser,
} from "@/components/RedditScreening";
import { SCREEN_LABEL, SCREEN_RECO, UNASSESSED } from "@/components/reddit-screen-meta";
import type { ScreenVerdict } from "@/lib/reddit-screen";

const STATUSES = ["open", "watching", "banned", "dismissed"] as const;
const FLAG_LABELS = ["sourcing", "promoting_use", "taper_sourcing"];

export default async function RedditScreeningPage({
  params,
  searchParams,
}: {
  params: Promise<{ guildId: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { guildId } = await params;
  const { status: rawStatus } = await searchParams;
  const status = STATUSES.includes(rawStatus as (typeof STATUSES)[number]) ? rawStatus! : "open";
  await requireGuildAccess(guildId);

  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000);
  const [guild, channels, users, statusCounts, labelCounts, crisis] = await Promise.all([
    prisma.guild.findUnique({
      where: { id: guildId },
      select: {
        redditScreenEnabled: true,
        redditScreenSubreddits: true,
        redditScreenSince: true,
        redditScreenAlertChannelId: true,
        redditScreenNotes: true,
      },
    }),
    listTextChannels(guildId).catch(() => []),
    prisma.redditScreenUser.findMany({
      where: { guildId, status },
      orderBy: { lastFlaggedAt: "desc" },
      take: 300,
    }),
    prisma.redditScreenUser.groupBy({
      by: ["status"],
      where: { guildId },
      _count: { _all: true },
    }),
    prisma.redditScreenItem.groupBy({
      by: ["label"],
      where: { guildId, screenedAt: { gte: weekAgo } },
      _count: { _all: true },
    }),
    prisma.redditScreenItem.findMany({
      where: { guildId, crisis: true, itemCreatedAt: { gte: twoWeeksAgo } },
      orderBy: { itemCreatedAt: "desc" },
      take: 25,
    }),
  ]);

  const flaggedItems = users.length
    ? await prisma.redditScreenItem.findMany({
        where: {
          guildId,
          label: { in: FLAG_LABELS },
          confidence: { not: "low" },
          OR: users.map((u) => ({ author: { equals: u.username, mode: "insensitive" as const } })),
        },
        orderBy: { itemCreatedAt: "desc" },
        take: 2000,
      })
    : [];
  const itemsByUser = new Map<string, typeof flaggedItems>();
  for (const it of flaggedItems) {
    const k = it.author.toLowerCase();
    const list = itemsByUser.get(k) ?? [];
    if (list.length < 15) list.push(it);
    itemsByUser.set(k, list);
  }

  const rank = (rec: string | null) => (rec ? (SCREEN_RECO[rec]?.rank ?? UNASSESSED.rank) : UNASSESSED.rank);
  const queue: QueueUser[] = users
    .map((u) => ({
      username: u.username,
      displayName: u.displayName,
      status: u.status,
      flagCount: u.flagCount,
      lastFlaggedAt: u.lastFlaggedAt?.toISOString() ?? null,
      recommendation: u.recommendation,
      confidence: u.confidence,
      verdict: (u.verdict as unknown as ScreenVerdict | null) ?? null,
      verdictAt: u.verdictAt?.toISOString() ?? null,
      assessPending: u.assessDueAt !== null,
      assessError: u.assessError,
      itemsAnalyzed: u.itemsAnalyzed,
      decidedAt: u.decidedAt?.toISOString() ?? null,
      items: (itemsByUser.get(u.username) ?? []).map((it) => ({
        id: it.id,
        kind: it.kind,
        subreddit: it.subreddit,
        label: it.label,
        confidence: it.confidence,
        recoveryIntent: it.recoveryIntent,
        reason: it.reason,
        evidence: it.evidence,
        permalink: it.permalink,
        createdAt: it.itemCreatedAt.toISOString(),
      })),
    }))
    .sort(
      (a, b) =>
        rank(a.recommendation) - rank(b.recommendation) ||
        (b.lastFlaggedAt ?? "").localeCompare(a.lastFlaggedAt ?? "")
    );

  const countFor = (s: string) => statusCounts.find((r) => r.status === s)?._count._all ?? 0;
  const screenedWeek = labelCounts.reduce((n, r) => n + r._count._all, 0);
  const subs = guild?.redditScreenSubreddits ?? [];

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-2xl font-semibold tracking-tight">Reddit sourcing screen</h1>
      <p className="mt-1 text-sm text-white/60">
        Claude reads every new post and comment in your screened subreddits
        and flags people using the sub to find or push the drug. It keeps
        them separate from members who are struggling to quit. Flagged users
        get a full-history assessment. You make the call on reddit and record
        it here; nothing is banned automatically.
      </p>

      <div className="mt-6">
        <RedditScreenConfig
          guildId={guildId}
          initial={{
            enabled: guild?.redditScreenEnabled ?? false,
            subreddits: subs,
            since: guild?.redditScreenSince?.toISOString() ?? null,
            alertChannelId: guild?.redditScreenAlertChannelId ?? "",
            notes: guild?.redditScreenNotes ?? "",
          }}
          channels={channels.map((c) => ({ id: c.id, name: c.name }))}
          oauthReady={redditOauthEnabled()}
          apiKeyReady={Boolean(env.anthropicApiKey())}
        />
      </div>

      {screenedWeek > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-1.5 text-xs text-white/50">
          <span className="mr-1">Last 7 days: {screenedWeek.toLocaleString()} screened</span>
          {labelCounts
            .sort((a, b) => b._count._all - a._count._all)
            .map((r) => (
              <span
                key={r.label}
                className={`rounded-md px-1.5 py-0.5 ring-1 ${SCREEN_LABEL[r.label]?.badge ?? SCREEN_LABEL.ok.badge}`}
              >
                {r._count._all.toLocaleString()} {SCREEN_LABEL[r.label]?.label ?? r.label}
              </span>
            ))}
        </div>
      )}

      {crisis.length > 0 && (
        <div className="mt-6 rounded-2xl bg-sky-400/[0.06] p-4 ring-1 ring-sky-400/20">
          <h2 className="text-sm font-semibold text-sky-100">
            Possible crisis signals (last 14 days)
          </h2>
          <p className="mt-0.5 text-xs text-sky-100/60">
            These may need a caring response, not moderation.
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            {crisis.map((c) => (
              <li key={c.id} className="text-white/75">
                <a
                  href={`https://www.reddit.com/user/${encodeURIComponent(c.author)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-white/90 hover:underline"
                >
                  u/{c.author}
                </a>{" "}
                <span className="text-white/40">
                  · <LocalTime iso={c.itemCreatedAt.toISOString()} /> ·{" "}
                </span>
                <a href={c.permalink} target="_blank" rel="noreferrer" className="hover:underline">
                  {c.crisisNote || c.evidence}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-8 flex items-center gap-1.5">
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={`/dashboard/${guildId}/reddit-screening${s === "open" ? "" : `?status=${s}`}`}
            className={`rounded-md px-2.5 py-1 text-xs capitalize ring-1 ${
              status === s
                ? "bg-white/10 text-white/90 ring-white/20"
                : "text-white/50 ring-white/10 hover:bg-white/5"
            }`}
          >
            {s} <span className="tabular-nums text-white/40">{countFor(s)}</span>
          </Link>
        ))}
      </div>

      <div className="mt-4">
        {queue.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-white/60">
            {!guild?.redditScreenEnabled
              ? "Turn the screen on above to start."
              : status === "open"
                ? "Nobody is waiting for review. New flags show up here within a few minutes of being posted."
                : `No ${status} users.`}
          </div>
        ) : (
          <RedditScreenQueue guildId={guildId} users={queue} subreddits={subs} />
        )}
      </div>
    </div>
  );
}
