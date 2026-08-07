// Exports the bot's own configuration for this guild as portable JSON:
// guild settings + template rosters, scheduled posts, and milestone
// config/tiers. Pairs with config-import for disaster recovery or cloning
// onto a test server. Excludes operational state (fire times, audit logs,
// message events) and anything member-generated.

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

  const [guild, posts, milestoneConfig, tiers] = await Promise.all([
    prisma.guild.findUnique({ where: { id: guildId } }),
    prisma.scheduledPost.findMany({ where: { guildId }, orderBy: { name: "asc" } }),
    prisma.milestoneConfig.findUnique({ where: { guildId } }),
    prisma.milestoneTier.findMany({ where: { guildId }, orderBy: { sortOrder: "asc" } }),
  ]);
  if (!guild) return NextResponse.json({ error: "Guild not found" }, { status: 404 });

  const payload = {
    version: 1 as const,
    exportedAt: new Date().toISOString(),
    guildId,
    guildName: guild.name,
    settings: {
      timezone: guild.timezone,
      // adminRoleId included for reference; import deliberately ignores it
      // (importing a wrong value could lock every admin out of the portal).
      adminRoleId: guild.adminRoleId,
      redditEnabled: guild.redditEnabled,
      redditSubreddit: guild.redditSubreddit,
      redditChannelId: guild.redditChannelId,
      leaveEnabled: guild.leaveEnabled,
      leaveChannelId: guild.leaveChannelId,
      leaveTemplates: guild.leaveTemplates,
      welcomeDmEnabled: guild.welcomeDmEnabled,
      welcomeDmTemplates: guild.welcomeDmTemplates,
      reminderTemplates: guild.reminderTemplates,
      archiveEnabled: guild.archiveEnabled,
    },
    posts: posts.map((p) => ({
      name: p.name,
      channelIds: p.channelIds,
      cron: p.cron,
      runAt: p.runAt?.toISOString() ?? null,
      timezone: p.timezone,
      useEmbed: p.useEmbed,
      content: p.content,
      embedTitle: p.embedTitle,
      embedColor: p.embedColor,
      embedUrl: p.embedUrl,
      embedImage: p.embedImage,
      mentionRoleId: p.mentionRoleId,
      leadMinutes: p.leadMinutes,
      skipMode: p.skipMode,
      skipIfRecentWithin: p.skipIfRecentWithin,
      reminderMinutes: p.reminderMinutes,
      reminderContent: p.reminderContent,
      active: p.active,
    })),
    milestones: milestoneConfig
      ? {
          channelId: milestoneConfig.channelId,
          title: milestoneConfig.title,
          description: milestoneConfig.description,
          congratsEnabled: milestoneConfig.congratsEnabled,
          congratsChannelId: milestoneConfig.congratsChannelId,
          congratsTemplates: milestoneConfig.congratsTemplates,
          ephemeralTemplates: milestoneConfig.ephemeralTemplates,
          tiers: tiers.map((t) => ({
            label: t.label,
            emoji: t.emoji,
            roleId: t.roleId,
            sortOrder: t.sortOrder,
            congratsTemplates: t.congratsTemplates,
          })),
        }
      : null,
  };

  const fileName = `bot-config-${guildId}-${new Date().toISOString().split("T")[0]}.json`;
  return new NextResponse(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
});
