"use client";

// Client controls for batch AI reviews (POST/DELETE
// /api/guilds/[guildId]/ai-review/batch):
//   - BatchReviewForm: pick the activity window, preview how many members
//     match, then queue one review per member. Preview-before-queue is
//     deliberate — this is the expensive button on the page.
//   - CancelBatchButton: drop a running batch's still-queued jobs (the
//     in-flight review finishes; we never kill one mid-run).

import { useState } from "react";
import { useRouter } from "next/navigation";

type BatchCounts = {
  matchedActivity: number;
  departed: number;
  excludedByRole: number;
  alreadyReviewed: number;
  overCap: number;
  toQueue: number;
};

export type PickableRole = { id: string; name: string };

// Roles preselected in the exclusion picker when the guild has them — people
// who already hold the contributor role (or outrank it) don't need a bulk fit
// review. Matched case-insensitively against the guild's actual role names.
const DEFAULT_EXCLUDED_ROLE_NAMES = new Set([
  "contributor",
  "mods",
  "head mods",
  "admin",
  "server owner",
]);

export function BatchReviewForm({
  guildId,
  roles,
}: {
  guildId: string;
  roles: PickableRole[];
}) {
  const router = useRouter();
  const [days, setDays] = useState(60);
  const [minMessages, setMinMessages] = useState(10);
  const [skipRecent, setSkipRecent] = useState(true);
  const [skipDays, setSkipDays] = useState(30);
  const [excluded, setExcluded] = useState<Set<string>>(
    () =>
      new Set(
        roles
          .filter((r) => DEFAULT_EXCLUDED_ROLE_NAMES.has(r.name.toLowerCase()))
          .map((r) => r.id)
      )
  );
  const [preview, setPreview] = useState<BatchCounts | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Any knob change invalidates a shown preview — the count no longer applies.
  function knob<T>(set: (v: T) => void) {
    return (v: T) => {
      set(v);
      setPreview(null);
      setDone(null);
      setError(null);
    };
  }
  const setDaysK = knob(setDays);
  const setMinMessagesK = knob(setMinMessages);
  const setSkipRecentK = knob(setSkipRecent);
  const setSkipDaysK = knob(setSkipDays);

  function toggleRole(id: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setPreview(null);
    setDone(null);
    setError(null);
  }

  async function call(dryRun: boolean): Promise<{ counts: BatchCounts }> {
    const res = await fetch(`/api/guilds/${guildId}/ai-review/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        activeWithinDays: days,
        minMessages,
        skipReviewedWithinDays: skipRecent ? skipDays : null,
        excludeRoleIds: [...excluded],
        dryRun,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      counts?: BatchCounts;
      error?: string;
    };
    if (!res.ok || !data.counts) throw new Error(data.error ?? "Request failed.");
    return { counts: data.counts };
  }

  async function runPreview() {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setPreview((await call(true)).counts);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function queue() {
    setBusy(true);
    setError(null);
    try {
      const { counts } = await call(false);
      setPreview(null);
      setDone(
        `Queued ${counts.toQueue} review${counts.toQueue === 1 ? "" : "s"}. The worker runs them one at a time — you'll get a DM when the whole batch is finished.`
      );
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const num =
    "w-16 rounded-md bg-black/30 px-2 py-1 text-center font-mono text-sm text-white/90 ring-1 ring-white/10 focus:outline-none focus:ring-white/25";

  return (
    <div className="rounded-xl bg-white/[0.02] p-4 ring-1 ring-white/10">
      <p className="text-sm font-medium text-white/80">Review recently active members</p>
      <p className="mt-0.5 text-xs text-white/50">
        Queues an AI fit review for every member who is still in the server and
        has been active recently. Each review still reads their full history —
        the window only picks who gets reviewed. Runs in the background; single
        reviews stay available and jump the queue.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-white/70">
        <label className="flex items-center gap-2">
          Active in the last
          <input
            type="number"
            min={1}
            max={365}
            value={days}
            onChange={(e) => setDaysK(Math.max(1, Math.min(365, Number(e.target.value) || 1)))}
            className={num}
          />
          days
        </label>
        <label className="flex items-center gap-2">
          with at least
          <input
            type="number"
            min={1}
            max={10000}
            value={minMessages}
            onChange={(e) =>
              setMinMessagesK(Math.max(1, Math.min(10000, Number(e.target.value) || 1)))
            }
            className={num}
          />
          messages
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={skipRecent}
            onChange={(e) => setSkipRecentK(e.target.checked)}
            className="h-4 w-4 accent-[color:var(--color-brand-600)]"
          />
          skip anyone reviewed in the last
          <input
            type="number"
            min={1}
            max={365}
            value={skipDays}
            disabled={!skipRecent}
            onChange={(e) =>
              setSkipDaysK(Math.max(1, Math.min(365, Number(e.target.value) || 1)))
            }
            className={`${num} disabled:opacity-40`}
          />
          days
        </label>
      </div>

      <div className="mt-3 text-sm text-white/70">
        Skip members holding any of these roles{" "}
        <span className="text-xs text-white/40">(click to toggle)</span>
        {roles.length === 0 ? (
          <p className="mt-1 text-xs text-amber-200/80">
            Couldn&apos;t load the server&apos;s roles — no role exclusions will
            apply to this batch.
          </p>
        ) : (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {roles.map((r) => {
              const on = excluded.has(r.id);
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => toggleRole(r.id)}
                  aria-pressed={on}
                  className={`rounded-full px-2.5 py-1 text-xs ring-1 transition ${
                    on
                      ? "bg-[color:var(--color-brand-600)] text-white ring-transparent"
                      : "bg-white/5 text-white/60 ring-white/10 hover:bg-white/10"
                  }`}
                >
                  {on ? "✓ " : ""}
                  {r.name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void runPreview()}
          className="rounded-lg bg-white/5 px-3 py-1.5 text-sm text-white/80 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-50"
        >
          {busy && !preview ? "Counting…" : "Preview batch"}
        </button>
        {preview && preview.toQueue > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void queue()}
            className="rounded-lg bg-[color:var(--color-brand-600)] px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Queuing…" : `Queue ${preview.toQueue} reviews`}
          </button>
        )}
      </div>

      {preview && (
        <p className="mt-2 text-xs text-white/60">
          {preview.toQueue > 0 ? (
            <>
              <span className="font-medium text-white/85">{preview.toQueue}</span>{" "}
              member{preview.toQueue === 1 ? "" : "s"} will be reviewed
            </>
          ) : (
            "No members left to review with these settings"
          )}
          {" — "}
          {preview.matchedActivity} matched the activity window
          {preview.departed > 0 && `, ${preview.departed} left the server`}
          {preview.excludedByRole > 0 &&
            `, ${preview.excludedByRole} hold an excluded role`}
          {preview.alreadyReviewed > 0 && `, ${preview.alreadyReviewed} recently reviewed`}
          {preview.overCap > 0 && `, ${preview.overCap} over the per-batch cap`}.
          {preview.toQueue > 0 && " Each review is a separate Claude API call — check the count before queuing."}
        </p>
      )}
      {done && <p className="mt-2 text-xs text-emerald-300/90">{done}</p>}
      {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
    </div>
  );
}

export function CancelBatchButton({
  guildId,
  batchId,
  pendingCount,
}: {
  guildId: string;
  batchId: string;
  pendingCount: number;
}) {
  const router = useRouter();
  const [arming, setArming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/guilds/${guildId}/ai-review/batch?batchId=${encodeURIComponent(batchId)}`,
        { method: "DELETE" }
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Cancel failed.");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      setArming(false);
    }
  }

  return (
    <div className="shrink-0 text-right">
      {arming ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void cancel()}
            className="rounded-lg bg-red-500/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
          >
            {busy ? "Cancelling…" : `Drop ${pendingCount} queued`}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setArming(false)}
            className="rounded-lg px-2 py-1.5 text-xs text-white/60 hover:text-white/90"
          >
            Keep going
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setArming(true)}
          className="rounded-lg px-3 py-1.5 text-xs text-red-300/80 ring-1 ring-red-400/20 hover:bg-red-400/10"
        >
          Cancel batch
        </button>
      )}
      {error && <p className="mt-1 text-[11px] text-red-300">{error}</p>}
    </div>
  );
}
