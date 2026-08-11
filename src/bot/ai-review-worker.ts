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
import { getUser } from "@/lib/discord-rest";
import {
  generateReview,
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

async function tick(client: Client) {
  const job = await prisma.aiReviewJob.findFirst({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
  });
  if (!job) return;

  await prisma.aiReviewJob.update({
    where: { id: job.id },
    data: { status: "running", startedAt: new Date() },
  });
  console.log(
    `[ai-review] job ${job.id}: reviewing ${job.targetUserId} in guild ${job.guildId}`
  );

  try {
    const guild = await prisma.guild.findUnique({ where: { id: job.guildId } });
    const systemPrompt = resolveReviewPrompt(guild?.aiReviewPrompt);
    const stats = await loadStats(job.guildId, job.targetUserId);
    const targetName = await resolveName(job, stats);

    const result = await generateReview({
      guildId: job.guildId,
      targetUserId: job.targetUserId,
      targetName,
      sinceAt: job.sinceAt,
      untilAt: job.untilAt,
      channelIds: job.channelIds,
      systemPrompt,
      archiveEnabled: Boolean(guild?.archiveEnabled),
      stats: stats?.stats ?? null,
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
    await notifyRequester(client, job, targetName, result.verdict.recommendation);
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
