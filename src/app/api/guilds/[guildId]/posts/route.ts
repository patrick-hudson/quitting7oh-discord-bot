import { NextResponse } from "next/server";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { postSchema } from "@/lib/post-schema";
import { computeNextFireAt, isValidCron } from "@/lib/cron";

export const POST = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  const session = await requireGuildAccess(guildId);

  const guild = await prisma.guild.findUnique({ where: { id: guildId } });
  if (!guild) return NextResponse.json({ error: "Guild not found" }, { status: 404 });

  const input = postSchema.parse(await req.json());

  if (input.scheduleKind === "cron" && !isValidCron(input.cron)) {
    return NextResponse.json({ error: "Invalid cron expression" }, { status: 400 });
  }

  const cron = input.scheduleKind === "cron" ? input.cron : null;
  const runAt = input.scheduleKind === "oneoff" && input.runAt ? new Date(input.runAt) : null;
  if (runAt && Number.isNaN(runAt.getTime())) {
    return NextResponse.json({ error: "Invalid runAt" }, { status: 400 });
  }

  const nextFireAt = computeNextFireAt({
    cron,
    runAt,
    timezone: input.timezone,
    guildTimezone: guild.timezone,
  });

  const post = await prisma.scheduledPost.create({
    data: {
      guildId,
      name: input.name,
      channelIds: input.channelIds,
      cron,
      runAt,
      timezone: input.timezone || null,
      useEmbed: input.useEmbed,
      content: input.content,
      embedTitle: input.embedTitle || null,
      embedColor: input.embedColor || null,
      embedUrl: input.embedUrl || null,
      embedImage: input.embedImage || null,
      mentionRoleId: input.mentionRoleId || null,
      leadMinutes: input.leadMinutes,
      skipIfRecentWithin: input.skipIfRecentWithin,
      reminderMinutes: input.reminderMinutes,
      reminderContent: input.reminderContent,
      active: input.active,
      nextFireAt,
      createdBy: session.user.discordId,
    },
  });

  return NextResponse.json({ post });
});
