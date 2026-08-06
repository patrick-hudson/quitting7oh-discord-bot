// Convert a Discord message into a Markdown chunk. Preserves emojis,
// hyperlinks, mentions (resolved to readable names), embeds, and attachments.
//
// What we do NOT try to preserve:
//   - Animated emoji animation (we link to the emoji image)
//   - Voice messages / app interactions / poll results
//   - Reactions are summarized inline but not styled

import type { DiscordMessageRaw } from "./discord-rest";

export type Resolver = {
  // user id → display name (global_name preferred, fallback to username, then id)
  user: (id: string) => string;
  role: (id: string) => string;
  channel: (id: string) => string;
  // attachment id → zip-relative path when the file was archived into the
  // export (see export-media.ts); null/undefined = link the (expiring)
  // Discord CDN URL instead.
  media?: (attachmentId: string) => string | null;
};

export function formatMessage(msg: DiscordMessageRaw, resolve: Resolver): string {
  const author = displayName(msg.author);
  const tsIso = msg.timestamp;
  const tsLocal = new Date(tsIso).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const editedMark = msg.edited_timestamp ? " *(edited)*" : "";
  const replyLine = msg.referenced_message
    ? `\n> *replying to ${displayName(msg.referenced_message.author ?? { username: "unknown", global_name: null })}*`
    : "";

  const body = resolveTokens(msg.content, resolve);
  const embedsMd = msg.embeds.map((e) => formatEmbed(e, resolve)).join("\n\n");
  const attachmentsMd = msg.attachments
    .map((a) => {
      const isImage = (a.content_type ?? "").startsWith("image/");
      const target = resolve.media?.(a.id) ?? a.url;
      return isImage
        ? `![${a.filename}](${target})`
        : `📎 [${a.filename}](${target}) (${formatBytes(a.size)})`;
    })
    .join("\n");
  const reactionsMd =
    msg.reactions && msg.reactions.length > 0
      ? "\n\n*Reactions:* " +
        msg.reactions
          .map((r) => `${formatEmojiToken(r.emoji)} ${r.count}`)
          .join("  ")
      : "";

  const parts = [
    `### ${author} — ${tsLocal}${editedMark}${replyLine}`,
    body,
    embedsMd,
    attachmentsMd,
  ].filter(Boolean);
  return parts.join("\n\n") + reactionsMd;
}

function displayName(author: {
  username?: string;
  global_name?: string | null;
}): string {
  return author.global_name || author.username || "unknown";
}

// Resolve Discord-specific tokens to readable text while keeping markdown
// (bold, italic, code, etc.) intact — Discord's markdown is mostly compatible
// with standard markdown, so we pass it through unchanged.
function resolveTokens(text: string, resolve: Resolver): string {
  if (!text) return "";
  return text
    // User mentions: <@id> or <@!id> → @display-name
    .replace(/<@!?(\d{17,21})>/g, (_, id) => `@${resolve.user(id)}`)
    // Role mentions: <@&id> → @role-name
    .replace(/<@&(\d{17,21})>/g, (_, id) => `@${resolve.role(id)}`)
    // Channel mentions: <#id> → #channel-name
    .replace(/<#(\d{17,21})>/g, (_, id) => `#${resolve.channel(id)}`)
    // Custom emojis: <:name:id> or <a:name:id> → :name: (with image link as title)
    .replace(/<a?:([a-zA-Z0-9_]+):(\d{17,21})>/g, (_match, name, id) => {
      const animated = _match.startsWith("<a:");
      const ext = animated ? "gif" : "png";
      return `![:${name}:](https://cdn.discordapp.com/emojis/${id}.${ext})`;
    })
    // Discord timestamps: <t:UNIX:fmt> → human-readable in the exporter's locale
    .replace(/<t:(\d+):?([tTdDfFR])?>/g, (_, unix, fmt) => {
      const d = new Date(parseInt(unix, 10) * 1000);
      return discordTimestamp(d, fmt ?? "f");
    });
}

function discordTimestamp(d: Date, fmt: string): string {
  switch (fmt) {
    case "t":
      return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    case "T":
      return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    case "d":
      return d.toLocaleDateString();
    case "D":
      return d.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" });
    case "F":
      return d.toLocaleString([], {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    case "R": {
      const diff = Math.round((d.getTime() - Date.now()) / 1000);
      const abs = Math.abs(diff);
      const u = (n: number, name: string) => `${n} ${name}${n === 1 ? "" : "s"}`;
      const future = diff >= 0;
      let val: string;
      if (abs < 60) val = u(abs, "second");
      else if (abs < 3600) val = u(Math.round(abs / 60), "minute");
      else if (abs < 86400) val = u(Math.round(abs / 3600), "hour");
      else val = u(Math.round(abs / 86400), "day");
      return future ? `in ${val}` : `${val} ago`;
    }
    case "f":
    default:
      return d.toLocaleString([], {
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
  }
}

function formatEmojiToken(emoji: { id: string | null; name: string }): string {
  if (!emoji.id) return emoji.name; // unicode
  return `:${emoji.name}:`;
}

function formatEmbed(e: NonNullable<DiscordMessageRaw["embeds"][number]>, resolve: Resolver): string {
  const lines: string[] = [];
  if (e.title) {
    lines.push(e.url ? `> **[${e.title}](${e.url})**` : `> **${e.title}**`);
  }
  if (e.author?.name) {
    lines.push(e.author.url ? `> *[${e.author.name}](${e.author.url})*` : `> *${e.author.name}*`);
  }
  if (e.description) {
    lines.push(
      e.description
        .split("\n")
        .map((l) => `> ${resolveTokens(l, resolve)}`)
        .join("\n")
    );
  }
  if (e.fields) {
    for (const field of e.fields) {
      lines.push(`> **${field.name}**`);
      lines.push(
        field.value
          .split("\n")
          .map((l) => `> ${resolveTokens(l, resolve)}`)
          .join("\n")
      );
    }
  }
  if (e.image?.url) lines.push(`> ![](${e.image.url})`);
  if (e.thumbnail?.url) lines.push(`> ![](${e.thumbnail.url})`);
  if (e.footer?.text) lines.push(`> _${e.footer.text}_`);
  return lines.join("\n");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
