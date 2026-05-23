// Polling scheduler. Every N seconds:
//   - SELECT ScheduledPost WHERE active = true AND nextFireAt <= now()
//   - For each row: post the message, then either compute a new nextFireAt
//     (recurring) or set active=false + nextFireAt=null (one-off).
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
import type { ScheduledPost } from "@prisma/client";

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
  const now = new Date();
  const due = await prisma.scheduledPost.findMany({
    where: { active: true, nextFireAt: { lte: now, not: null } },
    include: { guild: true },
    take: 25,
  });
  if (due.length === 0) return;

  for (const post of due) {
    try {
      await sendPost(client, post);
      await advancePost(post, post.guild.timezone);
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
) {
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

  let succeeded = 0;
  const failures: string[] = [];
  await Promise.all(
    post.channelIds.map(async (channelId) => {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased() || !("send" in channel)) {
          throw new Error("not a sendable text channel");
        }
        await channel.send(payload);
        succeeded++;
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
  if (succeeded === 0) {
    throw new Error(`all ${post.channelIds.length} channels failed`);
  }

  console.log(
    `[scheduler] sent "${post.name}" to ${succeeded}/${post.channelIds.length} channels`
  );
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
