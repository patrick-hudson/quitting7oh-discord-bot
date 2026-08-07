"use client";

// "Snapshot now" + live progress. Kicks off a SnapshotJob, then polls the jobs
// endpoint while anything is running and renders each step's status + timing —
// so the snapshot process is fully visible rather than a thing that silently
// appears in the list.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Step = {
  name: string;
  status: "running" | "done" | "failed";
  ms?: number;
  detail?: string;
  error?: string;
};
type Job = {
  id: string;
  kind: string;
  status: "pending" | "running" | "done" | "failed";
  steps: Step[];
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

export function SnapshotRunner({ guildId }: { guildId: string }) {
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wasActive, setWasActive] = useState(false);

  const loadJobs = useCallback(async () => {
    try {
      const res = await fetch(`/api/guilds/${guildId}/snapshots`);
      if (!res.ok) return;
      const d = await res.json();
      setJobs(d.jobs ?? []);
    } catch {
      // next poll retries
    }
  }, [guildId]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  const active = jobs.some((j) => j.status === "pending" || j.status === "running");
  useEffect(() => {
    if (!active) {
      // Refresh the snapshot list once a run finishes so the new row appears.
      if (wasActive) {
        setWasActive(false);
        router.refresh();
      }
      return;
    }
    setWasActive(true);
    const t = setInterval(() => void loadJobs(), 1500);
    return () => clearInterval(t);
  }, [active, wasActive, loadJobs, router]);

  async function start() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/guilds/${guildId}/snapshots`, { method: "POST" });
    setBusy(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? `Failed (${res.status})`);
      return;
    }
    void loadJobs();
  }

  const latest = jobs[0];
  const showProgress =
    latest &&
    (latest.status === "pending" ||
      latest.status === "running" ||
      latest.status === "failed" ||
      // Briefly keep the just-finished run visible.
      (latest.status === "done" && latest.steps.length > 0 && active));

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-3">
        {error && <span className="text-xs text-red-300">{error}</span>}
        <button
          type="button"
          disabled={busy || active}
          onClick={() => void start()}
          className="rounded-lg bg-[color:var(--color-brand-600)] px-4 py-2 text-sm font-medium hover:bg-[color:var(--color-brand-500)] disabled:opacity-50"
        >
          {active ? "Snapshotting…" : busy ? "Starting…" : "Snapshot now"}
        </button>
      </div>

      {showProgress && latest && (
        <div className="w-full max-w-md rounded-lg bg-white/[0.03] p-3 text-left ring-1 ring-white/10">
          <p className="mb-2 text-xs text-white/50">
            {latest.status === "failed"
              ? "Snapshot failed"
              : latest.status === "done"
                ? "Snapshot complete"
                : "Collecting snapshot…"}
          </p>
          <ul className="space-y-1">
            {latest.steps.map((s, i) => (
              <li key={i} className="flex items-center gap-2 text-xs">
                <StepIcon status={s.status} />
                <span className="text-white/80">{s.name}</span>
                {s.detail && <span className="text-white/40">· {s.detail}</span>}
                {typeof s.ms === "number" && (
                  <span className="ml-auto font-mono text-[11px] text-white/40">
                    {fmtMs(s.ms)}
                  </span>
                )}
              </li>
            ))}
            {latest.steps.length === 0 && (
              <li className="text-xs text-white/40">Queued…</li>
            )}
          </ul>
          {latest.error && (
            <p className="mt-2 text-xs text-red-300">{latest.error}</p>
          )}
        </div>
      )}
    </div>
  );
}

function StepIcon({ status }: { status: Step["status"] }) {
  if (status === "done")
    return <span className="text-emerald-400">✓</span>;
  if (status === "failed") return <span className="text-red-400">✗</span>;
  return (
    <span className="inline-block h-3 w-3 animate-spin rounded-full border border-white/30 border-t-white/80" />
  );
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
