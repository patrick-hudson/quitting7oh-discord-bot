// Downloads message attachments into an export zip so archives survive
// Discord's ~24h signed-URL expiry (links stored as URLs silently rot; bytes
// don't). Two-pass design: download everything first, then format messages
// against the map of what actually landed — so the markdown never links to a
// file that failed to download.

import type JSZip from "jszip";
import type { DiscordMessageRaw } from "@/lib/discord-rest";

const FILE_CAP_MB = Number(process.env.EXPORT_MEDIA_FILE_CAP_MB ?? "10");
const TOTAL_CAP_MB = Number(process.env.EXPORT_MEDIA_TOTAL_CAP_MB ?? "200");

export type MediaStats = {
  downloaded: number;
  skippedTooLarge: number;
  skippedOverBudget: number;
  failed: number;
  bytes: number;
};

// Downloads attachments from `messages` into `zip` under media/, deduped by
// attachment id. Returns a map of attachmentId → zip-relative path for every
// file that made it, plus stats for the export's index/summary.
export async function downloadAttachmentsIntoZip(
  messages: DiscordMessageRaw[],
  zip: JSZip,
  stats: MediaStats = {
    downloaded: 0,
    skippedTooLarge: 0,
    skippedOverBudget: 0,
    failed: 0,
    bytes: 0,
  }
): Promise<{ paths: Map<string, string>; stats: MediaStats }> {
  const paths = new Map<string, string>();
  const fileCap = FILE_CAP_MB * 1024 * 1024;
  const totalCap = TOTAL_CAP_MB * 1024 * 1024;

  for (const m of messages) {
    for (const a of m.attachments) {
      if (paths.has(a.id)) continue;
      if (a.size > fileCap) {
        stats.skippedTooLarge++;
        continue;
      }
      if (stats.bytes + a.size > totalCap) {
        stats.skippedOverBudget++;
        continue;
      }
      try {
        // Attachment URLs in API responses come pre-signed (~24h validity),
        // so a plain fetch works — no Discord auth header needed.
        const res = await fetch(a.url);
        if (!res.ok) {
          stats.failed++;
          continue;
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        const safeName = a.filename.replace(/[^\w.-]+/g, "_").slice(0, 120);
        const path = `media/${a.id}-${safeName}`;
        zip.file(path, buf);
        paths.set(a.id, path);
        stats.downloaded++;
        stats.bytes += buf.byteLength;
      } catch {
        stats.failed++;
      }
    }
  }
  return { paths, stats };
}

export function mediaSummaryLine(stats: MediaStats): string {
  const mb = (stats.bytes / (1024 * 1024)).toFixed(1);
  const skipped = stats.skippedTooLarge + stats.skippedOverBudget + stats.failed;
  return (
    `${stats.downloaded} media file(s) archived (${mb} MB)` +
    (skipped > 0
      ? ` — ${stats.skippedTooLarge} over the ${FILE_CAP_MB}MB file cap, ` +
        `${stats.skippedOverBudget} over the ${TOTAL_CAP_MB}MB total cap, ` +
        `${stats.failed} failed (linked to Discord's expiring URLs instead)`
      : "")
  );
}
