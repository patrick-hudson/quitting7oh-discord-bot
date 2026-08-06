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
import path from "node:path";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import {
  fetchMessagesAfter,
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
    try {
      const channels = await listTextChannels(g.id);
      for (const ch of channels) {
        const added = await archiveChannel(g.id, ch.id, ch.name);
        if (added > 0) {
          totalNew += added;
          touched.push(`#${ch.name} (+${added})`);
        }
      }
      if (totalNew > 0) {
        console.log(`[archive] ${g.name}: +${totalNew} message(s)`);
        audit(g.id, "archive.ran", `Archived ${totalNew} new message(s)`, {
          channels: touched.slice(0, 25),
          totalNew,
        });
      }
    } catch (err) {
      console.error(`[archive] failed for guild ${g.id}:`, err);
      audit(
        g.id,
        "archive.failed",
        "Archive run failed — will retry next interval",
        { error: (err as Error).message?.slice(0, 500) },
        "error"
      );
    }
  }
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

  let cursor = state.lastMessageId ?? undefined;
  let added = 0;
  let mediaCount = 0;
  let mediaBytes = 0n;

  for (let page = 0; page < MAX_PAGES_PER_CHANNEL_PER_TICK; page++) {
    const { messages, hasMore } = await fetchMessagesAfter(channelId, cursor);
    if (messages.length === 0) break;

    // Media first, then JSONL, then cursor — so an interrupted run never
    // advances past content it didn't persist.
    for (const m of messages) {
      const stats = await archiveAttachments(mediaDirPath, m);
      mediaCount += stats.count;
      mediaBytes += BigInt(stats.bytes);
    }
    const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await appendFile(jsonlPath, lines, "utf8");

    cursor = messages[messages.length - 1].id;
    added += messages.length;
    await prisma.archiveChannelState.update({
      where: { guildId_channelId: { guildId, channelId } },
      data: {
        lastMessageId: cursor,
        archivedCount: { increment: messages.length },
        mediaCount: { increment: mediaCount },
        mediaBytes: { increment: mediaBytes },
      },
    });
    mediaCount = 0;
    mediaBytes = 0n;

    if (!hasMore) break;
  }

  return added;
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
