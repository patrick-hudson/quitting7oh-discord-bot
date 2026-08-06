// Manual "snapshot now" — collects the guild's current structure via REST and
// stores it as a manual snapshot (exempt from the scheduler's retention cap).

import { NextResponse } from "next/server";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { takeGuildSnapshot } from "@/lib/guild-snapshot";

export const POST = withErrors(async (
  _req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  const session = await requireGuildAccess(guildId);

  const id = await takeGuildSnapshot(guildId, "manual");
  audit(guildId, "snapshot.taken", "Manual structure snapshot", {
    snapshotId: id,
    kind: "manual",
    requestedBy: session.user.discordId,
  });
  return NextResponse.json({ id });
});
