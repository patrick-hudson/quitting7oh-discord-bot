// Moderation log: records human mod actions into the ModerationLog table.
//
// Two sources:
//   1. GuildAuditLogEntryCreate — Discord's real-time audit-log gateway event
//      (requires the GuildModeration intent + the bot having the View Audit
//      Log permission). Gives reliable executor/target/reason for bans,
//      unbans, kicks, and timeouts.
//   2. MessageDelete / MessageBulkDelete — for deleted-message content. The
//      content is only available when the message was still in the bot's
//      cache (sent since the current process started, not yet swept).
//      Attribution is best-effort: Discord only writes an audit entry when
//      someone deletes ANOTHER person's message, and batches repeat deletes
//      into a count bump on the existing entry — so we match against fresh
//      entries OR count increases, and otherwise assume a self-delete.

import {
  AuditLogEvent,
  Events,
  type Client,
  type Guild,
  type GuildAuditLogsEntry,
  type Message,
  type OmitPartialGroupDMChannel,
  type PartialMessage,
  type ReadonlyCollection,
  type GuildTextBasedChannel,
} from "discord.js";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

function record(row: {
  guildId: string;
  kind: string;
  executorId?: string | null;
  executorName?: string | null;
  targetId?: string | null;
  targetName?: string | null;
  reason?: string | null;
  channelId?: string | null;
  content?: string | null;
  data?: Record<string, unknown>;
}): void {
  prisma.moderationLog
    .create({
      data: {
        ...row,
        data: (row.data ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    })
    .catch((err) => console.warn(`[mod-log] write failed for ${row.kind}:`, err));
}

async function userName(client: Client, id: string | null): Promise<string | null> {
  if (!id) return null;
  try {
    const u = await client.users.fetch(id);
    return u.globalName || u.username;
  } catch {
    return null;
  }
}

export function registerModLog(client: Client) {
  client.on(
    Events.GuildAuditLogEntryCreate,
    async (entry: GuildAuditLogsEntry, guild: Guild) => {
      try {
        await handleAuditEntry(client, entry, guild);
      } catch (err) {
        console.error(`[mod-log] audit entry failed:`, err);
      }
    }
  );

  client.on(Events.MessageDelete, async (message) => {
    try {
      await handleMessageDelete(client, message);
    } catch (err) {
      console.error(`[mod-log] message delete failed:`, err);
    }
  });

  client.on(Events.MessageBulkDelete, async (messages, channel) => {
    try {
      await handleBulkDelete(client, messages, channel);
    } catch (err) {
      console.error(`[mod-log] bulk delete failed:`, err);
    }
  });
}

async function handleAuditEntry(
  client: Client,
  entry: GuildAuditLogsEntry,
  guild: Guild
) {
  const executorId = entry.executorId ?? null;
  // Ignore the bot's own actions — those live in BotAuditLog already.
  if (executorId && executorId === client.user?.id) return;

  const base = {
    guildId: guild.id,
    executorId,
    executorName: await userName(client, executorId),
    targetId: entry.targetId ?? null,
    targetName: await userName(client, entry.targetId ?? null),
    reason: entry.reason ?? null,
  };

  switch (entry.action) {
    case AuditLogEvent.MemberBanAdd:
      record({ ...base, kind: "ban", data: { auditEntryId: entry.id } });
      return;
    case AuditLogEvent.MemberBanRemove:
      record({ ...base, kind: "unban", data: { auditEntryId: entry.id } });
      return;
    case AuditLogEvent.MemberKick:
      record({ ...base, kind: "kick", data: { auditEntryId: entry.id } });
      return;
    case AuditLogEvent.MemberUpdate: {
      // Timeouts arrive as a MemberUpdate touching communication_disabled_until.
      const change = entry.changes.find(
        (c) => c.key === "communication_disabled_until"
      );
      if (!change) return; // some other member edit (nickname etc.) — not logged
      const until = change.new ? new Date(String(change.new)) : null;
      const active = until !== null && until.getTime() > Date.now();
      record({
        ...base,
        kind: active ? "timeout" : "timeout_removed",
        data: {
          auditEntryId: entry.id,
          until: until?.toISOString() ?? null,
        },
      });
      return;
    }
    default:
      return; // other audit actions aren't part of the mod log (yet)
  }
}

// Tracks the last-seen count per MessageDelete audit entry so we can detect
// Discord's batching (repeat deletes bump `count` on the existing entry
// instead of creating a new one). Small and self-limiting: entries age out of
// the fetch window naturally.
const deleteEntryCounts = new Map<string, number>();

async function attributeDeletion(
  guild: Guild,
  authorId: string | undefined,
  channelId: string
): Promise<{ executorId: string | null; attribution: string }> {
  try {
    const logs = await guild.fetchAuditLogs({
      type: AuditLogEvent.MessageDelete,
      limit: 5,
    });
    for (const entry of logs.entries.values()) {
      const extra = entry.extra as { channel?: { id?: string }; count?: number };
      if (authorId && entry.targetId !== authorId) continue;
      if (extra?.channel?.id && extra.channel.id !== channelId) continue;

      const prevCount = deleteEntryCounts.get(entry.id);
      const count = extra?.count ?? 1;
      deleteEntryCounts.set(entry.id, count);
      const isFresh = Date.now() - entry.createdTimestamp < 15_000;
      const countBumped = prevCount !== undefined && count > prevCount;
      if (isFresh || countBumped) {
        return { executorId: entry.executorId ?? null, attribution: "audit-match" };
      }
    }
  } catch (err) {
    // Missing View Audit Log permission, most likely. Content still logs.
    console.warn("[mod-log] audit fetch for delete attribution failed:", err);
    return { executorId: null, attribution: "no-audit-access" };
  }
  // No audit entry → Discord doesn't log self-deletes, so this was most
  // likely the author deleting their own message.
  return { executorId: null, attribution: "assumed-self-delete" };
}

async function handleMessageDelete(
  client: Client,
  message: OmitPartialGroupDMChannel<Message | PartialMessage>
) {
  if (!message.guildId || !message.guild) return;
  // Ignore deletions of the bot's own messages (scheduler edits/cleanup noise).
  if (message.author?.id === client.user?.id) return;

  const authorId = message.author?.id;
  const { executorId, attribution } = await attributeDeletion(
    message.guild,
    authorId,
    message.channelId
  );
  // Self-deletes of uncached messages carry no author AND no content — pure
  // noise ("someone deleted something, we know nothing"). Skip those.
  if (!authorId && !executorId && message.partial) return;

  const attachments = message.attachments?.map((a) => ({
    name: a.name,
    url: a.url,
  }));

  record({
    guildId: message.guildId,
    kind: "message_delete",
    executorId,
    executorName: await userName(client, executorId),
    targetId: authorId ?? null,
    targetName: message.author
      ? message.author.globalName || message.author.username
      : null,
    channelId: message.channelId,
    content: message.partial ? null : (message.content ?? null),
    data: {
      messageId: message.id,
      attribution,
      cached: !message.partial,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      sentAt: message.createdAt?.toISOString(),
    },
  });
}

async function handleBulkDelete(
  client: Client,
  messages: ReadonlyCollection<string, OmitPartialGroupDMChannel<Message | PartialMessage>>,
  channel: GuildTextBasedChannel
) {
  const guild = channel.guild;
  // Bulk deletes are always mod/bot actions; a fresh audit entry exists.
  let executorId: string | null = null;
  try {
    const logs = await guild.fetchAuditLogs({
      type: AuditLogEvent.MessageBulkDelete,
      limit: 1,
    });
    const entry = logs.entries.first();
    if (entry && Date.now() - entry.createdTimestamp < 15_000) {
      executorId = entry.executorId ?? null;
    }
  } catch {
    // fall through — logged without executor
  }

  const items = messages.map((m) => ({
    messageId: m.id,
    authorId: m.author?.id ?? null,
    authorName: m.author ? m.author.globalName || m.author.username : null,
    content: m.partial ? null : (m.content ?? null),
  }));

  record({
    guildId: guild.id,
    kind: "message_bulk_delete",
    executorId,
    executorName: await userName(client, executorId),
    channelId: channel.id,
    data: { count: messages.size, messages: items },
  });
}
