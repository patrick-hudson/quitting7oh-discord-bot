// Batch AI contributor-fit reviews: queue one review per recently-active
// member who is still in the server. Selection comes straight from
// MessageEvent (distinct non-bot authors with activity in the last N days),
// NOT the leaderboard cache — the cache only holds the top 250 by total, which
// would miss quieter-but-active members and include long-gone heavy posters.
//
// POST  { activeWithinDays, minMessages, skipReviewedWithinDays, dryRun }
//       dryRun=true returns the would-be counts without creating anything, so
//       the portal can show "this will queue N reviews" before committing.
// DELETE ?batchId=... cancels a batch's still-pending jobs (the in-flight one,
//       if any, finishes — we never kill a review mid-run).
//
// Each queued job reviews the member's FULL history (sinceAt=null): the
// activity window is a selection filter, not a review window — a thin recent
// sample sitting on years of history should still be judged on all of it.

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { listGuildMembers } from "@/lib/discord-rest";
import type { LeaderboardData } from "@/lib/leaderboard";

// Hard ceiling on one batch — a runaway-spend backstop, not a target.
const MAX_BATCH = 500;

const createSchema = z.object({
  // Selection: members with >= minMessages non-bot messages in the last
  // activeWithinDays days, who are still in the server.
  activeWithinDays: z.number().int().min(1).max(365).default(60),
  minMessages: z.number().int().min(1).max(10000).default(10),
  // Skip members who already have a completed review newer than this many
  // days. null/omitted = review everyone selected, even if recently reviewed.
  skipReviewedWithinDays: z.number().int().min(1).max(365).nullable().optional(),
  // Members holding any of these roles are skipped — someone who already has
  // the contributor role (or outranks it) doesn't need a bulk fit review. The
  // portal's role picker (AiReviewBatch.tsx) supplies the ids. Empty = exclude
  // no one by role.
  excludeRoleIds: z
    .array(z.string().regex(/^\d{17,21}$/))
    .max(100)
    .default([]),
  dryRun: z.boolean().default(false),
});

type ActiveAuthor = { authorId: string; recent: number };

export const POST = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  const session = await requireGuildAccess(guildId);
  const requestedBy = session.user.discordId;
  if (!requestedBy) {
    return NextResponse.json(
      { error: "Session has no Discord ID — sign out and back in." },
      { status: 400 }
    );
  }

  const input = createSchema.parse(await req.json());

  // One batch at a time per guild — this is the expensive path.
  const batchInFlight = await prisma.aiReviewJob.count({
    where: {
      guildId,
      batchId: { not: null },
      status: { in: ["pending", "running"] },
    },
  });
  if (batchInFlight > 0) {
    return NextResponse.json(
      { error: "A batch is already in progress for this guild. Cancel it or wait for it to finish." },
      { status: 409 }
    );
  }

  // Distinct authors with enough recent activity, most active first (so the
  // queue works through the biggest bodies of evidence first).
  const active = await prisma.$queryRaw<ActiveAuthor[]>`
    SELECT "authorId" AS "authorId", COUNT(*)::int AS recent
    FROM "MessageEvent"
    WHERE "guildId" = ${guildId}
      AND "isBot" = false
      AND "sentAt" > NOW() - make_interval(days => ${input.activeWithinDays}::int)
    GROUP BY "authorId"
    HAVING COUNT(*) >= ${input.minMessages}
    ORDER BY recent DESC
  `;

  // Still-in-server + role filters, from the live member list. Both are the
  // point of the feature, so a failed fetch is an error, not a silent skip
  // that quietly reviews admins or departed members.
  let memberRoles: Map<string, string[]>;
  try {
    const members = await listGuildMembers(guildId);
    memberRoles = new Map(members.map((m) => [m.user.id, m.roles]));
  } catch {
    return NextResponse.json(
      { error: "Couldn't fetch the server's member list from Discord. Try again in a minute." },
      { status: 502 }
    );
  }
  const excludedRoleIds = new Set(input.excludeRoleIds);
  const stillHere = active.filter((a) => memberRoles.has(a.authorId));
  const departed = active.length - stillHere.length;
  const inServer = stillHere.filter(
    (a) => !memberRoles.get(a.authorId)!.some((rid) => excludedRoleIds.has(rid))
  );
  const excludedByRole = stillHere.length - inServer.length;

  // Optionally drop members who were already reviewed recently.
  let skipRecentIds = new Set<string>();
  if (input.skipReviewedWithinDays) {
    const cutoff = new Date(
      Date.now() - input.skipReviewedWithinDays * 86_400_000
    );
    const recent = await prisma.aiReviewJob.findMany({
      where: {
        guildId,
        status: "done",
        finishedAt: { gte: cutoff },
        targetUserId: { in: inServer.map((a) => a.authorId) },
      },
      select: { targetUserId: true },
      distinct: ["targetUserId"],
    });
    skipRecentIds = new Set(recent.map((r) => r.targetUserId));
  }

  const eligible = inServer.filter((a) => !skipRecentIds.has(a.authorId));
  const capped = eligible.slice(0, MAX_BATCH);
  const counts = {
    matchedActivity: active.length,
    departed,
    excludedByRole,
    alreadyReviewed: skipRecentIds.size,
    overCap: eligible.length - capped.length,
    toQueue: capped.length,
  };

  if (input.dryRun) {
    return NextResponse.json({ dryRun: true, counts });
  }
  if (capped.length === 0) {
    return NextResponse.json(
      { error: "No members match — everyone active in that window has left, holds an excluded role, or was recently reviewed." },
      { status: 400 }
    );
  }

  // Best-effort display names from the leaderboard cache; the worker resolves
  // anything missing at review time.
  const nameById = new Map<string, string>();
  try {
    const cache = await prisma.leaderboardCache.findUnique({
      where: { guildId },
      select: { data: true },
    });
    const rows = (cache?.data as unknown as LeaderboardData | undefined)?.rows ?? [];
    for (const r of rows) if (r.name) nameById.set(r.authorId, r.name);
  } catch {
    // names are cosmetic here
  }

  const batchId = randomUUID();
  await prisma.aiReviewJob.createMany({
    data: capped.map((a) => ({
      guildId,
      batchId,
      targetUserId: a.authorId,
      targetName: nameById.get(a.authorId) ?? null,
      channelIds: [],
      requestedBy,
    })),
  });

  audit(
    guildId,
    "aireview.batch_queued",
    `Queued a batch of ${capped.length} AI fit reviews (active in last ${input.activeWithinDays}d, ≥${input.minMessages} msgs)`,
    { batchId, requestedBy, ...counts, ...input }
  );

  return NextResponse.json({ batchId, counts });
});

export const DELETE = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  const session = await requireGuildAccess(guildId);

  const batchId = new URL(req.url).searchParams.get("batchId");
  if (!batchId) {
    return NextResponse.json({ error: "batchId is required." }, { status: 400 });
  }

  const res = await prisma.aiReviewJob.updateMany({
    where: { guildId, batchId, status: "pending" },
    data: {
      status: "cancelled",
      finishedAt: new Date(),
      error: "Cancelled with the rest of the batch before running.",
    },
  });

  audit(
    guildId,
    "aireview.batch_cancelled",
    `Cancelled a review batch — ${res.count} queued review(s) dropped`,
    { batchId, cancelled: res.count, by: session.user.discordId }
  );

  return NextResponse.json({ cancelled: res.count });
});
