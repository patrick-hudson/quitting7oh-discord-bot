import NextAuth from "next-auth";
import Discord from "next-auth/providers/discord";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db";

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  adapter: PrismaAdapter(prisma),
  providers: [
    Discord({
      clientId: process.env.DISCORD_CLIENT_ID!,
      clientSecret: process.env.DISCORD_CLIENT_SECRET!,
      authorization: { params: { scope: "identify email" } },
    }),
  ],
  session: { strategy: "database" },
  callbacks: {
    async session({ session, user }) {
      // Expose the Discord user ID on the session by reading the linked
      // Account row. Auth.js provides `user.id` (our internal cuid); we want
      // the Discord snowflake to check guild membership.
      const account = await prisma.account.findFirst({
        where: { userId: user.id, provider: "discord" },
        select: { providerAccountId: true },
      });
      return {
        ...session,
        user: {
          ...session.user,
          id: user.id,
          discordId: account?.providerAccountId ?? null,
        },
      };
    },
  },
  events: {
    // Stamp the User row each time someone successfully signs in. Used by the
    // dashboard "Recently signed in" panel — purely informational, no auth
    // logic depends on it.
    async signIn({ user }) {
      if (!user.id) return;
      await prisma.user
        .update({ where: { id: user.id }, data: { lastSignInAt: new Date() } })
        .catch((err) => console.warn("[auth] lastSignInAt update failed:", err));
    },
  },
  pages: { signIn: "/login" },
});

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      discordId: string | null;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }
}
