import { prisma } from "@/lib/db";
import { listRoles, listTextChannels } from "@/lib/discord-rest";
import { THEMES } from "@/lib/milestone-themes";
import { MilestoneForm } from "@/components/MilestoneForm";

const DEFAULT_TIERS = [
  { label: "24 hours", emoji: "⏰" },
  { label: "30 days", emoji: "🌱" },
  { label: "60 days", emoji: "🌿" },
  { label: "90 days", emoji: "🌳" },
  { label: "6 months", emoji: "💎" },
  { label: "1 year", emoji: "🏆" },
  { label: "2+ years", emoji: "👑" },
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
        }))
      : DEFAULT_TIERS.map((d, i) => ({
          label: d.label,
          emoji: d.emoji,
          roleId: "",
          sortOrder: i,
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
