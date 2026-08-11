// Contributor leaderboard — a pure read of the precomputed LeaderboardCache
// (built in the background by the leaderboard worker). No aggregate scan or
// Discord calls at request time, so it loads instantly. Sorting is done here
// in-memory over the cached rows via ?sort.

import { prisma } from "@/lib/db";
import { LeaderboardTable } from "@/components/LeaderboardTable";
import { LeaderboardRefresh } from "@/components/LeaderboardRefresh";
import type { LeaderboardData, LeaderboardRow } from "@/lib/leaderboard";

type SortKey =
  | "d30"
  | "d7"
  | "total"
  | "activeDays"
  | "consistency"
  | "channels"
  | "tenure"
  | "lastSeen";

const COLUMNS: Array<{ key: SortKey; label: string; hint: string }> = [
  { key: "total", label: "Total", hint: "All messages logged" },
  { key: "d30", label: "30d", hint: "Messages in the last 30 days" },
  { key: "d7", label: "7d", hint: "Messages in the last 7 days" },
  { key: "activeDays", label: "Active days", hint: "Distinct days they posted" },
  {
    key: "consistency",
    label: "Consistency",
    hint: "Share of days-since-first-post that they posted",
  },
  { key: "channels", label: "Channels", hint: "Distinct channels posted in" },
  { key: "tenure", label: "First post", hint: "How long they've been posting" },
  { key: "lastSeen", label: "Last active", hint: "Most recent message" },
];

export default async function LeaderboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ guildId: string }>;
  searchParams: Promise<{ sort?: string }>;
}) {
  const { guildId } = await params;
  const { sort } = await searchParams;
  const sortKey: SortKey = (COLUMNS.find((c) => c.key === sort)?.key ??
    "d30") as SortKey;

  const cache = await prisma.leaderboardCache.findUnique({ where: { guildId } });
  const data = (cache?.data as unknown as LeaderboardData | undefined) ?? {
    rows: [],
    channelNames: {},
  };
  const rows: LeaderboardRow[] = Array.isArray(data.rows) ? data.rows : [];

  const sorted = [...rows].sort((a, b) => {
    switch (sortKey) {
      case "total":
        return b.total - a.total;
      case "d7":
        return b.d7 - a.d7;
      case "activeDays":
        return b.activeDays - a.activeDays;
      case "consistency":
        return b.consistency - a.consistency;
      case "channels":
        return b.channels - a.channels;
      case "tenure":
        return b.tenureDays - a.tenureDays;
      case "lastSeen":
        return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
      case "d30":
      default:
        return b.d30 - a.d30;
    }
  });

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Contributor leaderboard
          </h1>
          <p className="mt-1 text-sm text-white/60">
            Member activity from the message log — who posts, how much, how
            consistently, and how long they&apos;ve been around. Sort by any
            column, or expand a row for the per-channel breakdown.
          </p>
        </div>
        <LeaderboardRefresh
          guildId={guildId}
          generatedAt={cache?.generatedAt?.toISOString() ?? null}
          computing={cache?.computing ?? false}
        />
      </div>
      <p className="mt-2 text-xs text-white/40">
        Recomputed in the background on a schedule (and on demand via Refresh).
        Covers all activity the bot has recorded; with the full message archive
        enabled it backfills toward each channel&apos;s start over time. Bots
        excluded. Departed members resolve via snapshots, then a Discord lookup.
      </p>

      {sorted.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-dashed border-white/10 p-12 text-center text-white/60">
          {cache?.generatedAt
            ? "No message activity logged yet."
            : "Leaderboard is being generated — check back in a minute."}
        </div>
      ) : (
        <LeaderboardTable
          guildId={guildId}
          rows={sorted}
          columns={COLUMNS}
          sortKey={sortKey}
          channelNames={data.channelNames ?? {}}
        />
      )}
    </div>
  );
}
