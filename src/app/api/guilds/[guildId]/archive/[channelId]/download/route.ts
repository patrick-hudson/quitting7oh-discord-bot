// Streams a channel's archive JSONL from ARCHIVE_DIR. The web container
// mounts the archive volume read-only; media files stay on the volume (noted
// on the Export page) — this endpoint serves the message log only.

import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";

function archiveDir(): string {
  return process.env.ARCHIVE_DIR ?? "./archive-data";
}

export const GET = withErrors(async (
  _req: Request,
  ctx: { params: Promise<{ guildId: string; channelId: string }> }
) => {
  const { guildId, channelId } = await ctx.params;
  await requireGuildAccess(guildId);

  // Both segments are snowflakes; reject anything else so no path tricks.
  if (!/^\d{17,21}$/.test(guildId) || !/^\d{17,21}$/.test(channelId)) {
    return NextResponse.json({ error: "Bad ids" }, { status: 400 });
  }

  const filePath = path.join(archiveDir(), guildId, `${channelId}.jsonl`);
  if (!existsSync(filePath)) {
    return NextResponse.json(
      { error: "No archive for this channel yet." },
      { status: 404 }
    );
  }

  const size = statSync(filePath).size;
  const stream = Readable.toWeb(
    createReadStream(filePath)
  ) as unknown as ReadableStream;
  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "Content-Disposition": `attachment; filename="archive-${channelId}.jsonl"`,
      "Content-Length": String(size),
    },
  });
});
