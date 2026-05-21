import { NextResponse } from "next/server";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { computeNextFireAt } from "@/lib/cron";

export const POST = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string; id: string }> }
) => {
  const { guildId, id } = await ctx.params;
  await requireGuildAccess(guildId);

  const body = (await req.json()) as { active?: boolean };
  const active = typeof body.active === "boolean" ? body.active : undefined;

  const existing = await prisma.scheduledPost.findUnique({ where: { id } });
  if (!existing || existing.guildId !== guildId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const guild = await prisma.guild.findUnique({ where: { id: guildId } });
  if (!guild) return NextResponse.json({ error: "Guild not found" }, { status: 404 });

  const nextActive = active ?? !existing.active;

  // When reactivating, recompute nextFireAt so it doesn't fire immediately
  // because of an old past timestamp.
  const nextFireAt = nextActive
    ? computeNextFireAt({
        cron: existing.cron,
        runAt: existing.runAt,
        timezone: existing.timezone,
        guildTimezone: guild.timezone,
      })
    : null;

  const post = await prisma.scheduledPost.update({
    where: { id },
    data: { active: nextActive, nextFireAt },
  });
  return NextResponse.json({ post });
});
