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
  await fireDueReminders(client);
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
      await maybeScheduleReminder(post, sent);
    } catch (err) {
      console.error(`[scheduler] failed to send post ${post.id}:`, err);
      // Push nextFireAt forward by 60s so we don't hammer a permanently broken
      // post every poll. Also record the failure so the dashboard can surface
      // it instead of relying on log spelunking.
      const retryAt = new Date(Date.now() + 60_000);
      const message = err instanceof Error ? err.message : String(err);
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
    } catch (err) {
      console.error(`[scheduler] failed to send reminder ${reminder.id}:`, err);
      const message = err instanceof Error ? err.message : String(err);
      // Don't bump remindAt — the next tick retries. But if the meeting time is
      // already well past, give up so we don't reply "starting soon" hours late.
      const giveUp = reminder.meetingAt.getTime() < Date.now() - 60 * 60_000;
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

async function sendReminder(client: Client, reminder: PostReminder) {
  const content = substituteTimePlaceholders(reminder.content, reminder.meetingAt);

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

async function sendPost(
  client: Client,
  post: ScheduledPost & { guild: { timezone: string } }
): Promise<{
  meetingAt: Date;
  messages: Array<{ channelId: string; messageId: string }>;
}> {
  const mention = post.mentionRoleId ? `<@&${post.mentionRoleId}>` : "";
  const allowedMentions = post.mentionRoleId
    ? { roles: [post.mentionRoleId] }
    : undefined;

  // Meeting time = actual send time + leadMinutes. Using send time (not the
  // scheduled nextFireAt) avoids confusing "X seconds ago" rendering from the
  // up-to-one-poll-interval delay between scheduled and actual fire.
  const meetingTime = new Date(Date.now() + post.leadMinutes * 60_000);
  const content = substituteTimePlaceholders(post.content, meetingTime);
  const embedTitle = post.embedTitle
    ? substituteTimePlaceholders(post.embedTitle, meetingTime)
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

  return { meetingAt: meetingTime, messages };
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
