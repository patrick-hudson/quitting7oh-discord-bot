// One-time historical backfill of leaderboard-monitored subreddits from the
// Arctic Shift archive (src/lib/arctic-shift.ts) — the full history of posts
// and comments, with settled scores, at zero cost to our Reddit API budget.
//
// Resumable by construction: RedditBackfillState keeps a per-(guild, sub)
// created_utc cursor per content kind; each tick advances one incomplete
// stream by a bounded number of pages, paced ~1 req/sec out of respect for a
// free community service. A stream is done when a page comes back short —
// the live collector in the reddit poller owns everything from then on.

import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import {
  ArcticTransientError,
  fetchArcticComments,
  fetchArcticPosts,
} from "@/lib/arctic-shift";
import { persistComments, persistPosts } from "@/lib/reddit-store";

const POLL_MS = 60_000;
const PAGES_PER_TICK = 20; // ×100 items — a sub's full history lands in hours
const PACE_MS = 1_200;
// Progressive backoff on slow-down signals: 1m, 2m, 4m, … capped at 30m —
// and never earlier than the server's own X-RateLimit-Reset when it sends
// one. The streak resets after any successful page.
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 30 * 60_000;

let cooldownUntil = 0;
let backoffStreak = 0;

export function runRedditBackfill() {
  console.log("[reddit-backfill] polling for monitored subs to backfill");
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (err) {
      console.error("[reddit-backfill] tick failed:", err);
    } finally {
      running = false;
    }
  }, POLL_MS);
  setTimeout(() => tick().catch(() => {}), 20_000);
}

async function tick() {
  if (Date.now() < cooldownUntil) return; // respecting a slow-down signal

  // Ensure a state row exists for every monitored sub.
  const guilds = await prisma.guild.findMany({
    where: { redditLeaderboardSubreddits: { isEmpty: false } },
    select: { id: true, redditLeaderboardSubreddits: true },
  });
  for (const g of guilds) {
    for (const sub of g.redditLeaderboardSubreddits) {
      const subreddit = sub.toLowerCase();
      await prisma.redditBackfillState.upsert({
        where: { guildId_subreddit: { guildId: g.id, subreddit } },
        create: { guildId: g.id, subreddit },
        update: {},
      });
    }
  }

  // Advance ONE incomplete stream per tick, posts before comments.
  const state = await prisma.redditBackfillState.findFirst({
    where: { OR: [{ postsDoneAt: null }, { commentsDoneAt: null }] },
    orderBy: { updatedAt: "asc" },
  });
  if (!state) return;

  const kind = state.postsDoneAt === null ? "posts" : "comments";
  const cursorField = kind === "posts" ? "postsCursor" : "commentsCursor";
  let cursor =
    (kind === "posts" ? state.postsCursor : state.commentsCursor)?.getTime() ?? 0;
  let fetched = 0;

  console.log(
    `[reddit-backfill] r/${state.subreddit} ${kind} from ${new Date(cursor).toISOString().slice(0, 10)}`
  );

  try {
    for (let page = 0; page < PAGES_PER_TICK; page++) {
      const afterEpoch = Math.floor(cursor / 1000);
      const batch =
        kind === "posts"
          ? await fetchArcticPosts(state.subreddit, afterEpoch)
          : await fetchArcticComments(state.subreddit, afterEpoch);

      backoffStreak = 0; // a page came back — the streak is over

      if (batch.length > 0) {
        if (kind === "posts") {
          await persistPosts(state.guildId, state.subreddit, batch as never, {
            settledScores: true,
          });
        } else {
          await persistComments(state.guildId, state.subreddit, batch as never, {
            settledScores: true,
          });
        }
        fetched += batch.length;
        const newest = batch[batch.length - 1].createdAt.getTime();
        // Guard against a page of identical timestamps stalling the cursor.
        cursor = newest > cursor ? newest : cursor + 1000;
        await prisma.redditBackfillState.update({
          where: { id: state.id },
          data: {
            [cursorField]: new Date(cursor),
            [kind === "posts" ? "postsFetched" : "commentsFetched"]: {
              increment: batch.length,
            },
          },
        });
      }

      if (batch.length < 100) {
        // Reached the archive's edge — the live collector owns it from here.
        await prisma.redditBackfillState.update({
          where: { id: state.id },
          data: { [kind === "posts" ? "postsDoneAt" : "commentsDoneAt"]: new Date() },
        });
        const total =
          (kind === "posts" ? state.postsFetched : state.commentsFetched) + fetched;
        console.log(
          `[reddit-backfill] r/${state.subreddit} ${kind} complete (${total} total)`
        );
        audit(
          state.guildId,
          "reddit.backfilled",
          `Backfilled ${total.toLocaleString()} historical ${kind} for r/${state.subreddit} from Arctic Shift`,
          { subreddit: state.subreddit, kind, total }
        );
        return;
      }
      await sleep(PACE_MS);
    }
    console.log(
      `[reddit-backfill] r/${state.subreddit} ${kind}: +${fetched} this tick, continuing next tick`
    );
  } catch (err) {
    if (err instanceof ArcticTransientError) {
      backoffStreak++;
      const progressive = Math.min(
        BACKOFF_CAP_MS,
        BACKOFF_BASE_MS * 2 ** (backoffStreak - 1)
      );
      cooldownUntil = Math.max(err.resetAtMs ?? 0, Date.now() + progressive);
      console.warn(
        `[reddit-backfill] ${err.message} — cooling off ${Math.round((cooldownUntil - Date.now()) / 60000)}m (streak ${backoffStreak}${err.resetAtMs ? ", server-provided reset" : ""})`
      );
      return; // no error audit: this is polite behavior, not a failure
    }
    console.error(`[reddit-backfill] r/${state.subreddit} ${kind} failed:`, err);
    audit(
      state.guildId,
      "reddit.poll_failed",
      `Arctic Shift backfill of r/${state.subreddit} ${kind} failed — will retry`,
      { subreddit: state.subreddit, kind, error: (err as Error).message?.slice(0, 500) },
      "error"
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
