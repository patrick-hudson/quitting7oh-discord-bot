// Mod decisions on a sourcing-screen user: mark banned / watching /
// dismissed / reopen, or queue a fresh whole-history assessment. The actual
// ban happens on reddit — the bot's app-only OAuth can't ban, and a human
// should make that call anyway. See REDDIT_SCREENING.md.

import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

const postSchema = z.object({
  action: z.enum(["banned", "watching", "dismissed", "open", "reassess"]),
});

export const POST = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string; username: string }> }
) => {
  const { guildId, username } = await ctx.params;
  const session = await requireGuildAccess(guildId);
  const { action } = postSchema.parse(await req.json());
  const key = decodeURIComponent(username).toLowerCase();

  const user = await prisma.redditScreenUser.findUnique({
    where: { guildId_username: { guildId, username: key } },
  });
  if (!user) {
    return NextResponse.json({ error: "No screened user by that name." }, { status: 404 });
  }

  const updated = await prisma.redditScreenUser.update({
    where: { id: user.id },
    data:
      action === "reassess"
        ? { assessDueAt: new Date(), assessError: null }
        : {
            status: action,
            decidedBy: action === "open" ? null : (session.user.discordId ?? "unknown"),
            decidedAt: action === "open" ? null : new Date(),
          },
  });
  audit(
    guildId,
    "redditscreen.decision",
    action === "reassess"
      ? `Re-assessment queued for u/${user.displayName}`
      : `u/${user.displayName} marked ${action}`,
    { username: key, action, recommendation: user.recommendation, by: session.user.discordId }
  );
  return NextResponse.json({ user: updated });
});
