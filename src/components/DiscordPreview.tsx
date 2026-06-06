"use client";

// Approximate Discord-style preview for scheduled posts. Renders the subset of
// markdown the bot actually uses (bold/italic/underline/code/strikethrough,
// bullet lists, links) plus Discord-specific tokens: {meetingTime} placeholders,
// raw <t:UNIX:fmt> timestamps, and <@&roleId> / <#channelId> mentions.
//
// This is intentionally a "good enough" preview — it doesn't try to be a full
// Discord client. The goal is catching layout/typo problems before publishing,
// not pixel-perfect rendering.

import React from "react";
import { substituteAnsiColorTokens } from "@/lib/ansi-tokens";

type Role = { id: string; name: string };
type Channel = { id: string; name: string };

export function DiscordPreview({
  useEmbed,
  content,
  embedTitle,
  embedColor,
  embedUrl,
  embedImage,
  mentionRoleId,
  leadMinutes,
  roles,
  channels,
}: {
  useEmbed: boolean;
  content: string;
  embedTitle: string;
  embedColor: string;
  embedUrl: string;
  embedImage: string;
  mentionRoleId: string;
  leadMinutes: number;
  roles: Role[];
  channels: Channel[];
}) {
  // Use "now" as the fire time so {meetingTime:R} renders as "in N minutes"
  // based on leadMinutes. Refreshes when leadMinutes changes.
  const meetingDate = new Date(Date.now() + leadMinutes * 60_000);
  const tier = roles.find((r) => r.id === mentionRoleId);
  const colorBorder = /^#[0-9a-fA-F]{6}$/.test(embedColor) ? embedColor : "#5865F2";

  const renderedContent = renderDiscordMarkdown(
    substitutePlaceholders(content, meetingDate, roles, channels),
    roles,
    channels
  );
  const renderedTitle = embedTitle
    ? substitutePlaceholders(embedTitle, meetingDate, roles, channels)
    : "";

  return (
    <div className="rounded-lg bg-[#313338] p-3 text-sm text-[#dbdee1] ring-1 ring-white/5">
      {/* Bot author bar */}
      <div className="mb-2 flex items-center gap-2 text-xs text-white/40">
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[#5865F2] text-[10px] font-semibold">
          7OH
        </div>
        <span className="text-white/80">Quitting7oh Bot</span>
        <span className="rounded-sm bg-[#5865F2] px-1 text-[10px] font-semibold text-white">
          APP
        </span>
        <span>· Today at {formatClockTime(meetingDate)}</span>
      </div>

      {/* Optional role ping above the embed */}
      {tier && (
        <div className="mb-2">
          <span className="rounded bg-[#5865F2]/30 px-1 text-[#c9cdfb]">@{tier.name}</span>
        </div>
      )}

      {useEmbed ? (
        <div
          className="flex gap-3 rounded-md bg-[#2b2d31] p-3"
          style={{ borderLeft: `4px solid ${colorBorder}` }}
        >
          <div className="flex-1 space-y-2">
            {renderedTitle && (
              <div className="font-semibold text-white">
                {embedUrl ? (
                  <a
                    href={embedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#00a8fc] hover:underline"
                  >
                    {renderedTitle}
                  </a>
                ) : (
                  renderedTitle
                )}
              </div>
            )}
            <div className="whitespace-pre-wrap text-[14px] leading-snug">
              {renderedContent}
            </div>
            {embedImage && /^https?:\/\//.test(embedImage) && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={embedImage}
                alt=""
                className="mt-2 max-h-48 rounded"
              />
            )}
          </div>
        </div>
      ) : (
        <div className="whitespace-pre-wrap text-[14px] leading-snug text-white/90">
          {renderedContent}
        </div>
      )}
    </div>
  );
}

// --- Helpers ---------------------------------------------------------------

function formatClockTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Replace bot-level placeholders ({meetingTime[:fmt]}) and raw Discord tokens
// (<t:UNIX:fmt>, <@&roleId>, <#channelId>) into preview-friendly tokens that
// the markdown renderer below knows how to style.
function substitutePlaceholders(
  text: string,
  meetingDate: Date,
  roles: Role[],
  channels: Channel[]
): string {
  // First: {meetingTime[:X]} → <t:UNIX:X>
  const unix = Math.floor(meetingDate.getTime() / 1000);
  text = text.replace(/\{meetingTime(?::([tTdDfFR]))?\}/g, (_m, fmt) => {
    return `<t:${unix}:${fmt ?? "t"}>`;
  });
  // {red}/{bold}/etc. → real ESC bytes. Mirror the scheduler so the preview
  // shows real colors for any ```ansi``` block the user writes.
  text = substituteAnsiColorTokens(text);
  // #channel-name → <#id>, matching the scheduler's pre-send rewrite. Unknown
  // names are left as-is so typos don't render as broken-looking links.
  const channelsByName = new Map(channels.map((c) => [c.name.toLowerCase(), c.id]));
  text = text.replace(
    /(?<![A-Za-z0-9])#([A-Za-z0-9][A-Za-z0-9_-]{0,99})/g,
    (m, name: string) => {
      const id = channelsByName.get(name.toLowerCase());
      return id ? `<#${id}>` : m;
    }
  );
  // role mention -> @name (preview only)
  text = text.replace(/<@&(\d{17,21})>/g, (_m, id) => {
    const role = roles.find((r) => r.id === id);
    return `〔@${role?.name ?? id}〕`;
  });
  // channel mention -> #name (preview only)
  text = text.replace(/<#(\d{17,21})>/g, (_m, id) => {
    const channel = channels.find((c) => c.id === id);
    return `〔#${channel?.name ?? id}〕`;
  });
  return text;
}

// Tiny markdown renderer. Handles the subset Discord supports for our posts.
// Returns React nodes (not HTML strings) so we don't have to dangerously set HTML.
function renderDiscordMarkdown(
  text: string,
  _roles: Role[],
  _channels: Channel[]
): React.ReactNode {
  // Split into lines so we can handle list items independently.
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let listBuffer: React.ReactNode[] = [];
  let ansiBuffer: string[] | null = null;

  const flushList = () => {
    if (listBuffer.length > 0) {
      blocks.push(
        <ul key={blocks.length} className="ml-5 list-disc space-y-0.5">
          {listBuffer.map((node, i) => (
            <li key={i}>{node}</li>
          ))}
        </ul>
      );
      listBuffer = [];
    }
  };
  const flushAnsi = () => {
    if (ansiBuffer !== null) {
      blocks.push(renderAnsiBlock(ansiBuffer.join("\n"), blocks.length));
      ansiBuffer = null;
    }
  };

  lines.forEach((line, lineIdx) => {
    // Inside an open ```ansi block: collect until the closing fence.
    if (ansiBuffer !== null) {
      if (line.trim() === "```") {
        flushAnsi();
      } else {
        ansiBuffer.push(line);
      }
      return;
    }
    // Opening ```ansi fence.
    if (line.trim() === "```ansi") {
      flushList();
      ansiBuffer = [];
      return;
    }
    const listMatch = line.match(/^\s*[-*]\s+(.*)$/);
    if (listMatch) {
      listBuffer.push(renderInline(listMatch[1], `l-${lineIdx}`));
    } else {
      flushList();
      blocks.push(
        <div key={`line-${lineIdx}`}>{renderInline(line, `b-${lineIdx}`) || " "}</div>
      );
    }
  });
  flushList();
  // Unterminated ```ansi block still renders — better than swallowing the text.
  flushAnsi();

  return <>{blocks}</>;
}

// Inline markdown: **bold**, *italic*, __underline__, ~~strike~~, `code`,
// Discord timestamps <t:UNIX:fmt>, "preview tokens" 〔@role〕/〔#channel〕,
// and bare URLs (linkified).
function renderInline(text: string, keyBase: string): React.ReactNode {
  if (text === "") return null;
  // Order matters: timestamps and tokens first (so their syntax isn't eaten by
  // markdown rules), then markdown.
  type Token = { kind: string; value: string; format?: string };
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const remaining = text.slice(i);

    // Discord timestamp: <t:UNIX:fmt>
    const ts = remaining.match(/^<t:(\d+):([tTdDfFR])>/);
    if (ts) {
      tokens.push({ kind: "timestamp", value: ts[1], format: ts[2] });
      i += ts[0].length;
      continue;
    }
    // Mention preview token: 〔@name〕 or 〔#name〕
    const mention = remaining.match(/^〔([@#])([^〕]+)〕/);
    if (mention) {
      tokens.push({ kind: mention[1] === "@" ? "rolemention" : "channelmention", value: mention[2] });
      i += mention[0].length;
      continue;
    }
    // Code: `text`
    const code = remaining.match(/^`([^`]+)`/);
    if (code) {
      tokens.push({ kind: "code", value: code[1] });
      i += code[0].length;
      continue;
    }
    // Bold: **text**
    const bold = remaining.match(/^\*\*([^*]+)\*\*/);
    if (bold) {
      tokens.push({ kind: "bold", value: bold[1] });
      i += bold[0].length;
      continue;
    }
    // Underline: __text__
    const underline = remaining.match(/^__([^_]+)__/);
    if (underline) {
      tokens.push({ kind: "underline", value: underline[1] });
      i += underline[0].length;
      continue;
    }
    // Italic: *text* (single asterisk, after **)
    const italic = remaining.match(/^\*([^*]+)\*/);
    if (italic) {
      tokens.push({ kind: "italic", value: italic[1] });
      i += italic[0].length;
      continue;
    }
    // Strike: ~~text~~
    const strike = remaining.match(/^~~([^~]+)~~/);
    if (strike) {
      tokens.push({ kind: "strike", value: strike[1] });
      i += strike[0].length;
      continue;
    }
    // Bare URL → linkify
    const url = remaining.match(/^https?:\/\/[^\s]+/);
    if (url) {
      tokens.push({ kind: "url", value: url[0] });
      i += url[0].length;
      continue;
    }
    // Markdown link [text](url)
    const link = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (link) {
      tokens.push({ kind: "link", value: link[1], format: link[2] });
      i += link[0].length;
      continue;
    }
    // Plain text chunk: gobble until next special char
    let chunkEnd = remaining.search(/[*_~`<〔h\[]/);
    if (chunkEnd === -1) chunkEnd = remaining.length;
    if (chunkEnd === 0) {
      // single character we don't know what to do with; take it literally
      tokens.push({ kind: "text", value: remaining[0] });
      i += 1;
    } else {
      tokens.push({ kind: "text", value: remaining.slice(0, chunkEnd) });
      i += chunkEnd;
    }
  }

  return (
    <>
      {tokens.map((t, idx) => {
        const k = `${keyBase}-${idx}`;
        switch (t.kind) {
          case "bold":
            return <strong key={k} className="font-bold">{t.value}</strong>;
          case "italic":
            return <em key={k} className="italic">{t.value}</em>;
          case "underline":
            return <u key={k}>{t.value}</u>;
          case "strike":
            return <s key={k}>{t.value}</s>;
          case "code":
            return (
              <code key={k} className="rounded bg-[#1e1f22] px-1 font-mono text-[12px]">
                {t.value}
              </code>
            );
          case "timestamp":
            return (
              <span
                key={k}
                className="rounded bg-[#3f4248] px-1 text-[13px] text-white/90"
                title={`<t:${t.value}:${t.format ?? "t"}>`}
              >
                {renderTimestamp(parseInt(t.value, 10), t.format ?? "t")}
              </span>
            );
          case "rolemention":
            return (
              <span key={k} className="rounded bg-[#5865F2]/30 px-1 text-[#c9cdfb]">
                @{t.value}
              </span>
            );
          case "channelmention":
            return (
              <span key={k} className="rounded bg-[#5865F2]/30 px-1 text-[#c9cdfb]">
                #{t.value}
              </span>
            );
          case "url":
            return (
              <a
                key={k}
                href={t.value}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#00a8fc] hover:underline"
              >
                {t.value}
              </a>
            );
          case "link":
            return (
              <a
                key={k}
                href={t.format}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#00a8fc] hover:underline"
              >
                {t.value}
              </a>
            );
          default:
            return <React.Fragment key={k}>{t.value}</React.Fragment>;
        }
      })}
    </>
  );
}

function renderTimestamp(unixSec: number, format: string): string {
  const date = new Date(unixSec * 1000);
  const now = new Date();
  switch (format) {
    case "t":
      return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    case "T":
      return date.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      });
    case "d":
      return date.toLocaleDateString([], { month: "numeric", day: "numeric", year: "numeric" });
    case "D":
      return date.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" });
    case "f":
      return date.toLocaleString([], {
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    case "F":
      return date.toLocaleString([], {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    case "R": {
      const diffSec = Math.round((date.getTime() - now.getTime()) / 1000);
      const abs = Math.abs(diffSec);
      const future = diffSec >= 0;
      const fmt = (n: number, unit: string) =>
        future ? `in ${n} ${unit}${n === 1 ? "" : "s"}` : `${n} ${unit}${n === 1 ? "" : "s"} ago`;
      if (abs < 60) return fmt(abs, "second");
      if (abs < 3600) return fmt(Math.round(abs / 60), "minute");
      if (abs < 86400) return fmt(Math.round(abs / 3600), "hour");
      return fmt(Math.round(abs / 86400), "day");
    }
    default:
      return date.toLocaleString();
  }
}

// Discord's documented ANSI palette → approximate dark-theme hex values for
// the preview. Not pixel-exact to Discord's renderer but close enough for the
// purpose: see roughly what members will see before publishing.
const ANSI_FG: Record<string, string> = {
  "30": "#80868b", // gray
  "31": "#f04747", // red
  "32": "#43b581", // green
  "33": "#faa61a", // yellow
  "34": "#7289da", // blue
  "35": "#f47fff", // pink
  "36": "#00bcd4", // cyan
  "37": "#ffffff", // white
};

// Render a ```ansi``` block: walk the text, accumulating runs of characters
// styled by whatever ESC [...m sequence was last seen. `[0m` resets.
function renderAnsiBlock(text: string, key: number): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let style: React.CSSProperties = {};
  let buffer = "";
  let partIdx = 0;

  const flush = () => {
    if (buffer) {
      parts.push(
        <span
          key={partIdx++}
          style={Object.keys(style).length ? style : undefined}
        >
          {buffer}
        </span>
      );
      buffer = "";
    }
  };

  for (let i = 0; i < text.length; i++) {
    if (text[i] === "" && text[i + 1] === "[") {
      flush();
      let j = i + 2;
      while (j < text.length && text[j] !== "m") j++;
      const codes = text
        .slice(i + 2, j)
        .split(";")
        .filter(Boolean);
      for (const code of codes) {
        if (code === "0") {
          style = {};
        } else if (code === "1") {
          style = { ...style, fontWeight: "bold" };
        } else if (code === "4") {
          style = { ...style, textDecoration: "underline" };
        } else if (ANSI_FG[code]) {
          style = { ...style, color: ANSI_FG[code] };
        }
      }
      i = j; // skip past the 'm'
      continue;
    }
    buffer += text[i];
  }
  flush();

  return (
    <pre
      key={key}
      className="my-1 whitespace-pre-wrap break-words rounded-md bg-[#1e1f22] p-2 font-mono text-[13px] leading-snug"
    >
      {parts}
    </pre>
  );
}
