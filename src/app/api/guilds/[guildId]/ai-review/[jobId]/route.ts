// One AI review job in full — including the verdict blob — for API/agent
// callers. The list route (../route.ts GET) deliberately returns summaries
// only; this is the drill-down. See API.md.

import { NextResponse } from "next/server";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";

export const GET = withErrors(async (
  _req: Request,
  ctx: { params: Promise<{ guildId: string; jobId: string }> }
) => {
  const { guildId, jobId } = await ctx.params;
  await requireGuildAccess(guildId);

  const job = await prisma.aiReviewJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      guildId: true,
      batchId: true,
      targetUserId: true,
      targetName: true,
      sinceAt: true,
      untilAt: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      error: true,
      verdict: true,
      recommendation: true,
      model: true,
      source: true,
      messagesAnalyzed: true,
      inputTokens: true,
      outputTokens: true,
      createdAt: true,
    },
  });
  if (!job || job.guildId !== guildId) {
    return NextResponse.json({ error: "Review not found." }, { status: 404 });
  }
  return NextResponse.json({ job });
});
