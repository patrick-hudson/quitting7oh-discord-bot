// Identity links between reddit contributors and Discord members, set by a
// mod on the Reddit leaderboard page. platform=reddit AI reviews use them to
// pull the linked member's Discord history in as additional evidence. Always
// manual — a wrong link attributes someone else's words. See API.md.

import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

const putSchema = z.object({
  redditUsername: z.string().trim().regex(/^[A-Za-z0-9_-]{3,20}$/, "Invalid reddit username"),
  discordUserId: z.string().regex(/^\d{17,21}$/, "Invalid Discord user ID"),
});

export const PUT = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  const session = await requireGuildAccess(guildId);
  const input = putSchema.parse(await req.json());
  const key = input.redditUsername.toLowerCase();

  const link = await prisma.redditIdentityLink.upsert({
    where: { guildId_redditUsername: { guildId, redditUsername: key } },
    create: {
      guildId,
      redditUsername: key,
      discordUserId: input.discordUserId,
      createdBy: session.user.discordId ?? "unknown",
    },
    update: { discordUserId: input.discordUserId },
  });
  audit(
    guildId,
    "reddit.identity_linked",
    `u/${input.redditUsername} linked to Discord member ${input.discordUserId}`,
    { redditUsername: key, discordUserId: input.discordUserId, by: session.user.discordId }
  );
  return NextResponse.json({ link });
});

export const DELETE = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  const session = await requireGuildAccess(guildId);
  const username = new URL(req.url).searchParams.get("redditUsername")?.toLowerCase();
  if (!username) {
    return NextResponse.json({ error: "redditUsername is required." }, { status: 400 });
  }
  await prisma.redditIdentityLink.deleteMany({
    where: { guildId, redditUsername: username },
  });
  audit(guildId, "reddit.identity_unlinked", `u/${username} unlinked`, {
    redditUsername: username,
    by: session.user.discordId,
  });
  return NextResponse.json({ ok: true });
});
