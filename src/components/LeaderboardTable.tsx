"use client";

// Renders the contributor leaderboard and handles per-user drill-down: click a
// row to expand a per-channel breakdown, lazily fetched from
// /api/guilds/[guildId]/leaderboard/[userId]. Sorting stays server-side (column
// headers are links that re-render the page with ?sort=), so this component
// receives already-sorted, serializable rows.

import Link from "next/link";
import { useState } from "react";
import { LocalTime } from "@/components/LocalTime";

type Row = {
  authorId: string;
  name: string | null;
  present: boolean;
  total: number;
  d7: number;
  d30: number;
  activeDays: number;
  consistency: number;
  channels: number;
  tenureDays: number;
  lastSeen: string;
  roleNames: string[];
};

type Column = { key: string; label: string; hint: string };
type Breakdown = { channelId: string; count: number; lastSeen: string | null };

export function LeaderboardTable({
  guildId,
  rows,
  columns,
  sortKey,
  channelNames,
}: {
  guildId: string;
  rows: Row[];
  columns: Column[];
  sortKey: string;
  channelNames: Record<string, string>;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  // Cache fetched breakdowns by authorId so re-expanding is instant.
  const [cache, setCache] = useState<Record<string, Breakdown[] | "loading" | "error">>(
    {}
  );

  async function toggle(authorId: string) {
    if (expanded === authorId) {
      setExpanded(null);
      return;
    }
    setExpanded(authorId);
    if (cache[authorId]) return;
    setCache((c) => ({ ...c, [authorId]: "loading" }));
    try {
      const res = await fetch(`/api/guilds/${guildId}/leaderboard/${authorId}`);
      if (!res.ok) throw new Error();
      const d = (await res.json()) as { channels: Breakdown[] };
      setCache((c) => ({ ...c, [authorId]: d.channels }));
    } catch {
      setCache((c) => ({ ...c, [authorId]: "error" }));
    }
  }

  const colSpan = columns.length + 3; // #, member, ...columns, roles

  return (
    <div className="mt-6 overflow-x-auto rounded-2xl ring-1 ring-white/10">
      <table className="w-full text-left text-sm">
        <thead className="bg-white/[0.03] text-xs uppercase tracking-wide text-white/50">
          <tr>
            <th className="w-12 px-3 py-2 font-medium">#</th>
            <th className="px-3 py-2 font-medium">Member</th>
            {columns.map((c) => (
              <th key={c.key} className="px-3 py-2 font-medium" title={c.hint}>
                <Link
                  href={`/dashboard/${guildId}/leaderboard?sort=${c.key}`}
                  className={`hover:text-white ${sortKey === c.key ? "text-white" : ""}`}
                >
                  {c.label}
                  {sortKey === c.key ? " ↓" : ""}
                </Link>
              </th>
            ))}
            <th className="px-3 py-2 font-medium">Roles</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {rows.map((r, i) => {
            const open = expanded === r.authorId;
            const bd = cache[r.authorId];
            return (
              <RowGroup key={r.authorId}>
                <tr
                  className="cursor-pointer bg-white/[0.02] hover:bg-white/[0.04]"
                  onClick={() => void toggle(r.authorId)}
                >
                  <td className="w-12 whitespace-nowrap px-3 py-2 text-white/40">
                    {/* inline-flex + gap (not a text-node space) keeps the
                        caret and rank on one line — a breaking space here let
                        two-digit ranks wrap the number onto a second line when
                        the row grew tall. */}
                    <span className="inline-flex items-baseline gap-1">
                      <span className="w-3 shrink-0 text-white/30">
                        {open ? "▾" : "▸"}
                      </span>
                      <span className="tabular-nums">{i + 1}</span>
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {r.name ? (
                      <span className="font-medium text-white/90">
                        {r.name}
                        {!r.present && (
                          <span className="ml-1 text-[10px] text-white/40">(left)</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-white/40">
                        <span className="font-mono text-xs">{r.authorId}</span>{" "}
                        <span className="text-[10px]">(left)</span>
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-white/80">
                    {r.total.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-white/80">{r.d30}</td>
                  <td className="px-3 py-2 tabular-nums text-white/80">{r.d7}</td>
                  <td className="px-3 py-2 tabular-nums text-white/80">{r.activeDays}</td>
                  <td className="px-3 py-2 tabular-nums text-white/70">{r.consistency}%</td>
                  <td className="px-3 py-2 tabular-nums text-white/70">{r.channels}</td>
                  <td className="px-3 py-2 text-xs text-white/50">{r.tenureDays}d ago</td>
                  <td className="px-3 py-2 text-xs text-white/50">
                    <LocalTime iso={r.lastSeen} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex max-w-[220px] flex-wrap gap-1">
                      {r.roleNames.map((n) => (
                        <span
                          key={n}
                          className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-white/60"
                        >
                          {n}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
                {open && (
                  <tr className="bg-black/20">
                    <td colSpan={colSpan} className="px-6 py-3">
                      <ChannelBreakdown
                        data={bd}
                        channelNames={channelNames}
                        total={r.total}
                      />
                    </td>
                  </tr>
                )}
              </RowGroup>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// <tbody> can't contain fragments directly across some tooling; a keyed
// wrapper keeps the two <tr>s grouped without an extra DOM element.
function RowGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function ChannelBreakdown({
  data,
  channelNames,
  total,
}: {
  data: Breakdown[] | "loading" | "error" | undefined;
  channelNames: Record<string, string>;
  total: number;
}) {
  if (!data || data === "loading") {
    return <p className="text-xs text-white/40">Loading channel breakdown…</p>;
  }
  if (data === "error") {
    return <p className="text-xs text-red-300">Couldn&apos;t load the breakdown.</p>;
  }
  if (data.length === 0) {
    return <p className="text-xs text-white/40">No per-channel data.</p>;
  }
  const max = Math.max(...data.map((d) => d.count));
  return (
    <div className="space-y-1">
      <p className="mb-1 text-xs uppercase tracking-wide text-white/40">
        Messages by channel
      </p>
      {data.map((d) => (
        <div key={d.channelId} className="flex items-center gap-2 text-xs">
          <span className="w-40 shrink-0 truncate text-white/70">
            #{channelNames[d.channelId] ?? d.channelId.slice(-6)}
          </span>
          <div className="h-2 flex-1 overflow-hidden rounded bg-white/5">
            <div
              className="h-full rounded bg-[color:var(--color-brand-500)]"
              style={{ width: `${Math.max(2, (d.count / max) * 100)}%` }}
            />
          </div>
          <span className="w-12 shrink-0 text-right tabular-nums text-white/70">
            {d.count.toLocaleString()}
          </span>
          <span className="w-10 shrink-0 text-right tabular-nums text-white/40">
            {Math.round((d.count / total) * 100)}%
          </span>
        </div>
      ))}
    </div>
  );
}
