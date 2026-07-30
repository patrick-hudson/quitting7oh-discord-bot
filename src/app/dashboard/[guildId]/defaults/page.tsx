// Per-guild defaults — currently the reminder-template roster used by the
// scheduler when a ScheduledPost has no reminderContent of its own. Designed
// as a standalone page so more "default" knobs (e.g. default lead time) can be
// added as separate sections without bloating Settings.

import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { DefaultsForm } from "@/components/DefaultsForm";
import { REMINDER_TEMPLATES } from "@/lib/reminder-templates";
import { LEAVE_TEMPLATES } from "@/lib/leave-templates";
import { WELCOME_TEMPLATES } from "@/lib/welcome-templates";

export default async function DefaultsPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;
  const guild = await prisma.guild.findUnique({ where: { id: guildId } });
  if (!guild) notFound();

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Defaults</h1>
      <p className="mt-1 text-sm text-white/60">
        Fallback content the bot uses when a post doesn&apos;t override it. Changes
        here affect every post in this guild that uses the defaults.
      </p>

      <div className="mt-8">
        <DefaultsForm
          guildId={guildId}
          initialReminderTemplates={guild.reminderTemplates}
          builtInReminderTemplates={REMINDER_TEMPLATES}
          initialLeaveTemplates={guild.leaveTemplates}
          builtInLeaveTemplates={LEAVE_TEMPLATES}
          initialWelcomeDmTemplates={guild.welcomeDmTemplates}
          builtInWelcomeDmTemplates={WELCOME_TEMPLATES}
        />
      </div>
    </div>
  );
}
