"use client";

// Client controls for the AI contributor-fit reviewer.
//   - AiReviewButton: enqueue a review for a known member (used from the
//     leaderboard drill-down), then navigate to the review once queued.
//   - NewReviewForm: enqueue by pasting a Discord user id (used on the AI
//     Reviews page).
// Both hit POST /api/guilds/[guildId]/ai-review and route to the job page.

import { useState } from "react";
import { useRouter } from "next/navigation";

async function enqueue(
  guildId: string,
  body: { targetUserId: string; targetName?: string }
): Promise<string> {
  const res = await fetch(`/api/guilds/${guildId}/ai-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as {
    job?: { id: string };
    error?: string;
  };
  if (!res.ok || !data.job) {
    throw new Error(data.error ?? "Couldn't queue the review.");
  }
  return data.job.id;
}

export function AiReviewButton({
  guildId,
  targetUserId,
  targetName,
  className,
}: {
  guildId: string;
  targetUserId: string;
  targetName?: string | null;
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const id = await enqueue(guildId, {
        targetUserId,
        targetName: targetName ?? undefined,
      });
      router.push(`/dashboard/${guildId}/ai-review/${id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className={className}>
      <button
        type="button"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          void run();
        }}
        className="rounded-md bg-[color:var(--color-brand-600)]/90 px-2.5 py-1 text-xs font-medium text-white ring-1 ring-transparent hover:bg-[color:var(--color-brand-600)] disabled:opacity-60"
      >
        {busy ? "Queuing…" : "Run AI fit review"}
      </button>
      {error && <p className="mt-1 text-[11px] text-red-300">{error}</p>}
    </div>
  );
}

export function NewReviewForm({ guildId }: { guildId: string }) {
  const router = useRouter();
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = /^\d{17,21}$/.test(id.trim());

  async function submit() {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const jobId = await enqueue(guildId, { targetUserId: id.trim() });
      router.push(`/dashboard/${guildId}/ai-review/${jobId}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl bg-white/[0.02] p-4 ring-1 ring-white/10">
      <label className="text-sm font-medium text-white/80">Review a member by ID</label>
      <p className="mt-0.5 text-xs text-white/50">
        Paste a Discord user ID. Tip: you can also start a review from any row on
        the{" "}
        <a href={`/dashboard/${guildId}/leaderboard`} className="underline hover:text-white/80">
          leaderboard
        </a>
        .
      </p>
      <div className="mt-3 flex gap-2">
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && valid && void submit()}
          placeholder="123456789012345678"
          inputMode="numeric"
          className="min-w-0 flex-1 rounded-lg bg-black/30 px-3 py-1.5 font-mono text-sm text-white/90 ring-1 ring-white/10 placeholder:text-white/30 focus:outline-none focus:ring-white/25"
        />
        <button
          type="button"
          disabled={!valid || busy}
          onClick={() => void submit()}
          className="shrink-0 rounded-lg bg-[color:var(--color-brand-600)] px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Queuing…" : "Review"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
    </div>
  );
}
