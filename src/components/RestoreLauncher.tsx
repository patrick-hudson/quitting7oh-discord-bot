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
  guildName,
  snapshotId,
  missingRoles,
  missingChannels,
}: {
  guildId: string;
  guildName: string;
  snapshotId: string;
  missingRoles: number;
  missingChannels: number;
}) {
  const [options, setOptions] = useState({
    createRoles: true,
    createChannels: true,
    reapplyMemberRoles: false,
  });
  const [ackDisruptive, setAckDisruptive] = useState(false);
  const [ackRateLimit, setAckRateLimit] = useState(false);
  const [confirmText, setConfirmText] = useState("");
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
    // Reset the gates so a second run requires re-confirming from scratch.
    setAckDisruptive(false);
    setAckRateLimit(false);
    setConfirmText("");
    void loadJobs();
  }

  const latest = jobs[0];
  const gatesPassed =
    ackDisruptive &&
    ackRateLimit &&
    confirmText.trim().toLowerCase() === guildName.trim().toLowerCase();

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-amber-500/40 bg-amber-500/[0.07] p-4 text-sm">
        <p className="font-semibold text-amber-200">⚠ Read before running a restore</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-amber-100/80">
          <li>
            This creates roles and channels in bulk. It <strong>cannot be
            undone</strong> with one click — you&apos;d have to delete each
            recreated thing by hand.
          </li>
          <li>
            Discord rate-limits role creation aggressively. A large restore
            takes several minutes, and rushing it can get the bot{" "}
            <strong>blocked from creating roles for 24+ hours</strong>.
          </li>
          <li>
            Only run this to recover from an actual loss (a nuked or
            misconfigured server) — not to &quot;sync&quot; routine changes.
          </li>
        </ul>
      </div>

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

      {/* Confirmation gates — all three required to enable the button. */}
      <div className="space-y-2 rounded-lg bg-white/[0.03] p-3 ring-1 ring-white/10">
        <label className="flex cursor-pointer items-start gap-2 text-sm text-white/80">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={ackDisruptive}
            onChange={(e) => setAckDisruptive(e.target.checked)}
          />
          I understand this creates roles/channels in bulk and can&apos;t be
          undone with one click.
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-sm text-white/80">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={ackRateLimit}
            onChange={(e) => setAckRateLimit(e.target.checked)}
          />
          I understand a rushed restore can lock the bot out of role creation
          for 24+ hours.
        </label>
        <div className="pt-1">
          <label className="mb-1 block text-xs text-white/60">
            Type the server name{" "}
            <span className="font-mono text-white/80">{guildName}</span> to
            confirm:
          </label>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={guildName}
            className="w-full rounded-md bg-white/5 px-3 py-2 text-sm ring-1 ring-white/10 placeholder:text-white/25 focus:outline-none focus:ring-2 focus:ring-amber-500/60"
          />
        </div>
      </div>

      <button
        type="button"
        disabled={active || !gatesPassed}
        onClick={() => setConfirmOpen(true)}
        className="rounded-lg bg-red-600/80 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:cursor-not-allowed disabled:bg-white/5 disabled:text-white/40"
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
        destructive
        title={`Restore ${guildName} from this snapshot?`}
        description={
          <>
            Last chance to back out. The bot will start creating{" "}
            {missingRoles > 0 && <strong>{missingRoles} role(s)</strong>}
            {missingRoles > 0 && missingChannels > 0 && " and "}
            {missingChannels > 0 && (
              <strong>{missingChannels} channel(s)</strong>
            )}
            {missingRoles === 0 && missingChannels === 0 && "member role changes"}
            , slowly, over several minutes. Nothing existing is deleted, but this
            can&apos;t be undone with one click.
          </>
        }
        confirmLabel="Yes, start restore"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void launch()}
      />
    </div>
  );
}
