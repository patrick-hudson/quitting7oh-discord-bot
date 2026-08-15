// Authorization helpers. Auth.js handles "is this user signed in"; this module
// answers "is this user allowed to manage guild X".
//
// Two ways to be "signed in":
//   - A portal session (Discord OAuth cookie).
//   - An API bearer token (`Authorization: Bearer q7t_...`, see API.md) —
//     resolves to the Discord user who minted it, then flows through the
//     exact same guild checks. Token management routes opt out via
//     { allowToken: false } so a leaked token can't mint replacements.
//
// Guild rules (most permissive wins):
//   1. User's Discord ID is in BOOTSTRAP_ADMIN_USER_IDS  -> allow any guild.
//   2. Guild has adminRoleId set AND user has that role  -> allow that guild.
// Otherwise: deny.

import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { getGuildMember, listBotGuilds, iconUrl } from "@/lib/discord-rest";

export type GuildAccess = { allowed: boolean; reason?: string };

export async function checkGuildAccess(
  discordUserId: string | null,
  guildId: string
): Promise<GuildAccess> {
  if (!discordUserId) return { allowed: false, reason: "not signed in" };
  if (env.bootstrapAdminIds().has(discordUserId)) return { allowed: true };

  const guild = await prisma.guild.findUnique({ where: { id: guildId } });
  if (!guild) return { allowed: false, reason: "guild not configured" };
  if (!guild.adminRoleId) return { allowed: false, reason: "no admin role configured" };

  const member = await getGuildMember(guildId, discordUserId);
  if (!member) return { allowed: false, reason: "not a member of guild" };
  if (!member.roles.includes(guild.adminRoleId))
    return { allowed: false, reason: "missing admin role" };

  return { allowed: true };
}

export const API_TOKEN_PREFIX = "q7t_";

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Session-compatible shape produced by a bearer token, so routes that read
// session.user.discordId / .name / .image work unchanged for token callers.
export type TokenActor = {
  user: { discordId: string | null; name: string | null; image?: string | null };
};

// Resolve `Authorization: Bearer q7t_...` to an actor, if present. Returns
// null when there's no bearer header (fall through to the cookie session);
// throws 401 for a token that's presented but unknown or revoked — silently
// ignoring a bad credential would mask agent misconfigurations.
async function tokenActor(): Promise<TokenActor | null> {
  let authHeader: string | null;
  try {
    authHeader = (await headers()).get("authorization");
  } catch {
    return null; // outside a request scope (e.g. bot worker importing this lib)
  }
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token.startsWith(API_TOKEN_PREFIX)) return null;

  const row = await prisma.apiToken.findUnique({
    where: { tokenHash: hashApiToken(token) },
  });
  if (!row || row.revokedAt) {
    throw new AuthError("invalid or revoked API token", 401);
  }
  void prisma.apiToken
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
  return { user: { discordId: row.discordUserId, name: `token:${row.name}`, image: null } };
}

// Helper for API routes / pages: returns the acting identity (bearer token or
// portal session) and 401s otherwise. Pass { allowToken: false } for routes a
// token must never reach (token management itself).
export async function requireSession(opts: { allowToken?: boolean } = {}) {
  if (opts.allowToken !== false) {
    const actor = await tokenActor();
    if (actor) return actor;
  }
  const session = await auth();
  if (!session?.user) {
    throw new AuthError("unauthorized", 401);
  }
  return session;
}

export async function requireGuildAccess(
  guildId: string,
  opts: { allowToken?: boolean } = {}
) {
  const session = await requireSession(opts);
  const result = await checkGuildAccess(session.user.discordId, guildId);
  if (!result.allowed) {
    throw new AuthError(result.reason ?? "forbidden", 403);
  }
  return session;
}

export class AuthError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

// All guilds the signed-in user can manage. Used to populate the guild
// switcher in the portal nav.
//
// Bootstrap admins see every guild the bot is in (lazy-upserting Guild rows
// from Discord so a fresh DB still shows something on first login). Regular
// users see only guilds where they hold the configured admin role.
export async function listAccessibleGuilds(discordUserId: string | null) {
  if (!discordUserId) return [];

  if (env.bootstrapAdminIds().has(discordUserId)) {
    const botGuilds = await listBotGuilds().catch(() => []);
    for (const g of botGuilds) {
      await prisma.guild.upsert({
        where: { id: g.id },
        create: { id: g.id, name: g.name, iconUrl: iconUrl(g.id, g.icon) },
        update: { name: g.name, iconUrl: iconUrl(g.id, g.icon) },
      });
    }
    return prisma.guild.findMany({ orderBy: { name: "asc" } });
  }

  const all = await prisma.guild.findMany({ orderBy: { name: "asc" } });
  const out = [] as typeof all;
  for (const g of all) {
    if (!g.adminRoleId) continue;
    const member = await getGuildMember(g.id, discordUserId).catch(() => null);
    if (member && member.roles.includes(g.adminRoleId)) out.push(g);
  }
  return out;
}
