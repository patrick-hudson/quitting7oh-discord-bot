// Cancels a queued or running user-export job. Pending jobs flip straight to
// cancelled; running jobs get cancelRequested=true, which the worker notices
// between scan pages and winds down (usually within a few seconds).

import { NextResponse } from "next/server";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";

export const POST = withErrors(async (
  _req: Request,
  ctx: { params: Promise<{ guildId: string; jobId: string }> }
) => {
  const { guildId, jobId } = await ctx.params;
  await requireGuildAccess(guildId);

  const job = await prisma.userExportJob.findUnique({ where: { id: jobId } });
  if (!job || job.guildId !== guildId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (job.status !== "pending" && job.status !== "running") {
    return NextResponse.json(
      { error: `Job is already ${job.status}.` },
      { status: 409 }
    );
  }

  const updated = await prisma.userExportJob.update({
    where: { id: jobId },
    data: {
      cancelRequested: true,
      // Pending jobs can be finalized immediately — nothing is running.
      ...(job.status === "pending"
        ? { status: "cancelled", finishedAt: new Date() }
        : {}),
    },
  });

  return NextResponse.json({ job: { id: updated.id, status: updated.status } });
});
