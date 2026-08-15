import { NextResponse } from "next/server";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { audit } from "@/lib/audit";
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
      skipMode: input.skipMode,
      skipIfRecentWithin: input.skipIfRecentWithin,
      reminderMinutes: input.reminderMinutes,
      reminderContent: input.reminderContent,
      active: input.active,
      nextFireAt,
      createdBy: session.user.discordId,
    },
  });

  audit(guildId, "post.created", `Created scheduled post "${post.name}"`, {
    postId: post.id,
    active: post.active,
    by: session.user.discordId,
  });
  return NextResponse.json({ post });
});

// GET — every scheduled post, full rows (no blobs on this model). The portal
// pages read the DB directly; this is the API caller's equivalent.
export const GET = withErrors(async (
  _req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  await requireGuildAccess(guildId);
  const posts = await prisma.scheduledPost.findMany({
    where: { guildId },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({ posts });
});
