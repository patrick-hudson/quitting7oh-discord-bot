// Archive coverage: per-channel state of the continuous message archive —
// message/media counts, backfill completion, and whether the one-time
// reaction/join backfills have processed each channel. Download the raw
// JSONL via /archive/{channelId}/download. See API.md.

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

  const channels = await prisma.archiveChannelState.findMany({
    where: { guildId },
    orderBy: { channelName: "asc" },
    select: {
      channelId: true,
      channelName: true,
      archivedCount: true,
      mediaCount: true,
      mediaBytes: true,
      backfillComplete: true,
      eventsBackfilledAt: true,
      reactionsBackfilledAt: true,
      joinsBackfilledAt: true,
      updatedAt: true,
    },
  });
  return NextResponse.json({
    channels: channels.map((c) => ({
      ...c,
      mediaBytes: Number(c.mediaBytes), // BigInt → number for JSON
    })),
  });
});
