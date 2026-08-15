// Ad-hoc aggregate queries over the raw event tables, so API callers can
// answer questions the precomputed stats blob doesn't ("messages per week in
// #general since March", "who reacted the most in July", "joins per day").
//
//   GET /activity?metric=messages|reactions|joins
//                &groupBy=day|week|month|channel|author
//                &since=<iso>&until=<iso>&channelId=&authorId=&limit=
//
// Buckets use the guild's configured timezone. Rows are capped (default 500,
// max 2000), ordered by bucket ascending for time groupings and by count
// descending for channel/author groupings. Joins have no channel and use
// groupBy=day|week|month only. See API.md.

import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";

const querySchema = z.object({
  metric: z.enum(["messages", "reactions", "joins"]).default("messages"),
  groupBy: z.enum(["day", "week", "month", "channel", "author"]).default("day"),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  channelId: z.string().regex(/^\d{17,21}$/).optional(),
  authorId: z.string().regex(/^\d{17,21}$/).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});

const TABLE: Record<string, { table: string; ts: string; actor: string }> = {
  messages: { table: "MessageEvent", ts: "sentAt", actor: "authorId" },
  reactions: { table: "ReactionEvent", ts: "sentAt", actor: "reactorId" },
  joins: { table: "MemberJoinEvent", ts: "joinedAt", actor: "userId" },
};

export const GET = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  await requireGuildAccess(guildId);

  const url = new URL(req.url);
  const q = querySchema.parse(Object.fromEntries(url.searchParams));
  if (q.metric === "joins" && (q.groupBy === "channel" || q.channelId)) {
    return NextResponse.json(
      { error: "joins have no channel — use groupBy=day|week|month|author" },
      { status: 400 }
    );
  }

  const guild = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { timezone: true },
  });
  const tz = guild?.timezone ?? "UTC";
  const spec = TABLE[q.metric];

  // Assembled with Prisma.sql/raw: identifiers come from the fixed TABLE map
  // above (never user input); every user-supplied value is a bound parameter.
  const col = (name: string) => Prisma.raw(`"${name}"`);
  const local = Prisma.sql`(${col(spec.ts)} AT TIME ZONE 'UTC' AT TIME ZONE ${tz})`;

  const key =
    q.groupBy === "day"
      ? Prisma.sql`to_char(${local}::date, 'YYYY-MM-DD')`
      : q.groupBy === "week"
        ? Prisma.sql`to_char(date_trunc('week', ${local})::date, 'YYYY-MM-DD')`
        : q.groupBy === "month"
          ? Prisma.sql`to_char(date_trunc('month', ${local})::date, 'YYYY-MM')`
          : q.groupBy === "channel"
            ? Prisma.sql`"channelId"`
            : Prisma.sql`${col(spec.actor)}`;

  const conditions = [
    Prisma.sql`"guildId" = ${guildId}`,
    ...(q.metric === "joins" ? [] : [Prisma.sql`"isBot" = false`]),
    ...(q.since ? [Prisma.sql`${col(spec.ts)} >= ${new Date(q.since)}`] : []),
    ...(q.until ? [Prisma.sql`${col(spec.ts)} < ${new Date(q.until)}`] : []),
    ...(q.channelId ? [Prisma.sql`"channelId" = ${q.channelId}`] : []),
    ...(q.authorId ? [Prisma.sql`${col(spec.actor)} = ${q.authorId}`] : []),
  ];
  const timeGrouped = ["day", "week", "month"].includes(q.groupBy);
  const order = timeGrouped ? Prisma.sql`key ASC` : Prisma.sql`count DESC`;

  const rows = await prisma.$queryRaw<
    { key: string; count: number; actors: number }[]
  >`
    SELECT ${key} AS key,
           COUNT(*)::int AS count,
           COUNT(DISTINCT ${col(spec.actor)})::int AS actors
    FROM ${Prisma.raw(`"${spec.table}"`)}
    WHERE ${Prisma.join(conditions, " AND ")}
    GROUP BY 1 ORDER BY ${order}
    LIMIT ${q.limit}
  `;

  return NextResponse.json({
    metric: q.metric,
    groupBy: q.groupBy,
    timezone: tz,
    rows,
  });
});
