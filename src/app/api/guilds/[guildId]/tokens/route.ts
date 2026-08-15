// Personal API tokens (see API.md). POST mints one and returns the plaintext
// ONCE; GET lists the caller's active tokens (hashes never leave the DB).
// Both are session-only — { allowToken: false } — so a leaked token cannot
// mint replacements or enumerate its siblings. Tokens are user-scoped (they
// act as their creator across every guild they can manage); the guild in the
// path is where the mint/revoke is audited.

import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrors } from "@/lib/api";
import {
  API_TOKEN_PREFIX,
  hashApiToken,
  requireGuildAccess,
} from "@/lib/authz";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

const createSchema = z.object({ name: z.string().trim().min(1).max(60) });

export const POST = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  const session = await requireGuildAccess(guildId, { allowToken: false });
  const discordUserId = session.user.discordId;
  if (!discordUserId) {
    return NextResponse.json(
      { error: "Session has no Discord ID — sign out and back in." },
      { status: 400 }
    );
  }

  const { name } = createSchema.parse(await req.json());
  const token = API_TOKEN_PREFIX + randomBytes(24).toString("hex");
  const row = await prisma.apiToken.create({
    data: {
      name,
      tokenHash: hashApiToken(token),
      tokenPrefix: token.slice(0, API_TOKEN_PREFIX.length + 8),
      discordUserId,
    },
  });

  audit(guildId, "config.token_created", `API token "${name}" created`, {
    tokenId: row.id,
    by: discordUserId,
  });
  // The one and only time the plaintext leaves the server.
  return NextResponse.json({
    token,
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
  });
});

export const GET = withErrors(async (
  _req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  const session = await requireGuildAccess(guildId, { allowToken: false });

  const tokens = await prisma.apiToken.findMany({
    where: { discordUserId: session.user.discordId ?? "", revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      tokenPrefix: true,
      createdAt: true,
      lastUsedAt: true,
    },
  });
  return NextResponse.json({ tokens });
});
