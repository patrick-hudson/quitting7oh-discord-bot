import { prisma } from "@/lib/db";
import { listRoles } from "@/lib/discord-rest";
import { SettingsForm } from "@/components/SettingsForm";

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;
  const [guild, roles] = await Promise.all([
    prisma.guild.findUnique({ where: { id: guildId } }),
    listRoles(guildId).catch(() => []),
  ]);
  if (!guild) return null;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">Guild settings</h1>
      <p className="mt-1 text-sm text-white/60">{guild.name}</p>

      <div className="mt-8">
        <SettingsForm
          guildId={guildId}
          initial={{ timezone: guild.timezone, adminRoleId: guild.adminRoleId ?? "" }}
          roles={roles.map((r) => ({ id: r.id, name: r.name }))}
        />
      </div>
    </div>
  );
}
