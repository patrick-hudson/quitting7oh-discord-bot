// Serves a finished user-export zip from the job row's blob column.

import { NextResponse } from "next/server";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";

export const GET = withErrors(async (
  _req: Request,
  ctx: { params: Promise<{ guildId: string; jobId: string }> }
) => {
  const { guildId, jobId } = await ctx.params;
  await requireGuildAccess(guildId);

  const job = await prisma.userExportJob.findUnique({ where: { id: jobId } });
  if (!job || job.guildId !== guildId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (job.status !== "done" || !job.output) {
    return NextResponse.json(
      { error: `Export is ${job.status} — nothing to download yet.` },
      { status: 409 }
    );
  }

  const bytes = new Uint8Array(job.output);
  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${job.fileName ?? `user-export-${job.targetUserId}.zip`}"`,
      "Content-Length": String(bytes.byteLength),
    },
  });
});
