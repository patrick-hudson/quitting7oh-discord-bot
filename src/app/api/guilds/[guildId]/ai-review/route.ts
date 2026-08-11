// AI contributor-fit review jobs. POST queues a review for the bot worker
// (src/bot/ai-review-worker.ts); GET lists recent reviews for the AI Reviews
// page. The verdict blob lives on the row and is read directly by the server
// components — this list endpoint returns only summary fields.

import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";

const createSchema = z
  .object({
    targetUserId: z.string().regex(/^\d{17,21}$/, "Invalid Discord user ID"),
    targetName: z.string().max(120).optional(),
    sinceAt: z.string().datetime().nullable().optional(),
    untilAt: z.string().datetime().nullable().optional(),
    channelIds: z
      .array(z.string().regex(/^\d{17,21}$/))
      .max(100)
      .default([]),
  })
  .superRefine((v, ctx) => {
    if (v.sinceAt && v.untilAt && new Date(v.sinceAt) >= new Date(v.untilAt)) {
      ctx.addIssue({
        code: "custom",
        path: ["untilAt"],
        message: "Until must be after Since",
      });
    }
  });

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

  // One in-flight ad-hoc review per guild — bounds Claude spend and keeps the
  // worker's Discord rate-limit budget sane. Double-clicks 409 instead of
  // double-queuing. Batch jobs don't count: the worker runs an ad-hoc review
  // ahead of any queued batch work, so this stays responsive mid-batch.
  const inFlight = await prisma.aiReviewJob.count({
    where: { guildId, status: { in: ["pending", "running"] }, batchId: null },
  });
  if (inFlight > 0) {
    return NextResponse.json(
      { error: "A review is already queued or running for this guild. Wait for it to finish." },
      { status: 409 }
    );
  }

  const job = await prisma.aiReviewJob.create({
    data: {
      guildId,
      targetUserId: input.targetUserId,
      targetName: input.targetName ?? null,
      sinceAt: input.sinceAt ? new Date(input.sinceAt) : null,
      untilAt: input.untilAt ? new Date(input.untilAt) : null,
      channelIds: input.channelIds,
      requestedBy,
    },
  });

  return NextResponse.json({ job: { id: job.id, status: job.status } });
});

export const GET = withErrors(async (
  _req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  await requireGuildAccess(guildId);

  const jobs = await prisma.aiReviewJob.findMany({
    where: { guildId },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      targetUserId: true,
      targetName: true,
      status: true,
      recommendation: true,
      messagesAnalyzed: true,
      source: true,
      createdAt: true,
      finishedAt: true,
      error: true,
    },
  });
  return NextResponse.json({ jobs });
});
