import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { createRole, deleteRole, listRoles, setRolePositions } from "@/lib/discord-rest";
import { getTheme, hexToInt } from "@/lib/milestone-themes";

const bodySchema = z.object({
  themeId: z.string().min(1),
  // Tier labels the user has on the form right now — used as role names so the
  // labels match. Order matters; aligned 1-to-1 with the theme's color array.
  labels: z.array(z.string().min(1).max(80)).min(1).max(25),
  // If true, replace roleIds for ALL tiers. Otherwise only fill in tiers that
  // don't already have a roleId set.
  replaceAll: z.boolean().default(false),
  // If set, the newly-created roles are positioned directly below this role
  // in the guild's role list (highest milestone closest to the anchor).
  belowRoleId: z
    .string()
    .regex(/^\d{17,21}$/)
    .optional()
    .or(z.literal(""))
    .or(z.null()),
});

// POST — auto-create Discord roles for the milestone tiers using a color theme.
// Replaces (or fills in) the MilestoneTier.roleId values and returns the
// updated tiers so the form can refresh its dropdowns.
export const POST = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  const session = await requireGuildAccess(guildId);

  const { themeId, labels, replaceAll, belowRoleId } = bodySchema.parse(await req.json());
  const theme = getTheme(themeId);
  if (!theme) return NextResponse.json({ error: "Unknown theme" }, { status: 400 });
  if (labels.length > theme.colors.length) {
    return NextResponse.json(
      { error: `Theme "${theme.name}" only has ${theme.colors.length} colors` },
      { status: 400 }
    );
  }

  // Existing tiers in display order. We update these in place; if there are
  // fewer DB rows than labels, the form hasn't saved yet — bail and ask user
  // to save first so the row IDs exist.
  const existing = await prisma.milestoneTier.findMany({
    where: { guildId },
    orderBy: { sortOrder: "asc" },
  });
  if (existing.length !== labels.length) {
    return NextResponse.json(
      { error: "Save the tier list before auto-creating roles (server out of sync)." },
      { status: 400 }
    );
  }

  // Create only the roles we actually need — skip tiers that already have one
  // unless replaceAll is set. Track stats and what got replaced so we can
  // (1) report back to the UI and (2) delete old Discord roles when replacing.
  const createdRoleIds: string[] = [];
  const replacedDiscordRoleIds: string[] = []; // pre-existing IDs that the tier rows are abandoning
  let created = 0;
  let preserved = 0;
  for (let i = 0; i < existing.length; i++) {
    const tier = existing[i];
    if (!replaceAll && tier.roleId) {
      createdRoleIds.push(tier.roleId);
      preserved++;
      continue;
    }
    if (replaceAll && tier.roleId) {
      replacedDiscordRoleIds.push(tier.roleId);
    }
    try {
      const role = await createRole(guildId, {
        name: labels[i],
        color: hexToInt(theme.colors[i]),
        hoist: false,
        mentionable: false,
        unicodeEmoji: existing[i].emoji,
      });
      createdRoleIds.push(role.id);
      created++;
    } catch (err) {
      // Role icons require boost level 2. If the failure was specifically
      // about boosts/role-icons, retry without it so the rest of the flow
      // still works on un-boosted servers. Discord error code 50101 = "This
      // server needs more boosts to perform this action."
      const msg = (err as Error).message;
      const isBoostError =
        msg.includes("unicode_emoji") ||
        msg.includes("ROLE_ICONS") ||
        msg.includes("more boosts") ||
        msg.includes("50101");
      if (isBoostError) {
        try {
          const role = await createRole(guildId, {
            name: labels[i],
            color: hexToInt(theme.colors[i]),
            hoist: false,
            mentionable: false,
          });
          createdRoleIds.push(role.id);
          created++;
          continue;
        } catch (retryErr) {
          return NextResponse.json(
            {
              error: `Failed creating role "${labels[i]}" even without icon: ${(retryErr as Error).message}.`,
            },
            { status: 500 }
          );
        }
      }
      return NextResponse.json(
        {
          error: `Failed creating role "${labels[i]}": ${msg}. ` +
            `Confirm the bot has Manage Roles permission.`,
        },
        { status: 500 }
      );
    }
  }

  // Apply roleIds back to the tier rows.
  await prisma.$transaction(
    existing.map((tier, i) =>
      prisma.milestoneTier.update({
        where: { id: tier.id },
        data: { roleId: createdRoleIds[i] },
      })
    )
  );

  // Always reposition so the milestone group reads top-down by advancement:
  //   ... [optional anchor: e.g. @Moderator] ...
  //   2+ years      ← highest sortOrder, top of milestone group
  //   1 year
  //   ...
  //   24 hours      ← lowest sortOrder, bottom of milestone group
  //   @everyone
  //
  // Anchor selection:
  //   - belowRoleId set      → slot directly under that role
  //   - belowRoleId not set  → use the highest-positioned newly-created role
  //                            as the ceiling, so the milestone group sits
  //                            where Discord put it and just gets internally
  //                            ordered with the most-advanced tier on top.
  try {
    const allRoles = await listRoles(guildId);
    const newRoleMeta = createdRoleIds
      .map((id) => allRoles.find((r) => r.id === id))
      .filter((r): r is NonNullable<typeof r> => Boolean(r));

    let rawCeiling: number;
    if (belowRoleId) {
      const anchor = allRoles.find((r) => r.id === belowRoleId);
      rawCeiling = anchor
        ? anchor.position - 1
        : Math.max(...newRoleMeta.map((r) => r.position));
    } else {
      rawCeiling = Math.max(...newRoleMeta.map((r) => r.position));
    }
    // Make sure the lowest tier doesn't get clamped to 1 colliding with the
    // second-lowest. Need at least `numTiers` headroom above @everyone.
    const ceiling = Math.max(rawCeiling, createdRoleIds.length);

    const positions = createdRoleIds
      .map((id, i) => ({ id, sortOrder: existing[i].sortOrder }))
      .sort((a, b) => b.sortOrder - a.sortOrder) // highest sortOrder first
      .map((row, i) => ({
        id: row.id,
        position: ceiling - i,
      }));
    await setRolePositions(guildId, positions);
  } catch (err) {
    // Don't fail the whole flow if repositioning hits a permissions snag —
    // the roles exist and are linked, the user can drag them by hand.
    console.warn("[milestones] reposition failed:", err);
  }

  // Delete the old Discord roles that we just replaced. Best-effort — if the
  // bot can't delete one (e.g. permissions, or it's above the bot's role),
  // we log and keep going. The new roles are already created and linked.
  let deleted = 0;
  for (const roleId of replacedDiscordRoleIds) {
    try {
      await deleteRole(guildId, roleId);
      deleted++;
    } catch (err) {
      console.warn(`[milestones] could not delete old role ${roleId}:`, err);
    }
  }

  const tiers = await prisma.milestoneTier.findMany({
    where: { guildId },
    orderBy: { sortOrder: "asc" },
  });

  audit(
    guildId,
    "milestone.roles_created",
    `Auto-created milestone roles from theme — ${created} created, ${deleted} deleted`,
    { by: session.user.discordId, created, preserved, deleted },
    "warn"
  );
  return NextResponse.json({
    tiers,
    stats: {
      created,
      preserved,
      deleted,
      replacedButNotDeleted: replacedDiscordRoleIds.length - deleted,
    },
  });
});
