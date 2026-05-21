import { prisma } from "@/lib/db";
import { listRoles, listTextChannels } from "@/lib/discord-rest";
import { THEMES } from "@/lib/milestone-themes";
import { MilestoneForm } from "@/components/MilestoneForm";

const DEFAULT_TIERS = [
  {
    label: "24 hours",
    emoji: "⏰",
    congratsTemplate:
      "{emoji} {user} just made it through day one — the hardest day. We see you. Keep showing up.",
  },
  {
    label: "3 days",
    emoji: "💪",
    congratsTemplate:
      "{emoji} {user} hit **3 days**. Three of the hardest mornings in a row — your brain is healing right now. Don't stop now.",
  },
  {
    label: "1 week",
    emoji: "🌤️",
    congratsTemplate:
      "{emoji} {user} crossed **1 WEEK** clean. Seven days of choosing yourself when every part of you wanted to quit choosing. The fog is starting to lift — keep going.",
  },
  {
    label: "2 weeks",
    emoji: "🌈",
    congratsTemplate:
      "{emoji} {user} hit **2 WEEKS**. The acute fight is winding down and you're still standing. That's everything. You're doing this.",
  },
  {
    label: "30 days",
    emoji: "🌱",
    congratsTemplate:
      "{emoji} {user} hit **30 days**. A full month of choosing yourself, every day. Proud of you.",
  },
  {
    label: "60 days",
    emoji: "🌿",
    congratsTemplate:
      "{emoji} {user} just crossed **60 days**. Two months in, and the roots are taking hold.",
  },
  {
    label: "90 days",
    emoji: "🌳",
    congratsTemplate:
      "{emoji} {user} reached **90 days** — a quarter year clean. That's real, durable progress.",
  },
  {
    label: "6 months",
    emoji: "💎",
    congratsTemplate:
      "{emoji} {user} hit **6 MONTHS**. Half a year of discipline showing up. Massive respect.",
  },
  {
    label: "1 year",
    emoji: "🏆",
    congratsTemplate:
      "{emoji} {user} just crossed **1 YEAR**. 365 days of choosing recovery — you're an inspiration to this whole community.",
  },
  {
    label: "2+ years",
    emoji: "👑",
    congratsTemplate:
      "{emoji} {user} crossed **2+ YEARS**. Living proof this works. Thank you for being here and showing the way.",
  },
];

const DEFAULT_CONGRATS_TEMPLATE =
  "{emoji} Big congrats to {user} on reaching **{tier}** — proud of you. Keep going.\nClaim yours in {claimChannel}.";

const DEFAULT_EPHEMERAL_TEMPLATE =
  "{emoji} You've claimed **{tier}** — every day you showed up to earn this matters. We're proud of you. Keep going.";

export default async function MilestonesPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;
  const guild = await prisma.guild.findUnique({ where: { id: guildId } });
  if (!guild) return null;

  // Seed config if it doesn't exist yet so the form has stable data to bind to.
  let config = await prisma.milestoneConfig.findUnique({ where: { guildId } });
  if (!config) {
    config = await prisma.milestoneConfig.create({ data: { guildId } });
  }

  const tiers = await prisma.milestoneTier.findMany({
    where: { guildId },
    orderBy: { sortOrder: "asc" },
  });

  const [channels, roles] = await Promise.all([
    listTextChannels(guildId).catch(() => []),
    listRoles(guildId).catch(() => []),
  ]);

  // Suggest defaults if the guild has no tiers yet. They're not saved until
  // the user hits "Save" — just pre-fills the form.
  const initialTiers =
    tiers.length > 0
      ? tiers.map((t) => ({
          id: t.id,
          label: t.label,
          emoji: t.emoji,
          roleId: t.roleId,
          sortOrder: t.sortOrder,
          congratsTemplate: t.congratsTemplate ?? "",
        }))
      : DEFAULT_TIERS.map((d, i) => ({
          label: d.label,
          emoji: d.emoji,
          roleId: "",
          sortOrder: i,
          congratsTemplate: d.congratsTemplate,
        }));

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Milestone roles</h1>
      <p className="mt-1 text-sm text-white/60">
        Publish a single message with buttons so members can self-claim a milestone role.
        Clicking a button replaces any earlier milestone role they hold.
      </p>
      <p className="mt-3 text-xs text-white/40">
        The bot needs <strong>Manage Roles</strong> permission, and its own role must sit
        above every milestone role in this guild&apos;s role list.
      </p>

      <div className="mt-8">
        <MilestoneForm
          guildId={guildId}
          initial={{
            channelId: config.channelId ?? "",
            title: config.title,
            description: config.description,
            tiers: initialTiers,
            messageId: config.messageId,
            congratsEnabled: config.congratsEnabled,
            congratsChannelId: config.congratsChannelId ?? "",
            congratsTemplate: config.congratsTemplate ?? DEFAULT_CONGRATS_TEMPLATE,
            ephemeralTemplate: config.ephemeralTemplate ?? DEFAULT_EPHEMERAL_TEMPLATE,
          }}
          channels={channels.map((c) => ({ id: c.id, name: c.name }))}
          roles={roles.map((r) => ({ id: r.id, name: r.name, color: r.color }))}
          themes={THEMES}
        />
      </div>
    </div>
  );
}
