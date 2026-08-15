// Moderation log as JSON — human mod actions (bans, kicks, timeouts, message
// deletions with cached content). Same filters as the portal page: exact
// `kind`, backward pagination via `before`. Never pruned server-side, so this
// can page through the guild's full moderation history. See API.md.

import { NextResponse } from "next/server";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";

const MAX_PAGE = 200;

export const GET = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  await requireGuildAccess(guildId);

  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") ?? "";
  const before = url.searchParams.get("before");
  const beforeDate = before ? new Date(before) : null;
  const limit = Math.min(
    MAX_PAGE,
    Math.max(1, Number(url.searchParams.get("limit") ?? "100") || 100)
  );

  const entries = await prisma.moderationLog.findMany({
    where: {
      guildId,
      ...(kind ? { kind } : {}),
      ...(beforeDate && !Number.isNaN(beforeDate.getTime())
        ? { createdAt: { lt: beforeDate } }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return NextResponse.json({
    entries,
    nextBefore:
      entries.length === limit
        ? entries[entries.length - 1].createdAt.toISOString()
        : null,
  });
});
