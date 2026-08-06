// User-message export jobs. POST queues a job for the bot worker
// (src/bot/user-export-worker.ts); GET lists recent jobs for the export page.
// The zip itself is served by the sibling download route — the list query
// deliberately never selects the blob column.

import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";

const createSchema = z
  .object({
    targetUserId: z.string().regex(/^\d{17,21}$/, "Invalid Discord user ID"),
    sinceAt: z.string().datetime().nullable().optional(),
    untilAt: z.string().datetime().nullable().optional(),
    channelIds: z
      .array(z.string().regex(/^\d{17,21}$/))
      .max(100)
      .default([]),
    includeMedia: z.boolean().default(false),
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

  // One in-flight job per guild keeps the worker's rate-limit budget sane and
  // prevents accidental double-clicks from queueing duplicate grinds.
  const inFlight = await prisma.userExportJob.count({
    where: { guildId, status: { in: ["pending", "running"] } },
  });
  if (inFlight > 0) {
    return NextResponse.json(
      { error: "An export is already queued or running for this guild. Wait for it to finish." },
      { status: 409 }
    );
  }

  const job = await prisma.userExportJob.create({
    data: {
      guildId,
      targetUserId: input.targetUserId,
      sinceAt: input.sinceAt ? new Date(input.sinceAt) : null,
      untilAt: input.untilAt ? new Date(input.untilAt) : null,
      channelIds: input.channelIds,
      includeMedia: input.includeMedia,
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

  const jobs = await prisma.userExportJob.findMany({
    where: { guildId },
    orderBy: { createdAt: "desc" },
    take: 20,
    // No `output` — job blobs can be MBs each.
    select: {
      id: true,
      targetUserId: true,
      sinceAt: true,
      untilAt: true,
      channelIds: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      error: true,
      matchedCount: true,
      scannedCount: true,
      fileName: true,
      requestedBy: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ jobs });
});
