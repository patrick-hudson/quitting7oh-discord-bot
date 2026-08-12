// Imports a config-export JSON. Section-selective and deliberately cautious:
//   - settings: overwrites guild settings/rosters, but NEVER adminRoleId
//     (a bad value would lock every admin out of the portal).
//   - posts: CREATES all posts as inactive — the admin reviews and enables
//     each one, so an import can't start firing messages by surprise.
//   - milestones: replaces config + tiers, but keeps the current published
//     messageId so the existing claim message keeps working until republished.

import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

const snowflake = z.string().regex(/^\d{17,21}$/);
const roster = z.array(z.string().min(1).max(2000)).max(20);

const configSchema = z.object({
  version: z.literal(1),
  settings: z
    .object({
      timezone: z.string().min(1),
      redditEnabled: z.boolean(),
      // Current exports carry a list; older export files carry the single
      // redditSubreddit — accept both and merge on import.
      redditSubreddits: z.array(z.string().min(1).max(21)).max(10).optional(),
      redditSubreddit: z.string().nullable().optional(),
      redditChannelId: snowflake.nullable(),
      leaveEnabled: z.boolean(),
      leaveChannelId: snowflake.nullable(),
      leaveTemplates: roster,
      welcomeDmEnabled: z.boolean(),
      welcomeDmTemplates: roster,
      reminderTemplates: roster,
    })
    .passthrough(),
  posts: z.array(
    z.object({
      name: z.string().min(1).max(120),
      channelIds: z.array(snowflake).max(25),
      cron: z.string().nullable(),
      runAt: z.string().nullable(),
      timezone: z.string().nullable(),
      useEmbed: z.boolean(),
      content: z.string().min(1).max(4000),
      embedTitle: z.string().nullable(),
      embedColor: z.string().nullable(),
      embedUrl: z.string().nullable(),
      embedImage: z.string().nullable(),
      mentionRoleId: snowflake.nullable(),
      leadMinutes: z.number().int().min(0).max(1440),
      skipMode: z.enum(["off", "recent", "auto"]).optional(),
      skipIfRecentWithin: z.number().int().min(1).max(100).nullable().optional(),
      reminderMinutes: z.number().int().min(1).max(1439).nullable(),
      reminderContent: z.string().nullable(),
      active: z.boolean(),
    })
  ),
  milestones: z
    .object({
      channelId: snowflake.nullable(),
      title: z.string().min(1).max(256),
      description: z.string().min(1).max(2000),
      congratsEnabled: z.boolean(),
      congratsChannelId: snowflake.nullable(),
      congratsTemplates: roster,
      ephemeralTemplates: roster,
      tiers: z.array(
        z.object({
          label: z.string().min(1).max(80),
          emoji: z.string().min(1).max(8),
          roleId: snowflake.or(z.literal("")),
          sortOrder: z.number().int().min(0).max(99),
          congratsTemplates: roster,
        })
      ),
    })
    .nullable(),
});

const bodySchema = z.object({
  config: configSchema,
  sections: z.object({
    settings: z.boolean().default(false),
    posts: z.boolean().default(false),
    milestones: z.boolean().default(false),
  }),
});

export const POST = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  const session = await requireGuildAccess(guildId);

  const { config, sections } = bodySchema.parse(await req.json());
  const summary: string[] = [];

  if (sections.settings) {
    const s = config.settings;
    // New exports carry redditSubreddits; legacy files only redditSubreddit.
    const subreddits =
      s.redditSubreddits && s.redditSubreddits.length > 0
        ? s.redditSubreddits
        : s.redditSubreddit
          ? [s.redditSubreddit]
          : [];
    await prisma.guild.update({
      where: { id: guildId },
      data: {
        timezone: s.timezone,
        redditEnabled: s.redditEnabled,
        redditSubreddits: subreddits,
        // Fresh marks: imported subs re-seed their baselines on the next poll
        // (announcing nothing) rather than replaying against stale marks.
        redditLastPostAts: {},
        redditSubreddit: null,
        redditLastPostAt: null,
        redditChannelId: s.redditChannelId,
        leaveEnabled: s.leaveEnabled,
        leaveChannelId: s.leaveChannelId,
        leaveTemplates: s.leaveTemplates,
        welcomeDmEnabled: s.welcomeDmEnabled,
        welcomeDmTemplates: s.welcomeDmTemplates,
        reminderTemplates: s.reminderTemplates,
      },
    });
    summary.push("settings");
  }

  if (sections.posts && config.posts.length > 0) {
    await prisma.scheduledPost.createMany({
      data: config.posts.map((p) => ({
        guildId,
        name: p.name,
        channelIds: p.channelIds,
        cron: p.cron,
        runAt: p.runAt ? new Date(p.runAt) : null,
        timezone: p.timezone,
        useEmbed: p.useEmbed,
        content: p.content,
        embedTitle: p.embedTitle,
        embedColor: p.embedColor,
        embedUrl: p.embedUrl,
        embedImage: p.embedImage,
        mentionRoleId: p.mentionRoleId,
        leadMinutes: p.leadMinutes,
        skipMode: p.skipMode ?? "off",
        skipIfRecentWithin: p.skipIfRecentWithin ?? null,
        reminderMinutes: p.reminderMinutes,
        reminderContent: p.reminderContent,
        // Imported inactive regardless of source state; the active toggle
        // recomputes nextFireAt when the admin enables each post.
        active: false,
        nextFireAt: null,
        createdBy: session.user.discordId,
      })),
    });
    summary.push(`${config.posts.length} post(s) (inactive)`);
  }

  if (sections.milestones && config.milestones) {
    const m = config.milestones;
    await prisma.$transaction([
      prisma.milestoneConfig.upsert({
        where: { guildId },
        create: {
          guildId,
          channelId: m.channelId,
          title: m.title,
          description: m.description,
          congratsEnabled: m.congratsEnabled,
          congratsChannelId: m.congratsChannelId,
          congratsTemplates: m.congratsTemplates,
          ephemeralTemplates: m.ephemeralTemplates,
        },
        update: {
          channelId: m.channelId,
          title: m.title,
          description: m.description,
          congratsEnabled: m.congratsEnabled,
          congratsChannelId: m.congratsChannelId,
          congratsTemplates: m.congratsTemplates,
          ephemeralTemplates: m.ephemeralTemplates,
        },
      }),
      prisma.milestoneTier.deleteMany({ where: { guildId } }),
      prisma.milestoneTier.createMany({
        data: m.tiers.map((t) => ({
          guildId,
          label: t.label,
          emoji: t.emoji,
          roleId: t.roleId,
          sortOrder: t.sortOrder,
          congratsTemplates: t.congratsTemplates,
        })),
      }),
    ]);
    summary.push(`milestones (${m.tiers.length} tier(s))`);
  }

  audit(
    guildId,
    "config.imported",
    `Config import: ${summary.length > 0 ? summary.join(", ") : "nothing selected"}`,
    { sections, importedBy: session.user.discordId }
  );

  return NextResponse.json({ imported: summary });
});
