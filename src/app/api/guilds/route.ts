// Discovery endpoint for API/agent callers: which guilds can this identity
// manage? Mirrors the portal's guild switcher. Documented in API.md as the
// first call an agent should make.

import { NextResponse } from "next/server";
import { withErrors } from "@/lib/api";
import { listAccessibleGuilds, requireSession } from "@/lib/authz";

export const GET = withErrors(async () => {
  const session = await requireSession();
  const guilds = await listAccessibleGuilds(session.user.discordId);
  return NextResponse.json({
    guilds: guilds.map((g) => ({ id: g.id, name: g.name, timezone: g.timezone })),
  });
});
