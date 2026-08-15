// Persistence + aggregation for leaderboard-monitored subreddits. The reddit
// poller calls persistPosts/persistComments with whatever it fetched (shared
// fetches with the announce/firehose streams — a monitored sub that's already
// streamed costs no extra API calls) and refreshMaturingScores once per tick.
// The Reddit leaderboard page and API aggregate straight off these tables —
// small enough that no cache layer is needed.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  fetchInfoScores,
  type RedditComment,
  type RedditPost,
} from "@/lib/reddit";

// Accounts that would pollute a contributor leaderboard.
const EXCLUDED_AUTHORS = new Set(["automoderator", "[deleted]"]);

// `settledScores` marks rows as already-matured (Arctic Shift archive data
// carries final scores), so the maturation pass skips them.
export async function persistPosts(
  guildId: string,
  subreddit: string, // lowercased
  posts: RedditPost[],
  opts: { settledScores?: boolean } = {}
): Promise<number> {
  if (posts.length === 0) return 0;
  const stamped = opts.settledScores ? new Date() : null;
  const res = await prisma.redditPost.createMany({
    data: posts.map((p) => ({
      id: p.id,
      guildId,
      subreddit,
      author: p.author,
      title: p.title,
      body: p.body,
      permalink: p.permalink,
      score: p.score,
      scoreUpdatedAt: stamped,
      createdAt: p.createdAt,
    })),
    skipDuplicates: true,
  });
  return res.count;
}

export async function persistComments(
  guildId: string,
  subreddit: string, // lowercased
  comments: RedditComment[],
  opts: { settledScores?: boolean } = {}
): Promise<number> {
  if (comments.length === 0) return 0;
  const stamped = opts.settledScores ? new Date() : null;
  const res = await prisma.redditComment.createMany({
    data: comments.map((c) => ({
      id: c.id,
      guildId,
      subreddit,
      author: c.author,
      body: c.body,
      permalink: c.permalink,
      postTitle: c.postTitle,
      score: c.score,
      scoreUpdatedAt: stamped,
      createdAt: c.createdAt,
    })),
    skipDuplicates: true,
  });
  return res.count;
}

// Re-read settled scores for content that's old enough for votes to have
// accumulated (6h) but young enough to still matter (72h). One /api/info call
// covers 100 items, so this is at most two requests per invocation — call it
// once per poll tick. Items get exactly one refresh (scoreUpdatedAt stamps it).
export async function refreshMaturingScores(): Promise<number> {
  const from = new Date(Date.now() - 72 * 3600_000);
  const to = new Date(Date.now() - 6 * 3600_000);
  const [posts, comments] = await Promise.all([
    prisma.redditPost.findMany({
      where: { scoreUpdatedAt: null, createdAt: { gte: from, lte: to } },
      select: { id: true },
      take: 100,
    }),
    prisma.redditComment.findMany({
      where: { scoreUpdatedAt: null, createdAt: { gte: from, lte: to } },
      select: { id: true },
      take: 100,
    }),
  ]);
  const fullnames = [
    ...posts.map((p) => `t3_${p.id}`),
    ...comments.map((c) => `t1_${c.id}`),
  ];
  if (fullnames.length === 0) return 0;

  const scores = await fetchInfoScores(fullnames);
  const now = new Date();
  let updated = 0;
  for (const p of posts) {
    const score = scores.get(`t3_${p.id}`);
    await prisma.redditPost.updateMany({
      where: { id: p.id },
      data: { scoreUpdatedAt: now, ...(score !== undefined ? { score } : {}) },
    });
    updated++;
  }
  for (const c of comments) {
    const score = scores.get(`t1_${c.id}`);
    await prisma.redditComment.updateMany({
      where: { id: c.id },
      data: { scoreUpdatedAt: now, ...(score !== undefined ? { score } : {}) },
    });
    updated++;
  }
  return updated;
}

export type RedditLeaderboardRow = {
  author: string;
  posts: number;
  comments: number;
  total: number;
  karma: number; // settled post + comment score sum
  avgScore: number;
  activeDays: number;
  firstSeen: string; // ISO
  lastSeen: string; // ISO
};

export type RedditLeaderboardData = {
  rows: RedditLeaderboardRow[];
  subreddits: string[]; // monitored subs that actually have data
  totalPosts: number;
  totalComments: number;
  collectingSince: string | null;
};

// Aggregate contributors across (or within) a guild's collected subreddits.
// Returned unranked-but-sorted by total activity; the UI re-sorts client-side
// for the karma view. Bounded to the top 250 by activity, like the Discord
// leaderboard.
export async function computeRedditLeaderboard(
  guildId: string,
  subreddit?: string
): Promise<RedditLeaderboardData> {
  const subFilter = subreddit
    ? Prisma.sql`AND subreddit = ${subreddit.toLowerCase()}`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<
    Array<{
      author: string;
      posts: number;
      comments: number;
      karma: number;
      activeDays: number;
      firstSeen: Date;
      lastSeen: Date;
    }>
  >`
    WITH everything AS (
      SELECT author, score, "createdAt", 1 AS is_post
      FROM "RedditPost" WHERE "guildId" = ${guildId} ${subFilter}
      UNION ALL
      SELECT author, score, "createdAt", 0 AS is_post
      FROM "RedditComment" WHERE "guildId" = ${guildId} ${subFilter}
    )
    SELECT author,
           SUM(is_post)::int AS posts,
           SUM(1 - is_post)::int AS comments,
           SUM(score)::int AS karma,
           COUNT(DISTINCT "createdAt"::date)::int AS "activeDays",
           MIN("createdAt") AS "firstSeen",
           MAX("createdAt") AS "lastSeen"
    FROM everything
    GROUP BY author
    ORDER BY COUNT(*) DESC
    LIMIT 250
  `;

  const [subs, postCount, commentCount, oldest] = await Promise.all([
    prisma.redditPost.findMany({
      where: { guildId },
      distinct: ["subreddit"],
      select: { subreddit: true },
    }),
    prisma.redditPost.count({ where: { guildId } }),
    prisma.redditComment.count({ where: { guildId } }),
    prisma.redditPost.findFirst({
      where: { guildId },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
  ]);

  return {
    rows: rows
      .filter((r) => !EXCLUDED_AUTHORS.has(r.author.toLowerCase()))
      .map((r) => {
        const total = r.posts + r.comments;
        return {
          author: r.author,
          posts: r.posts,
          comments: r.comments,
          total,
          karma: r.karma,
          avgScore: total > 0 ? Math.round((r.karma / total) * 10) / 10 : 0,
          activeDays: r.activeDays,
          firstSeen: r.firstSeen.toISOString(),
          lastSeen: r.lastSeen.toISOString(),
        };
      }),
    subreddits: subs.map((s) => s.subreddit).sort(),
    totalPosts: postCount,
    totalComments: commentCount,
    collectingSince: oldest?.createdAt.toISOString() ?? null,
  };
}
