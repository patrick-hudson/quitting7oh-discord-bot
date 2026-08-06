"use client";

// Lightweight rendered previews for template textareas — reuses the
// Discord-markdown renderer from DiscordPreview (bold/lists/timestamps/
// mentions/ansi blocks) without the post-specific chrome (embeds, role
// pings). Forms substitute their own placeholders with SAMPLE values before
// handing text here, so admins see roughly what members will see.

import {
  renderDiscordMarkdown,
  substitutePlaceholders,
} from "@/components/DiscordPreview";

// One message bubble.
export function MessagePreview({
  content,
  meetingDate,
}: {
  content: string;
  // When set, {meetingTime[:fmt]} placeholders render as Discord-style
  // timestamps relative to this date.
  meetingDate?: Date;
}) {
  const substituted = substitutePlaceholders(
    content,
    meetingDate ?? new Date(),
    [],
    []
  );
  return (
    <div className="rounded-lg bg-[#313338] px-3 py-2 text-[14px] leading-snug text-[#dbdee1] ring-1 ring-white/5">
      <div className="whitespace-pre-wrap">
        {renderDiscordMarkdown(substituted, [], [])}
      </div>
    </div>
  );
}

// A roster preview: one bubble per template entry. `substitute` maps a raw
// template line to display text (sample placeholder values, \n expansion).
export function RosterPreview({
  lines,
  substitute,
  meetingDate,
  emptyNote = "Nothing to preview.",
}: {
  lines: string[];
  substitute?: (line: string) => string;
  meetingDate?: Date;
  emptyNote?: string;
}) {
  if (lines.length === 0) {
    return <p className="text-xs text-white/40">{emptyNote}</p>;
  }
  return (
    <div className="space-y-1.5">
      {lines.map((line, i) => (
        <MessagePreview
          key={i}
          content={substitute ? substitute(line) : line}
          meetingDate={meetingDate}
        />
      ))}
    </div>
  );
}
