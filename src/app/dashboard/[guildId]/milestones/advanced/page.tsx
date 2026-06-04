// Bulk-edit view for milestone message rosters. Renders the full set of tiers
// and the guild-level fallback rosters as always-open textareas so an admin can
// see and edit everything in one place — no expand-to-edit step.

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { MilestoneTemplatesForm } from "@/components/MilestoneTemplatesForm";

export default async function MilestoneTemplatesPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;
  const [guild, config, tiers] = await Promise.all([
    prisma.guild.findUnique({ where: { id: guildId } }),
    prisma.milestoneConfig.findUnique({ where: { guildId } }),
    prisma.milestoneTier.findMany({ where: { guildId }, orderBy: { sortOrder: "asc" } }),
  ]);
  if (!guild) notFound();
  // If the config row doesn't exist yet, defer to the main page — that flow
  // seeds defaults the first time an admin saves there.
  if (!config) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">Milestone templates</h1>
        <p className="mt-4 rounded-md bg-white/[0.03] px-3 py-3 text-sm text-white/70 ring-1 ring-white/5">
          Configure the milestones once on the{" "}
          <Link
            href={`/dashboard/${guildId}/milestones`}
            className="text-[color:var(--color-brand-500)] hover:underline"
          >
            main milestones page
          </Link>
          , then come back here to bulk-edit messages.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Milestone templates</h1>
          <p className="mt-1 text-sm text-white/60">
            Every congrats roster on one page. Edits save through the same
            endpoint as the main milestones form.
          </p>
        </div>
        <Link
          href={`/dashboard/${guildId}/milestones`}
          className="rounded-lg px-3 py-1.5 text-sm text-white/70 hover:bg-white/5"
        >
          ← Back to milestones
        </Link>
      </div>

      <div className="mt-8">
        <MilestoneTemplatesForm
          guildId={guildId}
          config={{
            channelId: config.channelId,
            title: config.title,
            description: config.description,
            congratsEnabled: config.congratsEnabled,
            congratsChannelId: config.congratsChannelId,
          }}
          tiers={tiers.map((t) => ({
            id: t.id,
            label: t.label,
            emoji: t.emoji,
            roleId: t.roleId,
            sortOrder: t.sortOrder,
            congratsTemplates: t.congratsTemplates,
          }))}
          initialCongratsTemplates={config.congratsTemplates}
          initialEphemeralTemplates={config.ephemeralTemplates}
        />
      </div>
    </div>
  );
}
