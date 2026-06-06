// Out-of-band "fire this post now" trigger. We don't have IPC to the bot worker,
// so this just flips a flag on the post; the scheduler picks it up on the next
// poll (up to ~SCHEDULER_POLL_SECONDS seconds of lag), fires it through the
// same code path as a regular scheduled fire, and clears the flag.
//
// Does NOT touch cron / runAt / nextFireAt, so the regular schedule is unaffected.

import { NextResponse } from "next/server";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";

export const POST = withErrors(async (
  _req: Request,
  ctx: { params: Promise<{ guildId: string; id: string }> }
) => {
  const { guildId, id } = await ctx.params;
  await requireGuildAccess(guildId);

  const existing = await prisma.scheduledPost.findUnique({ where: { id } });
  if (!existing || existing.guildId !== guildId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const post = await prisma.scheduledPost.update({
    where: { id },
    data: { manualFireRequested: true },
  });
  return NextResponse.json({ post });
});
