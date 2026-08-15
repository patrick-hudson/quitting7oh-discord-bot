"use client";

// Shared chip-list editor for subreddit sets: type + Enter (or Add), paste
// comma-separated lists or full reddit URLs, × to remove. Draft commits on
// blur so a forgotten Enter never loses a sub. Used by the Settings and
// Reddit-leaderboard pages.

import { useState } from "react";

export function SubredditListEditor({
  label,
  hint,
  placeholder,
  list,
  setList,
}: {
  label: string;
  hint: string;
  placeholder: string;
  list: string[];
  setList: React.Dispatch<React.SetStateAction<string[]>>;
}) {
  const [draft, setDraft] = useState("");

  function parse(raw: string): string[] {
    return raw
      .split(/[,\s]+/)
      .map((s) =>
        s
          .trim()
          .replace(/^https?:\/\/(www\.)?reddit\.com\//i, "")
          .replace(/^\/?r\//i, "")
          .replace(/\/.*$/, "")
      )
      .filter(Boolean);
  }

  function add(raw: string) {
    const parsed = parse(raw);
    if (parsed.length === 0) return;
    setList((prev) => {
      const seen = new Set(prev.map((s) => s.toLowerCase()));
      const next = [...prev];
      for (const s of parsed) {
        if (!seen.has(s.toLowerCase())) {
          seen.add(s.toLowerCase());
          next.push(s);
        }
      }
      return next;
    });
    setDraft("");
  }

  return (
    <div>
      <label className="mb-1 block text-sm text-white/80">{label}</label>
      {list.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {list.map((s) => (
            <span
              key={s.toLowerCase()}
              className="inline-flex items-center gap-1 rounded-full bg-white/5 py-1 pl-2.5 pr-1 text-xs text-white/80 ring-1 ring-white/10"
            >
              r/{s}
              <button
                type="button"
                aria-label={`Remove r/${s}`}
                onClick={() => setList((prev) => prev.filter((x) => x !== s))}
                className="rounded-full px-1 text-white/40 hover:bg-white/10 hover:text-white/90"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="text-sm text-white/40">r/</span>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
            }
          }}
          onBlur={() => add(draft)}
          placeholder={list.length > 0 ? "add another…" : placeholder}
          className="w-full rounded-lg bg-white/5 px-3 py-2 text-sm ring-1 ring-white/10 placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-500)]"
        />
        <button
          type="button"
          onClick={() => add(draft)}
          disabled={!draft.trim()}
          className="shrink-0 rounded-lg bg-white/5 px-3 py-2 text-sm text-white/70 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-40"
        >
          Add
        </button>
      </div>
      <p className="mt-1 text-xs text-white/40">{hint}</p>
    </div>
  );
}
