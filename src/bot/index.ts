// discord.js bot worker.
//
// Responsibilities:
//   1. Stay logged in to Discord so we can send messages.
//   2. Poll the DB for ScheduledPost rows whose nextFireAt is due, send the
//      message, then compute the next nextFireAt (or deactivate if one-off).
//   3. Lazy-upsert Guild rows when the bot joins a new guild.

import {
  Client,
  Events,
  GatewayIntentBits,
  Options,
  Partials,
  type Message,
} from "discord.js";
import { prisma } from "@/lib/db";
import { iconUrl } from "@/lib/discord-rest";
import { audit } from "@/lib/audit";
import { runScheduler } from "./scheduler";
import { runRedditPoller } from "./reddit-poller";
import { runUserExportWorker } from "./user-export-worker";
import { runArchiveWorker } from "./archive-worker";
import { runRestoreWorker } from "./restore-worker";
import { runSnapshotWorker } from "./snapshot-worker";
import { runLeaderboardWorker } from "./leaderboard-worker";
import { runAiReviewWorker } from "./ai-review-worker";
import { runStatsWorker } from "./stats-worker";
import { runReactionBackfill } from "./reaction-backfill";
import { runJoinBackfill } from "./join-backfill";
import { registerMilestoneHandler } from "./milestones";
import { registerLeaveAnnouncer } from "./leave-announcer";
import { registerWelcomeDm } from "./welcome-dm";
import { registerModLog } from "./mod-log";

async function main() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN not set");

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      // GuildModeration (non-privileged) delivers real-time audit-log entries
      // for the mod log (bans/kicks/timeouts). The bot's role also needs the
      // View Audit Log permission in the server.
      GatewayIntentBits.GuildModeration,
      // MessageContent is a PRIVILEGED intent (dev-portal toggle required).
      // Enabled deliberately for the mod log so deleted messages can be
      // recorded with their content. MessageEvent activity logging still
      // stores counts only — message text is persisted ONLY when a message
      // is deleted (see src/bot/mod-log.ts).
      GatewayIntentBits.MessageContent,
      // Reaction add events feed ReactionEvent for the stats page.
      GatewayIntentBits.GuildMessageReactions,
    ],
    // Without the GuildMember partial, discord.js silently drops
    // GuildMemberRemove for members that weren't cached — which is most of
    // them, since we never chunk the member list. The Message partial lets
    // MessageDelete fire for uncached messages (logged without content).
    // Reaction/User partials do the same for reactions on uncached messages —
    // without them, reaction logging would only see recently-sent messages.
    partials: [
      Partials.GuildMember,
      Partials.Message,
      Partials.Reaction,
      Partials.User,
    ],
    // Cache recent messages so deleted ones can be logged with content.
    // 200/channel with a 6h sweep bounds memory while covering the window
    // where deletions actually happen.
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 200,
    }),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      messages: { interval: 3600, lifetime: 6 * 3600 },
    },
  });

  registerMilestoneHandler(client);
  registerLeaveAnnouncer(client);
  registerWelcomeDm(client);
  registerModLog(client);

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

  // Reaction logging for the stats page — same fire-and-forget model. The
  // unique constraint absorbs remove/re-add cycles and gateway redeliveries
  // (P2002 = already counted). Removals are deliberately not mirrored.
  client.on(Events.MessageReactionAdd, (reaction, user) => {
    const guildId = reaction.message.guildId;
    if (!guildId) return;
    prisma.reactionEvent
      .create({
        data: {
          guildId,
          channelId: reaction.message.channelId,
          messageId: reaction.message.id,
          reactorId: user.id,
          emoji: reaction.emoji.name ?? reaction.emoji.id ?? "?",
          // On partial users `bot` can be undefined; treat unknown as human.
          isBot: user.bot ?? false,
        },
      })
      .catch((err: unknown) => {
        const code = (err as { code?: string } | null)?.code;
        if (code !== "P2002") {
          console.warn("[bot] reaction log failed:", err);
        }
      });
  });

  // Join logging for the stats page — live counterpart of the archive join
  // backfill (join system messages are off in this guild, so the gateway is
  // the only live source). The unique (guildId, userId, joinedAt) constraint
  // absorbs redeliveries and any overlap with backfilled system messages.
  client.on(Events.GuildMemberAdd, (member) => {
    prisma.memberJoinEvent
      .create({
        data: {
          guildId: member.guild.id,
          userId: member.id,
          username: member.user.globalName || member.user.username,
          source: "gateway",
          joinedAt: member.joinedAt ?? new Date(),
        },
      })
      .catch((err: unknown) => {
        const code = (err as { code?: string } | null)?.code;
        if (code !== "P2002") {
          console.warn("[bot] join log failed:", err);
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
    runArchiveWorker();
    runRestoreWorker();
    runSnapshotWorker();
    runLeaderboardWorker();
    runAiReviewWorker(client);
    runStatsWorker();
    runReactionBackfill();
    runJoinBackfill();
  });

  client.on(Events.GuildCreate, async (g) => {
    console.log(`[bot] joined guild ${g.name} (${g.id})`);
    await prisma.guild.upsert({
      where: { id: g.id },
      create: { id: g.id, name: g.name, iconUrl: iconUrl(g.id, g.icon) },
      update: { name: g.name, iconUrl: iconUrl(g.id, g.icon) },
    });
    audit(g.id, "guild.joined", `Bot added to ${g.name}`, { name: g.name });
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
