// Revoke one of the caller's API tokens. Session-only, own-tokens-only.
// Revocation keeps the row (audit trail) but the token stops authenticating
// on its next use.

import { NextResponse } from "next/server";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

export const DELETE = withErrors(async (
  _req: Request,
  ctx: { params: Promise<{ guildId: string; tokenId: string }> }
) => {
  const { guildId, tokenId } = await ctx.params;
  const session = await requireGuildAccess(guildId, { allowToken: false });

  const row = await prisma.apiToken.findUnique({ where: { id: tokenId } });
  if (!row || row.discordUserId !== session.user.discordId) {
    return NextResponse.json({ error: "Token not found." }, { status: 404 });
  }
  if (!row.revokedAt) {
    await prisma.apiToken.update({
      where: { id: tokenId },
      data: { revokedAt: new Date() },
    });
    audit(guildId, "config.token_revoked", `API token "${row.name}" revoked`, {
      tokenId,
      by: session.user.discordId,
    });
  }
  return NextResponse.json({ ok: true });
});
