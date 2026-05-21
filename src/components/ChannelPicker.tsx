"use client";

import { useMemo, useState } from "react";

type Channel = { id: string; name: string; parent_id: string | null };

// Multi-select channel picker. Channels are fetched from Discord via
// /api/guilds/[guildId]/channels and grouped by category. Includes a search
// box and a quick selected-summary at the top.
export function ChannelPicker({
  channels,
  selectedIds,
  onChange,
}: {
  channels: Channel[];
  selectedIds: string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return channels;
    return channels.filter((c) => c.name.toLowerCase().includes(q));
  }, [channels, query]);

  // Group by parent_id (category). Channels without a parent go into an
  // "Uncategorized" bucket. Build a name lookup from the full channel list so
  // category labels still appear even when the channel is a category itself —
  // but the channel listing only contains text-capable channels, so we look
  // up parent names via id and fall back to the raw id.
  const grouped = useMemo(() => {
    const byParent = new Map<string | null, Channel[]>();
    for (const c of filtered) {
      const k = c.parent_id;
      const arr = byParent.get(k) ?? [];
      arr.push(c);
      byParent.set(k, arr);
    }
    return Array.from(byParent.entries()).sort(([a], [b]) => {
      if (a === null) return 1;
      if (b === null) return -1;
      return a.localeCompare(b);
    });
  }, [filtered]);

  const selectedSet = new Set(selectedIds);
  const selectedChannels = channels.filter((c) => selectedSet.has(c.id));

  function toggle(id: string) {
    if (selectedSet.has(id)) onChange(selectedIds.filter((x) => x !== id));
    else onChange([...selectedIds, id]);
  }

  function clear() {
    onChange([]);
  }

  return (
    <div className="rounded-lg bg-white/5 ring-1 ring-white/10">
      <div className="flex items-center gap-2 border-b border-white/5 p-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={channels.length ? "Search channels…" : "Loading channels…"}
          className="flex-1 rounded-md bg-transparent px-2 py-1 text-sm placeholder:text-white/30 focus:outline-none"
        />
        {selectedIds.length > 0 && (
          <button
            type="button"
            onClick={clear}
            className="rounded px-2 py-1 text-xs text-white/50 hover:bg-white/10 hover:text-white"
          >
            Clear ({selectedIds.length})
          </button>
        )}
      </div>

      {selectedChannels.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-white/5 p-2">
          {selectedChannels.map((c) => (
            <span
              key={c.id}
              className="inline-flex items-center gap-1 rounded-md bg-[color:var(--color-brand-500)]/20 px-2 py-0.5 text-xs text-[color:var(--color-brand-500)] ring-1 ring-[color:var(--color-brand-500)]/30"
            >
              #{c.name}
              <button
                type="button"
                onClick={() => toggle(c.id)}
                className="ml-0.5 text-[color:var(--color-brand-500)]/70 hover:text-white"
                aria-label={`Remove ${c.name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="max-h-64 overflow-y-auto p-1">
        {grouped.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-white/40">
            {channels.length === 0 ? "Loading…" : "No channels match."}
          </p>
        )}
        {grouped.map(([parentId, list]) => (
          <div key={parentId ?? "uncategorized"} className="mb-1">
            <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-white/40">
              {parentId ? "Category" : "Uncategorized"}
            </div>
            {list.map((c) => (
              <label
                key={c.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-sm hover:bg-white/5"
              >
                <input
                  type="checkbox"
                  checked={selectedSet.has(c.id)}
                  onChange={() => toggle(c.id)}
                  className="accent-[color:var(--color-brand-500)]"
                />
                <span className="text-white/40">#</span>
                <span>{c.name}</span>
              </label>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
