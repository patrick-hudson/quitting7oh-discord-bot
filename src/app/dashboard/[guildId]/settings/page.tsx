import { prisma } from "@/lib/db";
import { listRoles, listTextChannels } from "@/lib/discord-rest";
import { SettingsForm } from "@/components/SettingsForm";
import { ConfigBackup } from "@/components/ConfigBackup";

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;
  const [guild, roles, channels] = await Promise.all([
    prisma.guild.findUnique({ where: { id: guildId } }),
    listRoles(guildId).catch(() => []),
    listTextChannels(guildId).catch(() => []),
  ]);
  if (!guild) return null;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">Guild settings</h1>
      <p className="mt-1 text-sm text-white/60">{guild.name}</p>

      <div className="mt-8">
        <SettingsForm
          guildId={guildId}
          initial={{
            timezone: guild.timezone,
            adminRoleId: guild.adminRoleId ?? "",
            redditEnabled: guild.redditEnabled,
            redditSubreddit: guild.redditSubreddit ?? "",
            redditChannelId: guild.redditChannelId ?? "",
            leaveEnabled: guild.leaveEnabled,
            leaveChannelId: guild.leaveChannelId ?? "",
            welcomeDmEnabled: guild.welcomeDmEnabled,
          }}
          roles={roles.map((r) => ({ id: r.id, name: r.name }))}
          channels={channels.map((c) => ({ id: c.id, name: c.name }))}
        />
      </div>

      <div className="mt-8">
        <ConfigBackup guildId={guildId} />
      </div>
    </div>
  );
}
