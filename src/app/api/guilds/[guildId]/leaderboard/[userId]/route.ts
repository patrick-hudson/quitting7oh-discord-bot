// Per-user channel breakdown for the leaderboard drill-down: how many
// messages this member posted in each channel, most recent first. Lazy-loaded
// when a row is expanded so the main table stays a single aggregate query.

import { NextResponse } from "next/server";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";

export const GET = withErrors(async (
  _req: Request,
  ctx: { params: Promise<{ guildId: string; userId: string }> }
) => {
  const { guildId, userId } = await ctx.params;
  await requireGuildAccess(guildId);

  const grouped = await prisma.messageEvent.groupBy({
    by: ["channelId"],
    where: { guildId, authorId: userId, isBot: false },
    _count: { _all: true },
    _max: { sentAt: true },
  });

  const channels = grouped
    .map((g) => ({
      channelId: g.channelId,
      count: g._count._all,
      lastSeen: g._max.sentAt?.toISOString() ?? null,
    }))
    .sort((a, b) => b.count - a.count);

  return NextResponse.json({ channels });
});
