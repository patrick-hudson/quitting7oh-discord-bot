"use client";

// Queue and track user-message export jobs. The heavy lifting happens in the
// bot worker; this form just creates the job and polls the jobs list while
// anything is pending/running so status flips to Download without a manual
// refresh.

import { useCallback, useEffect, useState } from "react";

type Channel = { id: string; name: string };

type Job = {
  id: string;
  targetUserId: string;
  sinceAt: string | null;
  untilAt: string | null;
  channelIds: string[];
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  matchedCount: number;
  scannedCount: number;
  fileName: string | null;
  createdAt: string;
};

export function UserExportForm({
  guildId,
  channels,
}: {
  guildId: string;
  channels: Channel[];
}) {
  const [targetUserId, setTargetUserId] = useState("");
  const [since, setSince] = useState(""); // datetime-local
  const [until, setUntil] = useState("");
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [includeMedia, setIncludeMedia] = useState(false);
  const [showChannels, setShowChannels] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);

  const loadJobs = useCallback(async () => {
    try {
      const res = await fetch(`/api/guilds/${guildId}/user-export`);
      if (!res.ok) return;
      const d = await res.json();
      setJobs(d.jobs ?? []);
    } catch {
      // transient — next poll retries
    }
  }, [guildId]);

  // Initial load + poll while anything is in flight.
  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);
  const hasActive = jobs.some((j) => j.status === "pending" || j.status === "running");
  useEffect(() => {
    if (!hasActive) return;
    const t = setInterval(() => void loadJobs(), 5000);
    return () => clearInterval(t);
  }, [hasActive, loadJobs]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const res = await fetch(`/api/guilds/${guildId}/user-export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetUserId: targetUserId.trim(),
        sinceAt: since ? new Date(since).toISOString() : null,
        untilAt: until ? new Date(until).toISOString() : null,
        channelIds,
        includeMedia,
      }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? `Failed (${res.status})`);
      return;
    }
    setTargetUserId("");
    void loadJobs();
  }

  function toggleChannel(id: string) {
    setChannelIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={onSubmit}
        className="space-y-4 rounded-2xl bg-white/[0.02] p-5 ring-1 ring-white/5"
      >
        <div>
          <label className="mb-1 block text-sm text-white/80">Discord user ID</label>
          <input
            required
            value={targetUserId}
            onChange={(e) => setTargetUserId(e.target.value)}
            placeholder="e.g. 1366097989382307901"
            className="w-full rounded-lg bg-white/5 px-3 py-2 text-sm font-mono ring-1 ring-white/10 placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-500)]"
          />
          <p className="mt-1 text-xs text-white/40">
            Right-click the member in Discord → Copy User ID (requires Developer
            Mode in Discord settings).
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-sm text-white/80">Since (optional)</label>
            <input
              type="datetime-local"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              className="w-full rounded-lg bg-white/5 px-3 py-2 text-sm ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-500)]"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-white/80">Until (optional)</label>
            <input
              type="datetime-local"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              className="w-full rounded-lg bg-white/5 px-3 py-2 text-sm ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-500)]"
            />
          </div>
        </div>

        <div className="rounded-lg bg-white/[0.03] px-3 py-2 ring-1 ring-white/5">
          <button
            type="button"
            onClick={() => setShowChannels((s) => !s)}
            className="flex w-full items-center justify-between text-left text-sm text-white/70 hover:text-white"
          >
            <span>
              Channels:{" "}
              {channelIds.length === 0
                ? "all text channels"
                : `${channelIds.length} selected`}
            </span>
            <span className="text-white/40">{showChannels ? "▾" : "▸"}</span>
          </button>
          {showChannels && (
            <div className="mt-2 grid max-h-56 grid-cols-2 gap-1 overflow-y-auto">
              {channels.map((c) => (
                <label
                  key={c.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-0.5 text-xs text-white/70 hover:bg-white/5"
                >
                  <input
                    type="checkbox"
                    checked={channelIds.includes(c.id)}
                    onChange={() => toggleChannel(c.id)}
                  />
                  #{c.name}
                </label>
              ))}
            </div>
          )}
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-sm text-white/80">
          <input
            type="checkbox"
            checked={includeMedia}
            onChange={(e) => setIncludeMedia(e.target.checked)}
          />
          <span>Include media files</span>
        </label>
        <p className="-mt-2 text-xs text-white/40">
          Downloads the user&apos;s attachments into the zip so links don&apos;t
          expire (~24h). Size caps apply; larger zips.
        </p>

        {error && (
          <div className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300 ring-1 ring-red-500/20">
            {error}
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-white/40">
            Runs in the background — the bot DMs you a link when it&apos;s ready.
          </p>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-[color:var(--color-brand-600)] px-4 py-2 text-sm font-medium hover:bg-[color:var(--color-brand-500)] disabled:opacity-50"
          >
            {submitting ? "Queuing…" : "Queue export"}
          </button>
        </div>
      </form>

      {jobs.length > 0 && (
        <div className="overflow-hidden rounded-2xl ring-1 ring-white/10">
          <div className="bg-white/[0.03] px-4 py-2 text-xs font-semibold uppercase tracking-wide text-white/50">
            Recent exports
          </div>
          <ul className="divide-y divide-white/5">
            {jobs.map((j) => (
              <li key={j.id} className="flex items-center gap-3 bg-white/[0.02] px-4 py-3">
                <StatusBadge status={j.status} />
                <div className="min-w-0 flex-1 text-sm">
                  <span className="font-mono text-white/80">{j.targetUserId}</span>
                  <span className="ml-2 text-xs text-white/40">
                    {new Date(j.createdAt).toLocaleString()}
                    {j.status === "done" && ` · ${j.matchedCount} message(s)`}
                    {j.status === "failed" && j.error && ` · ${j.error.slice(0, 120)}`}
                  </span>
                </div>
                {j.status === "done" && (
                  <a
                    href={`/api/guilds/${guildId}/user-export/${j.id}/download`}
                    className="rounded-md bg-[color:var(--color-brand-600)] px-2.5 py-1 text-xs font-medium hover:bg-[color:var(--color-brand-500)]"
                  >
                    Download
                  </a>
                )}
                {(j.status === "pending" || j.status === "running") && (
                  <button
                    type="button"
                    onClick={async () => {
                      await fetch(
                        `/api/guilds/${guildId}/user-export/${j.id}/cancel`,
                        { method: "POST" }
                      ).catch(() => {});
                      void loadJobs();
                    }}
                    className="rounded-md px-2.5 py-1 text-xs text-red-300/80 ring-1 ring-red-500/20 hover:bg-red-500/10"
                  >
                    Cancel
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: Job["status"] }) {
  const styles: Record<Job["status"], string> = {
    pending: "bg-white/10 text-white/60",
    running: "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30",
    done: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30",
    failed: "bg-red-500/15 text-red-300 ring-1 ring-red-500/30",
    cancelled: "bg-white/10 text-white/50 ring-1 ring-white/10",
  };
  return (
    <span className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-medium ${styles[status]}`}>
      {status}
    </span>
  );
}
