"use client";

// Launches a restore-assist job and polls its progress. The plan (what's
// missing) is computed server-side on the restore page; this component owns
// the option toggles, the confirm step, and the live job log.

import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";

type Job = {
  id: string;
  status: "pending" | "running" | "done" | "failed";
  log: string[];
  error: string | null;
  createdAt: string;
};

export function RestoreLauncher({
  guildId,
  snapshotId,
  missingRoles,
  missingChannels,
}: {
  guildId: string;
  snapshotId: string;
  missingRoles: number;
  missingChannels: number;
}) {
  const [options, setOptions] = useState({
    createRoles: true,
    createChannels: true,
    reapplyMemberRoles: false,
  });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);

  const loadJobs = useCallback(async () => {
    try {
      const res = await fetch(`/api/guilds/${guildId}/restore`);
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
    if (!active) return;
    const t = setInterval(() => void loadJobs(), 4000);
    return () => clearInterval(t);
  }, [active, loadJobs]);

  async function launch() {
    setConfirmOpen(false);
    setError(null);
    const res = await fetch(`/api/guilds/${guildId}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshotId, options }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? `Failed (${res.status})`);
      return;
    }
    void loadJobs();
  }

  const latest = jobs[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4 text-sm text-white/80">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={options.createRoles}
            onChange={(e) =>
              setOptions((o) => ({ ...o, createRoles: e.target.checked }))
            }
          />
          Recreate {missingRoles} missing role(s)
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={options.createChannels}
            onChange={(e) =>
              setOptions((o) => ({ ...o, createChannels: e.target.checked }))
            }
          />
          Recreate {missingChannels} missing channel(s)
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={options.reapplyMemberRoles}
            onChange={(e) =>
              setOptions((o) => ({ ...o, reapplyMemberRoles: e.target.checked }))
            }
          />
          Re-apply member roles from snapshot
        </label>
      </div>

      {error && (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300 ring-1 ring-red-500/20">
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={active}
        onClick={() => setConfirmOpen(true)}
        className="rounded-lg bg-[color:var(--color-brand-600)] px-4 py-2 text-sm font-medium hover:bg-[color:var(--color-brand-500)] disabled:opacity-50"
      >
        {active ? "Restore running…" : "Start restore"}
      </button>

      {latest && (
        <div className="rounded-2xl bg-white/[0.02] p-4 ring-1 ring-white/10">
          <p className="text-xs text-white/50">
            Latest job — <span className="text-white/80">{latest.status}</span>
            {latest.error ? ` · ${latest.error.slice(0, 200)}` : ""}
          </p>
          {latest.log.length > 0 && (
            <pre className="mt-2 max-h-64 overflow-y-auto rounded-md bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-white/70 ring-1 ring-white/10">
              {latest.log.join("\n")}
            </pre>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Start restore?"
        description={
          <>
            The bot will recreate missing structure from this snapshot —
            slowly, on purpose (Discord rate-limits role creation hard).
            Nothing existing is deleted or modified. Message history cannot be
            restored.
          </>
        }
        confirmLabel="Start restore"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void launch()}
      />
    </div>
  );
}
