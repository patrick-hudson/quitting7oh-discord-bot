// Bulk archive / unarchive of AI review jobs — portal housekeeping so the
// reviews list stays readable after big batches. Archiving is soft (sets
// archivedAt): the data stays for timeline compares, the fit report, and the
// batch feature's "recently reviewed" skip. Works on any FINISHED job (done,
// failed, or cancelled); pending/running jobs can never be archived.
//
// POST { archived: true|false } plus either { ids: [...] } for a selection or
// { all: true } for every finished review in the guild (the list view caps at
// 100 rows, so "archive everything" must be server-side).

import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

const schema = z
  .object({
    archived: z.boolean(),
    ids: z.array(z.string().cuid()).max(1000).optional(),
    all: z.boolean().default(false),
  })
  .refine((v) => v.all || (v.ids && v.ids.length > 0), {
    message: "Provide ids or all=true.",
  });

export const POST = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  const session = await requireGuildAccess(guildId);

  const input = schema.parse(await req.json());

  const res = await prisma.aiReviewJob.updateMany({
    where: {
      guildId,
      status: { in: ["done", "failed", "cancelled"] },
      ...(input.all ? {} : { id: { in: input.ids } }),
      // Only flip rows that actually change, so the audit count is honest.
      archivedAt: input.archived ? null : { not: null },
    },
    data: { archivedAt: input.archived ? new Date() : null },
  });

  audit(
    guildId,
    "aireview.archived",
    `${input.archived ? "Archived" : "Unarchived"} ${res.count} AI fit review(s)${
      input.all ? " (all finished)" : ""
    }`,
    {
      archived: input.archived,
      count: res.count,
      all: input.all,
      by: session.user.discordId,
    }
  );

  return NextResponse.json({ updated: res.count });
});
