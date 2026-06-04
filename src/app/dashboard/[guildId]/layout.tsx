import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { AppSidebar } from "@/components/AppSidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { checkGuildAccess, listAccessibleGuilds } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { getGuild as discordGetGuild, iconUrl } from "@/lib/discord-rest";

export default async function GuildLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  // Make sure we have a Guild row for this guildId (lazy upsert from Discord).
  await ensureGuildRow(guildId);

  const access = await checkGuildAccess(session.user.discordId, guildId);
  if (!access.allowed) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-20 text-center">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 text-white/60">{access.reason}</p>
      </main>
    );
  }

  const guilds = await listAccessibleGuilds(session.user.discordId);
  const currentGuildName =
    guilds.find((g) => g.id === guildId)?.name ?? "Unknown guild";

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar
          guilds={guilds.map((g) => ({ id: g.id, name: g.name }))}
          currentGuildId={guildId}
          currentGuildName={currentGuildName}
          user={{ name: session.user.name, image: session.user.image }}
        />
        <SidebarInset>
          <header className="flex h-12 items-center gap-2 border-b border-sidebar-border px-4">
            <SidebarTrigger className="-ml-1" />
            <span className="text-sm text-foreground/60">{currentGuildName}</span>
          </header>
          <main className="mx-auto w-full max-w-6xl px-6 py-8">{children}</main>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

// If this guild isn't in our DB yet, look it up from Discord and create a row.
// Returns silently if the bot can't see the guild (the access check below will
// fail and surface a clean error).
async function ensureGuildRow(guildId: string) {
  const existing = await prisma.guild.findUnique({ where: { id: guildId } });
  if (existing) return;
  const fromDiscord = await discordGetGuild(guildId).catch(() => null);
  if (!fromDiscord) return;
  await prisma.guild.create({
    data: {
      id: fromDiscord.id,
      name: fromDiscord.name,
      iconUrl: iconUrl(fromDiscord.id, fromDiscord.icon),
    },
  });
}
