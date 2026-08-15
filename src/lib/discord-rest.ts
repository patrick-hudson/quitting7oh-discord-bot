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
//   - 429 (rate limited): sleeps for `retry_after` seconds — escalating on
//     repeat 429s (retry_after × attempt, capped at 60s) — up to 8 attempts.
//     Discord itself does NOT back off harder per 429; it expects exact
//     retry_after compliance. But repeated 429s count toward the invalid-
//     request limit (10k per 10 min → temporary Cloudflare IP ban), so we
//     escalate on our side to get out of a hot bucket fast.
//   - 5xx (server side): exponential backoff (250ms, 500ms, 1000ms), up to 3 attempts
// Other failures pass straight through so the caller can throw with context.
const MAX_RATE_LIMIT_RETRIES = 8;
const MAX_SERVER_ERROR_RETRIES = 3;
async function discordFetch(url: string, init: RequestInit): Promise<Response> {
  let rateLimitAttempts = 0;
  let serverErrorAttempts = 0;
  for (;;) {
    const res = await fetch(url, init);

    if (res.status === 429 && rateLimitAttempts < MAX_RATE_LIMIT_RETRIES) {
      rateLimitAttempts++;
      // Prefer the JSON body's retry_after; fall back to the response header.
      // `body.global` means the whole bot is limited, not just this route —
      // still just a sleep for us, but worth surfacing in the log line.
      const body = await res.clone().json().catch(() => ({}));
      const headerRetry = res.headers.get("retry-after");
      const retryAfterSec =
        typeof body.retry_after === "number"
          ? body.retry_after
          : headerRetry
          ? Number(headerRetry)
          : 1;
      // Escalate on consecutive 429s (attempt multiplier, capped at 60s) and
      // add jitter so concurrent callers don't synchronize on the retry tick.
      const waitMs =
        Math.min(Math.max(retryAfterSec * 1000, 100) * rateLimitAttempts, 60_000) +
        Math.random() * 250;
      console.warn(
        `[discord-rest] 429${body.global ? " (GLOBAL)" : ""} on ${init.method ?? "GET"} ${url} — waiting ${Math.round(
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

// Proactive rate-limit pacing for tight paging loops (exports). Discord's
// response headers say how many requests remain in the route's current bucket
// and when it resets; sleeping when the bucket is empty avoids the 429
// entirely — strictly better than reacting to one, since excessive 429s count
// toward the invalid-request limit that triggers temporary IP bans.
async function paceFromHeaders(res: Response): Promise<void> {
  const remaining = Number(res.headers.get("x-ratelimit-remaining"));
  const resetAfter = Number(res.headers.get("x-ratelimit-reset-after"));
  if (remaining === 0 && Number.isFinite(resetAfter) && resetAfter > 0) {
    await new Promise((r) => setTimeout(r, resetAfter * 1000 + 50));
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

// Fetches a user by id — works for ANY user, including people who have left
// the guild (returns their account-level username/global_name, not a server
// nickname). Used as the leaderboard's last-resort name resolution for
// departed posters not found in snapshots. Returns null on 404/error so
// callers can fall back to showing the raw id.
export async function getUser(
  userId: string
): Promise<{ username: string; global_name: string | null } | null> {
  try {
    const res = await discordFetch(`${BASE}/users/${userId}`, { headers: headers() });
    if (!res.ok) return null;
    return (await res.json()) as { username: string; global_name: string | null };
  } catch {
    return null;
  }
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

// --- Restore-assist write helpers ---
// All creation here is used by the restore worker, which paces itself hard:
// Discord applies aggressive undocumented anti-nuke limits to role creation
// (tripping them can block role creation for 24h+), so callers must space
// these out rather than blasting.

export async function createRoleRaw(
  guildId: string,
  payload: {
    name: string;
    color?: number;
    hoist?: boolean;
    mentionable?: boolean;
    permissions?: string;
  },
  reason?: string
): Promise<DiscordRoleRaw> {
  const res = await discordFetch(`${BASE}/guilds/${guildId}/roles`, {
    method: "POST",
    headers: {
      ...headers(),
      ...(reason ? { "X-Audit-Log-Reason": encodeURIComponent(reason) } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`discord createRole ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function createChannelRaw(
  guildId: string,
  payload: {
    name: string;
    type: number;
    parent_id?: string | null;
    topic?: string | null;
    nsfw?: boolean;
    rate_limit_per_user?: number;
    permission_overwrites?: Array<{
      id: string;
      type: number;
      allow: string;
      deny: string;
    }>;
  },
  reason?: string
): Promise<DiscordChannelRaw> {
  const res = await discordFetch(`${BASE}/guilds/${guildId}/channels`, {
    method: "POST",
    headers: {
      ...headers(),
      ...(reason ? { "X-Audit-Log-Reason": encodeURIComponent(reason) } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`discord createChannel ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function addMemberRole(
  guildId: string,
  userId: string,
  roleId: string,
  reason?: string
): Promise<void> {
  const res = await discordFetch(
    `${BASE}/guilds/${guildId}/members/${userId}/roles/${roleId}`,
    {
      method: "PUT",
      headers: {
        ...headers(),
        ...(reason ? { "X-Audit-Log-Reason": encodeURIComponent(reason) } : {}),
      },
    }
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`discord addMemberRole ${res.status}: ${await res.text()}`);
  }
}

// Removes a single role from a member. `reason` lands in Discord's own audit
// log so server admins can see why the bot did it. 404 (member or role gone)
// is treated as success — the desired end-state holds either way.
export async function removeMemberRole(
  guildId: string,
  userId: string,
  roleId: string,
  reason?: string
): Promise<void> {
  const res = await discordFetch(
    `${BASE}/guilds/${guildId}/members/${userId}/roles/${roleId}`,
    {
      method: "DELETE",
      headers: {
        ...headers(),
        ...(reason ? { "X-Audit-Log-Reason": encodeURIComponent(reason) } : {}),
      },
    }
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`discord removeMemberRole ${res.status}: ${await res.text()}`);
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
    await paceFromHeaders(res);
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

// Inverse: the creation time embedded in a Discord snowflake. Used by the
// "auto" post-skip mode to learn when the bot last posted in a channel from
// its stored message id, with no extra column.
export function dateFromSnowflake(id: string): Date {
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH));
}

// Scan a channel newest→oldest, keeping only messages by `authorId` within
// [since, until]. Stops paging once messages get older than `since` (or the
// scan cap is hit). Returns matches in chronological order plus how many
// messages were scanned in total — the caller surfaces that so a capped scan
// is visible rather than silently incomplete.
export async function scanMessagesByAuthor(
  channelId: string,
  authorId: string,
  options: {
    since?: Date | null;
    until?: Date | null;
    scanLimit?: number;
    // Checked between pages; return true to abort the scan (throws).
    shouldAbort?: () => Promise<boolean> | boolean;
  } = {}
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
    if (options.shouldAbort && (await options.shouldAbort())) {
      throw new ScanAbortedError();
    }
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
    // Sleep out the rest of the bucket window when it's exhausted, instead of
    // provoking a 429 on the next page.
    await paceFromHeaders(res);
  }

  return { matches: matches.reverse(), scanned, hitCap: scanned >= scanLimit };
}

// Thrown by scanMessagesByAuthor when the caller's shouldAbort() trips.
// Callers use instanceof to distinguish a cancellation from a real failure.
export class ScanAbortedError extends Error {
  constructor() {
    super("scan aborted by caller");
    this.name = "ScanAbortedError";
  }
}

// The ids of a channel's most recent `limit` messages (newest first). Used by
// the "skip if still in recent scrollback" post option. Capped at 100 (one
// page) — the option is about very-recent visibility, not deep history.
export async function fetchRecentMessageIds(
  channelId: string,
  limit: number
): Promise<Set<string>> {
  const capped = Math.min(Math.max(limit, 1), 100);
  const res = await discordFetch(
    `${BASE}/channels/${channelId}/messages?limit=${capped}`,
    { headers: headers() }
  );
  if (!res.ok) {
    throw new Error(`discord fetchRecentMessageIds ${res.status}: ${await res.text()}`);
  }
  const batch = (await res.json()) as Array<{ id: string }>;
  return new Set(batch.map((m) => m.id));
}

// One forward page of channel history for the incremental archive: messages
// strictly AFTER `after` (or from the very beginning when omitted), returned
// ascending. Discord's ordering with the `after` cursor isn't worth trusting —
// we sort by snowflake ourselves. Paces from rate-limit headers before
// returning so tight loops don't provoke 429s.
export async function fetchMessagesAfter(
  channelId: string,
  after?: string
): Promise<{ messages: DiscordMessageRaw[]; hasMore: boolean }> {
  const params = new URLSearchParams({ limit: "100" });
  if (after) params.set("after", after);
  const res = await discordFetch(
    `${BASE}/channels/${channelId}/messages?${params.toString()}`,
    { headers: headers() }
  );
  if (!res.ok) {
    throw new Error(`discord fetchMessagesAfter ${res.status}: ${await res.text()}`);
  }
  const batch = (await res.json()) as DiscordMessageRaw[];
  batch.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  await paceFromHeaders(res);
  return { messages: batch, hasMore: batch.length === 100 };
}

// One page of channel history OLDER than `before` (or the newest page when
// `before` is omitted), returned ascending. Used by the archive's backfill
// pass to walk history from the newest page down to the channel's first
// message. hasMore=false means we hit the start of the channel.
export async function fetchMessagesBefore(
  channelId: string,
  before?: string
): Promise<{ messages: DiscordMessageRaw[]; hasMore: boolean }> {
  const params = new URLSearchParams({ limit: "100" });
  if (before) params.set("before", before);
  const res = await discordFetch(
    `${BASE}/channels/${channelId}/messages?${params.toString()}`,
    { headers: headers() }
  );
  if (!res.ok) {
    throw new Error(`discord fetchMessagesBefore ${res.status}: ${await res.text()}`);
  }
  const batch = (await res.json()) as DiscordMessageRaw[];
  batch.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  await paceFromHeaders(res);
  return { messages: batch, hasMore: batch.length === 100 };
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
  nick?: string | null;
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

// --- Raw structure reads used by guild snapshots (src/lib/guild-snapshot.ts) ---
// Unlike the dropdown-oriented helpers above, these return EVERYTHING
// unfiltered (all roles including @everyone/managed, all channel types),
// because a backup that silently drops rows isn't a backup.

export type DiscordRoleRaw = {
  id: string;
  name: string;
  color: number;
  hoist: boolean;
  position: number;
  permissions: string; // bitfield as decimal string
  managed: boolean;
  mentionable: boolean;
  icon?: string | null;
  unicode_emoji?: string | null;
};

export async function listRolesRaw(guildId: string): Promise<DiscordRoleRaw[]> {
  const res = await discordFetch(`${BASE}/guilds/${guildId}/roles`, { headers: headers() });
  if (!res.ok) throw new Error(`discord roles ${res.status}: ${await res.text()}`);
  return res.json();
}

export type DiscordChannelRaw = {
  id: string;
  name: string;
  type: number;
  position: number;
  parent_id: string | null;
  topic?: string | null;
  nsfw?: boolean;
  rate_limit_per_user?: number;
  bitrate?: number;
  user_limit?: number;
  permission_overwrites?: Array<{
    id: string; // role or member id
    type: number; // 0 = role, 1 = member
    allow: string;
    deny: string;
  }>;
};

export async function listAllChannels(guildId: string): Promise<DiscordChannelRaw[]> {
  const res = await discordFetch(`${BASE}/guilds/${guildId}/channels`, { headers: headers() });
  if (!res.ok) throw new Error(`discord channels ${res.status}: ${await res.text()}`);
  return res.json();
}

export type DiscordEmojiRaw = {
  id: string;
  name: string;
  animated?: boolean;
  managed?: boolean;
  available?: boolean;
};

export async function listEmojis(guildId: string): Promise<DiscordEmojiRaw[]> {
  const res = await discordFetch(`${BASE}/guilds/${guildId}/emojis`, { headers: headers() });
  if (!res.ok) throw new Error(`discord emojis ${res.status}: ${await res.text()}`);
  return res.json();
}

export type DiscordGuildRaw = {
  id: string;
  name: string;
  icon: string | null;
  banner?: string | null;
  description?: string | null;
  verification_level?: number;
  default_message_notifications?: number;
  explicit_content_filter?: number;
  afk_channel_id?: string | null;
  afk_timeout?: number;
  system_channel_id?: string | null;
  rules_channel_id?: string | null;
  public_updates_channel_id?: string | null;
  preferred_locale?: string;
};

export async function getGuildRaw(guildId: string): Promise<DiscordGuildRaw> {
  const res = await discordFetch(`${BASE}/guilds/${guildId}`, { headers: headers() });
  if (!res.ok) throw new Error(`discord guild ${res.status}: ${await res.text()}`);
  return res.json();
}

// Users who currently have `emoji` on a message — used by the one-time
// reaction backfill. Paginated 100/page; `maxPages` bounds runaway crawls on
// viral messages. Custom emoji are addressed as name:id, unicode by the
// character itself.
export async function listReactionUsers(
  channelId: string,
  messageId: string,
  emoji: { id: string | null; name: string },
  maxPages = 3
): Promise<Array<{ id: string; bot?: boolean }>> {
  const ident = encodeURIComponent(
    emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name
  );
  const users: Array<{ id: string; bot?: boolean }> = [];
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ limit: "100" });
    if (after) params.set("after", after);
    const res = await discordFetch(
      `${BASE}/channels/${channelId}/messages/${messageId}/reactions/${ident}?${params.toString()}`,
      { headers: headers() }
    );
    if (res.status === 404) return users; // message or emoji gone — fine
    if (!res.ok) {
      throw new Error(`discord reactions ${res.status}: ${await res.text()}`);
    }
    const batch = (await res.json()) as Array<{ id: string; bot?: boolean }>;
    users.push(...batch);
    if (batch.length < 100) break;
    after = batch[batch.length - 1].id;
  }
  return users;
}

// Live headline counts for the stats page. with_counts=true makes Discord
// include approximate member/presence totals on the guild object.
export async function getGuildCounts(
  guildId: string
): Promise<{ memberCount: number | null; onlineCount: number | null }> {
  const res = await discordFetch(`${BASE}/guilds/${guildId}?with_counts=true`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`discord guild counts ${res.status}: ${await res.text()}`);
  const g = (await res.json()) as {
    approximate_member_count?: number;
    approximate_presence_count?: number;
  };
  return {
    memberCount: g.approximate_member_count ?? null,
    onlineCount: g.approximate_presence_count ?? null,
  };
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
