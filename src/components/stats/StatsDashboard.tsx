"use client";

// The Stats page body — renders a precomputed ServerStatsData blob. All charts
// follow the dataviz method: validated dark categorical palette, one axis per
// chart, thin marks, legends for multi-series, tooltips everywhere, text in
// text tokens (never series colors). Sections whose source data doesn't exist
// yet (snapshots, milestone tiers, moderation) hide with a hint instead of
// rendering empty axes.

import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ServerStatsData } from "@/lib/server-stats";

// Validated dark-surface categorical palette (dataviz reference instance).
const C = {
  blue: "#3987e5",
  aqua: "#199e70",
  yellow: "#c98500",
  violet: "#9085e9",
  red: "#e66767",
  magenta: "#d55181",
  orange: "#d95926",
  blueSoft: "#86b6ef",
  good: "#0ca30c",
  critical: "#d03b3b",
};
// Sequential blue, low → high on a dark surface (near-zero recedes to bg).
const SEQ = ["#104281", "#1c5cab", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4"];
const GRID = "rgba(255,255,255,0.06)";
const TICK = { fill: "rgba(255,255,255,0.45)", fontSize: 11 } as const;

const nf = new Intl.NumberFormat("en-US");
const fmtDay = (d: string) =>
  new Date(d + "T00:00:00Z").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
const fmtMonth = (m: string) =>
  new Date(m + "-15T00:00:00Z").toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });

export function StatsDashboard({ data }: { data: ServerStatsData }) {
  if (data.tiles.totalMessages === 0) {
    return (
      <div className="mt-8 rounded-2xl border border-dashed border-white/10 p-10 text-center text-white/60">
        No message activity recorded yet. Stats fill in as the bot observes the
        server.
      </div>
    );
  }
  return (
    <div className="mt-6 space-y-10">
      <Tiles data={data} />
      <ActivitySection data={data} />
      <MembersSection data={data} />
      <RecoverySection data={data} />
      <ReactionsSection data={data} />
      <RecordsSection data={data} />
      <ModerationSection data={data} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

function Tiles({ data }: { data: ServerStatsData }) {
  const t = data.tiles;
  const msgTrend = pctChange(t.messages7d, t.messagesPrev7d);
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <Tile
        label="Members"
        value={t.memberCount}
        sub={
          t.memberDelta30d !== null ? (
            <Delta value={t.memberDelta30d} suffix=" in 30d" />
          ) : null
        }
      />
      <Tile label="Online now" value={t.onlineCount} />
      <Tile
        label="Messages · 7d"
        value={t.messages7d}
        sub={msgTrend !== null ? <Delta pct={msgTrend} suffix=" vs prior week" /> : null}
      />
      <Tile
        label="Active members · 7d"
        value={t.activeMembers7d}
        sub={<span className="text-white/40">{nf.format(t.activeMembers30d)} in 30d</span>}
      />
      <Tile
        label="Engagement"
        value={t.engagementRate30d !== null ? pct(t.engagementRate30d) : null}
        sub={<span className="text-white/40">of members active in 30d</span>}
      />
      <Tile
        label="Stickiness"
        value={t.stickiness !== null ? pct(t.stickiness) : null}
        sub={<span className="text-white/40">daily ÷ monthly actives</span>}
      />
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
}: {
  label: string;
  value: number | string | null;
  sub?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl bg-white/[0.02] p-3.5 ring-1 ring-white/10">
      <p className="text-[11px] uppercase tracking-wide text-white/45">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-white/90">
        {value === null ? "—" : typeof value === "number" ? nf.format(value) : value}
      </p>
      {sub && <p className="mt-0.5 text-[11px]">{sub}</p>}
    </div>
  );
}

function Delta({
  value,
  pct: pctIn,
  suffix = "",
}: {
  value?: number;
  pct?: number;
  suffix?: string;
}) {
  const v = pctIn ?? value ?? 0;
  const up = v > 0;
  const flat = v === 0;
  const text =
    pctIn !== undefined
      ? `${Math.abs(pctIn).toFixed(0)}%`
      : nf.format(Math.abs(value ?? 0));
  return (
    <span style={{ color: flat ? "rgba(255,255,255,0.4)" : up ? C.good : C.critical }}>
      {flat ? "—" : up ? "▲" : "▼"} {text}
      <span className="text-white/40">{suffix}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

type Range = "30" | "90" | "all";

function ActivitySection({ data }: { data: ServerStatsData }) {
  const [range, setRange] = useState<Range>("90");
  const series = useMemo(() => {
    const rows = data.messagesPerDay.map((d, i, arr) => {
      const from = Math.max(0, i - 6);
      const avg =
        arr.slice(from, i + 1).reduce((n, r) => n + r.count, 0) / (i - from + 1);
      return { ...d, avg: Math.round(avg * 10) / 10 };
    });
    if (range === "all") return rows;
    return rows.slice(-Number(range));
  }, [data.messagesPerDay, range]);

  return (
    <Section
      title="Activity"
      aside={
        <div className="flex gap-1">
          {(["30", "90", "all"] as Range[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`rounded-md px-2 py-0.5 text-[11px] ring-1 transition ${
                range === r
                  ? "bg-white/10 text-white/90 ring-white/20"
                  : "text-white/50 ring-white/10 hover:bg-white/5"
              }`}
            >
              {r === "all" ? "All" : `${r}d`}
            </button>
          ))}
        </div>
      }
    >
      <Card
        title="Messages per day"
        legend={[
          { label: "Daily", color: C.blue },
          { label: "7-day average", color: C.blueSoft },
        ]}
      >
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={series} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis
              dataKey="date"
              tick={TICK}
              tickFormatter={fmtDay}
              axisLine={false}
              tickLine={false}
              minTickGap={40}
            />
            <YAxis tick={TICK} axisLine={false} tickLine={false} width={48} />
            <Tooltip content={<DarkTooltip labelFmt={fmtDay} />} />
            <Area
              type="monotone"
              dataKey="count"
              name="Messages"
              stroke={C.blue}
              strokeWidth={2}
              fill={C.blue}
              fillOpacity={0.18}
              activeDot={{ r: 4 }}
            />
            <Line
              type="monotone"
              dataKey="avg"
              name="7d avg"
              stroke={C.blueSoft}
              strokeWidth={2}
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="When the server is alive"
          sub={`Messages by hour × weekday, last 90 days (${data.timezone})`}
        >
          <Heatmap grid={data.heatmap} />
        </Card>
        <Card title="Channels · last 30 days" sub="vs the 30 days before">
          <ChannelBars channels={data.channels} />
        </Card>
      </div>
    </Section>
  );
}

function Heatmap({ grid }: { grid: number[][] }) {
  const max = Math.max(1, ...grid.flat());
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[560px]">
        {grid.map((row, d) => (
          <div key={d} className="flex items-center gap-[3px]">
            <span className="w-8 shrink-0 text-right text-[10px] text-white/40">
              {days[d]}
            </span>
            {row.map((v, h) => (
              <div
                key={h}
                title={`${days[d]} ${String(h).padStart(2, "0")}:00 — ${nf.format(v)} messages`}
                className="my-[1.5px] h-4 flex-1 rounded-[3px] transition hover:ring-1 hover:ring-white/40"
                style={{
                  backgroundColor:
                    v === 0 ? "rgba(255,255,255,0.03)" : seqColor(v / max),
                }}
              />
            ))}
          </div>
        ))}
        <div className="mt-1 flex items-center gap-[3px]">
          <span className="w-8 shrink-0" />
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} className="flex-1 text-center text-[9px] text-white/35">
              {h % 3 === 0 ? h : ""}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function ChannelBars({ channels }: { channels: ServerStatsData["channels"] }) {
  const top = channels.filter((c) => c.count30d > 0).slice(0, 10);
  if (top.length === 0)
    return <p className="text-sm text-white/40">No messages in the last 30 days.</p>;
  const max = Math.max(...top.map((c) => c.count30d));
  return (
    <ul className="space-y-2">
      {top.map((c) => {
        const trend = pctChange(c.count30d, c.prev30d);
        return (
          <li key={c.channelId} title={`#${c.name}: ${nf.format(c.count30d)} messages (30d), ${nf.format(c.total)} all-time`}>
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate text-white/75">#{c.name}</span>
              <span className="shrink-0 tabular-nums text-white/50">
                {nf.format(c.count30d)}{" "}
                {trend !== null && Math.abs(trend) >= 5 && (
                  <Delta pct={trend} />
                )}
              </span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/5">
              <div
                className="h-full rounded-full"
                style={{ width: `${(c.count30d / max) * 100}%`, backgroundColor: C.blue }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Members & growth
// ---------------------------------------------------------------------------

function MembersSection({ data }: { data: ServerStatsData }) {
  const hasSnapshots = data.memberSeries.length > 1;
  return (
    <Section title="Members & growth">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Weekly active members">
          <ResponsiveContainer width="100%" height={200}>
            <LineChart
              data={data.weeklyActive}
              margin={{ top: 8, right: 8, left: -12, bottom: 0 }}
            >
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis
                dataKey="weekStart"
                tick={TICK}
                tickFormatter={fmtDay}
                axisLine={false}
                tickLine={false}
                minTickGap={32}
              />
              <YAxis tick={TICK} axisLine={false} tickLine={false} width={40} />
              <Tooltip content={<DarkTooltip labelFmt={(v) => `Week of ${fmtDay(v)}`} />} />
              <Line
                type="monotone"
                dataKey="authors"
                name="Active members"
                stroke={C.aqua}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        {hasSnapshots ? (
          <Card title="Member count">
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart
                data={data.memberSeries}
                margin={{ top: 8, right: 8, left: -12, bottom: 0 }}
              >
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={TICK}
                  tickFormatter={fmtDay}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={40}
                />
                <YAxis
                  tick={TICK}
                  axisLine={false}
                  tickLine={false}
                  width={48}
                  domain={["auto", "auto"]}
                />
                <Tooltip content={<DarkTooltip labelFmt={fmtDay} />} />
                <Area
                  type="monotone"
                  dataKey="members"
                  name="Members"
                  stroke={C.violet}
                  strokeWidth={2}
                  fill={C.violet}
                  fillOpacity={0.15}
                  activeDot={{ r: 4 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </Card>
        ) : (
          <HintCard title="Member count over time">
            Appears once nightly guild snapshots accumulate (Snapshots page).
          </HintCard>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {hasSnapshots && data.joinLeave.length > 0 ? (
          <Card
            title="Joins vs leaves · weekly"
            legend={[
              { label: "Joined", color: C.aqua },
              { label: "Left", color: C.red },
            ]}
          >
            <ResponsiveContainer width="100%" height={200}>
              <BarChart
                data={data.joinLeave}
                margin={{ top: 8, right: 8, left: -12, bottom: 0 }}
                barGap={2}
              >
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis
                  dataKey="weekStart"
                  tick={TICK}
                  tickFormatter={fmtDay}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis tick={TICK} axisLine={false} tickLine={false} width={36} />
                <Tooltip content={<DarkTooltip labelFmt={(v) => `Week of ${fmtDay(v)}`} />} />
                <Bar dataKey="joins" name="Joined" fill={C.aqua} radius={[4, 4, 0, 0]} />
                <Bar dataKey="leaves" name="Left" fill={C.red} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        ) : (
          <HintCard title="Joins vs leaves">
            Derived from weekly snapshots — appears after two or more exist.
          </HintCard>
        )}

        <Card
          title="New-member activation"
          sub="Members who posted within 7 days of joining (of those still here)"
          legend={[
            { label: "Joined", color: C.blue },
            { label: "Posted in first week", color: C.aqua },
          ]}
        >
          {data.activation.length === 0 ? (
            <p className="text-sm text-white/40">No join data in the tracked window yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart
                data={data.activation}
                margin={{ top: 8, right: 8, left: -12, bottom: 0 }}
                barGap={2}
              >
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis
                  dataKey="month"
                  tick={TICK}
                  tickFormatter={fmtMonth}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis tick={TICK} axisLine={false} tickLine={false} width={36} />
                <Tooltip content={<DarkTooltip labelFmt={fmtMonth} />} />
                <Bar dataKey="joined" name="Joined" fill={C.blue} radius={[4, 4, 0, 0]} />
                <Bar
                  dataKey="posted7d"
                  name="Posted in first week"
                  fill={C.aqua}
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Retention cohorts"
          sub="Of members whose first message was in month X, how many posted again N months later"
        >
          <CohortGrid cohorts={data.cohorts} />
        </Card>
        <Card
          title="Who does the talking"
          sub={`${nf.format(data.concentration.totalAuthors)} members have ever posted · top 10 wrote ${pct(
            data.concentration.top10Share
          )} of everything · median ${nf.format(data.concentration.medianPerAuthor)} messages`}
        >
          <ConcentrationBars buckets={data.concentration.buckets} />
        </Card>
      </div>
    </Section>
  );
}

function CohortGrid({ cohorts }: { cohorts: ServerStatsData["cohorts"] }) {
  if (cohorts.rows.length === 0)
    return <p className="text-sm text-white/40">Not enough history yet.</p>;
  const n = cohorts.rows.length;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] border-separate border-spacing-[2px] text-center text-[11px]">
        <thead>
          <tr className="text-white/40">
            <th className="pr-1 text-left font-normal">Cohort</th>
            <th className="font-normal">Size</th>
            {Array.from({ length: n }, (_, i) => (
              <th key={i} className="font-normal">
                +{i}m
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cohorts.rows.map((r) => (
            <tr key={r.cohort}>
              <td className="pr-1 text-left text-white/60">{fmtMonth(r.cohort)}</td>
              <td className="tabular-nums text-white/60">{nf.format(r.size)}</td>
              {r.active.map((a, i) => {
                if (a === null) return <td key={i} />;
                const ratio = r.size > 0 ? a / r.size : 0;
                const light = ratio > 0.55;
                return (
                  <td
                    key={i}
                    title={`${fmtMonth(r.cohort)} +${i} months: ${nf.format(a)} of ${nf.format(r.size)} still posting (${pct(ratio)})`}
                    className="rounded px-1 py-1 tabular-nums"
                    style={{
                      backgroundColor:
                        ratio === 0 ? "rgba(255,255,255,0.03)" : seqColor(ratio),
                      color: light ? "#0f0f10" : "rgba(255,255,255,0.85)",
                    }}
                  >
                    {pct(ratio)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConcentrationBars({
  buckets,
}: {
  buckets: ServerStatsData["concentration"]["buckets"];
}) {
  const max = Math.max(1, ...buckets.map((b) => b.authors));
  return (
    <ul className="space-y-2">
      {buckets.map((b) => (
        <li key={b.label} title={`${nf.format(b.authors)} members with ${b.label} messages`}>
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-white/75">{b.label} messages</span>
            <span className="tabular-nums text-white/50">{nf.format(b.authors)}</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/5">
            <div
              className="h-full rounded-full"
              style={{ width: `${(b.authors / max) * 100}%`, backgroundColor: C.violet }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Recovery pulse
// ---------------------------------------------------------------------------

function RecoverySection({ data }: { data: ServerStatsData }) {
  const r = data.recovery;
  if (r.tiers.length === 0 && r.claimsPerMonth.length === 0) return null;
  // Ordinal blue ramp across tiers (ordered stages), floor-clamped for dark.
  const tierColor = (i: number) =>
    SEQ[Math.min(SEQ.length - 1, Math.round((i / Math.max(1, r.tiers.length - 1)) * (SEQ.length - 1)))];
  const seriesData = r.tierSeries.map((p) => ({ date: p.date, ...p.counts }));
  return (
    <Section title="Recovery pulse">
      {r.tiers.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {r.tiers.map((t) => (
            <Tile key={t.id} label={`${t.emoji} ${t.label}`} value={t.membersNow} />
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {r.tierSeries.length > 1 && r.tiers.length > 0 ? (
          <Card
            title="Milestone roles over time"
            legend={r.tiers.map((t, i) => ({
              label: `${t.emoji} ${t.label}`,
              color: tierColor(i),
            }))}
          >
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart
                data={seriesData}
                margin={{ top: 8, right: 8, left: -12, bottom: 0 }}
              >
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={TICK}
                  tickFormatter={fmtDay}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis tick={TICK} axisLine={false} tickLine={false} width={36} />
                <Tooltip content={<DarkTooltip labelFmt={fmtDay} />} />
                {r.tiers.map((t, i) => (
                  <Area
                    key={t.id}
                    type="monotone"
                    dataKey={t.id}
                    name={`${t.emoji} ${t.label}`}
                    stackId="tiers"
                    stroke="#0f0f10"
                    strokeWidth={1.5}
                    fill={tierColor(i)}
                    fillOpacity={0.9}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </Card>
        ) : (
          r.tiers.length > 0 && (
            <HintCard title="Milestone roles over time">
              Builds up from weekly snapshots — check back as history accumulates.
            </HintCard>
          )
        )}

        <div className="grid gap-4">
          {r.claimsPerMonth.length > 0 && (
            <Card title="Milestones celebrated" sub="Claims per month (last ~90 days of audit history)">
              <ResponsiveContainer width="100%" height={r.tiers.length > 0 ? 96 : 200}>
                <BarChart
                  data={r.claimsPerMonth}
                  margin={{ top: 4, right: 8, left: -12, bottom: 0 }}
                >
                  <XAxis
                    dataKey="month"
                    tick={TICK}
                    tickFormatter={fmtMonth}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis tick={TICK} axisLine={false} tickLine={false} width={30} />
                  <Tooltip content={<DarkTooltip labelFmt={fmtMonth} />} />
                  <Bar dataKey="count" name="Claims" fill={C.yellow} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Card>
          )}
          <Card title="Tenure of active members" sub="How long the people talking this month have been here">
            <ConcentrationLike buckets={data.recovery.tenureBuckets} color={C.aqua} unit="members" />
          </Card>
        </div>
      </div>
    </Section>
  );
}

function ConcentrationLike({
  buckets,
  color,
  unit,
}: {
  buckets: Array<{ label: string; members: number }>;
  color: string;
  unit: string;
}) {
  const max = Math.max(1, ...buckets.map((b) => b.members));
  return (
    <ul className="space-y-2">
      {buckets.map((b) => (
        <li key={b.label} title={`${nf.format(b.members)} ${unit}: ${b.label}`}>
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-white/75">{b.label}</span>
            <span className="tabular-nums text-white/50">{nf.format(b.members)}</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/5">
            <div
              className="h-full rounded-full"
              style={{ width: `${(b.members / max) * 100}%`, backgroundColor: color }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

function ReactionsSection({ data }: { data: ServerStatsData }) {
  const r = data.reactions;
  if (r.trackingSince === null) {
    return (
      <Section title="Reactions">
        <HintCard title="Reaction tracking just started">
          The bot now logs every reaction as it happens — charts appear here as
          data accumulates. (History can&apos;t be backfilled.)
        </HintCard>
      </Section>
    );
  }
  return (
    <Section
      title="Reactions"
      note="Live since deploy; archive-recovered reactions are dated by the message they landed on (Discord doesn't store when a reaction was added)"
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Reactions · 30d" value={r.total30d} />
        <Tile
          label="Per message"
          value={r.perMessage30d !== null ? r.perMessage30d.toFixed(2) : null}
          sub={<span className="text-white/40">reactions ÷ messages, 30d</span>}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Reactions per day"
          legend={[
            { label: "Reactions", color: C.magenta },
            { label: "People reacting", color: C.violet },
          ]}
        >
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart
              data={r.perDay}
              margin={{ top: 8, right: 8, left: -12, bottom: 0 }}
            >
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis
                dataKey="date"
                tick={TICK}
                tickFormatter={fmtDay}
                axisLine={false}
                tickLine={false}
                minTickGap={40}
              />
              <YAxis tick={TICK} axisLine={false} tickLine={false} width={40} />
              <Tooltip content={<DarkTooltip labelFmt={fmtDay} />} />
              <Area
                type="monotone"
                dataKey="count"
                name="Reactions"
                stroke={C.magenta}
                strokeWidth={2}
                fill={C.magenta}
                fillOpacity={0.18}
                activeDot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="reactors"
                name="People reacting"
                stroke={C.violet}
                strokeWidth={2}
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </Card>
        <div className="grid gap-4">
          <Card title="Favorite emojis · 30d">
            {r.topEmojis.length === 0 ? (
              <p className="text-sm text-white/40">Nothing yet.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {r.topEmojis.map((e) => (
                  <span
                    key={e.emoji}
                    title={`${nf.format(e.count)} × ${e.emoji}`}
                    className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1 text-sm ring-1 ring-white/10"
                  >
                    <span>{displayEmoji(e.emoji)}</span>
                    <span className="text-xs tabular-nums text-white/55">
                      {nf.format(e.count)}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </Card>
          <Card title="Most generous reactors · 30d">
            {r.topReactors.length === 0 ? (
              <p className="text-sm text-white/40">Nothing yet.</p>
            ) : (
              <ConcentrationLike
                buckets={r.topReactors.map((t) => ({ label: t.name, members: t.count }))}
                color={C.magenta}
                unit="reactions"
              />
            )}
          </Card>
        </div>
      </div>
    </Section>
  );
}

// Custom-emoji names come through as bare words — wrap them in colons so they
// read as emoji names; real unicode emoji pass through untouched.
function displayEmoji(e: string): string {
  return /^[A-Za-z0-9_~]+$/.test(e) ? `:${e}:` : e;
}

// ---------------------------------------------------------------------------
// Records & moderation
// ---------------------------------------------------------------------------

function RecordsSection({ data }: { data: ServerStatsData }) {
  const r = data.records;
  return (
    <Section title="Records">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          label="Busiest day"
          value={r.busiestDay ? nf.format(r.busiestDay.count) : null}
          sub={
            r.busiestDay ? (
              <span className="text-white/40">messages on {fmtDay(r.busiestDay.date)}</span>
            ) : null
          }
        />
        <Tile
          label="Busiest hour"
          value={r.busiestHour ? nf.format(r.busiestHour.count) : null}
          sub={
            r.busiestHour ? (
              <span className="text-white/40">{r.busiestHour.label} ({data.timezone})</span>
            ) : null
          }
        />
        <Tile
          label="Longest streak"
          value={r.longestStreakDays}
          sub={<span className="text-white/40">consecutive active days</span>}
        />
        <Tile
          label="Current streak"
          value={r.currentStreakDays}
          sub={<span className="text-white/40">days and counting</span>}
        />
      </div>
    </Section>
  );
}

function ModerationSection({ data }: { data: ServerStatsData }) {
  if (data.moderation.length === 0) return null;
  const kinds = [...new Set(data.moderation.map((m) => m.kind))].sort();
  const kindColors = [C.red, C.orange, C.yellow, C.magenta, C.violet, C.blue];
  const months = [...new Set(data.moderation.map((m) => m.month))].sort();
  const rows = months.map((month) => {
    const row: Record<string, string | number> = { month };
    for (const m of data.moderation) if (m.month === month) row[m.kind] = m.count;
    return row;
  });
  return (
    <Section title="Moderation" note="Mod-only context — not part of any shared view">
      <Card
        title="Actions per month"
        legend={kinds.map((k, i) => ({
          label: k.replaceAll("_", " "),
          color: kindColors[i % kindColors.length],
        }))}
      >
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={rows} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis
              dataKey="month"
              tick={TICK}
              tickFormatter={fmtMonth}
              axisLine={false}
              tickLine={false}
            />
            <YAxis tick={TICK} axisLine={false} tickLine={false} width={36} />
            <Tooltip content={<DarkTooltip labelFmt={fmtMonth} />} />
            {kinds.map((k, i) => (
              <Bar
                key={k}
                dataKey={k}
                name={k.replaceAll("_", " ")}
                stackId="mod"
                fill={kindColors[i % kindColors.length]}
                stroke="#0f0f10"
                strokeWidth={1}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </Card>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function Section({
  title,
  aside,
  note,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
            {title}
          </h2>
          {note && <p className="text-[11px] text-white/35">{note}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Card({
  title,
  sub,
  legend,
  children,
}: {
  title: string;
  sub?: string;
  legend?: Array<{ label: string; color: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl bg-white/[0.02] p-4 ring-1 ring-white/10">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div>
          <h3 className="text-sm font-medium text-white/80">{title}</h3>
          {sub && <p className="text-[11px] text-white/40">{sub}</p>}
        </div>
        {legend && legend.length > 1 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {legend.map((l) => (
              <span key={l.label} className="flex items-center gap-1.5 text-[11px] text-white/55">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: l.color }}
                />
                {l.label}
              </span>
            ))}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

function HintCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[160px] flex-col justify-center rounded-2xl border border-dashed border-white/10 p-4 text-center">
      <h3 className="text-sm font-medium text-white/60">{title}</h3>
      <p className="mt-1 text-xs text-white/40">{children}</p>
    </div>
  );
}

// Recharts tooltip, styled for the dark surface; text wears text tokens.
function DarkTooltip({
  active,
  payload,
  label,
  labelFmt,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number | string; color?: string }>;
  label?: string;
  labelFmt?: (v: string) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg border border-white/10 bg-[#1a1a1c] px-3 py-2 text-xs shadow-xl">
      <p className="mb-1 font-medium text-white/85">
        {label !== undefined && labelFmt ? labelFmt(String(label)) : label}
      </p>
      {payload.map((p, i) => (
        <p key={i} className="flex items-center gap-1.5 text-white/70">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: p.color }}
          />
          {p.name}: <span className="tabular-nums text-white/90">{typeof p.value === "number" ? nf.format(p.value) : p.value}</span>
        </p>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function pctChange(now: number, prev: number): number | null {
  if (prev === 0) return null;
  return ((now - prev) / prev) * 100;
}

// t in (0,1] → sequential blue step (dark surface: low recedes, high brightens).
function seqColor(t: number): string {
  const idx = Math.min(SEQ.length - 1, Math.floor(t * SEQ.length));
  return SEQ[idx];
}
