// Authorization helpers. Auth.js handles "is this user signed in"; this module
// answers "is this user allowed to manage guild X".
//
// Rules (most permissive wins):
//   1. User's Discord ID is in BOOTSTRAP_ADMIN_USER_IDS  -> allow any guild.
//   2. Guild has adminRoleId set AND user has that role  -> allow that guild.
// Otherwise: deny.

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

// Helper for API routes / pages: returns the session and 401s otherwise.
export async function requireSession() {
  const session = await auth();
  if (!session?.user) {
    throw new AuthError("unauthorized", 401);
  }
  return session;
}

export async function requireGuildAccess(guildId: string) {
  const session = await requireSession();
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
