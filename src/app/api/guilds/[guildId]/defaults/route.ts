// Per-guild defaults: knobs that affect the bot's auto-generated content when
// a post doesn't override them. Currently just the reminder-template roster.
// Kept off the main settings route because changing a default doesn't need
// the heavier work that route does (e.g. recomputing nextFireAt).

import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";

const templateRoster = z.array(z.string().min(1).max(2000)).max(20).default([]);

const defaultsSchema = z.object({
  // Mirrors the milestone congratsTemplates shape: up to 20 entries, each
  // capped at 2000 chars (Discord's message limit). Empty array = use the
  // bot's baked-in defaults (src/lib/reminder-templates.ts).
  reminderTemplates: templateRoster,
  // Departure-announcement roster; empty = src/lib/leave-templates.ts.
  leaveTemplates: templateRoster,
});

export const PATCH = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  await requireGuildAccess(guildId);

  const input = defaultsSchema.parse(await req.json());
  const guild = await prisma.guild.update({
    where: { id: guildId },
    data: {
      reminderTemplates: input.reminderTemplates,
      leaveTemplates: input.leaveTemplates,
    },
  });

  return NextResponse.json({ guild });
});
