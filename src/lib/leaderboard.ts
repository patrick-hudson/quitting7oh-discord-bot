// Computes the contributor leaderboard: aggregate MessageEvent per author and
// resolve display names. This is the slow part (big aggregate + Discord member
// list + snapshot lookup + per-user API lookups), so it runs in the background
// worker and the result is cached in LeaderboardCache. The page just reads the
// cache — no Discord calls at request time.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  getUser,
  listGuildMembers,
  listRoles,
  listTextChannels,
} from "@/lib/discord-rest";

export type LeaderboardRow = {
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
  lastSeen: string; // ISO
  roleNames: string[];
};

export type LeaderboardData = {
  rows: LeaderboardRow[];
  channelNames: Record<string, string>;
};

type Agg = {
  authorId: string;
  total: number;
  d7: number;
  d30: number;
  activeDays: number;
  channels: number;
  firstSeen: Date;
  lastSeen: Date;
};

const TOP_N = 250;
// Cap live Discord user lookups for departed posters so a long tail doesn't
// stall the compute; anything past this stays unresolved (shows as id).
const MAX_USER_LOOKUPS = 60;

export async function computeLeaderboard(guildId: string): Promise<LeaderboardData> {
  const rows = await prisma.$queryRaw<Agg[]>`
    SELECT
      "authorId" AS "authorId",
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE "sentAt" > NOW() - INTERVAL '7 days')::int AS d7,
      COUNT(*) FILTER (WHERE "sentAt" > NOW() - INTERVAL '30 days')::int AS d30,
      COUNT(DISTINCT DATE_TRUNC('day', "sentAt"))::int AS "activeDays",
      COUNT(DISTINCT "channelId")::int AS channels,
      MIN("sentAt") AS "firstSeen",
      MAX("sentAt") AS "lastSeen"
    FROM "MessageEvent"
    WHERE "guildId" = ${guildId} AND "isBot" = false
    GROUP BY "authorId"
    ORDER BY total DESC
    LIMIT ${TOP_N};
  `;

  const [members, roles, channels] = await Promise.all([
    listGuildMembers(guildId).catch(() => []),
    listRoles(guildId).catch(() => []),
    listTextChannels(guildId).catch(() => []),
  ]);
  const roleName = new Map(roles.map((r) => [r.id, r.name]));
  const channelNames: Record<string, string> = Object.fromEntries(
    channels.map((c) => [c.id, c.name])
  );
  const memberById = new Map(
    members.map((m) => [
      m.user.id,
      { name: m.user.global_name || m.user.username, roleIds: m.roles },
    ])
  );

  // Departed posters: resolve their last-known name — snapshots first, then a
  // Discord user lookup as a bounded fallback.
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
      // no snapshots yet — fall through to the API lookup
    }
    const stillUnknown = unresolvedIds
      .filter((id) => !lastKnownName.has(id))
      .slice(0, MAX_USER_LOOKUPS);
    if (stillUnknown.length > 0) {
      const fetched = await Promise.all(
        stillUnknown.map(async (id) => {
          const u = await getUser(id);
          return [id, u ? u.global_name || u.username : null] as const;
        })
      );
      for (const [id, name] of fetched) if (name) lastKnownName.set(id, name);
    }
  }

  const now = Date.now();
  const enriched: LeaderboardRow[] = rows.map((r) => {
    const first = new Date(r.firstSeen).getTime();
    const tenureDays = Math.max(1, Math.round((now - first) / 86_400_000));
    const consistency = Math.min(100, Math.round((r.activeDays / tenureDays) * 100));
    const m = memberById.get(r.authorId);
    return {
      authorId: r.authorId,
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

  return { rows: enriched, channelNames };
}
