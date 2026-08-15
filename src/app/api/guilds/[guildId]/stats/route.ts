// Cached server-stats blob as JSON, for API/agent callers — same data the
// portal's Stats page renders (ServerStatsData in src/lib/server-stats.ts).
// See API.md.

import { NextResponse } from "next/server";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { normalizeServerStats } from "@/lib/server-stats";

export const GET = withErrors(async (
  _req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  await requireGuildAccess(guildId);

  // Normalized so a cache built by an older compute still matches the
  // documented ServerStatsData shape (missing sections come back empty).
  const cache = await prisma.statsCache.findUnique({ where: { guildId } });
  return NextResponse.json({
    generatedAt: cache?.generatedAt?.toISOString() ?? null,
    computing: cache?.computing ?? false,
    data: cache?.generatedAt ? normalizeServerStats(cache.data) : null,
  });
});
