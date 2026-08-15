// Stored guild snapshots (metadata only — the data blobs are megabytes; fetch
// one via /snapshots/{snapshotId}). Distinct from GET /snapshots, which lists
// snapshot JOBS with per-step progress. See API.md.

import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";

export const GET = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  await requireGuildAccess(guildId);

  const url = new URL(req.url);
  const limit = Math.min(
    365,
    Math.max(1, Number(url.searchParams.get("limit") ?? "60") || 60)
  );
  // jsonb path extraction so we never load the multi-MB member/channel blobs
  // just to report row counts.
  const rows = await prisma.$queryRaw<
    { id: string; kind: string; createdAt: Date; counts: Prisma.JsonValue }[]
  >`
    SELECT id, kind, "createdAt", data->'counts' AS counts
    FROM "GuildSnapshot"
    WHERE "guildId" = ${guildId}
    ORDER BY "createdAt" DESC
    LIMIT ${limit}
  `;
  return NextResponse.json({
    snapshots: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      createdAt: r.createdAt.toISOString(),
      counts: r.counts,
    })),
  });
});
