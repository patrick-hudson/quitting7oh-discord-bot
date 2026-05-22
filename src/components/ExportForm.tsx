"use client";

import { useState } from "react";

export function ExportForm({
  guildId,
  channels,
}: {
  guildId: string;
  channels: Array<{ id: string; name: string }>;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(10000);
  const [onlyPinned, setOnlyPinned] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runExport() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/guilds/${guildId}/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelIds: Array.from(selected),
          limitPerChannel: limit,
          onlyPinned,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? `Export failed (${res.status})`);
        return;
      }
      // Pull the body as a blob and trigger a download.
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") ?? "";
      const filenameMatch = cd.match(/filename="([^"]+)"/);
      const filename = filenameMatch?.[1] ?? `discord-export-${guildId}.zip`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  const inputClass =
    "w-full rounded-lg bg-white/5 px-3 py-2 text-sm ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-500)]";

  return (
    <div className="space-y-6 rounded-2xl bg-white/[0.02] p-6 ring-1 ring-white/5">
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm text-white/80">
            Channels ({selected.size} of {channels.length} selected)
          </span>
          <div className="flex gap-3 text-xs text-white/60">
            <button
              type="button"
              onClick={() => setSelected(new Set(channels.map((c) => c.id)))}
              className="hover:text-white"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="hover:text-white"
            >
              Clear
            </button>
          </div>
        </div>
        <div className="max-h-80 overflow-y-auto rounded-lg bg-white/[0.03] p-2 ring-1 ring-white/5">
          {channels.length === 0 && (
            <p className="p-2 text-sm text-white/40">
              No channels visible to the bot. Make sure it has View Channel permission.
            </p>
          )}
          {(() => {
            const isInfo = (name: string) => /info/i.test(name);
            const byName = (a: { name: string }, b: { name: string }) =>
              a.name.localeCompare(b.name);
            const info = channels.filter((c) => isInfo(c.name)).sort(byName);
            const other = channels.filter((c) => !isInfo(c.name)).sort(byName);
            return (
              <>
                {renderGroup("Info channels", info, selected, toggle, setSelected)}
                {info.length > 0 && other.length > 0 && (
                  <div className="my-1 border-t border-white/5" />
                )}
                {renderGroup("Other channels", other, selected, toggle, setSelected)}
              </>
            );
          })()}
        </div>
      </div>

      <div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-white/80">
          <input
            type="checkbox"
            checked={onlyPinned}
            onChange={(e) => setOnlyPinned(e.target.checked)}
          />
          <span>Pinned messages only</span>
        </label>
        <p className="mt-1 text-xs text-white/40">
          Exports just the pinned posts from each selected channel (Discord caps
          this at 50 pins per channel).
        </p>
      </div>

      <div>
        <label className="mb-1 block text-sm text-white/80">
          Max messages per channel
        </label>
        <input
          type="number"
          min={1}
          max={50000}
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value) || 10000)}
          disabled={onlyPinned}
          className={`${inputClass} disabled:opacity-50`}
        />
        <p className="mt-1 text-xs text-white/40">
          Cap to avoid pulling forever on very busy channels. 10,000 is plenty
          for almost everything; bump to 50,000 only if you really need full
          history of a high-volume channel.
        </p>
      </div>

      {error && (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300 ring-1 ring-red-500/20">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={runExport}
        disabled={running || selected.size === 0}
        className="rounded-lg bg-[color:var(--color-brand-600)] px-4 py-2 text-sm font-medium hover:bg-[color:var(--color-brand-500)] disabled:opacity-50"
      >
        {running
          ? "Exporting…"
          : onlyPinned
          ? `Export pins from ${selected.size} channel(s) as zip`
          : `Export ${selected.size} channel(s) as zip`}
      </button>
    </div>
  );
}

function renderGroup(
  label: string,
  group: Array<{ id: string; name: string }>,
  selected: Set<string>,
  toggle: (id: string) => void,
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>
) {
  if (group.length === 0) return null;
  const allInGroupSelected = group.every((c) => selected.has(c.id));
  return (
    <div>
      <div className="flex items-center justify-between px-1.5 pb-1 pt-2">
        <span className="text-xs font-medium uppercase tracking-wide text-white/40">
          {label} ({group.length})
        </span>
        <button
          type="button"
          onClick={() =>
            setSelected((prev) => {
              const next = new Set(prev);
              if (allInGroupSelected) {
                group.forEach((c) => next.delete(c.id));
              } else {
                group.forEach((c) => next.add(c.id));
              }
              return next;
            })
          }
          className="text-[11px] text-white/40 hover:text-white"
        >
          {allInGroupSelected ? "Deselect group" : "Select group"}
        </button>
      </div>
      {group.map((c) => (
        <label
          key={c.id}
          className="flex cursor-pointer items-center gap-2 rounded p-1.5 text-sm hover:bg-white/5"
        >
          <input
            type="checkbox"
            checked={selected.has(c.id)}
            onChange={() => toggle(c.id)}
          />
          <span className="text-white/80">#{c.name}</span>
        </label>
      ))}
    </div>
  );
}
