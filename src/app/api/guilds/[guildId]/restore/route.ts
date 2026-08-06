// Restore-assist jobs. POST queues one for the bot worker; GET lists recent
// jobs with their progress logs for the restore page's status poller.

import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

const createSchema = z.object({
  snapshotId: z.string().min(1),
  options: z.object({
    createRoles: z.boolean(),
    createChannels: z.boolean(),
    reapplyMemberRoles: z.boolean(),
  }),
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
  if (
    !input.options.createRoles &&
    !input.options.createChannels &&
    !input.options.reapplyMemberRoles
  ) {
    return NextResponse.json(
      { error: "Pick at least one thing to restore." },
      { status: 400 }
    );
  }

  const snapshot = await prisma.guildSnapshot.findUnique({
    where: { id: input.snapshotId },
    select: { guildId: true },
  });
  if (!snapshot || snapshot.guildId !== guildId) {
    return NextResponse.json({ error: "Snapshot not found" }, { status: 404 });
  }

  const inFlight = await prisma.restoreJob.count({
    where: { guildId, status: { in: ["pending", "running"] } },
  });
  if (inFlight > 0) {
    return NextResponse.json(
      { error: "A restore is already queued or running." },
      { status: 409 }
    );
  }

  const job = await prisma.restoreJob.create({
    data: {
      guildId,
      snapshotId: input.snapshotId,
      options: input.options,
      requestedBy,
    },
  });
  audit(guildId, "restore.queued", "Restore-assist job queued", {
    jobId: job.id,
    snapshotId: input.snapshotId,
    options: input.options,
    requestedBy,
  });

  return NextResponse.json({ job: { id: job.id, status: job.status } });
});

export const GET = withErrors(async (
  _req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  await requireGuildAccess(guildId);

  const jobs = await prisma.restoreJob.findMany({
    where: { guildId },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  return NextResponse.json({ jobs });
});
