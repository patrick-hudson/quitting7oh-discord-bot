// Contributor leaderboard: per-member activity aggregated from MessageEvent
// (the same message log behind the activity graph — counts + timestamps only,
// no content). Built to spot who to promote: volume, consistency, breadth,
// recency, and tenure at a glance. Names/roles are resolved live from Discord.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  getUser,
  listGuildMembers,
  listRoles,
  listTextChannels,
} from "@/lib/discord-rest";
import { LeaderboardTable } from "@/components/LeaderboardTable";

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
  const [members, roles, channels] = await Promise.all([
    listGuildMembers(guildId).catch(() => []),
    listRoles(guildId).catch(() => []),
    listTextChannels(guildId).catch(() => []),
  ]);
  const channelName: Record<string, string> = Object.fromEntries(
    channels.map((c) => [c.id, c.name])
  );
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

  // For posters who have since left the server, recover their last-known name
  // from snapshots — each snapshot stored every member's nick + username, so a
  // departed user still appears in snapshots taken before they left. One query
  // picks each id's name from the most recent snapshot that still had them.
  const unresolvedIds = rows
    .map((r) => r.authorId)
    .filter((id) => !memberById.has(id));
  const lastKnownName = new Map<string, string>();
  if (unresolvedIds.length > 0) {
    try {
      const nameRows = await prisma.$queryRaw<{ id: string; name: string }[]>`
        SELECT DISTINCT ON (m->>'id')
          m->>'id' AS id,
          COALESCE(NULLIF(m->>'nick', ''), m->>'username') AS name
        FROM "GuildSnapshot" s,
          jsonb_array_elements(COALESCE(s.data->'members', '[]'::jsonb)) m
        WHERE s."guildId" = ${guildId}
          AND m->>'id' IN (${Prisma.join(unresolvedIds)})
        ORDER BY m->>'id', s."createdAt" DESC
      `;
      for (const r of nameRows) if (r.name) lastKnownName.set(r.id, r.name);
    } catch {
      // snapshots may not exist yet — fall through to the API lookup below
    }
  }

  // Still-unresolved ids (not in a snapshot either): last resort, ask Discord
  // for the account username via GET /users/{id} — works even for people who
  // left. Bounded + parallel so a long tail of departed posters doesn't stall
  // the page; anything still unresolved falls back to the raw id.
  const stillUnknown = unresolvedIds
    .filter((id) => !lastKnownName.has(id))
    .slice(0, 40);
  if (stillUnknown.length > 0) {
    const fetched = await Promise.all(
      stillUnknown.map(async (id) => {
        const u = await getUser(id);
        return [id, u ? u.global_name || u.username : null] as const;
      })
    );
    for (const [id, name] of fetched) if (name) lastKnownName.set(id, name);
  }

  const now = Date.now();
  const enriched = rows.map((r) => {
    const first = new Date(r.firstSeen).getTime();
    const tenureDays = Math.max(1, Math.round((now - first) / 86_400_000));
    const consistency = Math.min(100, Math.round((r.activeDays / tenureDays) * 100));
    const m = memberById.get(r.authorId);
    return {
      authorId: r.authorId,
      // Resolution chain: current member → snapshot/API last-known → id.
      name: m?.name ?? lastKnownName.get(r.authorId) ?? null,
      present: Boolean(m),
      total: r.total,
      d7: r.d7,
      d30: r.d30,
      activeDays: r.activeDays,
      consistency,
      channels: r.channels,
      tenureDays,
      lastSeen: new Date(r.lastSeen).toISOString(),
      roleNames: (m?.roleIds ?? [])
        .filter((id) => id !== guildId && roleName.has(id))
        .slice(0, 4)
        .map((id) => roleName.get(id)!),
    };
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

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-2xl font-semibold tracking-tight">Contributor leaderboard</h1>
      <p className="mt-1 text-sm text-white/60">
        Member activity from the message log — who posts, how much, how
        consistently, and how long they&apos;ve been around. Sort by any column,
        or expand a row for the per-channel breakdown.
      </p>
      <p className="mt-2 text-xs text-white/40">
        Covers all activity the bot has recorded. With the full message archive
        enabled, this backfills toward each channel&apos;s start over time — so
        historical totals keep growing as older history is archived. Bots
        excluded. Names resolve from current membership, then snapshots, then a
        Discord lookup for people who left; unknown ones show as their ID.
      </p>

      {sorted.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-dashed border-white/10 p-12 text-center text-white/60">
          No message activity logged yet.
        </div>
      ) : (
        <LeaderboardTable
          guildId={guildId}
          rows={sorted}
          columns={COLUMNS}
          sortKey={sortKey}
          channelNames={channelName}
        />
      )}
    </div>
  );
}
