// Recomputes each guild's server stats on a schedule (and on demand via the
// refresh flag), storing the result in StatsCache so the Stats page is an
// instant read. Mirrors leaderboard-worker's shape.
//
// Deliberately gateway-free: computeServerStats only needs Postgres + Discord
// REST, so this worker can be lifted into its own container if the bot ever
// needs the headroom — see the commented stats-worker service in
// docker-compose.prod.yml. In-process it's cheap: the aggregates run inside
// Postgres and the Node side just reshapes small result sets.

import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { computeServerStats } from "@/lib/server-stats";
import type { Prisma } from "@prisma/client";

const POLL_MS = 60_000;
const REFRESH_MINUTES = Number(process.env.STATS_REFRESH_MINUTES ?? "60");

export function runStatsWorker() {
  // 0 (or negative) disables the in-bot worker — used when running the
  // standalone stats container instead (see docker-compose.prod.yml).
  if (REFRESH_MINUTES <= 0) {
    console.log("[stats] disabled (STATS_REFRESH_MINUTES <= 0)");
    return;
  }
  console.log(`[stats] refreshing every ${REFRESH_MINUTES}m (poll ${POLL_MS}ms)`);
  prisma.statsCache
    .updateMany({ where: { computing: true }, data: { computing: false } })
    .catch((err) => console.warn("[stats] startup reset failed:", err));

  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (err) {
      console.error("[stats] tick failed:", err);
    } finally {
      running = false;
    }
  }, POLL_MS);
  // First pass shortly after boot so the page has data without waiting a cycle.
  setTimeout(() => tick().catch(() => {}), 30_000);
}

async function tick() {
  const guilds = await prisma.guild.findMany({ select: { id: true } });
  const staleBefore = new Date(Date.now() - REFRESH_MINUTES * 60_000);

  for (const g of guilds) {
    const cache = await prisma.statsCache.findUnique({ where: { guildId: g.id } });
    const needs =
      !cache ||
      cache.refreshRequested ||
      cache.generatedAt === null ||
      cache.generatedAt < staleBefore;
    if (!needs) continue;
    // Manual "Refresh" clicks set refreshRequested (already audited by the
    // API route); everything else is a scheduled/stale rebuild.
    const trigger = cache?.refreshRequested ? "manual" : "scheduled";

    await prisma.statsCache.upsert({
      where: { guildId: g.id },
      create: { guildId: g.id, computing: true },
      update: { computing: true, refreshRequested: false },
    });
    const started = Date.now();
    try {
      const data = await computeServerStats(g.id);
      await prisma.statsCache.update({
        where: { guildId: g.id },
        data: {
          data: data as unknown as Prisma.InputJsonValue,
          generatedAt: new Date(),
          computing: false,
        },
      });
      const ms = Date.now() - started;
      console.log(`[stats] computed ${g.id} in ${ms}ms`);
      audit(
        g.id,
        "stats.refreshed",
        `Server stats rebuilt (${trigger}) — ${data.tiles.totalMessages.toLocaleString()} messages, ${data.tiles.totalAuthors.toLocaleString()} member(s) analyzed in ${(ms / 1000).toFixed(1)}s`,
        {
          trigger,
          ms,
          totalMessages: data.tiles.totalMessages,
          totalAuthors: data.tiles.totalAuthors,
          memberCount: data.tiles.memberCount,
        }
      );
    } catch (err) {
      console.error(`[stats] compute failed for ${g.id}:`, err);
      audit(
        g.id,
        "stats.refresh_failed",
        `Server stats rebuild failed (${trigger})`,
        { trigger, error: (err as Error).message?.slice(0, 500) },
        "error"
      );
      await prisma.statsCache
        .update({ where: { guildId: g.id }, data: { computing: false } })
        .catch(() => {});
    }
  }
}
