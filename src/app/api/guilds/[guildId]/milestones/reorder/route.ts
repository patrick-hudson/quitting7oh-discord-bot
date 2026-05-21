import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { listRoles, setRolePositions } from "@/lib/discord-rest";

const bodySchema = z.object({
  belowRoleId: z
    .string()
    .regex(/^\d{17,21}$/)
    .optional()
    .or(z.literal(""))
    .or(z.null()),
});

// POST — repositions the already-linked milestone Discord roles so the role
// list reads top-down: 2+ years → ... → 24 hours. Doesn't touch role membership,
// colors, names, or any non-linked roles in the guild.
export const POST = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  await requireGuildAccess(guildId);

  const { belowRoleId } = bodySchema.parse(await req.json().catch(() => ({})));

  const tiers = await prisma.milestoneTier.findMany({
    where: { guildId },
    orderBy: { sortOrder: "asc" },
  });
  const linked = tiers.filter((t) => t.roleId);
  if (linked.length === 0) {
    return NextResponse.json(
      { error: "No tiers are linked to Discord roles yet — use Create roles in Discord first." },
      { status: 400 }
    );
  }

  const allRoles = await listRoles(guildId);
  const linkedMeta = linked
    .map((t) => allRoles.find((r) => r.id === t.roleId))
    .filter((r): r is NonNullable<typeof r> => Boolean(r));

  if (linkedMeta.length === 0) {
    return NextResponse.json(
      {
        error:
          "None of the linked Discord roles still exist. Re-link or recreate them first.",
      },
      { status: 400 }
    );
  }

  let rawCeiling: number;
  if (belowRoleId) {
    const anchor = allRoles.find((r) => r.id === belowRoleId);
    rawCeiling = anchor
      ? anchor.position - 1
      : Math.max(...linkedMeta.map((r) => r.position));
  } else {
    rawCeiling = Math.max(...linkedMeta.map((r) => r.position));
  }
  // Make sure the lowest tier doesn't get clamped to 1 colliding with the
  // second-lowest. Need at least `numTiers` headroom above @everyone.
  const ceiling = Math.max(rawCeiling, linked.length);

  // Highest sortOrder closest to anchor (top of milestone group).
  const positions = linked
    .map((t) => ({ id: t.roleId, sortOrder: t.sortOrder }))
    .sort((a, b) => b.sortOrder - a.sortOrder)
    .map((row, i) => ({
      id: row.id,
      position: ceiling - i,
    }));

  // Build a human-readable summary so the UI can prove the call ran and
  // ordered things correctly, even if Discord's cache hasn't refreshed yet.
  const summary = linked
    .map((t) => {
      const target = positions.find((p) => p.id === t.roleId)?.position;
      return `${t.label} → pos ${target}`;
    })
    .join(", ");

  console.log(`[milestones reorder] guild=${guildId} ceiling=${ceiling} ${summary}`);

  await setRolePositions(guildId, positions);

  return NextResponse.json({
    ok: true,
    repositioned: positions.length,
    summary,
  });
});
