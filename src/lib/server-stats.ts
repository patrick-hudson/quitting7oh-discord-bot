// Server activity/health stats — the compute behind the portal's Stats page.
// Everything is aggregated here into one ServerStatsData blob and cached in
// StatsCache by the stats worker (src/bot/stats-worker.ts), so the page is a
// pure read. The heavy lifting is Postgres GROUP BYs over MessageEvent plus
// mining the nightly GuildSnapshots; the Node side mostly reshapes results.
//
// Day/hour bucketing uses the guild's configured timezone (a 9pm-EST message
// should count as that day's activity, not tomorrow's UTC date).
//
// Deliberately separable: this module + the worker only need Postgres and
// Discord REST (no gateway), so the worker can be lifted into its own
// container later if the bot ever needs the headroom (see the commented
// stats-worker service in docker-compose.prod.yml).

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  getGuildCounts,
  listGuildMembers,
  listTextChannels,
} from "@/lib/discord-rest";

// ---------------------------------------------------------------------------
// Result shape (stored as JSON in StatsCache.data)
// ---------------------------------------------------------------------------

export type ServerStatsData = {
  version: 1;
  timezone: string;
  tiles: {
    memberCount: number | null;
    onlineCount: number | null;
    memberDelta30d: number | null;
    messages7d: number;
    messagesPrev7d: number;
    activeMembers7d: number;
    activeMembers30d: number;
    engagementRate30d: number | null; // 0..1, active30 / memberCount
    stickiness: number | null; // 0..1, avg DAU(7d) / MAU(30d)
    newMembers7d: number | null;
    leavers7d: number | null;
    totalMessages: number;
    totalAuthors: number;
    firstEventAt: string | null; // how far back the data goes
  };
  // One row per local-tz day with ≥1 human message, ascending, all-time.
  messagesPerDay: Array<{ date: string; count: number; authors: number }>;
  // [7 weekdays (Mon..Sun)][24 hours] message counts, last 90 days, local tz.
  heatmap: number[][];
  channels: Array<{
    channelId: string;
    name: string;
    count30d: number;
    prev30d: number;
    total: number;
  }>;
  weeklyActive: Array<{ weekStart: string; authors: number; messages: number }>;
  monthlyActive: Array<{ month: string; authors: number; messages: number }>;
  // Member count over time, one point per snapshot day.
  memberSeries: Array<{ date: string; members: number }>;
  // Weekly join/leave derived from consecutive weekly snapshots.
  joinLeave: Array<{ weekStart: string; joins: number; leaves: number }>;
  // New members per month, all-time. Merged from MemberJoinEvent (archived
  // type-7 system messages + live gateway joins — includes people who later
  // left) and current members' joined_at for any gap between the two.
  joinsPerMonth: Array<{ month: string; joins: number }>;
  // Of everyone who joined in month M — including joiners who later left —
  // how many posted within 7 days of joining.
  activation: Array<{ month: string; joined: number; posted7d: number }>;
  // Classic retention cohort grid: cohort = month of first message; active[n]
  // = distinct cohort members who posted in cohort month + n (null = future).
  cohorts: {
    months: string[]; // cohort labels, ascending
    rows: Array<{ cohort: string; size: number; active: Array<number | null> }>;
  };
  concentration: {
    totalAuthors: number;
    top10Share: number; // 0..1 share of all messages by top 10 authors
    medianPerAuthor: number;
    buckets: Array<{ label: string; authors: number }>;
  };
  records: {
    busiestDay: { date: string; count: number } | null;
    busiestHour: { label: string; count: number } | null;
    longestStreakDays: number;
    currentStreakDays: number;
  };
  recovery: {
    tiers: Array<{ id: string; label: string; emoji: string; membersNow: number }>;
    // Weekly member-per-tier counts from snapshots; counts keyed by tier id.
    tierSeries: Array<{ date: string; counts: Record<string, number> }>;
    claimsPerMonth: Array<{ month: string; count: number }>; // audit-log window (~90d)
    tenureBuckets: Array<{ label: string; members: number }>; // active-30d members by age in server
  };
  // Reaction tracking started later than message tracking; trackingSince is
  // the earliest observed reaction (null = none yet, section hidden).
  reactions: {
    trackingSince: string | null;
    total30d: number;
    perMessage30d: number | null; // reactions ÷ messages, both last 30d
    perDay: Array<{ date: string; count: number; reactors: number }>; // last 90d
    topEmojis: Array<{ emoji: string; count: number }>; // last 30d
    topReactors: Array<{ name: string; count: number }>; // last 30d, display names
  };
  moderation: Array<{ month: string; kind: string; count: number }>;
  generatedAt: string;
};

// Fill defaults for any section a cached blob doesn't have. The cache and the
// code deploy independently: right after a release that adds a section, the
// stored blob was built by the PREVIOUS compute and lacks the new fields until
// the worker's next rebuild — the renderer must not crash in that window.
// Returns null when the blob isn't a stats payload at all (empty `{}` default).
export function normalizeServerStats(raw: unknown): ServerStatsData | null {
  const d = raw as Partial<ServerStatsData> | null;
  if (!d || typeof d !== "object" || !d.tiles) return null;
  return {
    version: 1,
    timezone: d.timezone ?? "UTC",
    tiles: d.tiles,
    messagesPerDay: d.messagesPerDay ?? [],
    heatmap: d.heatmap ?? Array.from({ length: 7 }, () => Array(24).fill(0)),
    channels: d.channels ?? [],
    weeklyActive: d.weeklyActive ?? [],
    monthlyActive: d.monthlyActive ?? [],
    memberSeries: d.memberSeries ?? [],
    joinLeave: d.joinLeave ?? [],
    joinsPerMonth: d.joinsPerMonth ?? [],
    activation: d.activation ?? [],
    cohorts: d.cohorts ?? { months: [], rows: [] },
    concentration:
      d.concentration ?? {
        totalAuthors: 0,
        top10Share: 0,
        medianPerAuthor: 0,
        buckets: [],
      },
    records:
      d.records ?? {
        busiestDay: null,
        busiestHour: null,
        longestStreakDays: 0,
        currentStreakDays: 0,
      },
    recovery:
      d.recovery ?? { tiers: [], tierSeries: [], claimsPerMonth: [], tenureBuckets: [] },
    reactions:
      d.reactions ?? {
        trackingSince: null,
        total30d: 0,
        perMessage30d: null,
        perDay: [],
        topEmojis: [],
        topReactors: [],
      },
    moderation: d.moderation ?? [],
    generatedAt: d.generatedAt ?? "",
  };
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

export async function computeServerStats(guildId: string): Promise<ServerStatsData> {
  const guild = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { timezone: true },
  });
  const tz = guild?.timezone ?? "UTC";

  // Kick off the Discord REST reads alongside the SQL work.
  const [counts, members, channelList, tiers] = await Promise.all([
    getGuildCounts(guildId).catch(() => ({ memberCount: null, onlineCount: null })),
    listGuildMembers(guildId).catch(() => []),
    listTextChannels(guildId).catch(() => []),
    prisma.milestoneTier.findMany({
      where: { guildId },
      orderBy: { sortOrder: "asc" },
      select: { id: true, label: true, emoji: true, roleId: true },
    }),
  ]);
  const channelName = new Map(channelList.map((c) => [c.id, c.name]));

  // --- Daily series, all-time, local tz -----------------------------------
  const daily = await prisma.$queryRaw<
    { date: string; count: number; authors: number }[]
  >`
    SELECT to_char(("sentAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS date,
           COUNT(*)::int AS count,
           COUNT(DISTINCT "authorId")::int AS authors
    FROM "MessageEvent"
    WHERE "guildId" = ${guildId} AND "isBot" = false
    GROUP BY 1 ORDER BY 1
  `;

  // --- Hour × weekday heatmap, last 90 days -------------------------------
  const heatRows = await prisma.$queryRaw<
    { dow: number; hour: number; count: number }[]
  >`
    SELECT EXTRACT(ISODOW FROM ("sentAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz}))::int AS dow,
           EXTRACT(HOUR   FROM ("sentAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz}))::int AS hour,
           COUNT(*)::int AS count
    FROM "MessageEvent"
    WHERE "guildId" = ${guildId} AND "isBot" = false
      AND "sentAt" > NOW() - make_interval(days => 90)
    GROUP BY 1, 2
  `;
  const heatmap: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const r of heatRows) heatmap[r.dow - 1][r.hour] = r.count;

  // --- Per-channel usage ---------------------------------------------------
  const channelRows = await prisma.$queryRaw<
    { channelId: string; d30: number; prev30: number; total: number }[]
  >`
    SELECT "channelId" AS "channelId",
           COUNT(*) FILTER (WHERE "sentAt" > NOW() - make_interval(days => 30))::int AS d30,
           COUNT(*) FILTER (WHERE "sentAt" <= NOW() - make_interval(days => 30)
                              AND "sentAt" >  NOW() - make_interval(days => 60))::int AS prev30,
           COUNT(*)::int AS total
    FROM "MessageEvent"
    WHERE "guildId" = ${guildId} AND "isBot" = false
    GROUP BY 1 ORDER BY total DESC
  `;

  // --- Weekly / monthly distinct-author series ----------------------------
  const weekly = await prisma.$queryRaw<
    { weekStart: string; authors: number; messages: number }[]
  >`
    SELECT to_char(date_trunc('week', "sentAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS "weekStart",
           COUNT(DISTINCT "authorId")::int AS authors,
           COUNT(*)::int AS messages
    FROM "MessageEvent"
    WHERE "guildId" = ${guildId} AND "isBot" = false
      AND "sentAt" > NOW() - make_interval(days => 26 * 7)
    GROUP BY 1 ORDER BY 1
  `;
  const monthly = await prisma.$queryRaw<
    { month: string; authors: number; messages: number }[]
  >`
    SELECT to_char(date_trunc('month', "sentAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date, 'YYYY-MM') AS month,
           COUNT(DISTINCT "authorId")::int AS authors,
           COUNT(*)::int AS messages
    FROM "MessageEvent"
    WHERE "guildId" = ${guildId} AND "isBot" = false
      AND "sentAt" > NOW() - make_interval(days => 366)
    GROUP BY 1 ORDER BY 1
  `;

  // --- Headline activity numbers ------------------------------------------
  const [agg] = await prisma.$queryRaw<
    {
      total: number;
      authors: number;
      first: Date | null;
      m7: number;
      m7prev: number;
      a7: number;
      a30: number;
    }[]
  >`
    SELECT COUNT(*)::int AS total,
           COUNT(DISTINCT "authorId")::int AS authors,
           MIN("sentAt") AS first,
           COUNT(*) FILTER (WHERE "sentAt" > NOW() - make_interval(days => 7))::int AS m7,
           COUNT(*) FILTER (WHERE "sentAt" <= NOW() - make_interval(days => 7)
                              AND "sentAt" >  NOW() - make_interval(days => 14))::int AS "m7prev",
           COUNT(DISTINCT "authorId") FILTER (WHERE "sentAt" > NOW() - make_interval(days => 7))::int AS a7,
           COUNT(DISTINCT "authorId") FILTER (WHERE "sentAt" > NOW() - make_interval(days => 30))::int AS a30
    FROM "MessageEvent"
    WHERE "guildId" = ${guildId} AND "isBot" = false
  `;

  // Stickiness: average daily-active over the last 7 local days ÷ MAU.
  const last7 = daily.slice(-7);
  const avgDau = last7.length
    ? last7.reduce((n, d) => n + d.authors, 0) / last7.length
    : 0;

  // --- Concentration (lurkers vs core) ------------------------------------
  const perAuthor = await prisma.$queryRaw<{ c: number }[]>`
    SELECT COUNT(*)::int AS c
    FROM "MessageEvent"
    WHERE "guildId" = ${guildId} AND "isBot" = false
    GROUP BY "authorId" ORDER BY c DESC
  `;
  const totalMsgs = agg?.total ?? 0;
  const top10 = perAuthor.slice(0, 10).reduce((n, r) => n + r.c, 0);
  const median =
    perAuthor.length === 0
      ? 0
      : perAuthor[Math.floor(perAuthor.length / 2)].c;
  const bucketDefs: Array<{ label: string; min: number; max: number }> = [
    { label: "1–9", min: 1, max: 9 },
    { label: "10–49", min: 10, max: 49 },
    { label: "50–199", min: 50, max: 199 },
    { label: "200–999", min: 200, max: 999 },
    { label: "1000+", min: 1000, max: Infinity },
  ];
  const buckets = bucketDefs.map((b) => ({
    label: b.label,
    authors: perAuthor.filter((r) => r.c >= b.min && r.c <= b.max).length,
  }));

  // --- Retention cohorts (month of first message) -------------------------
  const cohortRows = await prisma.$queryRaw<
    { cohort: string; am: string; c: number }[]
  >`
    WITH firsts AS (
      SELECT "authorId", date_trunc('month', MIN("sentAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz})) AS cohort
      FROM "MessageEvent"
      WHERE "guildId" = ${guildId} AND "isBot" = false
      GROUP BY 1
    ),
    activity AS (
      SELECT DISTINCT "authorId", date_trunc('month', "sentAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz}) AS m
      FROM "MessageEvent"
      WHERE "guildId" = ${guildId} AND "isBot" = false
    )
    SELECT to_char(f.cohort, 'YYYY-MM') AS cohort,
           to_char(a.m, 'YYYY-MM') AS am,
           COUNT(DISTINCT a."authorId")::int AS c
    FROM firsts f JOIN activity a USING ("authorId")
    GROUP BY 1, 2 ORDER BY 1, 2
  `;
  const cohorts = buildCohortGrid(cohortRows, 12);

  // --- First-message map (for activation) ---------------------------------
  const firstPosts = await prisma.$queryRaw<{ authorId: string; first: Date }[]>`
    SELECT "authorId" AS "authorId", MIN("sentAt") AS first
    FROM "MessageEvent"
    WHERE "guildId" = ${guildId} AND "isBot" = false
    GROUP BY 1
  `;
  const firstPostAt = new Map(firstPosts.map((r) => [r.authorId, r.first]));

  // --- Joiners: recovered join events + current members for the gap --------
  // MemberJoinEvent covers archived system messages (all-time, including
  // people who later left) and live gateway joins. Current members' joined_at
  // fills whatever window neither source saw (e.g. after system messages were
  // turned off, before the gateway listener deployed) — but only for members
  // still present, so gap months undercount. Dedupe by user + local day.
  const joinEvents = await prisma.$queryRaw<{ userId: string; joinedAt: Date }[]>`
    SELECT "userId" AS "userId", "joinedAt" AS "joinedAt"
    FROM "MemberJoinEvent"
    WHERE "guildId" = ${guildId}
    ORDER BY "joinedAt"
  `;
  const localDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: tz });
  const joiners: Array<{ userId: string; joinedAt: Date }> = [...joinEvents];
  const seenJoins = new Set(joinEvents.map((j) => `${j.userId}|${localDay(j.joinedAt)}`));
  for (const m of members) {
    if (!m.joined_at) continue;
    const joined = new Date(m.joined_at);
    if (!seenJoins.has(`${m.user.id}|${localDay(joined)}`)) {
      joiners.push({ userId: m.user.id, joinedAt: joined });
    }
  }

  const joinsMonthly = new Map<string, number>();
  for (const j of joiners) {
    const key = localDay(j.joinedAt).slice(0, 7);
    joinsMonthly.set(key, (joinsMonthly.get(key) ?? 0) + 1);
  }
  const joinsPerMonth = [...joinsMonthly.entries()]
    .map(([month, joins]) => ({ month, joins }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // Activation: of everyone who joined in month M (last 12 months, and only
  // months after message tracking began — earlier cohorts would read 0%
  // purely because no messages exist from back then), how many posted within
  // 7 days of joining. Rejoiners whose first post predates this join don't
  // count — "posted within 7 days of joining" means after joining.
  const activationMap = new Map<string, { joined: number; posted7d: number }>();
  const twelveMonthsAgo = Date.now() - 366 * 86_400_000;
  const trackingStartMonth = agg?.first ? agg.first.toISOString().slice(0, 7) : null;
  for (const j of joiners) {
    if (j.joinedAt.getTime() < twelveMonthsAgo) continue;
    const key = localDay(j.joinedAt).slice(0, 7);
    if (trackingStartMonth === null || key < trackingStartMonth) continue;
    const slot = activationMap.get(key) ?? { joined: 0, posted7d: 0 };
    slot.joined++;
    const first = firstPostAt.get(j.userId);
    if (first) {
      const diff = first.getTime() - j.joinedAt.getTime();
      if (diff >= 0 && diff <= 7 * 86_400_000) slot.posted7d++;
    }
    activationMap.set(key, slot);
  }
  const activation = [...activationMap.entries()]
    .map(([month, v]) => ({ month, ...v }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // --- Snapshot mining: member series, join/leave, tier series ------------
  const snapMeta = await prisma.$queryRaw<{ id: string; at: Date; members: number }[]>`
    SELECT id, "createdAt" AS at, jsonb_array_length(COALESCE(data->'members', '[]'::jsonb))::int AS members
    FROM "GuildSnapshot"
    WHERE "guildId" = ${guildId}
    ORDER BY "createdAt"
  `;
  // One point per day (last snapshot of the day), capped to a year.
  const byDay = new Map<string, { date: string; members: number }>();
  for (const s of snapMeta) {
    const d = s.at.toISOString().slice(0, 10);
    byDay.set(d, { date: d, members: s.members });
  }
  const memberSeries = [...byDay.values()].slice(-365);

  // Weekly snapshots (last of each ISO week, up to 14) for diffs + tiers.
  const byWeek = new Map<string, { id: string; at: Date }>();
  for (const s of snapMeta) byWeek.set(isoWeekKey(s.at), { id: s.id, at: s.at });
  const weeklySnaps = [...byWeek.values()]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(-14);

  type SnapMember = { id: string; roles?: string[] };
  const weeklyMembers: Array<{ at: Date; members: SnapMember[] }> = [];
  for (const s of weeklySnaps) {
    const rows = await prisma.$queryRaw<{ members: Prisma.JsonValue }[]>`
      SELECT COALESCE(data->'members', '[]'::jsonb) AS members
      FROM "GuildSnapshot" WHERE id = ${s.id}
    `;
    const arr = rows[0]?.members;
    weeklyMembers.push({
      at: s.at,
      members: Array.isArray(arr) ? (arr as unknown as SnapMember[]) : [],
    });
  }

  const joinLeave: ServerStatsData["joinLeave"] = [];
  for (let i = 1; i < weeklyMembers.length; i++) {
    const prev = new Set(weeklyMembers[i - 1].members.map((m) => m.id));
    const curr = new Set(weeklyMembers[i].members.map((m) => m.id));
    let joins = 0;
    let leaves = 0;
    for (const id of curr) if (!prev.has(id)) joins++;
    for (const id of prev) if (!curr.has(id)) leaves++;
    joinLeave.push({
      weekStart: weeklyMembers[i].at.toISOString().slice(0, 10),
      joins,
      leaves,
    });
  }

  const tierSeries: ServerStatsData["recovery"]["tierSeries"] = weeklyMembers.map(
    (w) => {
      const counts: Record<string, number> = {};
      for (const t of tiers) {
        counts[t.id] = w.members.filter((m) => m.roles?.includes(t.roleId)).length;
      }
      return { date: w.at.toISOString().slice(0, 10), counts };
    }
  );

  // Tiles from snapshots: growth deltas.
  const nowMembers = memberSeries.at(-1)?.members ?? null;
  const memberDelta30d = deltaAgainst(memberSeries, 30, nowMembers);
  const last2 = weeklyMembers.slice(-2);
  let newMembers7d: number | null = null;
  let leavers7d: number | null = null;
  if (last2.length === 2) {
    const prev = new Set(last2[0].members.map((m) => m.id));
    const curr = new Set(last2[1].members.map((m) => m.id));
    newMembers7d = [...curr].filter((id) => !prev.has(id)).length;
    leavers7d = [...prev].filter((id) => !curr.has(id)).length;
  }

  // --- Recovery: current tier membership, claims, tenure ------------------
  const recoveryTiers = tiers.map((t) => ({
    id: t.id,
    label: t.label,
    emoji: t.emoji,
    membersNow: members.filter((m) => m.roles.includes(t.roleId)).length,
  }));

  const claims = await prisma.$queryRaw<{ month: string; count: number }[]>`
    SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') AS month,
           COUNT(*)::int AS count
    FROM "BotAuditLog"
    WHERE "guildId" = ${guildId} AND kind = 'milestone.claimed'
    GROUP BY 1 ORDER BY 1
  `;

  // Tenure of currently-active members (posted in last 30d).
  const activeIds = new Set(
    (
      await prisma.$queryRaw<{ authorId: string }[]>`
        SELECT DISTINCT "authorId" AS "authorId"
        FROM "MessageEvent"
        WHERE "guildId" = ${guildId} AND "isBot" = false
          AND "sentAt" > NOW() - make_interval(days => 30)
      `
    ).map((r) => r.authorId)
  );
  const tenureDefs: Array<{ label: string; maxDays: number }> = [
    { label: "< 1 month", maxDays: 30 },
    { label: "1–3 months", maxDays: 91 },
    { label: "3–6 months", maxDays: 183 },
    { label: "6–12 months", maxDays: 366 },
    { label: "1 year +", maxDays: Infinity },
  ];
  const tenureCounts = tenureDefs.map(() => 0);
  for (const m of members) {
    if (!activeIds.has(m.user.id) || !m.joined_at) continue;
    const days = (Date.now() - new Date(m.joined_at).getTime()) / 86_400_000;
    const idx = tenureDefs.findIndex((t) => days < t.maxDays);
    tenureCounts[idx === -1 ? tenureDefs.length - 1 : idx]++;
  }

  // --- Reactions -----------------------------------------------------------
  const [reactionAgg] = await prisma.$queryRaw<
    { first: Date | null; total30: number }[]
  >`
    SELECT MIN("sentAt") AS first,
           COUNT(*) FILTER (WHERE "sentAt" > NOW() - make_interval(days => 30))::int AS total30
    FROM "ReactionEvent"
    WHERE "guildId" = ${guildId} AND "isBot" = false
  `;
  const reactionsPerDay = await prisma.$queryRaw<
    { date: string; count: number; reactors: number }[]
  >`
    SELECT to_char(("sentAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS date,
           COUNT(*)::int AS count,
           COUNT(DISTINCT "reactorId")::int AS reactors
    FROM "ReactionEvent"
    WHERE "guildId" = ${guildId} AND "isBot" = false
      AND "sentAt" > NOW() - make_interval(days => 90)
    GROUP BY 1 ORDER BY 1
  `;
  const topEmojis = await prisma.$queryRaw<{ emoji: string; count: number }[]>`
    SELECT emoji, COUNT(*)::int AS count
    FROM "ReactionEvent"
    WHERE "guildId" = ${guildId} AND "isBot" = false
      AND "sentAt" > NOW() - make_interval(days => 30)
    GROUP BY 1 ORDER BY count DESC LIMIT 12
  `;
  const topReactorRows = await prisma.$queryRaw<{ reactorId: string; count: number }[]>`
    SELECT "reactorId" AS "reactorId", COUNT(*)::int AS count
    FROM "ReactionEvent"
    WHERE "guildId" = ${guildId} AND "isBot" = false
      AND "sentAt" > NOW() - make_interval(days => 30)
    GROUP BY 1 ORDER BY count DESC LIMIT 10
  `;
  const displayName = new Map(
    members.map((m) => [m.user.id, m.nick || m.user.global_name || m.user.username])
  );
  const messages30d = channelRows.reduce((n, c) => n + c.d30, 0);

  // --- Moderation trend ----------------------------------------------------
  const moderation = await prisma.$queryRaw<
    { month: string; kind: string; count: number }[]
  >`
    SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') AS month,
           kind, COUNT(*)::int AS count
    FROM "ModerationLog"
    WHERE "guildId" = ${guildId}
      AND "createdAt" > NOW() - make_interval(days => 366)
    GROUP BY 1, 2 ORDER BY 1
  `;

  // --- Records & streaks ---------------------------------------------------
  const busiestDay = daily.reduce<{ date: string; count: number } | null>(
    (best, d) => (best && best.count >= d.count ? best : { date: d.date, count: d.count }),
    null
  );
  const [busiestHourRow] = await prisma.$queryRaw<{ label: string; count: number }[]>`
    SELECT to_char(date_trunc('hour', "sentAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz}), 'YYYY-MM-DD HH24:00') AS label,
           COUNT(*)::int AS count
    FROM "MessageEvent"
    WHERE "guildId" = ${guildId} AND "isBot" = false
    GROUP BY 1 ORDER BY count DESC LIMIT 1
  `;
  const { longest, current } = streaks(daily.map((d) => d.date));

  return {
    version: 1,
    timezone: tz,
    tiles: {
      memberCount: counts.memberCount ?? nowMembers,
      onlineCount: counts.onlineCount,
      memberDelta30d,
      messages7d: agg?.m7 ?? 0,
      messagesPrev7d: agg?.m7prev ?? 0,
      activeMembers7d: agg?.a7 ?? 0,
      activeMembers30d: agg?.a30 ?? 0,
      engagementRate30d:
        counts.memberCount && counts.memberCount > 0
          ? (agg?.a30 ?? 0) / counts.memberCount
          : null,
      stickiness: agg?.a30 ? avgDau / agg.a30 : null,
      newMembers7d,
      leavers7d,
      totalMessages: totalMsgs,
      totalAuthors: agg?.authors ?? 0,
      firstEventAt: agg?.first ? agg.first.toISOString() : null,
    },
    messagesPerDay: daily,
    heatmap,
    channels: channelRows.map((c) => ({
      channelId: c.channelId,
      name: channelName.get(c.channelId) ?? c.channelId,
      count30d: c.d30,
      prev30d: c.prev30,
      total: c.total,
    })),
    weeklyActive: weekly,
    monthlyActive: monthly,
    memberSeries,
    joinLeave,
    joinsPerMonth,
    activation,
    cohorts,
    concentration: {
      totalAuthors: perAuthor.length,
      top10Share: totalMsgs > 0 ? top10 / totalMsgs : 0,
      medianPerAuthor: median,
      buckets,
    },
    records: {
      busiestDay,
      busiestHour: busiestHourRow ?? null,
      longestStreakDays: longest,
      currentStreakDays: current,
    },
    recovery: {
      tiers: recoveryTiers,
      tierSeries,
      claimsPerMonth: claims,
      tenureBuckets: tenureDefs.map((t, i) => ({ label: t.label, members: tenureCounts[i] })),
    },
    reactions: {
      trackingSince: reactionAgg?.first ? reactionAgg.first.toISOString() : null,
      total30d: reactionAgg?.total30 ?? 0,
      perMessage30d:
        messages30d > 0 && (reactionAgg?.total30 ?? 0) > 0
          ? (reactionAgg!.total30 / messages30d)
          : null,
      perDay: reactionsPerDay,
      topEmojis,
      topReactors: topReactorRows.map((r) => ({
        name: displayName.get(r.reactorId) ?? "departed member",
        count: r.count,
      })),
    },
    moderation,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildCohortGrid(
  rows: Array<{ cohort: string; am: string; c: number }>,
  maxCohorts: number
): ServerStatsData["cohorts"] {
  const sizes = new Map<string, number>(); // cohort → size (month 0 actives)
  const cells = new Map<string, number>(); // "cohort|activeMonth" → count
  for (const r of rows) {
    cells.set(`${r.cohort}|${r.am}`, r.c);
    if (r.am === r.cohort) sizes.set(r.cohort, r.c);
  }
  const months = [...sizes.keys()].sort().slice(-maxCohorts);
  const lastMonth = rows.length ? rows[rows.length - 1].am : null;
  const gridRows = months.map((cohort) => {
    const size = sizes.get(cohort) ?? 0;
    const active: Array<number | null> = [];
    for (let n = 0; n < months.length; n++) {
      const target = addMonths(cohort, n);
      if (lastMonth && target > lastMonth) {
        active.push(null); // future month
      } else {
        active.push(cells.get(`${cohort}|${target}`) ?? 0);
      }
    }
    return { cohort, size, active };
  });
  return { months, rows: gridRows };
}

function addMonths(yyyyMm: string, n: number): string {
  const [y, m] = yyyyMm.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

function isoWeekKey(d: Date): string {
  // Good-enough ISO week bucketing: year + week number from a Thursday-shifted date.
  const t = new Date(d.getTime());
  t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7));
  const week1 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((t.getTime() - week1.getTime()) / 86_400_000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7
    );
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Change vs. the closest series point ~N days back (null if no history).
function deltaAgainst(
  series: Array<{ date: string; members: number }>,
  daysBack: number,
  now: number | null
): number | null {
  if (now === null || series.length < 2) return null;
  const target = new Date(Date.now() - daysBack * 86_400_000)
    .toISOString()
    .slice(0, 10);
  let best: { date: string; members: number } | null = null;
  for (const p of series) {
    if (p.date <= target) best = p;
    else break;
  }
  // Fall back to the oldest point if history is shorter than the window.
  const base = best ?? series[0];
  return base.date < series.at(-1)!.date ? now - base.members : null;
}

// Longest/current run of consecutive local-tz dates with activity.
function streaks(dates: string[]): { longest: number; current: number } {
  if (dates.length === 0) return { longest: 0, current: 0 };
  let longest = 1;
  let run = 1;
  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(dates[i - 1] + "T00:00:00Z").getTime();
    const curr = new Date(dates[i] + "T00:00:00Z").getTime();
    run = curr - prev === 86_400_000 ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  // Current streak only counts if the last active day is today or yesterday.
  const last = dates[dates.length - 1];
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  return { longest, current: last === today || last === yesterday ? run : 0 };
}
