// Manual "snapshot now" — enqueues a SnapshotJob the bot's snapshot worker
// processes with live per-step progress. GET returns recent jobs for the
// portal's progress poller.

import { NextResponse } from "next/server";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";

export const POST = withErrors(async (
  _req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  const session = await requireGuildAccess(guildId);

  const inFlight = await prisma.snapshotJob.count({
    where: { guildId, status: { in: ["pending", "running"] } },
  });
  if (inFlight > 0) {
    return NextResponse.json(
      { error: "A snapshot is already running — watch its progress below." },
      { status: 409 }
    );
  }

  const job = await prisma.snapshotJob.create({
    data: { guildId, kind: "manual", requestedBy: session.user.discordId },
  });
  return NextResponse.json({ jobId: job.id });
});

export const GET = withErrors(async (
  _req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  await requireGuildAccess(guildId);

  const jobs = await prisma.snapshotJob.findMany({
    where: { guildId },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: {
      id: true,
      kind: true,
      status: true,
      steps: true,
      snapshotId: true,
      error: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
    },
  });
  return NextResponse.json({ jobs });
});
