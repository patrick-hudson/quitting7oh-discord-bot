// One stored snapshot in full: settings, roles, channels with permission
// overwrites, emojis, member role-assignments (GuildSnapshotData). Multi-MB
// for large guilds — fetch deliberately. See API.md.

import { NextResponse } from "next/server";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";

export const GET = withErrors(async (
  _req: Request,
  ctx: { params: Promise<{ guildId: string; snapshotId: string }> }
) => {
  const { guildId, snapshotId } = await ctx.params;
  await requireGuildAccess(guildId);

  const snap = await prisma.guildSnapshot.findUnique({ where: { id: snapshotId } });
  if (!snap || snap.guildId !== guildId) {
    return NextResponse.json({ error: "Snapshot not found." }, { status: 404 });
  }
  return NextResponse.json({
    id: snap.id,
    kind: snap.kind,
    createdAt: snap.createdAt.toISOString(),
    data: snap.data,
  });
});
