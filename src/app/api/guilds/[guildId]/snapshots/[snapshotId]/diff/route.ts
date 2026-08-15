// Structural diff between two snapshots — what changed in settings, roles,
// channels, overwrites, emojis, and membership. ?against=<olderSnapshotId>;
// omitted = the snapshot immediately before this one. Same diff the portal's
// Snapshots page renders. See API.md.

import { NextResponse } from "next/server";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { diffSnapshots } from "@/lib/snapshot-diff";
import type { GuildSnapshotData } from "@/lib/guild-snapshot";

export const GET = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string; snapshotId: string }> }
) => {
  const { guildId, snapshotId } = await ctx.params;
  await requireGuildAccess(guildId);

  const newer = await prisma.guildSnapshot.findUnique({ where: { id: snapshotId } });
  if (!newer || newer.guildId !== guildId) {
    return NextResponse.json({ error: "Snapshot not found." }, { status: 404 });
  }

  const againstId = new URL(req.url).searchParams.get("against");
  const older = againstId
    ? await prisma.guildSnapshot.findUnique({ where: { id: againstId } })
    : await prisma.guildSnapshot.findFirst({
        where: { guildId, createdAt: { lt: newer.createdAt } },
        orderBy: { createdAt: "desc" },
      });
  if (!older || older.guildId !== guildId) {
    return NextResponse.json(
      { error: "No older snapshot to diff against." },
      { status: 404 }
    );
  }

  const diff = diffSnapshots(
    older.data as unknown as GuildSnapshotData,
    newer.data as unknown as GuildSnapshotData
  );
  return NextResponse.json({
    older: { id: older.id, createdAt: older.createdAt.toISOString() },
    newer: { id: newer.id, createdAt: newer.createdAt.toISOString() },
    diff,
  });
});
