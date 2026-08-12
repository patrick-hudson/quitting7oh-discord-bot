import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { computeNextFireAt } from "@/lib/cron";

const settingsSchema = z.object({
  timezone: z.string().min(1),
  adminRoleId: z.union([z.string().regex(/^\d{17,21}$/), z.null()]),
  redditEnabled: z.boolean(),
  // Subreddit names without "r/". Reddit allows letters, digits, underscores.
  // All announce into the one redditChannelId; capped to keep polling polite.
  redditSubreddits: z
    .array(z.string().trim().regex(/^[A-Za-z0-9_]{1,21}$/, "Invalid subreddit name"))
    .max(10, "At most 10 subreddits")
    .default([]),
  redditChannelId: z.union([z.string().regex(/^\d{17,21}$/), z.literal(""), z.null()]),
  leaveEnabled: z.boolean(),
  leaveChannelId: z.union([z.string().regex(/^\d{17,21}$/), z.literal(""), z.null()]),
  welcomeDmEnabled: z.boolean(),
  archiveEnabled: z.boolean(),
});

export const PATCH = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  const session = await requireGuildAccess(guildId);

  const input = settingsSchema.parse(await req.json());

  // Dedupe case-insensitively, keeping the first spelling the admin typed.
  const seen = new Set<string>();
  const subreddits = input.redditSubreddits.filter((s) => {
    const key = s.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const redditChannelId = input.redditChannelId || null;
  if (input.redditEnabled && (subreddits.length === 0 || !redditChannelId)) {
    return NextResponse.json(
      { error: "Pick at least one subreddit and a channel to enable Reddit announcements." },
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

  // Prune high-water marks for subreddits that were removed; kept subs keep
  // their mark, newly added ones seed a fresh baseline on the next poll.
  const existing = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { redditLastPostAts: true, redditSubreddit: true, redditLastPostAt: true },
  });
  const oldMarks = existing?.redditLastPostAts;
  const marks: Record<string, string> = {};
  if (oldMarks && typeof oldMarks === "object" && !Array.isArray(oldMarks)) {
    for (const [k, v] of Object.entries(oldMarks)) {
      if (typeof v === "string" && seen.has(k)) marks[k] = v;
    }
  }
  // Legacy single-sub config not yet migrated by the poller: if that sub is
  // being kept, carry its old mark over so nothing is skipped or re-announced.
  const legacyKey = existing?.redditSubreddit?.toLowerCase();
  if (legacyKey && existing?.redditLastPostAt && seen.has(legacyKey) && !marks[legacyKey]) {
    marks[legacyKey] = existing.redditLastPostAt.toISOString();
  }

  const updated = await prisma.guild.update({
    where: { id: guildId },
    data: {
      timezone: input.timezone,
      adminRoleId: input.adminRoleId,
      redditEnabled: input.redditEnabled,
      redditSubreddits: subreddits,
      redditLastPostAts: marks,
      redditChannelId,
      // The new list supersedes any legacy single-sub config — clear it so the
      // poller's lazy migration can't resurrect a removed subreddit.
      redditSubreddit: null,
      redditLastPostAt: null,
      leaveEnabled: input.leaveEnabled,
      leaveChannelId,
      welcomeDmEnabled: input.welcomeDmEnabled,
      archiveEnabled: input.archiveEnabled,
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

  audit(guildId, "config.settings_saved", "Guild settings updated", {
    by: session.user.discordId,
    redditEnabled: input.redditEnabled,
    leaveEnabled: input.leaveEnabled,
    welcomeDmEnabled: input.welcomeDmEnabled,
    archiveEnabled: input.archiveEnabled,
  });
  return NextResponse.json({ guild: updated });
});
