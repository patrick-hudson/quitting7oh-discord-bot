"use client";

// Export / import the bot's configuration for this guild. Import is
// section-selective and safe by default (posts arrive inactive; adminRoleId
// is never imported).

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function ConfigBackup({ guildId }: { guildId: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [sections, setSections] = useState({
    settings: true,
    posts: true,
    milestones: true,
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onImport() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Pick a config JSON file first.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const config = JSON.parse(await file.text());
      const res = await fetch(`/api/guilds/${guildId}/config-import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config, sections }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? `Failed (${res.status})`);
        return;
      }
      const d = (await res.json()) as { imported: string[] };
      setResult(
        d.imported.length > 0
          ? `Imported: ${d.imported.join(", ")}.`
          : "Nothing selected to import."
      );
      router.refresh();
    } catch {
      setError("That file isn't valid JSON.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 border-t border-white/10 pt-6">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
          Config backup
        </h2>
        <p className="mt-1 text-xs text-white/40">
          Download the bot&apos;s configuration (settings, template rosters,
          scheduled posts, milestones) as JSON, or import a previous export.
          Imported posts arrive <strong>inactive</strong> for review; the admin
          role is never imported.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <a
          href={`/api/guilds/${guildId}/config-export`}
          className="rounded-lg bg-white/5 px-4 py-2 text-sm text-white/80 ring-1 ring-white/10 hover:bg-white/10"
        >
          Download config JSON
        </a>
      </div>

      <div className="space-y-2 rounded-lg bg-white/[0.03] p-3 ring-1 ring-white/5">
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="block w-full text-xs text-white/60 file:mr-3 file:rounded-md file:border-0 file:bg-white/10 file:px-3 file:py-1.5 file:text-xs file:text-white/80"
        />
        <div className="flex flex-wrap gap-4 text-xs text-white/70">
          {(
            [
              ["settings", "Settings + rosters"],
              ["posts", "Scheduled posts"],
              ["milestones", "Milestones"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={sections[key]}
                onChange={(e) =>
                  setSections((s) => ({ ...s, [key]: e.target.checked }))
                }
              />
              {label}
            </label>
          ))}
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-white/35">
            Importing posts creates duplicates if they already exist — best
            used on a fresh guild or after deleting the old ones.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onImport()}
            className="shrink-0 rounded-lg bg-[color:var(--color-brand-600)] px-4 py-2 text-sm font-medium hover:bg-[color:var(--color-brand-500)] disabled:opacity-50"
          >
            {busy ? "Importing…" : "Import"}
          </button>
        </div>
      </div>

      {result && (
        <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300 ring-1 ring-emerald-500/20">
          {result}
        </p>
      )}
      {error && (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300 ring-1 ring-red-500/20">
          {error}
        </p>
      )}
    </div>
  );
}
