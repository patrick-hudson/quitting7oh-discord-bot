// discord.js bot worker.
//
// Responsibilities:
//   1. Stay logged in to Discord so we can send messages.
//   2. Poll the DB for ScheduledPost rows whose nextFireAt is due, send the
//      message, then compute the next nextFireAt (or deactivate if one-off).
//   3. Lazy-upsert Guild rows when the bot joins a new guild.

import { Client, Events, GatewayIntentBits } from "discord.js";
import { prisma } from "@/lib/db";
import { iconUrl } from "@/lib/discord-rest";
import { runScheduler } from "./scheduler";
import { registerMilestoneHandler } from "./milestones";

async function main() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN not set");

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  registerMilestoneHandler(client);

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
