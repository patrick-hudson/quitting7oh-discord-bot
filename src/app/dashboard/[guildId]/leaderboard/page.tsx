// Contributor leaderboard: per-member activity aggregated from MessageEvent
// (the same message log behind the activity graph — counts + timestamps only,
// no content). Built to spot who to promote: volume, consistency, breadth,
// recency, and tenure at a glance. Names/roles are resolved live from Discord.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { listGuildMembers, listRoles } from "@/lib/discord-rest";
import { LocalTime } from "@/components/LocalTime";

type Row = {
  authorId: string;
  total: number;
  d7: number;
  d30: number;
  d90: number;
  activeDays: number;
  channels: number;
  firstSeen: Date;
  lastSeen: Date;
};

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

  const rows = await prisma.$queryRaw<Row[]>`
    SELECT
      "authorId" AS "authorId",
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE "sentAt" > NOW() - INTERVAL '7 days')::int AS d7,
      COUNT(*) FILTER (WHERE "sentAt" > NOW() - INTERVAL '30 days')::int AS d30,
      COUNT(*) FILTER (WHERE "sentAt" > NOW() - INTERVAL '90 days')::int AS d90,
      COUNT(DISTINCT DATE_TRUNC('day', "sentAt"))::int AS "activeDays",
      COUNT(DISTINCT "channelId")::int AS channels,
      MIN("sentAt") AS "firstSeen",
      MAX("sentAt") AS "lastSeen"
    FROM "MessageEvent"
    WHERE "guildId" = ${guildId} AND "isBot" = false
    GROUP BY "authorId"
    ORDER BY total DESC
    LIMIT 250;
  `;

  // Resolve names + current roles from Discord (best effort). Members who left
  // won't be here — we show their id and mark them.
  const [members, roles] = await Promise.all([
    listGuildMembers(guildId).catch(() => []),
    listRoles(guildId).catch(() => []),
  ]);
  const roleName = new Map(roles.map((r) => [r.id, r.name]));
  const memberById = new Map(
    members.map((m) => [
      m.user.id,
      {
        name: m.user.global_name || m.user.username,
        roleIds: m.roles,
        joinedAt: m.joined_at,
      },
    ])
  );

  const now = Date.now();
  const enriched = rows.map((r) => {
    const first = new Date(r.firstSeen).getTime();
    const tenureDays = Math.max(1, Math.round((now - first) / 86_400_000));
    const consistency = Math.min(100, Math.round((r.activeDays / tenureDays) * 100));
    const m = memberById.get(r.authorId);
    return { ...r, tenureDays, consistency, member: m ?? null };
  });

  const sorted = [...enriched].sort((a, b) => {
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

  const sortHref = (k: SortKey) => `/dashboard/${guildId}/leaderboard?sort=${k}`;

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-2xl font-semibold tracking-tight">Contributor leaderboard</h1>
      <p className="mt-1 text-sm text-white/60">
        Member activity from the message log — who posts, how much, how
        consistently, and how long they&apos;ve been around. Sort by any column
        to spot promotion candidates.
      </p>
      <p className="mt-2 text-xs text-white/40">
        Covers all activity the bot has recorded. With the full message archive
        enabled, this backfills toward each channel&apos;s start over time — so
        historical totals keep growing as older history is archived. Bots
        excluded. Names/roles resolved live; members who left show as their ID.
      </p>

      {sorted.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-dashed border-white/10 p-12 text-center text-white/60">
          No message activity logged yet.
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-2xl ring-1 ring-white/10">
          <table className="w-full text-left text-sm">
            <thead className="bg-white/[0.03] text-xs uppercase tracking-wide text-white/50">
              <tr>
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Member</th>
                {COLUMNS.map((c) => (
                  <th key={c.key} className="px-3 py-2 font-medium" title={c.hint}>
                    <Link
                      href={sortHref(c.key)}
                      className={`hover:text-white ${
                        sortKey === c.key ? "text-white" : ""
                      }`}
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
              {sorted.map((r, i) => (
                <tr key={r.authorId} className="bg-white/[0.02] hover:bg-white/[0.04]">
                  <td className="px-3 py-2 text-white/40">{i + 1}</td>
                  <td className="px-3 py-2">
                    {r.member ? (
                      <span className="font-medium text-white/90">{r.member.name}</span>
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
                  <td className="px-3 py-2 tabular-nums text-white/70">
                    {r.consistency}%
                  </td>
                  <td className="px-3 py-2 tabular-nums text-white/70">{r.channels}</td>
                  <td className="px-3 py-2 text-xs text-white/50">
                    {r.tenureDays}d ago
                  </td>
                  <td className="px-3 py-2 text-xs text-white/50">
                    <LocalTime iso={new Date(r.lastSeen).toISOString()} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex max-w-[220px] flex-wrap gap-1">
                      {(r.member?.roleIds ?? [])
                        .filter((id) => id !== guildId && roleName.has(id))
                        .slice(0, 4)
                        .map((id) => (
                          <span
                            key={id}
                            className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-white/60"
                          >
                            {roleName.get(id)}
                          </span>
                        ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
