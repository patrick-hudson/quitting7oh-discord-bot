import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { computeNextFireAt } from "@/lib/cron";

const settingsSchema = z.object({
  timezone: z.string().min(1),
  adminRoleId: z.union([z.string().regex(/^\d{17,21}$/), z.null()]),
  redditEnabled: z.boolean(),
  // Subreddit name without "r/". Reddit allows letters, digits, underscores.
  // Empty string from the form normalizes to null (not configured).
  redditSubreddit: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_]{1,21}$/, "Invalid subreddit name")
    .nullable()
    .or(z.literal("").transform(() => null)),
  redditChannelId: z.union([z.string().regex(/^\d{17,21}$/), z.literal(""), z.null()]),
  leaveEnabled: z.boolean(),
  leaveChannelId: z.union([z.string().regex(/^\d{17,21}$/), z.literal(""), z.null()]),
});

export const PATCH = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  await requireGuildAccess(guildId);

  const input = settingsSchema.parse(await req.json());

  const subreddit = input.redditSubreddit || null;
  const redditChannelId = input.redditChannelId || null;
  if (input.redditEnabled && (!subreddit || !redditChannelId)) {
    return NextResponse.json(
      { error: "Pick a subreddit and a channel to enable Reddit announcements." },
      { status: 400 }
    );
  }

  const leaveChannelId = input.leaveChannelId || null;
  if (input.leaveEnabled && !leaveChannelId) {
    return NextResponse.json(
      { error: "Pick a channel to enable departure announcements." },
      { status: 400 }
    );
  }

  // If the watched subreddit changes, reset the high-water mark so the new sub
  // re-seeds its baseline (and doesn't replay old posts against a stale mark).
  const existing = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { redditSubreddit: true },
  });
  const subredditChanged = (existing?.redditSubreddit ?? null) !== subreddit;

  const updated = await prisma.guild.update({
    where: { id: guildId },
    data: {
      timezone: input.timezone,
      adminRoleId: input.adminRoleId,
      redditEnabled: input.redditEnabled,
      redditSubreddit: subreddit,
      redditChannelId,
      leaveEnabled: input.leaveEnabled,
      leaveChannelId,
      ...(subredditChanged ? { redditLastPostAt: null } : {}),
    },
  });

  // Recompute next-fire for any cron posts that inherit guild timezone.
  const postsToRecompute = await prisma.scheduledPost.findMany({
    where: { guildId, cron: { not: null }, timezone: null, active: true },
  });
  for (const p of postsToRecompute) {
    const next = computeNextFireAt({
      cron: p.cron,
      runAt: null,
      timezone: null,
      guildTimezone: updated.timezone,
    });
    await prisma.scheduledPost.update({ where: { id: p.id }, data: { nextFireAt: next } });
  }

  return NextResponse.json({ guild: updated });
});
