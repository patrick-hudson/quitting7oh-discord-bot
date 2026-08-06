// Collects a point-in-time structural snapshot of a guild via Discord's REST
// API: settings, all roles, all channels with permission overwrites, emojis,
// and member role-assignments/nicknames. Used by the nightly scheduler job,
// the portal's "Snapshot now" button, the diff view, and restore assist.
//
// Everything here is REST-only (no gateway), so both the web and bot
// processes can collect snapshots.

import {
  getGuildRaw,
  listAllChannels,
  listEmojis,
  listGuildMembers,
  listRolesRaw,
  type DiscordChannelRaw,
  type DiscordRoleRaw,
} from "@/lib/discord-rest";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

export type SnapshotRole = DiscordRoleRaw;
export type SnapshotChannel = DiscordChannelRaw;

export type SnapshotMember = {
  id: string;
  username: string;
  nick: string | null;
  roles: string[]; // role ids, excluding @everyone
};

export type GuildSnapshotData = {
  version: 1;
  settings: {
    name: string;
    icon: string | null;
    banner: string | null;
    description: string | null;
    verificationLevel: number | null;
    afkChannelId: string | null;
    afkTimeout: number | null;
    systemChannelId: string | null;
    rulesChannelId: string | null;
  };
  roles: SnapshotRole[];
  channels: SnapshotChannel[];
  emojis: Array<{ id: string; name: string; animated: boolean }>;
  members: SnapshotMember[];
  counts: { roles: number; channels: number; emojis: number; members: number };
};

export async function collectGuildSnapshot(guildId: string): Promise<GuildSnapshotData> {
  const [guild, roles, channels, emojis, members] = await Promise.all([
    getGuildRaw(guildId),
    listRolesRaw(guildId),
    listAllChannels(guildId),
    listEmojis(guildId),
    listGuildMembers(guildId),
  ]);

  const memberData: SnapshotMember[] = members.map((m) => ({
    id: m.user.id,
    username: m.user.username,
    nick: m.nick ?? null,
    roles: m.roles,
  }));

  return {
    version: 1,
    settings: {
      name: guild.name,
      icon: guild.icon,
      banner: guild.banner ?? null,
      description: guild.description ?? null,
      verificationLevel: guild.verification_level ?? null,
      afkChannelId: guild.afk_channel_id ?? null,
      afkTimeout: guild.afk_timeout ?? null,
      systemChannelId: guild.system_channel_id ?? null,
      rulesChannelId: guild.rules_channel_id ?? null,
    },
    roles: roles.sort((a, b) => b.position - a.position),
    channels: channels.sort((a, b) => a.position - b.position),
    emojis: emojis.map((e) => ({
      id: e.id,
      name: e.name,
      animated: Boolean(e.animated),
    })),
    members: memberData,
    counts: {
      roles: roles.length,
      channels: channels.length,
      emojis: emojis.length,
      members: memberData.length,
    },
  };
}

// Collects and stores a snapshot row. Returns its id.
export async function takeGuildSnapshot(
  guildId: string,
  kind: "scheduled" | "manual"
): Promise<string> {
  const data = await collectGuildSnapshot(guildId);
  const row = await prisma.guildSnapshot.create({
    data: {
      guildId,
      kind,
      data: data as unknown as Prisma.InputJsonValue,
    },
  });
  return row.id;
}
