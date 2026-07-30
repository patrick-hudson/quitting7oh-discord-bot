// Background worker for user-message exports. The portal inserts UserExportJob
// rows (status=pending); this worker claims them one at a time, scans the
// selected channels via Discord's REST API filtering to the target author,
// builds a Markdown zip (one .md per channel + index.md), stores it on the job
// row, and DMs the requesting admin a download link (best effort).
//
// Same polling philosophy as the scheduler: no IPC, crash-safe (stuck
// "running" jobs are reset to pending on startup), one job at a time so a big
// export can't starve Discord rate limits for the scheduler's sends.

import JSZip from "jszip";
import { Client } from "discord.js";
import { prisma } from "@/lib/db";
import { formatMessage, type Resolver } from "@/lib/discord-export";
import {
  listRoles,
  listTextChannels,
  scanMessagesByAuthor,
} from "@/lib/discord-rest";
import type { UserExportJob } from "@prisma/client";
import { audit } from "@/lib/audit";

const POLL_MS = 15_000;
// Delete finished/failed jobs (and their zip blobs) after a week.
const PRUNE_AFTER_DAYS = 7;
// Per-channel scan ceiling — a backstop against a truly enormous channel
// grinding the worker for hours, NOT a Discord limit (the API pages
// arbitrarily deep). 200k ≈ 2,000 API requests ≈ tens of minutes worst case
// for one channel; most channels never get near it. Overridable via env.
// Surfaced in index.md when hit so the export is honest about being partial.
const SCAN_LIMIT_PER_CHANNEL = Number(
  process.env.USER_EXPORT_SCAN_LIMIT ?? "200000"
);

export function runUserExportWorker(client: Client) {
  console.log(`[user-export] polling every ${POLL_MS}ms`);

  // Crash recovery: anything left "running" from a previous process retries.
  prisma.userExportJob
    .updateMany({ where: { status: "running" }, data: { status: "pending" } })
    .then((r) => {
      if (r.count > 0) console.log(`[user-export] reset ${r.count} stuck job(s)`);
    })
    .catch((err) => console.warn("[user-export] startup reset failed:", err));

  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick(client);
    } catch (err) {
      console.error("[user-export] tick failed:", err);
    } finally {
      running = false;
    }
  }, POLL_MS);
}

async function tick(client: Client) {
  // Prune old jobs so zip blobs don't accumulate in the DB forever.
  const cutoff = new Date(Date.now() - PRUNE_AFTER_DAYS * 24 * 60 * 60_000);
  await prisma.userExportJob.deleteMany({
    where: { status: { in: ["done", "failed"] }, createdAt: { lt: cutoff } },
  });

  const job = await prisma.userExportJob.findFirst({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
  });
  if (!job) return;

  await prisma.userExportJob.update({
    where: { id: job.id },
    data: { status: "running", startedAt: new Date() },
  });
  console.log(
    `[user-export] job ${job.id}: exporting user ${job.targetUserId} in guild ${job.guildId}`
  );

  try {
    const result = await runExport(job);
    await prisma.userExportJob.update({
      where: { id: job.id },
      data: {
        status: "done",
        finishedAt: new Date(),
        output: result.zip,
        fileName: result.fileName,
        matchedCount: result.matched,
        scannedCount: result.scanned,
      },
    });
    console.log(
      `[user-export] job ${job.id}: done — ${result.matched} message(s) from ${result.scanned} scanned`
    );
    audit(
      job.guildId,
      "export.completed",
      `User export for ${job.targetUserId} finished — ${result.matched} message(s) from ${result.scanned} scanned`,
      {
        jobId: job.id,
        targetUserId: job.targetUserId,
        requestedBy: job.requestedBy,
        matched: result.matched,
        scanned: result.scanned,
        sinceAt: job.sinceAt?.toISOString() ?? null,
        untilAt: job.untilAt?.toISOString() ?? null,
        channelFilter: job.channelIds,
        fileName: result.fileName,
      }
    );
    await notifyRequester(client, job, result.matched);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[user-export] job ${job.id} failed:`, err);
    audit(
      job.guildId,
      "export.failed",
      `User export for ${job.targetUserId} failed`,
      {
        jobId: job.id,
        targetUserId: job.targetUserId,
        requestedBy: job.requestedBy,
        error: message.slice(0, 500),
      },
      "error"
    );
    await prisma.userExportJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        error: message.slice(0, 2000),
      },
    });
  }
}

async function runExport(job: UserExportJob): Promise<{
  zip: Uint8Array<ArrayBuffer>;
  fileName: string;
  matched: number;
  scanned: number;
}> {
  const [allChannels, allRoles] = await Promise.all([
    listTextChannels(job.guildId),
    listRoles(job.guildId),
  ]);
  const channelById = new Map(allChannels.map((c) => [c.id, c.name]));
  const roleById = new Map(allRoles.map((r) => [r.id, r.name]));
  const userById = new Map<string, string>();
  const resolver: Resolver = {
    user: (id) => userById.get(id) ?? id,
    role: (id) => roleById.get(id) ?? id,
    channel: (id) => channelById.get(id) ?? id,
  };

  const targetChannels =
    job.channelIds.length > 0
      ? allChannels.filter((c) => job.channelIds.includes(c.id))
      : allChannels;

  const zip = new JSZip();
  let targetName = job.targetUserId;
  let totalMatched = 0;
  let totalScanned = 0;
  const indexLines: string[] = [];
  const usedNames = new Set<string>();

  for (const channel of targetChannels) {
    let scanned = 0;
    try {
      const result = await scanMessagesByAuthor(channel.id, job.targetUserId, {
        since: job.sinceAt,
        until: job.untilAt,
        scanLimit: SCAN_LIMIT_PER_CHANNEL,
      });
      scanned = result.scanned;
      totalScanned += result.scanned;
      if (result.matches.length === 0) {
        if (result.hitCap) {
          indexLines.push(
            `- #${channel.name} — 0 found (⚠ scan capped at ${SCAN_LIMIT_PER_CHANNEL} messages; older history not covered)`
          );
        }
        continue;
      }

      // Learn display names from the messages themselves — the author's name
      // for the export title, everyone else's for mention resolution.
      for (const m of result.matches) {
        userById.set(m.author.id, m.author.global_name || m.author.username);
        if (m.author.id === job.targetUserId) {
          targetName = m.author.global_name || m.author.username;
        }
        for (const mention of m.mentions) {
          userById.set(mention.id, mention.global_name || mention.username);
        }
      }

      totalMatched += result.matches.length;
      const safeName = uniqueFileName(channel.name, channel.id, usedNames);
      const out: string[] = [
        `# #${channel.name}`,
        `*${result.matches.length} message(s) by ${targetName}.*` +
          (result.hitCap
            ? `\n\n*⚠ Scan capped at ${SCAN_LIMIT_PER_CHANNEL} messages — older history in this channel was not covered.*`
            : ""),
      ];
      for (const m of result.matches) {
        out.push(formatMessage(m, resolver));
      }
      zip.file(`${safeName}.md`, out.join("\n\n"));
      indexLines.push(
        `- [#${channel.name}](${safeName}.md) — ${result.matches.length} message(s)` +
          (result.hitCap ? " (⚠ scan capped)" : "")
      );
    } catch (err) {
      const message = (err as Error).message;
      indexLines.push(`- #${channel.name} — scan failed: ${message}`);
      totalScanned += scanned;
    }
  }

  const rangeLine = [
    job.sinceAt ? `from ${job.sinceAt.toISOString()}` : "from the beginning",
    job.untilAt ? `until ${job.untilAt.toISOString()}` : "until now",
  ].join(", ");
  zip.file(
    "index.md",
    [
      `# Message export — ${targetName} (${job.targetUserId})`,
      `Generated ${new Date().toISOString()}. Range: ${rangeLine}.`,
      `${totalMatched} message(s) found across ${targetChannels.length} channel(s) scanned.`,
      "",
      "Deleted messages can't be recovered — this export reflects what is",
      "currently visible to the bot on Discord.",
      "",
      "## Channels",
      ...(indexLines.length > 0 ? indexLines : ["*No messages found.*"]),
    ].join("\n")
  );

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  // Copy into a plain Uint8Array — Prisma's Bytes type wants Uint8Array over a
  // non-shared ArrayBuffer, which Node's Buffer doesn't guarantee.
  const bytes = new Uint8Array(buffer.byteLength) as Uint8Array<ArrayBuffer>;
  bytes.set(buffer);
  const safeUser = targetName.replace(/[^a-zA-Z0-9_-]+/g, "-") || job.targetUserId;
  const fileName = `user-export-${safeUser}-${new Date().toISOString().split("T")[0]}.zip`;
  return { zip: bytes, fileName, matched: totalMatched, scanned: totalScanned };
}

// Best-effort DM to the requesting admin with a portal link. Closed DMs or a
// missing NEXTAUTH_URL just log — the jobs list on the export page is the
// source of truth either way.
async function notifyRequester(client: Client, job: UserExportJob, matched: number) {
  try {
    const base = (process.env.NEXTAUTH_URL ?? "").replace(/\/$/, "");
    const link = base
      ? `${base}/dashboard/${job.guildId}/export`
      : "the portal's Export page";
    const user = await client.users.fetch(job.requestedBy);
    await user.send(
      `📦 Your message export for <@${job.targetUserId}> is ready — ${matched} message(s). Download it from ${link} (available for ${PRUNE_AFTER_DAYS} days).`
    );
  } catch (err) {
    console.warn(`[user-export] DM to requester ${job.requestedBy} failed:`, err);
  }
}

function uniqueFileName(channelName: string, channelId: string, used: Set<string>): string {
  const base =
    channelName.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || channelId;
  let candidate = base;
  if (used.has(candidate)) candidate = `${base}-${channelId}`;
  used.add(candidate);
  return candidate;
}
