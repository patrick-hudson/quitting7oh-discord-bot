// Recomputes each guild's contributor leaderboard on a schedule (and on
// demand via the refresh flag), storing the finished result in
// LeaderboardCache so the portal page is an instant read. The computation
// itself (aggregate + Discord name resolution) is what used to make the page
// take 15-30s; here it runs in the background where latency doesn't matter.

import { prisma } from "@/lib/db";
import { computeLeaderboard } from "@/lib/leaderboard";
import type { Prisma } from "@prisma/client";

const POLL_MS = 60_000;
const REFRESH_HOURS = Number(process.env.LEADERBOARD_REFRESH_HOURS ?? "6");

export function runLeaderboardWorker() {
  console.log(`[leaderboard] refreshing every ${REFRESH_HOURS}h (poll ${POLL_MS}ms)`);
  // Clear any stuck "computing" flags from a previous process.
  prisma.leaderboardCache
    .updateMany({ where: { computing: true }, data: { computing: false } })
    .catch((err) => console.warn("[leaderboard] startup reset failed:", err));

  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (err) {
      console.error("[leaderboard] tick failed:", err);
    } finally {
      running = false;
    }
  }, POLL_MS);
  // First pass shortly after boot so caches exist without waiting a full cycle.
  setTimeout(() => tick().catch(() => {}), 20_000);
}

async function tick() {
  const guilds = await prisma.guild.findMany({ select: { id: true } });
  const staleBefore = new Date(Date.now() - REFRESH_HOURS * 60 * 60_000);

  for (const g of guilds) {
    const cache = await prisma.leaderboardCache.findUnique({
      where: { guildId: g.id },
    });
    const needs =
      !cache ||
      cache.refreshRequested ||
      cache.generatedAt === null ||
      cache.generatedAt < staleBefore;
    if (!needs) continue;

    await prisma.leaderboardCache.upsert({
      where: { guildId: g.id },
      create: { guildId: g.id, computing: true },
      update: { computing: true, refreshRequested: false },
    });
    try {
      const data = await computeLeaderboard(g.id);
      await prisma.leaderboardCache.update({
        where: { guildId: g.id },
        data: {
          data: data as unknown as Prisma.InputJsonValue,
          generatedAt: new Date(),
          computing: false,
        },
      });
      console.log(`[leaderboard] refreshed ${g.id} (${data.rows.length} rows)`);
    } catch (err) {
      console.error(`[leaderboard] compute failed for ${g.id}:`, err);
      await prisma.leaderboardCache
        .update({ where: { guildId: g.id }, data: { computing: false } })
        .catch(() => {});
    }
  }
}
