"use client";

// The reviews list with bulk-archive housekeeping. Finished rows (done,
// failed, cancelled) get a checkbox; a toolbar appears when anything is
// selected to archive/unarchive the selection, and an "archive all finished"
// action covers reviews beyond the 100 shown. In-flight rows can't be
// selected. Hits POST /api/guilds/[guildId]/ai-review/archive.

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LocalTime } from "@/components/LocalTime";
import { RECO } from "@/components/ai-review-meta";

export type ReviewListItem = {
  id: string;
  targetUserId: string;
  targetName: string | null;
  status: string;
  recommendation: string | null;
  messagesAnalyzed: number;
  source: string | null;
  createdAtIso: string;
  error: string | null;
};

const FINISHED = new Set(["done", "failed", "cancelled"]);

export function AiReviewList({
  guildId,
  jobs,
  archivedView,
}: {
  guildId: string;
  jobs: ReviewListItem[];
  archivedView: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [armAll, setArmAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectable = jobs.filter((j) => FINISHED.has(j.status));
  const allChecked = selectable.length > 0 && selected.size === selectable.length;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function setArchived(body: { ids?: string[]; all?: boolean }, archived: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/guilds/${guildId}/ai-review/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, archived }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Request failed.");
      setSelected(new Set());
      setArmAll(false);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mt-3 flex min-h-8 flex-wrap items-center gap-2">
        {selectable.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-white/60">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={() =>
                setSelected(
                  allChecked ? new Set() : new Set(selectable.map((j) => j.id))
                )
              }
              className="h-4 w-4 accent-[color:var(--color-brand-600)]"
            />
            Select all shown
          </label>
        )}
        {selected.size > 0 ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void setArchived({ ids: [...selected] }, !archivedView)}
            className="rounded-lg bg-white/5 px-3 py-1.5 text-xs text-white/80 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-50"
          >
            {busy
              ? "Working…"
              : `${archivedView ? "Unarchive" : "Archive"} selected (${selected.size})`}
          </button>
        ) : (
          !archivedView &&
          selectable.length > 0 &&
          (armAll ? (
            <span className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void setArchived({ all: true }, true)}
                className="rounded-lg bg-red-500/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
              >
                {busy ? "Archiving…" : "Yes, archive every finished review"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setArmAll(false)}
                className="rounded-lg px-2 py-1.5 text-xs text-white/60 hover:text-white/90"
              >
                Never mind
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setArmAll(true)}
              className="rounded-lg px-3 py-1.5 text-xs text-white/50 ring-1 ring-white/10 hover:bg-white/5 hover:text-white/80"
            >
              Archive all finished
            </button>
          ))
        )}
        {error && <span className="text-xs text-red-300">{error}</span>}
      </div>

      <ul className="mt-2 divide-y divide-white/5 overflow-hidden rounded-2xl ring-1 ring-white/10">
        {jobs.map((j) => {
          const reco = j.recommendation ? RECO[j.recommendation] : null;
          const inProgress = j.status === "pending" || j.status === "running";
          const canSelect = FINISHED.has(j.status);
          return (
            <li key={j.id} className="bg-white/[0.02]">
              <div className="flex items-center gap-3 pl-4 hover:bg-white/[0.03]">
                <input
                  type="checkbox"
                  disabled={!canSelect}
                  checked={selected.has(j.id)}
                  onChange={() => toggle(j.id)}
                  className="h-4 w-4 shrink-0 accent-[color:var(--color-brand-600)] disabled:opacity-30"
                />
                <Link
                  href={`/dashboard/${guildId}/ai-review/${j.id}`}
                  className="flex min-w-0 flex-1 items-center gap-3 py-3 pr-4"
                >
                  <span
                    className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ${
                      reco
                        ? reco.badge
                        : inProgress || j.status === "cancelled"
                          ? "bg-white/5 text-white/60 ring-white/10"
                          : "bg-red-400/10 text-red-300 ring-red-400/20"
                    }`}
                  >
                    {reco
                      ? reco.label
                      : j.status === "failed"
                        ? "failed"
                        : j.status === "cancelled"
                          ? "skipped"
                          : j.status === "running"
                            ? "running…"
                            : "queued…"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-white/90">
                    {j.targetName ?? j.targetUserId}
                  </span>
                  {j.status === "done" && (
                    <span className="hidden shrink-0 text-[11px] text-white/40 sm:inline">
                      {j.messagesAnalyzed.toLocaleString()} msgs · {j.source}
                    </span>
                  )}
                  <span className="shrink-0 text-[11px] text-white/40">
                    <LocalTime iso={j.createdAtIso} />
                  </span>
                </Link>
              </div>
              {j.status === "failed" && j.error && (
                <p className="px-4 pb-3 pl-11 text-[11px] text-red-300/80">{j.error}</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
