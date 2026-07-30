// Reddit new-post announcer. Every N seconds:
//   - SELECT Guild WHERE redditEnabled AND redditSubreddit AND redditChannelId
//   - For each: fetch /r/<sub>/new, announce submissions newer than the guild's
//     redditLastPostAt high-water mark, then advance the mark.
//
// Mirrors the scheduler's polling model: non-overlapping ticks, at-least-once-ish
// (a transient Discord send failure drops that one announcement rather than
// blocking the feed). Reads Reddit's public RSS feed — no API key required.

import { Client, EmbedBuilder } from "discord.js";
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
      redditSubreddit: { not: null },
      redditChannelId: { not: null },
    },
  });
  if (guilds.length === 0) return;

  for (const g of guilds) {
    const subreddit = g.redditSubreddit!;
    const channelId = g.redditChannelId!;
    try {
      const posts = await fetchNewPosts(subreddit);
      if (posts.length === 0) continue;

      const newest = posts.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));

      // First time we look at this subreddit: seed the baseline without
      // announcing, so enabling the feature doesn't dump the last 25 posts.
      if (g.redditLastPostAt === null) {
        await prisma.guild.update({
          where: { id: g.id },
          data: { redditLastPostAt: newest.createdAt },
        });
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
        .filter((p) => p.createdAt > g.redditLastPostAt!)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      if (fresh.length === 0) continue;

      for (const post of fresh) {
        await announce(client, channelId, subreddit, post);
      }

      // Advance the mark to the newest item we saw this tick. Even if a send
      // failed above, we move past it — retrying a Discord failure risks
      // double-posting the ones that did succeed.
      await prisma.guild.update({
        where: { id: g.id },
        data: { redditLastPostAt: newest.createdAt },
      });
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
      // Leave the mark untouched so the next tick retries from where we were.
    }
  }
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
