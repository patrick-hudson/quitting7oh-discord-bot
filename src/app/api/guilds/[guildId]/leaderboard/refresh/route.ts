// POST: request an immediate leaderboard recompute (the worker picks up the
// flag on its next poll, ~within a minute). GET: current cache status, for the
// Refresh button to poll and reload when a fresh result lands.

import { NextResponse } from "next/server";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

export const POST = withErrors(async (
  _req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  const session = await requireGuildAccess(guildId);

  await prisma.leaderboardCache.upsert({
    where: { guildId },
    create: { guildId, refreshRequested: true },
    update: { refreshRequested: true },
  });
  audit(guildId, "leaderboard.refresh_requested", "Leaderboard refresh requested", {
    by: session.user.discordId,
  });
  return NextResponse.json({ ok: true });
});

export const GET = withErrors(async (
  _req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  await requireGuildAccess(guildId);

  const cache = await prisma.leaderboardCache.findUnique({
    where: { guildId },
    select: { generatedAt: true, computing: true, refreshRequested: true },
  });
  return NextResponse.json({
    generatedAt: cache?.generatedAt?.toISOString() ?? null,
    computing: cache?.computing ?? false,
    refreshRequested: cache?.refreshRequested ?? false,
  });
});
