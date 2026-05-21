import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { computeNextFireAt } from "@/lib/cron";

const settingsSchema = z.object({
  timezone: z.string().min(1),
  adminRoleId: z.union([z.string().regex(/^\d{17,21}$/), z.null()]),
});

export const PATCH = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  await requireGuildAccess(guildId);

  const input = settingsSchema.parse(await req.json());
  const updated = await prisma.guild.update({
    where: { id: guildId },
    data: { timezone: input.timezone, adminRoleId: input.adminRoleId },
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
