// Reddit leaderboard: GET returns the aggregated contributor rows (optionally
// ?subreddit= filtered) plus the monitored-sub config; PATCH updates which
// subreddits are collected. Collection itself runs in the reddit poller —
// shared fetches with announce/firehose, persistence in
// src/lib/reddit-store.ts. See API.md.

import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { computeRedditLeaderboard } from "@/lib/reddit-store";

const patchSchema = z.object({
  subreddits: z
    .array(z.string().trim().regex(/^[A-Za-z0-9_]{1,21}$/, "Invalid subreddit name"))
    .max(10, "At most 10 monitored subreddits"),
});

export const GET = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  await requireGuildAccess(guildId);

  const subreddit = new URL(req.url).searchParams.get("subreddit") ?? undefined;
  const [guild, data] = await Promise.all([
    prisma.guild.findUnique({
      where: { id: guildId },
      select: { redditLeaderboardSubreddits: true },
    }),
    computeRedditLeaderboard(guildId, subreddit),
  ]);
  return NextResponse.json({
    monitored: guild?.redditLeaderboardSubreddits ?? [],
    ...data,
  });
});

export const PATCH = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  const session = await requireGuildAccess(guildId);

  const input = patchSchema.parse(await req.json());
  const seen = new Set<string>();
  const subreddits = input.subreddits.filter((s) => {
    const key = s.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  await prisma.guild.update({
    where: { id: guildId },
    data: { redditLeaderboardSubreddits: subreddits },
  });
  audit(
    guildId,
    "reddit.leaderboard_config_saved",
    subreddits.length > 0
      ? `Reddit leaderboard now monitoring: ${subreddits.map((s) => `r/${s}`).join(", ")}`
      : "Reddit leaderboard monitoring cleared",
    { subreddits, by: session.user.discordId }
  );
  return NextResponse.json({ monitored: subreddits });
});
