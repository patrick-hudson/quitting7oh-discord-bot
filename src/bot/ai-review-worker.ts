// Background worker for AI contributor-fit reviews. The portal inserts
// AiReviewJob rows (status=pending); this worker claims them one at a time,
// gathers the target member's message history, asks Claude for a structured
// verdict (src/lib/ai-review.ts), writes it back to the row, audits, and DMs
// the requesting admin a link (best effort).
//
// Same philosophy as the other job workers: no IPC, crash-safe (stuck
// "running" jobs reset to pending on startup), one job at a time so a big
// review can't starve Discord rate limits. Unlike exports, finished reviews
// are NOT pruned — they're kept so a member can be re-reviewed later and the
// timelines compared.

import { Client } from "discord.js";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { getGuildMember, getUser } from "@/lib/discord-rest";
import {
  generateReview,
  resolveRedditReviewPrompt,
  resolveReviewPrompt,
  NoApiKeyError,
  NoMessagesError,
  type ReviewStats,
} from "@/lib/ai-review";
import type { LeaderboardData } from "@/lib/leaderboard";
import type { AiReviewJob, Prisma } from "@prisma/client";
import { env } from "@/lib/env";

const POLL_MS = 15_000;

export function runAiReviewWorker(client: Client) {
  console.log(`[ai-review] polling every ${POLL_MS}ms`);
  if (!env.anthropicApiKey()) {
    console.warn(
      "[ai-review] ANTHROPIC_API_KEY not set — queued reviews will fail with a clear error until it is."
    );
  }

  // Crash recovery: anything left "running" from a previous process retries.
  prisma.aiReviewJob
    .updateMany({ where: { status: "running" }, data: { status: "pending" } })
    .then((r) => {
      if (r.count > 0) console.log(`[ai-review] reset ${r.count} stuck job(s)`);
    })
    .catch((err) => console.warn("[ai-review] startup reset failed:", err));

  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick(client);
    } catch (err) {
      console.error("[ai-review] tick failed:", err);
    } finally {
      running = false;
    }
  }, POLL_MS);
}

// Drain the queue: keep claiming jobs until none are pending, so a batch of
// hundreds doesn't pay the poll interval between every review. Ad-hoc reviews
// (batchId=null) always jump ahead of batch jobs — a moderator asking about
// one member right now shouldn't wait hours behind a bulk run.
async function tick(client: Client) {
  for (;;) {
    const job =
      (await prisma.aiReviewJob.findFirst({
        where: { status: "pending", batchId: null },
        orderBy: { createdAt: "asc" },
      })) ??
      (await prisma.aiReviewJob.findFirst({
        where: { status: "pending" },
        orderBy: { createdAt: "asc" },
      }));
    if (!job) return;
    const keepGoing = await processJob(client, job);
    if (!keepGoing) return;
  }
}

// Returns false when the tick should stop draining (missing API key would
// otherwise insta-fail every queued job in one loop).
async function processJob(client: Client, job: AiReviewJob): Promise<boolean> {
  await prisma.aiReviewJob.update({
    where: { id: job.id },
    data: { status: "running", startedAt: new Date() },
  });
  console.log(
    `[ai-review] job ${job.id}: reviewing ${job.targetUserId} in guild ${job.guildId}`
  );

  // Batch jobs can sit queued for hours — re-check membership at run time so
  // we don't spend a review on someone who left after being selected. 404 =
  // gone; any other error fails open (run the review). Reddit reviews have no
  // membership to check.
  if (job.batchId && job.platform !== "reddit") {
    let member: unknown = undefined;
    try {
      member = await getGuildMember(job.guildId, job.targetUserId);
    } catch {
      member = undefined; // Discord hiccup — proceed with the review
    }
    if (member === null) {
      await prisma.aiReviewJob.update({
        where: { id: job.id },
        data: {
          status: "cancelled",
          finishedAt: new Date(),
          error: "Member left the server before their review ran — skipped.",
        },
      });
      console.log(`[ai-review] job ${job.id}: member left, skipped`);
      await maybeNotifyBatchDone(client, job);
      return true;
    }
  }

  try {
    const guild = await prisma.guild.findUnique({ where: { id: job.guildId } });
    const isReddit = job.platform === "reddit";
    const systemPrompt = isReddit
      ? resolveRedditReviewPrompt(guild?.aiRedditReviewPrompt)
      : resolveReviewPrompt(guild?.aiReviewPrompt);
    const stats = isReddit ? null : await loadStats(job.guildId, job.targetUserId);
    const targetName = isReddit
      ? (job.targetName ?? `u/${job.targetUserId}`)
      : await resolveName(job, stats);
    // Mod-confirmed identity link: lets a reddit review weigh the same
    // person's Discord history as additional evidence.
    const link = isReddit
      ? await prisma.redditIdentityLink.findUnique({
          where: {
            guildId_redditUsername: {
              guildId: job.guildId,
              redditUsername: job.targetUserId.toLowerCase(),
            },
          },
        })
      : null;

    const result = await generateReview({
      guildId: job.guildId,
      platform: isReddit ? "reddit" : "discord",
      targetUserId: job.targetUserId,
      targetName,
      sinceAt: job.sinceAt,
      untilAt: job.untilAt,
      channelIds: job.channelIds,
      systemPrompt,
      archiveEnabled: Boolean(guild?.archiveEnabled),
      stats: stats?.stats ?? null,
      linkedDiscordUserId: link?.discordUserId ?? null,
    });

    await prisma.aiReviewJob.update({
      where: { id: job.id },
      data: {
        status: "done",
        finishedAt: new Date(),
        targetName,
        verdict: result.verdict as unknown as Prisma.InputJsonValue,
        recommendation: result.verdict.recommendation,
        model: result.model,
        source: result.source,
        messagesAnalyzed: result.messagesAnalyzed,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        promptSnapshot: systemPrompt,
      },
    });
    console.log(
      `[ai-review] job ${job.id}: done — ${result.verdict.recommendation} (${result.messagesAnalyzed} msgs, ${result.source})`
    );
    audit(
      job.guildId,
      "aireview.completed",
      `AI fit review for ${targetName} — ${labelFor(result.verdict.recommendation)}${
        result.verdict.crisisFlag ? " ⚠ crisis flag" : ""
      }`,
      {
        jobId: job.id,
        targetUserId: job.targetUserId,
        requestedBy: job.requestedBy,
        recommendation: result.verdict.recommendation,
        confidence: result.verdict.confidence,
        crisisFlag: result.verdict.crisisFlag,
        messagesAnalyzed: result.messagesAnalyzed,
        source: result.source,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      },
      result.verdict.crisisFlag ? "warn" : "ok"
    );
    if (job.batchId) {
      await maybeNotifyBatchDone(client, job);
    } else {
      await notifyRequester(client, job, targetName, result.verdict.recommendation);
    }
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ai-review] job ${job.id} failed:`, err);
    // Expected, actionable failures get a friendlier audit than a raw stack.
    const status =
      err instanceof NoApiKeyError || err instanceof NoMessagesError ? "warn" : "error";
    audit(
      job.guildId,
      "aireview.failed",
      `AI fit review for ${job.targetName ?? job.targetUserId} failed: ${message.slice(0, 200)}`,
      {
        jobId: job.id,
        targetUserId: job.targetUserId,
        requestedBy: job.requestedBy,
        error: message.slice(0, 500),
      },
      status
    );
    await prisma.aiReviewJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        error: message.slice(0, 2000),
      },
    });
    if (job.batchId) await maybeNotifyBatchDone(client, job);
    // Without an API key every queued job fails identically — stop draining
    // and let the next poll retry, instead of torching a whole batch.
    return !(err instanceof NoApiKeyError);
  }
}

function labelFor(rec: string): string {
  switch (rec) {
    case "strong_fit":
      return "strong fit";
    case "possible_fit":
      return "possible fit";
    case "not_yet":
      return "not yet";
    case "concern":
      return "concern";
    default:
      return rec;
  }
}

// Pull the target's row from the precomputed leaderboard cache for quantitative
// context + a fallback display name. Best-effort — the review runs without it.
async function loadStats(
  guildId: string,
  targetUserId: string
): Promise<{ stats: ReviewStats; name: string | null } | null> {
  try {
    const cache = await prisma.leaderboardCache.findUnique({
      where: { guildId },
      select: { data: true },
    });
    const data = cache?.data as unknown as LeaderboardData | undefined;
    const row = data?.rows?.find((r) => r.authorId === targetUserId);
    if (!row) return null;
    return {
      name: row.name ?? null,
      stats: {
        total: row.total,
        d7: row.d7,
        d30: row.d30,
        activeDays: row.activeDays,
        consistency: row.consistency,
        channels: row.channels,
        tenureDays: row.tenureDays,
      },
    };
  } catch {
    return null;
  }
}

// Best display name: what the enqueuer stored, else the leaderboard cache, else
// a live Discord lookup, else the raw id.
async function resolveName(
  job: AiReviewJob,
  stats: { name: string | null } | null
): Promise<string> {
  if (job.targetName) return job.targetName;
  if (stats?.name) return stats.name;
  const u = await getUser(job.targetUserId);
  return u?.global_name || u?.username || job.targetUserId;
}

// Batch jobs skip the per-job DM (250 pings would be abuse, not a feature) and
// instead send ONE summary when the last job of the batch settles. "Settles"
// = no pending/running jobs left under this batchId, whatever the mix of
// done/failed/cancelled — including a moderator cancelling the tail.
async function maybeNotifyBatchDone(client: Client, job: AiReviewJob) {
  const batchId = job.batchId;
  if (!batchId) return;
  try {
    const remaining = await prisma.aiReviewJob.count({
      where: { guildId: job.guildId, batchId, status: { in: ["pending", "running"] } },
    });
    if (remaining > 0) return;

    const [byStatus, byRec, crisisCount] = await Promise.all([
      prisma.aiReviewJob.groupBy({
        by: ["status"],
        where: { guildId: job.guildId, batchId },
        _count: { _all: true },
      }),
      prisma.aiReviewJob.groupBy({
        by: ["recommendation"],
        where: { guildId: job.guildId, batchId, status: "done" },
        _count: { _all: true },
      }),
      prisma.aiReviewJob.count({
        where: {
          guildId: job.guildId,
          batchId,
          status: "done",
          verdict: { path: ["crisisFlag"], equals: true },
        },
      }),
    ]);
    const statusCount = (s: string) =>
      byStatus.find((r) => r.status === s)?._count._all ?? 0;
    const done = statusCount("done");
    const failed = statusCount("failed");
    const cancelled = statusCount("cancelled");
    const recParts = byRec
      .filter((r) => r.recommendation)
      .sort((a, b) => b._count._all - a._count._all)
      .map((r) => `${r._count._all} ${labelFor(r.recommendation!)}`)
      .join(", ");

    audit(
      job.guildId,
      "aireview.batch_completed",
      `Review batch finished — ${done} done${recParts ? ` (${recParts})` : ""}, ${failed} failed, ${cancelled} skipped/cancelled${
        crisisCount > 0 ? `, ⚠ ${crisisCount} crisis flag(s)` : ""
      }`,
      { batchId, done, failed, cancelled, crisisCount, requestedBy: job.requestedBy },
      crisisCount > 0 ? "warn" : "ok"
    );

    const base = (process.env.NEXTAUTH_URL ?? "").replace(/\/$/, "");
    const link = base
      ? `${base}/dashboard/${job.guildId}/ai-review`
      : "the portal's AI Reviews page";
    const user = await client.users.fetch(job.requestedBy);
    await user.send(
      `🧭 Your batch of AI fit reviews is finished: **${done} reviewed**${
        recParts ? ` (${recParts})` : ""
      }${failed ? `, ${failed} failed` : ""}${
        cancelled ? `, ${cancelled} skipped/cancelled` : ""
      }.${
        crisisCount > 0
          ? ` ⚠ ${crisisCount} review(s) raised a crisis flag — please look at those first.`
          : ""
      } Browse them at ${link}.`
    );
  } catch (err) {
    console.warn(`[ai-review] batch-done notify for ${batchId} failed:`, err);
  }
}

async function notifyRequester(
  client: Client,
  job: AiReviewJob,
  targetName: string,
  recommendation: string
) {
  try {
    const base = (process.env.NEXTAUTH_URL ?? "").replace(/\/$/, "");
    const link = base
      ? `${base}/dashboard/${job.guildId}/ai-review/${job.id}`
      : "the portal's AI Reviews page";
    const user = await client.users.fetch(job.requestedBy);
    await user.send(
      `🧭 Your AI fit review for ${targetName} is ready — **${labelFor(
        recommendation
      )}**. Read it at ${link}.`
    );
  } catch (err) {
    console.warn(`[ai-review] DM to requester ${job.requestedBy} failed:`, err);
  }
}
