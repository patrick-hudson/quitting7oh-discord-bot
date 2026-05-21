import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";

const tierSchema = z.object({
  id: z.string().optional(), // present for existing rows, absent for new ones
  label: z.string().min(1).max(80),
  emoji: z.string().min(1).max(8),
  roleId: z.string().regex(/^\d{17,21}$/, "Invalid role ID").or(z.literal("")),
  sortOrder: z.number().int().min(0).max(99),
  congratsTemplate: z.string().max(2000).optional().or(z.literal("")).or(z.null()),
});

const configSchema = z.object({
  channelId: z
    .string()
    .regex(/^\d{17,21}$/)
    .optional()
    .or(z.literal(""))
    .or(z.null()),
  title: z.string().min(1).max(256),
  description: z.string().min(1).max(2000),
  tiers: z.array(tierSchema).max(25),
  congratsEnabled: z.boolean().default(false),
  congratsChannelId: z
    .string()
    .regex(/^\d{17,21}$/)
    .optional()
    .or(z.literal(""))
    .or(z.null()),
  congratsTemplate: z.string().max(2000).optional().or(z.literal("")).or(z.null()),
  ephemeralTemplate: z.string().max(2000).optional().or(z.literal("")).or(z.null()),
});

// GET — returns current config + tiers for this guild, seeding defaults if none.
export const GET = withErrors(async (
  _req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  await requireGuildAccess(guildId);

  let config = await prisma.milestoneConfig.findUnique({ where: { guildId } });
  if (!config) {
    config = await prisma.milestoneConfig.create({ data: { guildId } });
  }
  const tiers = await prisma.milestoneTier.findMany({
    where: { guildId },
    orderBy: { sortOrder: "asc" },
  });

  return NextResponse.json({ config, tiers });
});

// PATCH — overwrites the config + replaces the tier set.
export const PATCH = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  await requireGuildAccess(guildId);

  const input = configSchema.parse(await req.json());
  const normalizedChannelId =
    input.channelId && input.channelId.length > 0 ? input.channelId : null;
  const normalizedCongratsChannelId =
    input.congratsChannelId && input.congratsChannelId.length > 0
      ? input.congratsChannelId
      : null;
  const normalizedCongratsTemplate =
    input.congratsTemplate && input.congratsTemplate.length > 0
      ? input.congratsTemplate
      : null;
  const normalizedEphemeralTemplate =
    input.ephemeralTemplate && input.ephemeralTemplate.length > 0
      ? input.ephemeralTemplate
      : null;

  const [config] = await prisma.$transaction([
    prisma.milestoneConfig.upsert({
      where: { guildId },
      create: {
        guildId,
        channelId: normalizedChannelId,
        title: input.title,
        description: input.description,
        congratsEnabled: input.congratsEnabled,
        congratsChannelId: normalizedCongratsChannelId,
        congratsTemplate: normalizedCongratsTemplate,
        ephemeralTemplate: normalizedEphemeralTemplate,
      },
      update: {
        channelId: normalizedChannelId,
        title: input.title,
        description: input.description,
        congratsEnabled: input.congratsEnabled,
        congratsChannelId: normalizedCongratsChannelId,
        congratsTemplate: normalizedCongratsTemplate,
        ephemeralTemplate: normalizedEphemeralTemplate,
      },
    }),
    // Replace-all is fine for a small set; keeps the row IDs predictable for
    // the buttons since custom_id encodes the tier id. Existing tiers carry
    // their id forward via upsert; new ones get a fresh cuid.
    prisma.milestoneTier.deleteMany({
      where: {
        guildId,
        NOT: { id: { in: input.tiers.filter((t) => t.id).map((t) => t.id!) } },
      },
    }),
    ...input.tiers.map((t) => {
      const tierCongrats =
        t.congratsTemplate && t.congratsTemplate.length > 0 ? t.congratsTemplate : null;
      return t.id
        ? prisma.milestoneTier.update({
            where: { id: t.id },
            data: {
              label: t.label,
              emoji: t.emoji,
              roleId: t.roleId,
              sortOrder: t.sortOrder,
              congratsTemplate: tierCongrats,
            },
          })
        : prisma.milestoneTier.create({
            data: {
              guildId,
              label: t.label,
              emoji: t.emoji,
              roleId: t.roleId,
              sortOrder: t.sortOrder,
              congratsTemplate: tierCongrats,
            },
          });
    }),
  ]);

  const tiers = await prisma.milestoneTier.findMany({
    where: { guildId },
    orderBy: { sortOrder: "asc" },
  });

  return NextResponse.json({ config, tiers });
});
