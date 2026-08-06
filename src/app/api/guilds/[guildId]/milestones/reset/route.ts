// Quietly resets a member's milestone back to zero: removes ONLY the roles
// that belong to this guild's milestone tiers — mod, verified, and any other
// roles are untouched by construction (we only ever remove tier.roleId
// values). No Discord message, DM, or announcement is sent; the action is
// recorded in the bot audit log (and Discord's own audit log carries a
// reason on each role removal).

import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { getGuildMember, removeMemberRole } from "@/lib/discord-rest";
import { audit } from "@/lib/audit";

const bodySchema = z.object({
  userId: z.string().regex(/^\d{17,21}$/, "Invalid Discord user ID"),
  // Optional mod note — stored in the audit row, never sent anywhere.
  note: z.string().max(500).optional().default(""),
});

export const POST = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  const session = await requireGuildAccess(guildId);

  const { userId, note } = bodySchema.parse(await req.json());

  const member = await getGuildMember(guildId, userId);
  if (!member) {
    return NextResponse.json(
      { error: "That user isn't a member of this server." },
      { status: 404 }
    );
  }

  const tiers = await prisma.milestoneTier.findMany({
    where: { guildId, roleId: { not: "" } },
    select: { roleId: true, label: true },
  });
  const tierByRole = new Map(tiers.map((t) => [t.roleId, t.label]));
  const held = member.roles.filter((rid) => tierByRole.has(rid));

  if (held.length === 0) {
    return NextResponse.json({ removed: [] });
  }

  const removed: string[] = [];
  for (const roleId of held) {
    await removeMemberRole(
      guildId,
      userId,
      roleId,
      `Milestone reset via portal by ${session.user.discordId ?? "unknown admin"}`
    );
    removed.push(tierByRole.get(roleId) ?? roleId);
  }

  audit(
    guildId,
    "milestone.reset",
    `Milestone reset for ${userId} — removed ${removed.join(", ")}`,
    {
      userId,
      removedTiers: removed,
      removedRoleIds: held,
      resetBy: session.user.discordId,
      ...(note.trim() ? { note: note.trim() } : {}),
    }
  );

  return NextResponse.json({ removed });
});
