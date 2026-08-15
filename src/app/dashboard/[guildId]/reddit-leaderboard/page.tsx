// Reddit contributor leaderboard: configure which subreddits are collected,
// watch the Arctic Shift backfill fill in history, rank contributors by
// activity or settled karma, queue mod-promotion AI reviews, and link reddit
// identities to Discord members. Data comes straight from the collected
// RedditPost/RedditComment tables (src/lib/reddit-store.ts) — no cache layer
// needed at this volume.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireGuildAccess } from "@/lib/authz";
import { computeRedditLeaderboard } from "@/lib/reddit-store";
import { redditOauthEnabled } from "@/lib/reddit";
import {
  RedditLeaderboardConfig,
  RedditLeaderboardTable,
} from "@/components/RedditLeaderboard";
import { LocalTime } from "@/components/LocalTime";

export default async function RedditLeaderboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ guildId: string }>;
  searchParams: Promise<{ sub?: string }>;
}) {
  const { guildId } = await params;
  const { sub } = await searchParams;
  await requireGuildAccess(guildId);

  const [guild, data, backfills, links] = await Promise.all([
    prisma.guild.findUnique({
      where: { id: guildId },
      select: { redditLeaderboardSubreddits: true },
    }),
    computeRedditLeaderboard(guildId, sub),
    prisma.redditBackfillState.findMany({
      where: { guildId },
      orderBy: { subreddit: "asc" },
    }),
    prisma.redditIdentityLink.findMany({ where: { guildId } }),
  ]);
  const monitored = guild?.redditLeaderboardSubreddits ?? [];
  const linkMap = Object.fromEntries(
    links.map((l) => [l.redditUsername, l.discordUserId])
  );

  return (
    <div className="mx-auto max-w-7xl">
      <h1 className="text-2xl font-semibold tracking-tight">Reddit leaderboard</h1>
      <p className="mt-1 text-sm text-white/60">
        Contributor activity across your monitored subreddits
        {data.collectingSince
          ? ` — ${data.totalPosts.toLocaleString()} posts and ${data.totalComments.toLocaleString()} comments collected since ${data.collectingSince.slice(0, 10)}`
          : ""}
        . Rank by activity or settled karma; queue a mod-promotion AI review
        from any row.
      </p>

      <div className="mt-6">
        <RedditLeaderboardConfig
          guildId={guildId}
          initial={monitored}
          oauthReady={redditOauthEnabled()}
        />
      </div>

      {backfills.length > 0 && (
        <div className="mt-4 rounded-2xl bg-white/[0.02] p-4 ring-1 ring-white/10">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-white/50">
            Historical backfill (Arctic Shift)
          </h2>
          <ul className="mt-2 space-y-1 text-xs text-white/60">
            {backfills.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-x-2">
                <span className="font-medium text-white/75">r/{b.subreddit}</span>
                <span>
                  posts:{" "}
                  {b.postsDoneAt
                    ? `✓ ${b.postsFetched.toLocaleString()}`
                    : `${b.postsFetched.toLocaleString()} so far (through ${b.postsCursor ? b.postsCursor.toISOString().slice(0, 10) : "start"})`}
                </span>
                <span>·</span>
                <span>
                  comments:{" "}
                  {b.commentsDoneAt
                    ? `✓ ${b.commentsFetched.toLocaleString()}`
                    : `${b.commentsFetched.toLocaleString()} so far (through ${b.commentsCursor ? b.commentsCursor.toISOString().slice(0, 10) : "start"})`}
                </span>
                <span className="text-white/35">
                  · updated <LocalTime iso={b.updatedAt.toISOString()} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.subreddits.length > 1 && (
        <div className="mt-6 flex items-center gap-1.5">
          <Link
            href={`/dashboard/${guildId}/reddit-leaderboard`}
            className={`rounded-md px-2 py-0.5 text-[11px] ring-1 ${!sub ? "bg-white/10 text-white/90 ring-white/20" : "text-white/50 ring-white/10 hover:bg-white/5"}`}
          >
            All
          </Link>
          {data.subreddits.map((s) => (
            <Link
              key={s}
              href={`/dashboard/${guildId}/reddit-leaderboard?sub=${encodeURIComponent(s)}`}
              className={`rounded-md px-2 py-0.5 text-[11px] ring-1 ${sub === s ? "bg-white/10 text-white/90 ring-white/20" : "text-white/50 ring-white/10 hover:bg-white/5"}`}
            >
              r/{s}
            </Link>
          ))}
        </div>
      )}

      <div className="mt-4">
        {data.rows.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-white/60">
            {monitored.length === 0
              ? "Add a subreddit above to start collecting."
              : "Collecting — the poller picks new content up within ~5 minutes and the backfill streams in history. Check back shortly."}
          </div>
        ) : (
          <RedditLeaderboardTable guildId={guildId} rows={data.rows} links={linkMap} />
        )}
      </div>
    </div>
  );
}
