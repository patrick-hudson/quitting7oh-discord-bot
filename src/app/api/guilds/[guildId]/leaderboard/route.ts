// Cached leaderboard data as JSON, for API/agent callers — the portal page
// reads the same cache directly as a server component. See API.md.

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

  const cache = await prisma.leaderboardCache.findUnique({ where: { guildId } });
  return NextResponse.json({
    generatedAt: cache?.generatedAt?.toISOString() ?? null,
    computing: cache?.computing ?? false,
    data: cache?.generatedAt ? cache.data : null,
  });
});
