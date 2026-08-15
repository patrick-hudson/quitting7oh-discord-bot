// One-time historical reaction crawl. The live MessageReactionAdd handler only
// sees reactions from deploy day forward; this worker recovers the past from
// the message archive: every archived message stores which emojis it carries
// (with counts), and Discord's reactions endpoint still lists WHO currently
// has each one. What Discord cannot tell us is WHEN a reaction was added, so
// backfilled rows use the message's own timestamp and are flagged
// `backfilled` — charts date them by the message they landed on.
//
// Shape: poll for archived channels (backfillComplete) that haven't had their
// reactions crawled (reactionsBackfilledAt null), process ONE channel per
// tick, stamp it, repeat until none remain — then this worker idles for good.
// The (messageId, reactorId, emoji) unique constraint makes the whole thing
// idempotent and merge-safe with live tracking. Paced gently: this is a
// background crawl sharing rate limits with everything else the bot does.

import { createReadStream } from "node:fs";
import { existsSync } from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { archiveDir } from "@/bot/archive-worker";
import { listReactionUsers, type DiscordMessageRaw } from "@/lib/discord-rest";

const POLL_MS = 5 * 60_000;
const PACE_MS = 400; // between reaction-endpoint calls (~2.5/sec)

export function runReactionBackfill() {
  console.log("[reaction-backfill] polling for archived channels to crawl");
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (err) {
      console.error("[reaction-backfill] tick failed:", err);
    } finally {
      running = false;
    }
  }, POLL_MS);
  setTimeout(() => tick().catch(() => {}), 60_000);
}

async function tick() {
  // One channel per tick keeps each unit of work small and resumable.
  const state = await prisma.archiveChannelState.findFirst({
    where: { backfillComplete: true, reactionsBackfilledAt: null },
    orderBy: { updatedAt: "asc" },
  });
  if (!state) return;

  const file = path.join(archiveDir(), state.guildId, `${state.channelId}.jsonl`);
  if (!existsSync(file)) {
    // Archive file missing (moved/pruned) — stamp so we don't retry forever.
    await stamp(state.id);
    return;
  }

  console.log(`[reaction-backfill] crawling #${state.channelName} (${state.channelId})`);
  let messagesWithReactions = 0;
  let rowsInserted = 0;
  let emojiFetches = 0;

  const rl = readline.createInterface({
    input: createReadStream(file, "utf8"),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.includes('"reactions"')) continue; // cheap pre-filter
    let m: DiscordMessageRaw;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (!m.reactions || m.reactions.length === 0) continue;
    messagesWithReactions++;
    const sentAt = new Date(m.timestamp);

    for (const r of m.reactions) {
      try {
        await sleep(PACE_MS);
        emojiFetches++;
        const users = await listReactionUsers(state.channelId, m.id, r.emoji);
        if (users.length === 0) continue;
        const res = await prisma.reactionEvent.createMany({
          data: users.map((u) => ({
            guildId: state.guildId,
            channelId: state.channelId,
            messageId: m.id,
            reactorId: u.id,
            emoji: r.emoji.name ?? r.emoji.id ?? "?",
            isBot: u.bot ?? false,
            backfilled: true,
            sentAt,
          })),
          skipDuplicates: true,
        });
        rowsInserted += res.count;
      } catch (err) {
        // One bad emoji/message shouldn't sink the channel; move on.
        console.warn(
          `[reaction-backfill] fetch failed for msg ${m.id} ${r.emoji.name}:`,
          (err as Error).message?.slice(0, 200)
        );
      }
    }
  }

  await stamp(state.id);
  console.log(
    `[reaction-backfill] #${state.channelName}: ${rowsInserted} reactions from ${messagesWithReactions} message(s) (${emojiFetches} fetches)`
  );
  audit(
    state.guildId,
    "stats.reactions_backfilled",
    `Recovered ${rowsInserted.toLocaleString()} historical reaction(s) in #${state.channelName}`,
    {
      channelId: state.channelId,
      messagesWithReactions,
      rowsInserted,
      emojiFetches,
    }
  );
}

function stamp(id: string) {
  return prisma.archiveChannelState.update({
    where: { id },
    data: { reactionsBackfilledAt: new Date() },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
