// Reddit new-post announcer. Every N seconds:
//   - SELECT Guild WHERE redditEnabled AND redditChannelId (and something to watch)
//   - For each watched subreddit: fetch /r/<sub>/new, announce submissions newer
//     than that subreddit's high-water mark, then advance the mark.
//
// Multiple subreddits per guild post into the ONE configured channel. Marks
// live in Guild.redditLastPostAts, a JSON map of lowercased subreddit name →
// ISO timestamp, so each sub seeds and advances independently — adding a new
// sub never dumps its backlog, and one failing sub never blocks another.
//
// Mirrors the scheduler's polling model: non-overlapping ticks, at-least-once-ish
// (a transient Discord send failure drops that one announcement rather than
// blocking the feed). Reads Reddit's public RSS feed — no API key required.

import { Client, EmbedBuilder } from "discord.js";
import type { Guild, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { fetchNewPosts, type RedditPost } from "@/lib/reddit";
import { audit } from "@/lib/audit";

const REDDIT_ORANGE = 0xff4500;

export function runRedditPoller(client: Client) {
  const intervalMs = env.redditPollSeconds() * 1000;
  console.log(`[reddit] polling every ${intervalMs}ms (public RSS)`);

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
      redditEnabled: true,
      redditChannelId: { not: null },
      // Either the new list is populated or a legacy single-sub config is
      // still waiting to be migrated.
      OR: [{ redditSubreddits: { isEmpty: false } }, { redditSubreddit: { not: null } }],
    },
  });
  if (guilds.length === 0) return;

  for (const guild of guilds) {
    const g = await migrateLegacyConfig(guild);
    const channelId = g.redditChannelId!;
    const marks = readMarks(g.redditLastPostAts);
    let marksChanged = false;

    for (const [i, subreddit] of g.redditSubreddits.entries()) {
      const key = subreddit.toLowerCase();
      try {
        // Space out per-sub fetches — Reddit 429s back-to-back unauthenticated
        // requests from the same IP, and there's a whole poll interval to fill.
        if (i > 0) await sleep(2_000);
        const posts = await fetchNewPosts(subreddit);
        if (posts.length === 0) continue;

        const newest = posts.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
        const mark = marks[key] ? new Date(marks[key]) : null;

        // First time we look at this subreddit: seed the baseline without
        // announcing, so enabling it doesn't dump the last 25 posts.
        if (mark === null) {
          marks[key] = newest.createdAt.toISOString();
          marksChanged = true;
          console.log(`[reddit] seeded baseline for r/${subreddit} (${g.name})`);
          audit(g.id, "reddit.baseline_seeded", `Seeded r/${subreddit} baseline — no backlog announced`, {
            subreddit,
            baselineAt: newest.createdAt.toISOString(),
          });
          continue;
        }

        // Announce anything newer than the mark, oldest-first so they land in
        // chronological order.
        const fresh = posts
          .filter((p) => p.createdAt > mark)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        if (fresh.length === 0) continue;

        for (const post of fresh) {
          await announce(client, channelId, subreddit, post);
        }

        // Advance the mark to the newest item we saw this tick. Even if a send
        // failed above, we move past it — retrying a Discord failure risks
        // double-posting the ones that did succeed.
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
            channelId,
            posts: fresh.map((p) => ({
              id: p.id,
              title: p.title.slice(0, 200),
              author: p.author,
              permalink: p.permalink,
            })),
          }
        );
      } catch (err) {
        console.error(`[reddit] failed for r/${subreddit} (${g.name}):`, err);
        audit(
          g.id,
          "reddit.poll_failed",
          `Poll of r/${subreddit} failed — will retry next tick`,
          { subreddit, channelId, error: (err as Error).message?.slice(0, 500) },
          "error"
        );
        // Leave this sub's mark untouched so the next tick retries from where
        // we were; the remaining subs still get their turn.
      }
    }

    if (marksChanged) {
      await prisma.guild.update({
        where: { id: g.id },
        data: { redditLastPostAts: marks as Prisma.InputJsonValue },
      });
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

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
