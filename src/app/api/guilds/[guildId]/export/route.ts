import { NextResponse } from "next/server";
import { z } from "zod";
import JSZip from "jszip";
import { withErrors } from "@/lib/api";
import { requireGuildAccess } from "@/lib/authz";
import {
  listMessages,
  listPinnedMessages,
  listRoles,
  listTextChannels,
} from "@/lib/discord-rest";
import { formatMessage, type Resolver } from "@/lib/discord-export";
import { downloadAttachmentsIntoZip, mediaSummaryLine } from "@/lib/export-media";

const bodySchema = z.object({
  channelIds: z
    .array(z.string().regex(/^\d{17,21}$/))
    .min(1)
    .max(25),
  limitPerChannel: z.number().int().min(1).max(50000).default(10000),
  onlyPinned: z.boolean().default(false),
  // Archive attachment bytes into the zip (media/) so the export survives
  // Discord's ~24h signed-URL expiry. Off by default — media can be big.
  includeMedia: z.boolean().default(false),
});

// POST — fetches messages from each selected channel, formats as Markdown,
// returns a zip file with one .md per channel plus an index.md summary.
export const POST = withErrors(async (
  req: Request,
  ctx: { params: Promise<{ guildId: string }> }
) => {
  const { guildId } = await ctx.params;
  await requireGuildAccess(guildId);

  const { channelIds, limitPerChannel, onlyPinned, includeMedia } = bodySchema.parse(
    await req.json()
  );

  // Pre-fetch channels and roles so we can resolve mentions while formatting.
  // Users get resolved per-message from the message author/mentions arrays —
  // no extra API call per user.
  const [allChannels, allRoles] = await Promise.all([
    listTextChannels(guildId),
    listRoles(guildId),
  ]);
  const channelById = new Map(allChannels.map((c) => [c.id, c.name]));
  const roleById = new Map(allRoles.map((r) => [r.id, r.name]));
  // userById is populated lazily from each message's mentions/author.
  const userById = new Map<string, string>();

  // Populated per-channel below when includeMedia is on.
  const mediaPaths = new Map<string, string>();
  const mediaStats = {
    downloaded: 0,
    skippedTooLarge: 0,
    skippedOverBudget: 0,
    failed: 0,
    bytes: 0,
  };

  const resolver: Resolver = {
    user: (id) => userById.get(id) ?? id,
    role: (id) => roleById.get(id) ?? id,
    channel: (id) => channelById.get(id) ?? id,
    media: includeMedia ? (id) => mediaPaths.get(id) ?? null : undefined,
  };

  const zip = new JSZip();
  const generatedAt = new Date().toLocaleString();
  const indexLines: string[] = [
    `# Channel export — ${generatedAt}`,
    onlyPinned
      ? `Exported pinned messages from ${channelIds.length} channel(s).`
      : `Exported ${channelIds.length} channel(s) from this Discord server. ` +
        `Each channel is a separate Markdown file in this archive.`,
    "",
    "## Channels",
  ];
  const usedNames = new Set<string>();

  for (const channelId of channelIds) {
    const channelName = channelById.get(channelId) ?? channelId;
    const safeName = uniqueFileName(channelName, channelId, usedNames);
    const fileName = `${safeName}.md`;

    const out: string[] = [`# #${channelName}`];
    try {
      const messages = onlyPinned
        ? await listPinnedMessages(channelId)
        : await listMessages(channelId, { limit: limitPerChannel });

      // Backfill the username cache from this channel's messages so mention
      // resolution works for users we haven't seen yet.
      for (const m of messages) {
        userById.set(m.author.id, m.author.global_name || m.author.username);
        for (const mention of m.mentions) {
          userById.set(mention.id, mention.global_name || mention.username);
        }
      }

      if (includeMedia) {
        const { paths } = await downloadAttachmentsIntoZip(messages, zip, mediaStats);
        for (const [id, p] of paths) mediaPaths.set(id, p);
      }

      const label = onlyPinned ? "pinned message(s)" : "message(s)";
      out.push(`*${messages.length} ${label}.*`);
      for (const m of messages) {
        out.push(formatMessage(m, resolver));
      }
      indexLines.push(`- [#${channelName}](${fileName}) — ${messages.length} ${label}`);
    } catch (err) {
      const message = (err as Error).message;
      out.push(`*Export failed: ${message}*`);
      indexLines.push(`- [#${channelName}](${fileName}) — export failed: ${message}`);
    }

    zip.file(fileName, out.join("\n\n"));
  }

  if (includeMedia) {
    indexLines.push("", `*${mediaSummaryLine(mediaStats)}*`);
  }
  zip.file("index.md", indexLines.join("\n"));

  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  const filename = `discord-export-${guildId}-${new Date().toISOString().split("T")[0]}.zip`;

  return new NextResponse(blob, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(blob.size),
    },
  });
});

// Channel names are mostly safe (Discord restricts to lowercase, digits, hyphens,
// underscores) but we sanitize defensively and fall back to the channel id on
// collisions, since two channels can share a name across categories.
function uniqueFileName(channelName: string, channelId: string, used: Set<string>): string {
  const base = channelName.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || channelId;
  let candidate = base;
  if (used.has(candidate)) candidate = `${base}-${channelId}`;
  used.add(candidate);
  return candidate;
}
