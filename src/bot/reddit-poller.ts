// Reddit watcher with three independent features per guild, sharing fetches:
//
//   - ANNOUNCE: new posts from redditSubreddits → redditChannelId, as embeds
//     with a short excerpt. Member-facing.
//   - FIREHOSE: every comment from redditFirehoseSubreddits →
//     redditFirehoseChannelId, batched up to 10 embeds per message, each
//     titled with its post for context. Mod-only monitoring. Requires the
//     OAuth reader (comment-volume polling would be 429'd anonymously).
//
//   - COLLECT: posts + comments from redditLeaderboardSubreddits persisted to
//     RedditPost/RedditComment (src/lib/reddit-store.ts) for the Reddit
//     contributor leaderboard. Independent of redditEnabled; a sub that's
//     already announced/firehosed is collected from the same fetch.
//
// A subreddit on several lists is fetched once per content kind per tick.
// High-water marks live in Guild.redditLastPostAts, a JSON map: post marks
// keyed by lowercased sub name, comment marks by "c:<sub>". Each seeds
// silently on first sight (no backlog dump) and advances independently, so
// one failing sub or stream never blocks another.
//
// Mirrors the scheduler's polling model: non-overlapping ticks, at-least-once
// -ish (a transient Discord send failure drops that item rather than blocking
// the feed).

import { Client, EmbedBuilder } from "discord.js";
import type { Guild, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import {
  fetchNewComments,
  fetchNewPosts,
  redditOauthEnabled,
  type RedditComment,
  type RedditPost,
} from "@/lib/reddit";
import { audit } from "@/lib/audit";
import { persistComments, persistPosts, refreshMaturingScores } from "@/lib/reddit-store";

const REDDIT_ORANGE = 0xff4500;
const COMMENT_GREY = 0x8a919b;

export function runRedditPoller(client: Client) {
  const intervalMs = env.redditPollSeconds() * 1000;
  console.log(`[reddit] polling every ${intervalMs}ms`);

  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick(client);
    } catch (err) {
      console.error("[reddit] tick failed:", err);
    } finally {
      running = false;
    }
  }, intervalMs);
}

async function tick(client: Client) {
  const guilds = await prisma.guild.findMany({
    where: {
      OR: [
        { redditSubreddits: { isEmpty: false } },
        { redditFirehoseSubreddits: { isEmpty: false } },
        { redditLeaderboardSubreddits: { isEmpty: false } },
        // Legacy single-sub config still waiting to be migrated.
        { redditSubreddit: { not: null } },
      ],
    },
  });

  for (const guild of guilds) {
    const g = await migrateLegacyConfig(guild);
    const marks = readMarks(g.redditLastPostAts);
    let marksChanged = false;
    let fetches = 0;
    const pace = async () => {
      // Space out Reddit calls within a tick; there's a whole interval to fill
      // and anonymous RSS 429s back-to-back requests from one IP.
      if (fetches++ > 0) await sleep(2_000);
    };

    // Three features, one fetch plan. A sub can be announced (posts → public
    // channel), firehosed (comments → mod channel), and/or monitored
    // (posts + comments persisted for the leaderboard) — each fetch happens
    // once and feeds every feature that wants it. Announce/firehose respect
    // the redditEnabled toggle; collection is independent of it.
    const announced = new Set(g.redditSubreddits.map((x) => x.toLowerCase()));
    const firehosed = new Set(g.redditFirehoseSubreddits.map((x) => x.toLowerCase()));
    const monitored = new Set(
      g.redditLeaderboardSubreddits.map((x) => x.toLowerCase())
    );
    const union = new Map<string, string>(); // key → display casing
    for (const list of [
      g.redditSubreddits,
      g.redditFirehoseSubreddits,
      g.redditLeaderboardSubreddits,
    ]) {
      for (const sub of list) {
        if (!union.has(sub.toLowerCase())) union.set(sub.toLowerCase(), sub);
      }
    }

    for (const [key, subreddit] of union) {
      const doAnnounce =
        g.redditEnabled && announced.has(key) && Boolean(g.redditChannelId);
      const doFirehose =
        g.redditEnabled &&
        firehosed.has(key) &&
        Boolean(g.redditFirehoseChannelId) &&
        redditOauthEnabled();
      const doCollect = monitored.has(key);

      // --- Posts: fetched once for announce and/or collection --------------
      if (doAnnounce || doCollect) {
        try {
          await pace();
          const posts = await fetchNewPosts(subreddit);

          if (doCollect) {
            const stored = await persistPosts(g.id, key, posts);
            if (stored > 0) {
              console.log(`[reddit] collected ${stored} post(s) from r/${subreddit} (${g.name})`);
            }
          }

          if (doAnnounce && posts.length > 0) {
            const newest = posts.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
            const mark = marks[key] ? new Date(marks[key]) : null;

            if (mark === null) {
              // First sight: seed the baseline without announcing.
              marks[key] = newest.createdAt.toISOString();
              marksChanged = true;
              console.log(`[reddit] seeded baseline for r/${subreddit} (${g.name})`);
              audit(g.id, "reddit.baseline_seeded", `Seeded r/${subreddit} baseline — no backlog announced`, {
                subreddit,
                baselineAt: newest.createdAt.toISOString(),
              });
            } else {
              const fresh = posts
                .filter((p) => p.createdAt > mark)
                .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
              if (fresh.length > 0) {
                for (const post of fresh) {
                  await announce(client, g.redditChannelId!, subreddit, post);
                }
                // Advance past everything seen this tick even if a send failed —
                // retrying a Discord failure risks double-posting the successes.
                marks[key] = newest.createdAt.toISOString();
                marksChanged = true;
                console.log(
                  `[reddit] announced ${fresh.length} new post(s) from r/${subreddit} (${g.name})`
                );
                audit(
                  g.id,
                  "reddit.announced",
                  `Announced ${fresh.length} new r/${subreddit} post(s)`,
                  {
                    subreddit,
                    channelId: g.redditChannelId,
                    posts: fresh.map((p) => ({
                      id: p.id,
                      title: p.title.slice(0, 200),
                      author: p.author,
                      permalink: p.permalink,
                    })),
                  }
                );
              }
            }
          }
        } catch (err) {
          console.error(`[reddit] post poll failed for r/${subreddit} (${g.name}):`, err);
          audit(
            g.id,
            "reddit.poll_failed",
            `Poll of r/${subreddit} failed — will retry next tick`,
            { subreddit, stream: "posts", error: (err as Error).message?.slice(0, 500) },
            "error"
          );
          // Mark untouched; next tick retries from where we were.
        }
      }

      // --- Comments: fetched once for firehose and/or collection -----------
      // Both need the OAuth reader (anonymous RSS can't sustain comment volume).
      if (doFirehose || (doCollect && redditOauthEnabled())) {
        const cKey = `c:${key}`;
        try {
          await pace();
          const comments = await fetchNewComments(subreddit);

          if (doCollect) {
            const stored = await persistComments(g.id, key, comments);
            if (stored > 0) {
              console.log(`[reddit] collected ${stored} comment(s) from r/${subreddit} (${g.name})`);
            }
          }

          if (doFirehose && comments.length > 0) {
            const newest = comments.reduce((a, b) =>
              a.createdAt > b.createdAt ? a : b
            );
            const mark = marks[cKey] ? new Date(marks[cKey]) : null;

            if (mark === null) {
              marks[cKey] = newest.createdAt.toISOString();
              marksChanged = true;
              console.log(`[reddit] seeded firehose baseline for r/${subreddit} (${g.name})`);
            } else {
              const fresh = comments
                .filter((c) => c.createdAt > mark)
                .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
              if (fresh.length > 0) {
                await firehose(client, g.redditFirehoseChannelId!, subreddit, fresh);
                marks[cKey] = newest.createdAt.toISOString();
                marksChanged = true;
                console.log(
                  `[reddit] firehosed ${fresh.length} new comment(s) from r/${subreddit} (${g.name})`
                );
                audit(
                  g.id,
                  "reddit.firehosed",
                  `Firehosed ${fresh.length} new r/${subreddit} comment(s)`,
                  { subreddit, channelId: g.redditFirehoseChannelId, count: fresh.length }
                );
              }
            }
          }
        } catch (err) {
          console.error(`[reddit] comment poll failed for r/${subreddit} (${g.name}):`, err);
          audit(
            g.id,
            "reddit.poll_failed",
            `Comment poll of r/${subreddit} failed — will retry next tick`,
            { subreddit, stream: "comments", error: (err as Error).message?.slice(0, 500) },
            "error"
          );
        }
      }
    }

    if (
      g.redditEnabled &&
      g.redditFirehoseChannelId &&
      g.redditFirehoseSubreddits.length > 0 &&
      !redditOauthEnabled()
    ) {
      console.warn(
        `[reddit] firehose configured for ${g.name} but REDDIT_CLIENT_ID/SECRET are not set — comments need the OAuth reader`
      );
    }

    if (marksChanged) {
      await prisma.guild.update({
        where: { id: g.id },
        data: { redditLastPostAts: marks as Prisma.InputJsonValue },
      });
    }
  }

  // Settle karma for collected content old enough for votes to accumulate —
  // at most two /api/info calls per tick (100 items each).
  if (redditOauthEnabled()) {
    try {
      const updated = await refreshMaturingScores();
      if (updated > 0) console.log(`[reddit] matured scores for ${updated} item(s)`);
    } catch (err) {
      console.error("[reddit] score maturation failed:", err);
    }
  }
}

// One-time, per-guild lazy migration of the legacy single-subreddit columns
// into the list + marks map. Runs at most once per guild (it clears the legacy
// fields), keeps the old high-water mark so nothing gets re-announced, and
// respects a list the admin may have already saved through the new UI.
async function migrateLegacyConfig(g: Guild): Promise<Guild> {
  if (!g.redditSubreddit) return g;
  const subreddits =
    g.redditSubreddits.length > 0 ? g.redditSubreddits : [g.redditSubreddit];
  const marks = readMarks(g.redditLastPostAts);
  const key = g.redditSubreddit.toLowerCase();
  if (g.redditLastPostAt && !marks[key] && subreddits.some((s) => s.toLowerCase() === key)) {
    marks[key] = g.redditLastPostAt.toISOString();
  }
  const updated = await prisma.guild.update({
    where: { id: g.id },
    data: {
      redditSubreddits: subreddits,
      redditLastPostAts: marks as Prisma.InputJsonValue,
      redditSubreddit: null,
      redditLastPostAt: null,
    },
  });
  console.log(
    `[reddit] migrated legacy config for ${g.name} → [${subreddits.join(", ")}]`
  );
  return updated;
}

// The marks column is unvalidated JSON — coerce defensively to a string map.
function readMarks(raw: Prisma.JsonValue): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

async function announce(
  client: Client,
  channelId: string,
  subreddit: string,
  post: RedditPost
) {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    throw new Error(`channel ${channelId} not a sendable text channel`);
  }

  // Title links to the post; self-posts also get a body snippet. Link/image
  // posts have no body in the feed, so they stay title-only — click through
  // for the link and comments.
  const embed = new EmbedBuilder()
    .setColor(REDDIT_ORANGE)
    .setTitle(truncate(post.title, 256))
    .setURL(post.permalink)
    .setAuthor({ name: `u/${post.author} · r/${subreddit}` })
    .setTimestamp(post.createdAt)
    .setFooter({ text: "reddit" });
  if (post.body) embed.setDescription(truncate(post.body, 300));

  await channel.send({ embeds: [embed] });
}

// Comments are high-volume, so they batch up to Discord's 10-embeds-per-
// message limit — a busy tick sends a handful of messages instead of dozens.
async function firehose(
  client: Client,
  channelId: string,
  subreddit: string,
  comments: RedditComment[]
) {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    throw new Error(`channel ${channelId} not a sendable text channel`);
  }
  for (let i = 0; i < comments.length; i += 10) {
    const embeds = comments.slice(i, i + 10).map((c) =>
      new EmbedBuilder()
        .setColor(COMMENT_GREY)
        .setAuthor({ name: `u/${c.author} · r/${subreddit}` })
        .setTitle(truncate(`💬 ${c.postTitle || "comment"}`, 256))
        .setURL(c.permalink)
        .setDescription(truncate(c.body || "(empty)", 1000))
        .setTimestamp(c.createdAt)
        .setFooter({ text: "reddit comment" })
    );
    await channel.send({ embeds });
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
