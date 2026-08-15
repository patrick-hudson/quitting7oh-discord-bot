// One-time recovery of historical member joins from the message archive.
// Discord posts a type-7 system message ("X joined") to the configured
// system-messages channel; its author IS the joiner and its timestamp IS the
// join time. This guild moved that channel over time (#general, then
// #joins-leaves), so the scan covers EVERY archived channel — wherever join
// messages lived, they're found. Pure local file reads, no Discord API calls.
//
// Live joins are recorded by the GuildMemberAdd listener in src/bot/index.ts;
// the message-snowflake id plus the (guildId, userId, joinedAt) unique
// constraint keep the two sources from double-counting.

import { createReadStream, existsSync } from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { archiveDir } from "@/bot/archive-worker";
import type { DiscordMessageRaw } from "@/lib/discord-rest";

const POLL_MS = 5 * 60_000;
const GUILD_MEMBER_JOIN = 7; // Discord message type

export type ParsedJoin = {
  id: string; // the system message's snowflake
  userId: string;
  username: string;
  joinedAt: Date;
};

export function runJoinBackfill() {
  console.log("[join-backfill] polling for archived channels to scan");
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (err) {
      console.error("[join-backfill] tick failed:", err);
    } finally {
      running = false;
    }
  }, POLL_MS);
  setTimeout(() => tick().catch(() => {}), 45_000);
}

async function tick() {
  // Local file scans are cheap — clear the whole queue in one pass.
  const states = await prisma.archiveChannelState.findMany({
    where: { backfillComplete: true, joinsBackfilledAt: null },
    orderBy: { updatedAt: "asc" },
  });
  for (const state of states) {
    const file = path.join(archiveDir(), state.guildId, `${state.channelId}.jsonl`);
    let inserted = 0;
    let found = 0;
    if (existsSync(file)) {
      const joins = await scanJoinMessages(file);
      found = joins.length;
      if (joins.length > 0) {
        const res = await prisma.memberJoinEvent.createMany({
          data: joins.map((j) => ({
            id: j.id,
            guildId: state.guildId,
            userId: j.userId,
            username: j.username,
            source: "system_message",
            joinedAt: j.joinedAt,
          })),
          skipDuplicates: true,
        });
        inserted = res.count;
      }
    }
    await prisma.archiveChannelState.update({
      where: { id: state.id },
      data: { joinsBackfilledAt: new Date() },
    });
    if (found > 0) {
      console.log(
        `[join-backfill] #${state.channelName}: ${inserted} join(s) recovered (${found} found)`
      );
      audit(
        state.guildId,
        "stats.joins_backfilled",
        `Recovered ${inserted.toLocaleString()} historical join(s) from #${state.channelName}`,
        { channelId: state.channelId, found, inserted }
      );
    }
  }
}

// Exported for testing against exported archive files.
export async function scanJoinMessages(file: string): Promise<ParsedJoin[]> {
  const joins: ParsedJoin[] = [];
  const rl = readline.createInterface({
    input: createReadStream(file, "utf8"),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.includes('"type":7,') && !line.includes('"type": 7,')) continue;
    let m: DiscordMessageRaw;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.type !== GUILD_MEMBER_JOIN || !m.author?.id) continue;
    const ts = new Date(m.timestamp);
    if (Number.isNaN(ts.getTime())) continue;
    joins.push({
      id: m.id,
      userId: m.author.id,
      username: m.author.global_name || m.author.username || m.author.id,
      joinedAt: ts,
    });
  }
  return joins;
}
