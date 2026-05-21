// Thin wrapper around the Discord REST API used by the web portal to populate
// channel/role dropdowns. Uses the bot token (NOT the user's OAuth token) so it
// works without any extra scopes — the bot just needs to be in the guild.

import { ChannelType } from "discord.js";

const BASE = "https://discord.com/api/v10";

function headers() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN not set");
  return { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
}

export type DiscordChannel = {
  id: string;
  name: string;
  type: number;
  parent_id: string | null;
};

export type DiscordRole = {
  id: string;
  name: string;
  color: number;
  position: number;
  managed: boolean;
};

export type DiscordGuild = {
  id: string;
  name: string;
  icon: string | null;
};

// Channels the bot can see in a guild. Filters to text-capable channels.
export async function listTextChannels(guildId: string): Promise<DiscordChannel[]> {
  const res = await fetch(`${BASE}/guilds/${guildId}/channels`, { headers: headers() });
  if (!res.ok) throw new Error(`discord channels ${res.status}: ${await res.text()}`);
  const channels = (await res.json()) as DiscordChannel[];
  const TEXT_TYPES = new Set<number>([
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.AnnouncementThread,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
  ]);
  return channels
    .filter((c) => TEXT_TYPES.has(c.type))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listRoles(guildId: string): Promise<DiscordRole[]> {
  const res = await fetch(`${BASE}/guilds/${guildId}/roles`, { headers: headers() });
  if (!res.ok) throw new Error(`discord roles ${res.status}: ${await res.text()}`);
  const roles = (await res.json()) as DiscordRole[];
  // Drop @everyone (id === guildId) and managed bot roles.
  return roles
    .filter((r) => r.id !== guildId && !r.managed)
    .sort((a, b) => b.position - a.position);
}

export async function getGuild(guildId: string): Promise<DiscordGuild | null> {
  const res = await fetch(`${BASE}/guilds/${guildId}`, { headers: headers() });
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(`discord guild ${res.status}: ${await res.text()}`);
  return res.json();
}

// Guilds the bot is currently a member of.
export async function listBotGuilds(): Promise<DiscordGuild[]> {
  const res = await fetch(`${BASE}/users/@me/guilds`, { headers: headers() });
  if (!res.ok) throw new Error(`discord bot guilds ${res.status}: ${await res.text()}`);
  return res.json();
}

// Member info for a given user in a guild — used to check role-based access.
export async function getGuildMember(
  guildId: string,
  userId: string
): Promise<{ roles: string[] } | null> {
  const res = await fetch(`${BASE}/guilds/${guildId}/members/${userId}`, { headers: headers() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`discord member ${res.status}: ${await res.text()}`);
  return res.json();
}

export function iconUrl(guildId: string, iconHash: string | null): string | null {
  if (!iconHash) return null;
  return `https://cdn.discordapp.com/icons/${guildId}/${iconHash}.png`;
}

// --- Button-message helpers used by the milestones feature ---

type ButtonComponent = {
  type: 2; // BUTTON
  style: 1 | 2 | 3 | 4 | 5; // primary | secondary | success | danger | link
  label: string;
  custom_id: string;
  emoji?: { name: string };
};

type ActionRow = { type: 1; components: ButtonComponent[] };

export type DiscordMessage = { id: string; channel_id: string };

// Sends a new message with embed + button rows. Returns the created message.
export async function sendButtonMessage(
  channelId: string,
  embed: { title: string; description: string; color?: number },
  rows: ActionRow[]
): Promise<DiscordMessage> {
  const res = await fetch(`${BASE}/channels/${channelId}/messages`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ embeds: [embed], components: rows }),
  });
  if (!res.ok) throw new Error(`discord sendMessage ${res.status}: ${await res.text()}`);
  return res.json();
}

// Edits an existing message in place.
export async function editButtonMessage(
  channelId: string,
  messageId: string,
  embed: { title: string; description: string; color?: number },
  rows: ActionRow[]
): Promise<DiscordMessage> {
  const res = await fetch(`${BASE}/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ embeds: [embed], components: rows }),
  });
  if (!res.ok) throw new Error(`discord editMessage ${res.status}: ${await res.text()}`);
  return res.json();
}

// Creates a role in a guild. Requires MANAGE_ROLES on the bot. New roles are
// placed at position 1 (just above @everyone); admins can drag them higher.
export async function createRole(
  guildId: string,
  params: { name: string; color: number; hoist?: boolean; mentionable?: boolean }
): Promise<{ id: string; name: string; color: number; position: number }> {
  const res = await fetch(`${BASE}/guilds/${guildId}/roles`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      name: params.name,
      color: params.color,
      hoist: params.hoist ?? false,
      mentionable: params.mentionable ?? false,
    }),
  });
  if (!res.ok) throw new Error(`discord createRole ${res.status}: ${await res.text()}`);
  return res.json();
}

// Deletes a role from a guild. Removes it from every member who held it.
export async function deleteRole(guildId: string, roleId: string): Promise<void> {
  const res = await fetch(`${BASE}/guilds/${guildId}/roles/${roleId}`, {
    method: "DELETE",
    headers: headers(),
  });
  // 404 = already gone, treat as success.
  if (!res.ok && res.status !== 404) {
    throw new Error(`discord deleteRole ${res.status}: ${await res.text()}`);
  }
}

// Bulk-updates role positions. Discord rebalances surrounding roles to make
// room. Roles are assigned the positions in the order given.
export async function setRolePositions(
  guildId: string,
  positions: Array<{ id: string; position: number }>
): Promise<void> {
  const res = await fetch(`${BASE}/guilds/${guildId}/roles`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify(positions),
  });
  if (!res.ok) throw new Error(`discord setRolePositions ${res.status}: ${await res.text()}`);
}

// Lays out buttons into Discord-compliant rows (max 5 per row, max 5 rows).
export function buttonsToRows(buttons: ButtonComponent[]): ActionRow[] {
  const rows: ActionRow[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push({ type: 1, components: buttons.slice(i, i + 5) });
  }
  if (rows.length > 5) throw new Error("too many buttons (max 25 per message)");
  return rows;
}
