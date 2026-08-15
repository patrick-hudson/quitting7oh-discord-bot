// Contributor fit report as JSON — every member ever reviewed, standing by
// their latest completed review. Same DISTINCT ON query the portal's report
// page runs (archived reviews count; failed/cancelled runs don't). See API.md.

import { NextResponse } from "next/server";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";

export const GET = withErrors(async (
  _req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  await requireGuildAccess(guildId);

  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      targetUserId: string;
      targetName: string | null;
      recommendation: string | null;
      confidence: string | null;
      crisisFlag: boolean;
      finishedAt: Date | null;
      messagesAnalyzed: number;
      reviewCount: number;
    }>
  >`
    SELECT DISTINCT ON ("targetUserId")
      id,
      "targetUserId",
      "targetName",
      recommendation,
      verdict->>'confidence' AS confidence,
      COALESCE((verdict->>'crisisFlag')::boolean, false) AS "crisisFlag",
      "finishedAt",
      "messagesAnalyzed",
      COUNT(*) OVER (PARTITION BY "targetUserId")::int AS "reviewCount"
    FROM "AiReviewJob"
    WHERE "guildId" = ${guildId} AND status = 'done'
    ORDER BY "targetUserId", "finishedAt" DESC NULLS LAST
  `;
  return NextResponse.json({
    members: rows.map((r) => ({
      ...r,
      finishedAt: r.finishedAt?.toISOString() ?? null,
    })),
  });
});
