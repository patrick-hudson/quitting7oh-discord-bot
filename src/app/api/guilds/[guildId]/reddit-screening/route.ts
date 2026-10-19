// Reddit sourcing screen: GET returns the config plus the mod queue; PATCH
// updates the config. Screening itself runs in the bot
// (src/bot/reddit-screen-worker.ts). See REDDIT_SCREENING.md and API.md.

import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

const patchSchema = z.object({
  enabled: z.boolean(),
  subreddits: z
    .array(z.string().trim().regex(/^[A-Za-z0-9_]{1,21}$/, "Invalid subreddit name"))
    .max(10, "At most 10 screened subreddits"),
  alertChannelId: z.string().regex(/^\d{17,21}$/).nullable(),
  notes: z.string().max(4000).nullable(),
  // How far back to screen already-collected items. Applied when the screen
  // is switched on, or whenever applyLookback is set (e.g. to reach further
  // back later — items already screened are never paid for twice).
  lookbackDays: z.number().int().min(0).max(90).default(7),
  applyLookback: z.boolean().default(false),
});

export const GET = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  await requireGuildAccess(guildId);
  const status = new URL(req.url).searchParams.get("status") ?? "open";

  const [guild, users] = await Promise.all([
    prisma.guild.findUnique({
      where: { id: guildId },
      select: {
        redditScreenEnabled: true,
        redditScreenSubreddits: true,
        redditScreenSince: true,
        redditScreenAlertChannelId: true,
        redditScreenNotes: true,
      },
    }),
    prisma.redditScreenUser.findMany({
      where: { guildId, ...(status === "all" ? {} : { status }) },
      orderBy: { lastFlaggedAt: "desc" },
      take: 500,
    }),
  ]);
  return NextResponse.json({ config: guild, users });
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

  const current = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { redditScreenEnabled: true, redditScreenSince: true },
  });
  const turningOn = input.enabled && !current?.redditScreenEnabled;
  const since =
    input.enabled && (turningOn || input.applyLookback || !current?.redditScreenSince)
      ? new Date(Date.now() - input.lookbackDays * 86_400_000)
      : current?.redditScreenSince ?? null;

  const notes = input.notes?.trim() || null;
  await prisma.guild.update({
    where: { id: guildId },
    data: {
      redditScreenEnabled: input.enabled,
      redditScreenSubreddits: subreddits,
      redditScreenAlertChannelId: input.alertChannelId,
      redditScreenNotes: notes,
      redditScreenSince: since,
    },
  });
  audit(
    guildId,
    "redditscreen.config_saved",
    input.enabled
      ? `Sourcing screen on for ${subreddits.map((s) => `r/${s}`).join(", ") || "no subreddits"} (screening since ${since?.toISOString().slice(0, 10)})`
      : "Sourcing screen turned off",
    {
      enabled: input.enabled,
      subreddits,
      alertChannelId: input.alertChannelId,
      since: since?.toISOString() ?? null,
      by: session.user.discordId,
    }
  );
  return NextResponse.json({ ok: true, since: since?.toISOString() ?? null });
});
