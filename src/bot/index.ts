// discord.js bot worker.
//
// Responsibilities:
//   1. Stay logged in to Discord so we can send messages.
//   2. Poll the DB for ScheduledPost rows whose nextFireAt is due, send the
//      message, then compute the next nextFireAt (or deactivate if one-off).
//   3. Lazy-upsert Guild rows when the bot joins a new guild.

import { Client, Events, GatewayIntentBits, Partials, type Message } from "discord.js";
import { prisma } from "@/lib/db";
import { iconUrl } from "@/lib/discord-rest";
import { runScheduler } from "./scheduler";
import { runRedditPoller } from "./reddit-poller";
import { runUserExportWorker } from "./user-export-worker";
import { registerMilestoneHandler } from "./milestones";
import { registerLeaveAnnouncer } from "./leave-announcer";
import { registerWelcomeDm } from "./welcome-dm";

async function main() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN not set");

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      // GuildMessages is NOT a privileged intent — we only need it to count
      // and timestamp messages for the activity graph. MESSAGE_CONTENT stays
      // off, so we never see message text.
      GatewayIntentBits.GuildMessages,
    ],
    // Without the GuildMember partial, discord.js silently drops
    // GuildMemberRemove for members that weren't cached — which is most of
    // them, since we never chunk the member list.
    partials: [Partials.GuildMember],
  });

  registerMilestoneHandler(client);
  registerLeaveAnnouncer(client);
  registerWelcomeDm(client);

  // Activity logging — one row per observed message. Fire-and-forget so a
  // slow DB never delays the event loop. We deliberately skip threads and
  // DMs (no guildId) since the dashboard is per-guild.
  client.on(Events.MessageCreate, (msg: Message) => {
    if (!msg.guildId) return;
    prisma.messageEvent
      .create({
        data: {
          id: msg.id,
          guildId: msg.guildId,
          channelId: msg.channelId,
          authorId: msg.author.id,
          isBot: msg.author.bot,
          sentAt: msg.createdAt,
        },
      })
      .catch((err: unknown) => {
        // P2002 (unique constraint) just means we already logged this id —
        // can happen on reconnect/redelivery. Anything else is worth knowing.
        const code = (err as { code?: string } | null)?.code;
        if (code !== "P2002") {
          console.warn("[bot] message log failed:", err);
        }
      });
  });

  client.once(Events.ClientReady, async (c) => {
    console.log(`[bot] logged in as ${c.user.tag} (${c.user.id})`);
    // Upsert all known guilds on startup so the portal has them right away.
    for (const [, g] of c.guilds.cache) {
      await prisma.guild.upsert({
        where: { id: g.id },
        create: { id: g.id, name: g.name, iconUrl: iconUrl(g.id, g.icon) },
        update: { name: g.name, iconUrl: iconUrl(g.id, g.icon) },
      });
    }
    runScheduler(client);
    runRedditPoller(client);
    runUserExportWorker(client);
  });

  client.on(Events.GuildCreate, async (g) => {
    console.log(`[bot] joined guild ${g.name} (${g.id})`);
    await prisma.guild.upsert({
      where: { id: g.id },
      create: { id: g.id, name: g.name, iconUrl: iconUrl(g.id, g.icon) },
      update: { name: g.name, iconUrl: iconUrl(g.id, g.icon) },
    });
  });

  client.on(Events.GuildUpdate, async (_old, g) => {
    await prisma.guild.update({
      where: { id: g.id },
      data: { name: g.name, iconUrl: iconUrl(g.id, g.icon) },
    }).catch(() => {});
  });

  await client.login(token);
}

main().catch((err) => {
  console.error("[bot] fatal:", err);
  process.exit(1);
});
