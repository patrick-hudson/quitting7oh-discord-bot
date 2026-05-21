import { NextResponse } from "next/server";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { listTextChannels } from "@/lib/discord-rest";

export const GET = withErrors(async (
  _req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  await requireGuildAccess(guildId);
  const channels = await listTextChannels(guildId);
  return NextResponse.json({ channels });
});
