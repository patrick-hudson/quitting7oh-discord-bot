// Full message archive worker. For guilds with archiveEnabled, incrementally
// copies every text channel's history to disk:
//
//   ARCHIVE_DIR/<guildId>/<channelId>.jsonl   — one raw API message per line
//   ARCHIVE_DIR/<guildId>/media/<id>-<name>   — attachment bytes
//
// Cursor per channel lives in ArchiveChannelState (lastMessageId = highest
// archived snowflake), so each run only fetches what's new; the first run
// after enabling walks the entire history. JSONL is append-only and the
// cursor is advanced only after the page is written, so a crash re-archives
// at most one page (dedupe on read by message id if it ever matters).
//
// Attachment bytes are downloaded because Discord's signed CDN URLs expire in
// ~24h — an archive of URLs is not an archive. Media over the per-file cap is
// skipped (the JSONL still has the metadata).

import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import {
  fetchMessagesAfter,
  fetchMessagesBefore,
  listTextChannels,
  type DiscordMessageRaw,
} from "@/lib/discord-rest";

const POLL_MS = Number(process.env.ARCHIVE_POLL_SECONDS ?? "3600") * 1000;
// Pages per channel per tick — bounds one tick's grind on first-time archives
// of huge channels (300 pages = 30k messages); the next tick continues.
const MAX_PAGES_PER_CHANNEL_PER_TICK = 300;
const MEDIA_FILE_CAP = Number(process.env.ARCHIVE_MEDIA_FILE_CAP_MB ?? "25") * 1024 * 1024;

export function archiveDir(): string {
  return process.env.ARCHIVE_DIR ?? "./archive-data";
}

export function runArchiveWorker() {
  console.log(`[archive] polling every ${POLL_MS}ms → ${archiveDir()}`);
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (err) {
      console.error("[archive] tick failed:", err);
    } finally {
      running = false;
    }
  }, POLL_MS);
  // Also run shortly after boot so enabling the toggle doesn't wait an hour.
  setTimeout(() => {
    if (!running) {
      running = true;
      tick()
        .catch((err) => console.error("[archive] initial tick failed:", err))
        .finally(() => {
          running = false;
        });
    }
  }, 30_000);
}

async function tick() {
  const guilds = await prisma.guild.findMany({
    where: { archiveEnabled: true },
    select: { id: true, name: true },
  });

  for (const g of guilds) {
    let totalNew = 0;
    const touched: string[] = [];
    // A guild-level failure (can't even list channels) aborts this guild; a
    // per-channel failure is recorded and we move on to the next channel.
    let channels;
    try {
      channels = await listTextChannels(g.id);
    } catch (err) {
      console.error(`[archive] can't list channels for guild ${g.id}:`, err);
      audit(
        g.id,
        "archive.failed",
        "Archive run couldn't list channels — will retry next interval",
        { error: (err as Error).message?.slice(0, 500) },
        "error"
      );
      continue;
    }

    const failures: Array<{ channel: string; reason: string }> = [];
    for (const ch of channels) {
      try {
        const added = await archiveChannel(g.id, ch.id, ch.name);
        if (added > 0) {
          totalNew += added;
          touched.push(`#${ch.name} (+${added})`);
        }
      } catch (err) {
        const reason = describeChannelError(err);
        console.warn(`[archive] #${ch.name} (${ch.id}) skipped: ${reason}`);
        failures.push({ channel: `#${ch.name} (${ch.id})`, reason });
        // continue to the next channel — one bad channel never stalls the rest
      }
    }

    if (totalNew > 0) {
      console.log(`[archive] ${g.name}: +${totalNew} message(s)`);
      audit(g.id, "archive.ran", `Archived ${totalNew} new message(s)`, {
        channels: touched.slice(0, 25),
        totalNew,
        ...(failures.length > 0 ? { skippedChannels: failures.length } : {}),
      });
    }
    if (failures.length > 0) {
      audit(
        g.id,
        "archive.channel_skipped",
        `Archive skipped ${failures.length} channel(s) it can't read — continued with the rest`,
        { failures: failures.slice(0, 50) },
        "warn"
      );
    }
  }
}

// Turn a raw Discord error into an actionable reason. The most common one for
// archiving is a 403 Missing Access (code 50001), which means the bot's role
// lacks View Channel and/or Read Message History in that specific channel.
function describeChannelError(err: unknown): string {
  const msg = (err as Error).message ?? String(err);
  if (msg.includes("50001") || msg.includes(" 403")) {
    return "Missing Access (403) — the bot's role needs View Channel + Read Message History on this channel";
  }
  if (msg.includes("50013") || msg.includes(" 401")) {
    return "Missing Permissions — grant the bot Read Message History here";
  }
  if (msg.includes(" 404")) {
    return "Channel not found (404) — it may have been deleted";
  }
  return msg.slice(0, 300);
}

async function archiveChannel(
  guildId: string,
  channelId: string,
  channelName: string
): Promise<number> {
  const dir = path.join(archiveDir(), guildId);
  const mediaDirPath = path.join(dir, "media");
  await mkdir(mediaDirPath, { recursive: true });
  const jsonlPath = path.join(dir, `${channelId}.jsonl`);

  const state = await prisma.archiveChannelState.upsert({
    where: { guildId_channelId: { guildId, channelId } },
    create: { guildId, channelId, channelName },
    update: { channelName },
  });

  // One-time: feed MessageEvent from any JSONL already on disk (messages
  // archived before MessageEvent-feeding existed). Idempotent via
  // skipDuplicates; gated by eventsBackfilledAt so it runs once per channel.
  if (!state.eventsBackfilledAt && existsSync(jsonlPath)) {
    try {
      const inserted = await reconcileEventsFromFile(guildId, channelId, jsonlPath);
      await prisma.archiveChannelState.update({
        where: { guildId_channelId: { guildId, channelId } },
        data: { eventsBackfilledAt: new Date() },
      });
      if (inserted > 0) {
        console.log(
          `[archive] reconciled ${inserted} MessageEvent row(s) from #${channelName}'s archive`
        );
        audit(
          guildId,
          "archive.reconciled",
          `Backfilled ${inserted} activity record(s) from #${channelName}'s archive`,
          { channelId, channelName, inserted }
        );
      }
    } catch (err) {
      console.warn(`[archive] event reconcile failed for ${channelId}:`, err);
    }
  }

  // Writes a page: media first, then JSONL, then advance the appropriate
  // cursor(s) — so an interrupted run never records progress past content it
  // didn't persist. Sets lastMessageId/oldestMessageId from the page bounds
  // (only when they extend the archived range).
  const writePage = async (
    messages: DiscordMessageRaw[],
    opts: { setLast?: boolean; setOldest?: boolean; backfillComplete?: boolean }
  ) => {
    let mediaCount = 0;
    let mediaBytes = 0n;
    for (const m of messages) {
      const s = await archiveAttachments(mediaDirPath, m);
      mediaCount += s.count;
      mediaBytes += BigInt(s.bytes);
    }
    if (messages.length > 0) {
      await appendFile(
        jsonlPath,
        messages.map((m) => JSON.stringify(m)).join("\n") + "\n",
        "utf8"
      );
      // Backfill MessageEvent (the activity index behind the leaderboard/graph)
      // from archived history, so stats reach back to each channel's start —
      // not just when real-time logging was enabled. skipDuplicates makes this
      // idempotent against the live logger and re-runs.
      await prisma.messageEvent
        .createMany({
          data: messages.map((m) => ({
            id: m.id,
            guildId,
            channelId,
            authorId: m.author.id,
            isBot: Boolean(m.author.bot),
            sentAt: new Date(m.timestamp),
          })),
          skipDuplicates: true,
        })
        .catch((err) =>
          console.warn(`[archive] MessageEvent backfill failed for ${channelId}:`, err)
        );
    }
    await prisma.archiveChannelState.update({
      where: { guildId_channelId: { guildId, channelId } },
      data: {
        ...(opts.setLast && messages.length > 0
          ? { lastMessageId: messages[messages.length - 1].id }
          : {}),
        ...(opts.setOldest && messages.length > 0
          ? { oldestMessageId: messages[0].id }
          : {}),
        ...(opts.backfillComplete ? { backfillComplete: true } : {}),
        archivedCount: { increment: messages.length },
        mediaCount: { increment: mediaCount },
        mediaBytes: { increment: mediaBytes },
      },
    });
  };

  let added = 0;
  let pages = 0;
  const budget = () => pages < MAX_PAGES_PER_CHANNEL_PER_TICK;

  // --- Phase 1: forward — keep up with messages newer than lastMessageId ---
  if (state.lastMessageId) {
    let cursor = state.lastMessageId;
    while (budget()) {
      pages++;
      const { messages, hasMore } = await fetchMessagesAfter(channelId, cursor);
      if (messages.length === 0) break;
      await writePage(messages, { setLast: true });
      cursor = messages[messages.length - 1].id;
      added += messages.length;
      if (!hasMore) break;
    }
  }

  // --- Phase 2: backfill — walk older history down to the channel start ---
  // Backfill cursor: the oldest archived id, or (for channels stuck on the old
  // forward-only bug) fall back to lastMessageId so we re-walk backward from
  // there. undefined → fetch the newest page first (seeds a fresh channel).
  if (!state.backfillComplete) {
    let before: string | undefined =
      state.oldestMessageId ?? state.lastMessageId ?? undefined;
    // Fresh channel with no cursors at all: the first backward page (no
    // `before`) is the newest page and also seeds lastMessageId.
    const seeding = !state.lastMessageId && !state.oldestMessageId;
    while (budget()) {
      pages++;
      const { messages, hasMore } = await fetchMessagesBefore(channelId, before);
      if (messages.length === 0) {
        await markBackfillComplete(guildId, channelId);
        break;
      }
      await writePage(messages, {
        setOldest: true,
        // On the seed page of a brand-new channel, also set the forward cursor.
        setLast: seeding && pages === 1,
        backfillComplete: !hasMore,
      });
      before = messages[0].id;
      added += messages.length;
      if (!hasMore) break; // reached the channel's first message
    }
  }

  return added;
}

async function markBackfillComplete(guildId: string, channelId: string) {
  await prisma.archiveChannelState.update({
    where: { guildId_channelId: { guildId, channelId } },
    data: { backfillComplete: true },
  });
}

// Streams a channel's JSONL and inserts a MessageEvent row per line (batched,
// skipDuplicates). Used once per channel to reconcile already-archived history
// into the activity index. Returns how many rows the DB reported inserting.
async function reconcileEventsFromFile(
  guildId: string,
  channelId: string,
  jsonlPath: string
): Promise<number> {
  const rl = readline.createInterface({
    input: createReadStream(jsonlPath, "utf8"),
    crlfDelay: Infinity,
  });
  let batch: Array<{
    id: string;
    guildId: string;
    channelId: string;
    authorId: string;
    isBot: boolean;
    sentAt: Date;
  }> = [];
  let inserted = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const res = await prisma.messageEvent.createMany({
      data: batch,
      skipDuplicates: true,
    });
    inserted += res.count;
    batch = [];
  };

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line) as DiscordMessageRaw;
      if (!m.id || !m.author?.id || !m.timestamp) continue;
      batch.push({
        id: m.id,
        guildId,
        channelId,
        authorId: m.author.id,
        isBot: Boolean(m.author.bot),
        sentAt: new Date(m.timestamp),
      });
      if (batch.length >= 1000) await flush();
    } catch {
      // skip malformed line
    }
  }
  await flush();
  return inserted;
}

async function archiveAttachments(
  mediaDirPath: string,
  m: DiscordMessageRaw
): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  for (const a of m.attachments) {
    if (a.size > MEDIA_FILE_CAP) continue;
    try {
      const res = await fetch(a.url); // pre-signed URL from the API response
      if (!res.ok) continue;
      const buf = new Uint8Array(await res.arrayBuffer());
      const safeName = a.filename.replace(/[^\w.-]+/g, "_").slice(0, 120);
      await writeFile(path.join(mediaDirPath, `${a.id}-${safeName}`), buf);
      count++;
      bytes += buf.byteLength;
    } catch {
      // Skipped — metadata still lives in the JSONL line.
    }
  }
  return { count, bytes };
}
