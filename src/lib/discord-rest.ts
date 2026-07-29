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

// Wraps fetch with Discord-specific recovery:
//   - 429 (rate limited): sleeps for `retry_after` seconds then retries, up to 5 attempts
//   - 5xx (server side): exponential backoff (250ms, 500ms, 1000ms), up to 3 attempts
// Other failures pass straight through so the caller can throw with context.
const MAX_RATE_LIMIT_RETRIES = 5;
const MAX_SERVER_ERROR_RETRIES = 3;
async function discordFetch(url: string, init: RequestInit): Promise<Response> {
  let rateLimitAttempts = 0;
  let serverErrorAttempts = 0;
  for (;;) {
    const res = await fetch(url, init);

    if (res.status === 429 && rateLimitAttempts < MAX_RATE_LIMIT_RETRIES) {
      rateLimitAttempts++;
      // Prefer the JSON body's retry_after; fall back to the response header.
      const body = await res.clone().json().catch(() => ({}));
      const headerRetry = res.headers.get("retry-after");
      const retryAfterSec =
        typeof body.retry_after === "number"
          ? body.retry_after
          : headerRetry
          ? Number(headerRetry)
          : 1;
      // Add a tiny jitter so concurrent callers don't synchronize on the same retry tick.
      const waitMs = Math.max(retryAfterSec * 1000, 100) + Math.random() * 200;
      console.warn(
        `[discord-rest] 429 on ${init.method ?? "GET"} ${url} — waiting ${Math.round(
          waitMs
        )}ms (attempt ${rateLimitAttempts}/${MAX_RATE_LIMIT_RETRIES})`
      );
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (res.status >= 500 && res.status < 600 && serverErrorAttempts < MAX_SERVER_ERROR_RETRIES) {
      serverErrorAttempts++;
      const waitMs = 250 * 2 ** (serverErrorAttempts - 1);
      console.warn(
        `[discord-rest] ${res.status} on ${init.method ?? "GET"} ${url} — retrying in ${waitMs}ms (attempt ${serverErrorAttempts}/${MAX_SERVER_ERROR_RETRIES})`
      );
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    return res;
  }
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
  const res = await discordFetch(`${BASE}/guilds/${guildId}/channels`, { headers: headers() });
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
  const res = await discordFetch(`${BASE}/guilds/${guildId}/roles`, { headers: headers() });
  if (!res.ok) throw new Error(`discord roles ${res.status}: ${await res.text()}`);
  const roles = (await res.json()) as DiscordRole[];
  // Drop @everyone (id === guildId) and managed bot roles.
  return roles
    .filter((r) => r.id !== guildId && !r.managed)
    .sort((a, b) => b.position - a.position);
}

export async function getGuild(guildId: string): Promise<DiscordGuild | null> {
  const res = await discordFetch(`${BASE}/guilds/${guildId}`, { headers: headers() });
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(`discord guild ${res.status}: ${await res.text()}`);
  return res.json();
}

// Guilds the bot is currently a member of.
export async function listBotGuilds(): Promise<DiscordGuild[]> {
  const res = await discordFetch(`${BASE}/users/@me/guilds`, { headers: headers() });
  if (!res.ok) throw new Error(`discord bot guilds ${res.status}: ${await res.text()}`);
  return res.json();
}

// Member info for a given user in a guild — used to check role-based access.
export async function getGuildMember(
  guildId: string,
  userId: string
): Promise<{ roles: string[] } | null> {
  const res = await discordFetch(`${BASE}/guilds/${guildId}/members/${userId}`, { headers: headers() });
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
  const res = await discordFetch(`${BASE}/channels/${channelId}/messages`, {
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
  const res = await discordFetch(`${BASE}/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ embeds: [embed], components: rows }),
  });
  if (!res.ok) throw new Error(`discord editMessage ${res.status}: ${await res.text()}`);
  return res.json();
}

// Creates a role in a guild. Requires MANAGE_ROLES on the bot. New roles are
// placed at position 1 (just above @everyone); admins can drag them higher.
// unicode_emoji shows up as the role icon next to member names; requires the
// guild to have boost level 2 (15 boosts). If the API rejects on the icon
// alone, the caller can retry without it.
export async function createRole(
  guildId: string,
  params: {
    name: string;
    color: number;
    hoist?: boolean;
    mentionable?: boolean;
    unicodeEmoji?: string;
  }
): Promise<{ id: string; name: string; color: number; position: number }> {
  const payload: Record<string, unknown> = {
    name: params.name,
    color: params.color,
    hoist: params.hoist ?? false,
    mentionable: params.mentionable ?? false,
  };
  if (params.unicodeEmoji) payload.unicode_emoji = params.unicodeEmoji;

  const res = await discordFetch(`${BASE}/guilds/${guildId}/roles`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`discord createRole ${res.status}: ${await res.text()}`);
  return res.json();
}

// Deletes a role from a guild. Removes it from every member who held it.
export async function deleteRole(guildId: string, roleId: string): Promise<void> {
  const res = await discordFetch(`${BASE}/guilds/${guildId}/roles/${roleId}`, {
    method: "DELETE",
    headers: headers(),
  });
  // 404 = already gone, treat as success.
  if (!res.ok && res.status !== 404) {
    throw new Error(`discord deleteRole ${res.status}: ${await res.text()}`);
  }
}

// --- Message fetching (for channel export) ---

export type DiscordMessageRaw = {
  id: string;
  channel_id: string;
  type: number;
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  author: {
    id: string;
    username: string;
    global_name: string | null;
    bot?: boolean;
    discriminator?: string;
  };
  mentions: Array<{ id: string; username: string; global_name: string | null }>;
  mention_roles: string[];
  attachments: Array<{
    id: string;
    filename: string;
    content_type?: string;
    size: number;
    url: string;
    width?: number;
    height?: number;
  }>;
  embeds: Array<{
    title?: string;
    type?: string;
    description?: string;
    url?: string;
    color?: number;
    author?: { name?: string; url?: string };
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
    image?: { url: string };
    thumbnail?: { url: string };
    footer?: { text?: string };
  }>;
  reactions?: Array<{
    count: number;
    emoji: { id: string | null; name: string };
  }>;
  referenced_message?: { id: string; author?: { username: string } } | null;
};

// Page through a channel's history oldest-first. Returns all messages up to
// `limit` total. Discord's API returns newest first by default; we walk
// backwards with the `before` parameter then reverse at the end.
export async function listMessages(
  channelId: string,
  options: { limit?: number } = {}
): Promise<DiscordMessageRaw[]> {
  const maxTotal = options.limit ?? 10000;
  const collected: DiscordMessageRaw[] = [];
  let before: string | undefined;

  while (collected.length < maxTotal) {
    const params = new URLSearchParams({ limit: "100" });
    if (before) params.set("before", before);
    const res = await discordFetch(
      `${BASE}/channels/${channelId}/messages?${params.toString()}`,
      { headers: headers() }
    );
    if (!res.ok) {
      throw new Error(`discord listMessages ${res.status}: ${await res.text()}`);
    }
    const batch = (await res.json()) as DiscordMessageRaw[];
    if (batch.length === 0) break;
    collected.push(...batch);
    before = batch[batch.length - 1].id;
    if (batch.length < 100) break; // last page
  }

  // API returns newest-first; reverse so the export reads chronologically.
  return collected.reverse();
}

// Discord snowflakes embed a timestamp; converting a Date to the snowflake
// floor lets us use `before=` cursors as time bounds without fetching pages
// we'd discard anyway.
const DISCORD_EPOCH = 1420070400000n;
export function snowflakeForDate(d: Date): string {
  return String((BigInt(d.getTime()) - DISCORD_EPOCH) << 22n);
}

// Scan a channel newest→oldest, keeping only messages by `authorId` within
// [since, until]. Stops paging once messages get older than `since` (or the
// scan cap is hit). Returns matches in chronological order plus how many
// messages were scanned in total — the caller surfaces that so a capped scan
// is visible rather than silently incomplete.
export async function scanMessagesByAuthor(
  channelId: string,
  authorId: string,
  options: { since?: Date | null; until?: Date | null; scanLimit?: number } = {}
): Promise<{ matches: DiscordMessageRaw[]; scanned: number; hitCap: boolean }> {
  const scanLimit = options.scanLimit ?? 20000;
  const sinceMs = options.since?.getTime() ?? null;
  const matches: DiscordMessageRaw[] = [];
  let scanned = 0;
  // Start the cursor at `until` when provided so we skip newer pages entirely.
  let before: string | undefined = options.until
    ? snowflakeForDate(options.until)
    : undefined;

  while (scanned < scanLimit) {
    const params = new URLSearchParams({ limit: "100" });
    if (before) params.set("before", before);
    const res = await discordFetch(
      `${BASE}/channels/${channelId}/messages?${params.toString()}`,
      { headers: headers() }
    );
    if (!res.ok) {
      throw new Error(`discord scanMessages ${res.status}: ${await res.text()}`);
    }
    const batch = (await res.json()) as DiscordMessageRaw[];
    if (batch.length === 0) break;

    let pastSince = false;
    for (const m of batch) {
      const ts = new Date(m.timestamp).getTime();
      if (sinceMs !== null && ts < sinceMs) {
        pastSince = true;
        break;
      }
      scanned++;
      if (m.author.id === authorId) matches.push(m);
    }
    if (pastSince) break;
    before = batch[batch.length - 1].id;
    if (batch.length < 100) break; // last page
  }

  return { matches: matches.reverse(), scanned, hitCap: scanned >= scanLimit };
}

// Lists members in a guild, paginated. Each page is up to 1000 members; we
// stop once a short page comes back. Used by the dashboard to count how many
// people hold each milestone role.
//
// Requires the bot's `GUILD_MEMBERS` privileged intent to be enabled in the
// developer portal — Discord rejects this REST call otherwise. We cap at 5
// pages (5000 members) defensively so a very large guild doesn't stall the
// dashboard render; counts in that case are a lower bound.
export type DiscordMemberLite = {
  user: {
    id: string;
    username: string;
    global_name: string | null;
    avatar: string | null;
  };
  roles: string[];
  // ISO timestamp of when this user joined the guild. Null for the few system
  // members Discord returns without a join date (rare).
  joined_at: string | null;
};
export async function listGuildMembers(guildId: string): Promise<DiscordMemberLite[]> {
  const all: DiscordMemberLite[] = [];
  let after: string | undefined;
  for (let page = 0; page < 5; page++) {
    const params = new URLSearchParams({ limit: "1000" });
    if (after) params.set("after", after);
    const res = await discordFetch(
      `${BASE}/guilds/${guildId}/members?${params.toString()}`,
      { headers: headers() }
    );
    if (!res.ok) {
      throw new Error(`discord listMembers ${res.status}: ${await res.text()}`);
    }
    const batch = (await res.json()) as DiscordMemberLite[];
    all.push(...batch);
    if (batch.length < 1000) break;
    after = batch[batch.length - 1].user.id;
  }
  return all;
}

// Pinned messages for a channel. Discord caps this at 50 per channel and
// returns them newest-pin first; we reverse so the export reads chronologically
// like listMessages does.
export async function listPinnedMessages(
  channelId: string
): Promise<DiscordMessageRaw[]> {
  const res = await discordFetch(
    `${BASE}/channels/${channelId}/pins`,
    { headers: headers() }
  );
  if (!res.ok) {
    throw new Error(`discord listPins ${res.status}: ${await res.text()}`);
  }
  const messages = (await res.json()) as DiscordMessageRaw[];
  return messages.reverse();
}

// Bulk-updates role positions. Discord rebalances surrounding roles to make
// room. Roles are assigned the positions in the order given.
export async function setRolePositions(
  guildId: string,
  positions: Array<{ id: string; position: number }>
): Promise<void> {
  const res = await discordFetch(`${BASE}/guilds/${guildId}/roles`, {
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
