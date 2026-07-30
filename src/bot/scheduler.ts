// Polling scheduler. Every N seconds:
//   - SELECT ScheduledPost WHERE active = true AND nextFireAt <= now()
//   - For each row: post the message, then either compute a new nextFireAt
//     (recurring) or set active=false + nextFireAt=null (one-off).
//   - SELECT PostReminder WHERE sentAt IS NULL AND remindAt <= now()
//   - For each row: reply to the original message(s) with a plain-text nudge.
//
// This polling model is intentionally simple: portal edits take effect on the
// next tick with no IPC, the bot is stateless beyond Discord login, and
// crashing mid-fire leaves the post due (we update lastFiredAt/nextFireAt
// only AFTER successful send). At-least-once semantics; recovery posts about
// a meeting starting "now" are fine to occasionally retry.

import { Client, EmbedBuilder } from "discord.js";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { computeNextFireAt } from "@/lib/cron";
import { REMINDER_TEMPLATES } from "@/lib/reminder-templates";
import { substituteAnsiColorTokens } from "@/lib/ansi-tokens";
import { audit } from "@/lib/audit";
import type { PostReminder, ScheduledPost } from "@prisma/client";

// Pick a random reminder template, avoiding the index used last time for this
// post. Mirrors pickFromRoster in milestones.ts. Returns the template plus its
// index so the caller can persist lastReminderIndex.
function pickReminderTemplate(
  roster: string[],
  lastIndex: number | null
): { template: string; index: number } {
  if (roster.length === 1) return { template: roster[0], index: 0 };
  const candidates: number[] = [];
  for (let i = 0; i < roster.length; i++) {
    if (i !== lastIndex) candidates.push(i);
  }
  const index = candidates[Math.floor(Math.random() * candidates.length)];
  return { template: roster[index], index };
}

export function runScheduler(client: Client) {
  const intervalMs = env.schedulerPollSeconds() * 1000;
  console.log(`[scheduler] polling every ${intervalMs}ms`);

  // Don't overlap ticks if the DB or Discord is slow.
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick(client);
    } catch (err) {
      console.error("[scheduler] tick failed:", err);
    } finally {
      running = false;
    }
  }, intervalMs);
}

async function tick(client: Client) {
  await fireDuePosts(client);
  await fireManualRequests(client);
  await fireDueReminders(client);
  await pruneAuditLog();
}

// Keep 90 days of bot-audit rows; check at most every 6 hours so the delete
// isn't on every tick's hot path. ModerationLog is deliberately NOT pruned —
// mod accountability records (bans, kicks, deleted messages) keep forever.
const AUDIT_RETENTION_DAYS = 90;
let lastAuditPrune = 0;
async function pruneAuditLog() {
  if (Date.now() - lastAuditPrune < 6 * 60 * 60_000) return;
  lastAuditPrune = Date.now();
  const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 24 * 60 * 60_000);
  const res = await prisma.botAuditLog
    .deleteMany({ where: { createdAt: { lt: cutoff } } })
    .catch((err) => {
      console.warn("[scheduler] audit prune failed:", err);
      return null;
    });
  if (res && res.count > 0) {
    console.log(
      `[scheduler] pruned ${res.count} audit row(s) older than ${AUDIT_RETENTION_DAYS}d`
    );
  }
}

async function fireDuePosts(client: Client) {
  const now = new Date();
  const due = await prisma.scheduledPost.findMany({
    where: { active: true, nextFireAt: { lte: now, not: null } },
    include: { guild: true },
    take: 25,
  });
  if (due.length === 0) return;

  for (const post of due) {
    try {
      const sent = await sendPost(client, post);
      await advancePost(post, post.guild.timezone);
      audit(
        post.guildId,
        "post.fired",
        `Fired "${post.name}" to ${sent.messages.length}/${post.channelIds.length} channel(s)`,
        {
          postId: post.id,
          postName: post.name,
          cron: post.cron,
          meetingAt: sent.meetingAt.toISOString(),
          messages: sent.messages,
          failures: sent.failures,
        },
        sent.failures.length > 0 ? "warn" : "ok"
      );
      await maybeScheduleReminder(post, sent);
    } catch (err) {
      console.error(`[scheduler] failed to send post ${post.id}:`, err);
      // Push nextFireAt forward by 60s so we don't hammer a permanently broken
      // post every poll. Also record the failure so the dashboard can surface
      // it instead of relying on log spelunking.
      const retryAt = new Date(Date.now() + 60_000);
      const message = err instanceof Error ? err.message : String(err);
      audit(
        post.guildId,
        "post.fire_failed",
        `Failed to fire "${post.name}" — retrying in 60s`,
        { postId: post.id, postName: post.name, channelIds: post.channelIds, error: message.slice(0, 500) },
        "error"
      );
      await prisma.scheduledPost.update({
        where: { id: post.id },
        data: {
          nextFireAt: retryAt,
          lastFailedAt: new Date(),
          // Truncate so a 50KB stack trace doesn't bloat the row.
          lastError: message.slice(0, 1000),
        },
      });
    }
  }
}

// "Fire now" requests from the portal. Honored regardless of `active` (the
// admin explicitly clicked the button) and without touching cron / nextFireAt
// so the regular schedule continues unchanged. Reminders still get scheduled
// if the post has reminderMinutes set.
async function fireManualRequests(client: Client) {
  const due = await prisma.scheduledPost.findMany({
    where: { manualFireRequested: true },
    include: { guild: true },
    take: 25,
  });
  if (due.length === 0) return;

  for (const post of due) {
    try {
      const sent = await sendPost(client, post);
      await prisma.scheduledPost.update({
        where: { id: post.id },
        data: { manualFireRequested: false, lastFiredAt: new Date() },
      });
      audit(
        post.guildId,
        "post.manual_fired",
        `Manually fired "${post.name}" to ${sent.messages.length}/${post.channelIds.length} channel(s)`,
        {
          postId: post.id,
          postName: post.name,
          messages: sent.messages,
          failures: sent.failures,
        },
        sent.failures.length > 0 ? "warn" : "ok"
      );
      await maybeScheduleReminder(post, sent);
      console.log(`[scheduler] manual fire delivered "${post.name}"`);
    } catch (err) {
      console.error(`[scheduler] manual fire failed for ${post.id}:`, err);
      const message = err instanceof Error ? err.message : String(err);
      audit(
        post.guildId,
        "post.manual_fire_failed",
        `Manual fire of "${post.name}" failed`,
        { postId: post.id, postName: post.name, channelIds: post.channelIds, error: message.slice(0, 500) },
        "error"
      );
      // Clear the flag either way — leaving it true would have us retry every
      // tick on a permanently broken post. The admin can click again to retry.
      await prisma.scheduledPost.update({
        where: { id: post.id },
        data: {
          manualFireRequested: false,
          lastFailedAt: new Date(),
          lastError: message.slice(0, 1000),
        },
      });
    }
  }
}

// After a post fires, queue a PostReminder if the post wants one. The reminder
// row snapshots everything the later fire needs (meeting time, chosen body, the
// exact messages to reply to) so it's independent of later edits to the post.
async function maybeScheduleReminder(
  post: ScheduledPost & { guild: { reminderTemplates: string[] } },
  sent: { meetingAt: Date; messages: Array<{ channelId: string; messageId: string }> }
) {
  if (post.reminderMinutes == null) return;
  if (sent.messages.length === 0) return; // nothing to reply to

  const remindAt = new Date(sent.meetingAt.getTime() - post.reminderMinutes * 60_000);
  // If the reminder time has already passed (e.g. a very short lead, or clock
  // skew), skip rather than firing it immediately on the next tick — a "starts
  // in 0 minutes" nudge moments after the original post is just noise.
  if (remindAt.getTime() <= Date.now()) {
    console.log(`[scheduler] "${post.name}" reminder time already passed, skipping`);
    return;
  }

  let content = post.reminderContent;
  if (!content) {
    // Prefer the guild's custom roster (admin-curated in /defaults); fall back
    // to the baked-in defaults when the guild hasn't set any.
    const roster =
      post.guild.reminderTemplates.length > 0
        ? post.guild.reminderTemplates
        : REMINDER_TEMPLATES;
    const pick = pickReminderTemplate(roster, post.lastReminderIndex);
    content = pick.template;
    await prisma.scheduledPost
      .update({ where: { id: post.id }, data: { lastReminderIndex: pick.index } })
      .catch((err) =>
        console.warn(`[scheduler] lastReminderIndex update failed for ${post.id}:`, err)
      );
  }

  await prisma.postReminder.create({
    data: {
      postId: post.id,
      firedAt: new Date(),
      meetingAt: sent.meetingAt,
      remindAt,
      content,
      channelIds: sent.messages.map((m) => m.channelId),
      messageIds: sent.messages.map((m) => m.messageId),
    },
  });
}

async function fireDueReminders(client: Client) {
  const now = new Date();
  const due = await prisma.postReminder.findMany({
    where: { sentAt: null, remindAt: { lte: now } },
    // guildId comes through the post relation so sendReminder can rewrite
    // #channel-name mentions against the right guild's channel list.
    include: { post: { select: { guildId: true } } },
    take: 25,
  });
  if (due.length === 0) return;

  for (const reminder of due) {
    try {
      await sendReminder(client, reminder);
      await prisma.postReminder.update({
        where: { id: reminder.id },
        data: { sentAt: new Date() },
      });
      audit(
        reminder.post.guildId,
        "reminder.sent",
        `Sent follow-up reminder to ${reminder.channelIds.length} channel(s)`,
        {
          reminderId: reminder.id,
          postId: reminder.postId,
          meetingAt: reminder.meetingAt.toISOString(),
          channelIds: reminder.channelIds,
          repliedToMessageIds: reminder.messageIds,
        }
      );
    } catch (err) {
      console.error(`[scheduler] failed to send reminder ${reminder.id}:`, err);
      const message = err instanceof Error ? err.message : String(err);
      // Don't bump remindAt — the next tick retries. But if the meeting time is
      // already well past, give up so we don't reply "starting soon" hours late.
      const giveUp = reminder.meetingAt.getTime() < Date.now() - 60 * 60_000;
      audit(
        reminder.post.guildId,
        giveUp ? "reminder.abandoned" : "reminder.failed",
        giveUp
          ? `Abandoned reminder ${reminder.id} — meeting over an hour past`
          : `Reminder ${reminder.id} failed — will retry next tick`,
        {
          reminderId: reminder.id,
          postId: reminder.postId,
          meetingAt: reminder.meetingAt.toISOString(),
          channelIds: reminder.channelIds,
          error: message.slice(0, 500),
        },
        "error"
      );
      await prisma.postReminder.update({
        where: { id: reminder.id },
        data: {
          lastFailedAt: new Date(),
          lastError: message.slice(0, 1000),
          // Mark as sent (abandoned) once an hour past the meeting.
          sentAt: giveUp ? new Date() : null,
        },
      });
    }
  }
}

async function sendReminder(
  client: Client,
  reminder: PostReminder & { post: { guildId: string } }
) {
  const channelsByName = channelNameMapFor(client, reminder.post.guildId);
  const content = substituteAnsiColorTokens(
    substituteChannelMentions(
      substituteTimePlaceholders(reminder.content, reminder.meetingAt),
      channelsByName
    )
  );

  let succeeded = 0;
  const failures: string[] = [];
  await Promise.all(
    reminder.channelIds.map(async (channelId, i) => {
      const messageId = reminder.messageIds[i];
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased() || !("send" in channel)) {
          throw new Error("not a sendable text channel");
        }
        // Reply to the original announcement so members can click back to it.
        // failIfNotExists: false → if the original was deleted, post a normal
        // message instead of throwing.
        await channel.send({
          content,
          reply: { messageReference: messageId, failIfNotExists: false },
          allowedMentions: { repliedUser: false },
        });
        succeeded++;
      } catch (err) {
        failures.push(`${channelId}: ${(err as Error).message}`);
      }
    })
  );

  if (failures.length > 0) {
    console.error(
      `[scheduler] reminder ${reminder.id} failed for ${failures.length}/${reminder.channelIds.length} channels:`,
      failures.join("; ")
    );
  }
  if (succeeded === 0) {
    throw new Error(`all ${reminder.channelIds.length} channels failed`);
  }
  console.log(
    `[scheduler] sent reminder ${reminder.id} to ${succeeded}/${reminder.channelIds.length} channels`
  );
}

// Replaces {meetingTime} and {meetingTime:X} placeholders with Discord's
// <t:UNIX:X> syntax so the time renders in each viewer's local timezone. Valid
// suffixes are Discord's standard format chars: t T d D f F R. Bare
// {meetingTime} defaults to t (short time, e.g. "9:30 AM").
function substituteTimePlaceholders(text: string, meetingTime: Date): string {
  const unix = Math.floor(meetingTime.getTime() / 1000);
  return text.replace(/\{meetingTime(?::([tTdDfFR]))?\}/g, (_m, fmt) => {
    return `<t:${unix}:${fmt ?? "t"}>`;
  });
}

// Build a lowercased name→id map of every channel the bot can see in the guild.
// Empty map if the guild isn't in cache (bot not present, or hasn't received
// the GUILD_CREATE yet). Used to rewrite #channel-name into Discord's <#id>
// mention syntax so it renders as a clickable channel pill.
function channelNameMapFor(client: Client, guildId: string): Map<string, string> {
  const map = new Map<string, string>();
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return map;
  for (const [id, ch] of guild.channels.cache) {
    if ("name" in ch && typeof ch.name === "string") {
      map.set(ch.name.toLowerCase(), id);
    }
  }
  return map;
}

// Replace #channel-name → <#id> for channels the bot can see in the guild.
// Names that don't match anything are left alone — a typo shouldn't break the
// message, just not render as a link. Negative lookbehind avoids matching
// inside URLs / words (e.g. `path/#anchor`).
function substituteChannelMentions(
  text: string,
  channelsByName: Map<string, string>
): string {
  return text.replace(
    /(?<![A-Za-z0-9])#([A-Za-z0-9][A-Za-z0-9_-]{0,99})/g,
    (m, name: string) => {
      const id = channelsByName.get(name.toLowerCase());
      return id ? `<#${id}>` : m;
    }
  );
}


async function sendPost(
  client: Client,
  post: ScheduledPost & { guild: { timezone: string } }
): Promise<{
  meetingAt: Date;
  messages: Array<{ channelId: string; messageId: string }>;
  failures: string[];
}> {
  const mention = post.mentionRoleId ? `<@&${post.mentionRoleId}>` : "";
  const allowedMentions = post.mentionRoleId
    ? { roles: [post.mentionRoleId] }
    : undefined;

  // Meeting time = actual send time + leadMinutes. Using send time (not the
  // scheduled nextFireAt) avoids confusing "X seconds ago" rendering from the
  // up-to-one-poll-interval delay between scheduled and actual fire.
  const meetingTime = new Date(Date.now() + post.leadMinutes * 60_000);
  const channelsByName = channelNameMapFor(client, post.guildId);
  // Body supports time, channel-mention, and color tokens. Embed title gets
  // time + channel mentions but skips color tokens — titles aren't inside an
  // ansi code block, so color escapes would render as garbage there.
  const content = substituteAnsiColorTokens(
    substituteChannelMentions(
      substituteTimePlaceholders(post.content, meetingTime),
      channelsByName
    )
  );
  const embedTitle = post.embedTitle
    ? substituteChannelMentions(
        substituteTimePlaceholders(post.embedTitle, meetingTime),
        channelsByName
      )
    : null;

  // Build the payload once and fan out to every target channel.
  const payload = post.useEmbed
    ? (() => {
        const embed = new EmbedBuilder().setDescription(content);
        if (embedTitle) embed.setTitle(embedTitle);
        if (post.embedColor) {
          const n = parseInt(post.embedColor.replace("#", ""), 16);
          if (!Number.isNaN(n)) embed.setColor(n);
        }
        if (post.embedUrl) embed.setURL(post.embedUrl);
        if (post.embedImage) embed.setImage(post.embedImage);
        return { content: mention || undefined, embeds: [embed], allowedMentions };
      })()
    : {
        content: mention ? `${mention}\n${content}` : content,
        allowedMentions,
      };

  // Captured per successful send so a follow-up reminder can reply to the exact
  // messages we posted (channel + message snowflake).
  const messages: Array<{ channelId: string; messageId: string }> = [];
  const failures: string[] = [];
  await Promise.all(
    post.channelIds.map(async (channelId) => {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased() || !("send" in channel)) {
          throw new Error("not a sendable text channel");
        }
        const msg = await channel.send(payload);
        messages.push({ channelId, messageId: msg.id });
      } catch (err) {
        failures.push(`${channelId}: ${(err as Error).message}`);
      }
    })
  );

  if (failures.length > 0) {
    console.error(
      `[scheduler] "${post.name}" failed for ${failures.length}/${post.channelIds.length} channels:`,
      failures.join("; ")
    );
  }

  // If every channel failed, throw so the outer handler schedules a retry. If
  // at least one succeeded, swallow the partial failure and advance the post
  // so successful channels don't get duplicate sends on the retry tick.
  if (messages.length === 0) {
    throw new Error(`all ${post.channelIds.length} channels failed`);
  }

  console.log(
    `[scheduler] sent "${post.name}" to ${messages.length}/${post.channelIds.length} channels`
  );

  return { meetingAt: meetingTime, messages, failures };
}

async function advancePost(post: ScheduledPost, guildTimezone: string) {
  const next = computeNextFireAt({
    cron: post.cron,
    runAt: post.runAt,
    timezone: post.timezone,
    guildTimezone,
  });
  await prisma.scheduledPost.update({
    where: { id: post.id },
    data: {
      lastFiredAt: new Date(),
      // For one-offs (cron == null), `next` is null and `runAt` is in the
      // past — deactivate so we don't keep selecting it.
      active: next !== null || post.cron !== null,
      nextFireAt: next,
    },
  });
}
