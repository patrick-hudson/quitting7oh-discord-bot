// Server stats — activity, growth, retention, recovery pulse, reactions, and
// moderation trends, rendered from the precomputed StatsCache blob (built by
// src/bot/stats-worker.ts). Pure read; the Refresh button requests a recompute
// through the API and polls until the worker lands it.

import { prisma } from "@/lib/db";
import { requireGuildAccess } from "@/lib/authz";
import { AutoRefresh } from "@/components/AutoRefresh";
import { StatsDashboard } from "@/components/stats/StatsDashboard";
import { StatsRefresh } from "@/components/stats/StatsRefresh";
import { normalizeServerStats } from "@/lib/server-stats";

export default async function StatsPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;
  await requireGuildAccess(guildId);

  // normalizeServerStats fills defaults for sections the cached blob predates
  // (cache and code deploy independently) and returns null for a blob that
  // isn't a stats payload at all — both fall back to the "building" state.
  const cache = await prisma.statsCache.findUnique({ where: { guildId } });
  const data =
    cache?.generatedAt != null ? normalizeServerStats(cache.data) : null;

  return (
    <div className="mx-auto max-w-7xl">
      {!data && <AutoRefresh intervalMs={10_000} />}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Server stats</h1>
          <p className="mt-1 text-sm text-white/60">
            Activity, growth, retention, and the community&apos;s recovery pulse
            {data?.tiles.firstEventAt
              ? ` — tracked since ${data.tiles.firstEventAt.slice(0, 10)}`
              : ""}
            . Numbers come from the bot&apos;s own observations, so they cover
            what it has seen, not Discord&apos;s full history.
          </p>
        </div>
        <StatsRefresh
          guildId={guildId}
          generatedAt={cache?.generatedAt?.toISOString() ?? null}
          computing={cache?.computing ?? false}
        />
      </div>

      {data ? (
        <StatsDashboard data={data} />
      ) : (
        <div className="mt-8 rounded-2xl border border-dashed border-white/10 p-10 text-center text-white/60">
          {cache?.computing
            ? "Crunching the numbers — this page refreshes itself when the first build lands."
            : "No stats built yet. The stats worker runs within a minute of the bot booting; this page checks back automatically."}
        </div>
      )}
    </div>
  );
}
