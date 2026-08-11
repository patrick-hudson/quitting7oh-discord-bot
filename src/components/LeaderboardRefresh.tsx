"use client";

// Shows when the leaderboard was last built and a Refresh button that requests
// a recompute, then polls until the worker produces a newer result and reloads
// the page.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LocalTime } from "@/components/LocalTime";

export function LeaderboardRefresh({
  guildId,
  generatedAt,
  computing,
}: {
  guildId: string;
  generatedAt: string | null;
  computing: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(computing);
  const baseline = useRef(generatedAt);

  // While a recompute is pending, poll the status endpoint; when generatedAt
  // advances past what we loaded with, refresh the page to show new data.
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/guilds/${guildId}/leaderboard/refresh`);
        if (!res.ok) return;
        const d = (await res.json()) as {
          generatedAt: string | null;
          computing: boolean;
          refreshRequested: boolean;
        };
        if (d.generatedAt && d.generatedAt !== baseline.current) {
          setPending(false);
          router.refresh();
        } else if (!d.computing && !d.refreshRequested) {
          // Finished without producing a newer stamp (e.g. failed) — stop.
          setPending(false);
        }
      } catch {
        // keep polling
      }
    }, 4000);
    return () => clearInterval(t);
  }, [pending, guildId, router]);

  async function refresh() {
    setPending(true);
    baseline.current = generatedAt;
    await fetch(`/api/guilds/${guildId}/leaderboard/refresh`, {
      method: "POST",
    }).catch(() => {});
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => void refresh()}
        className="rounded-lg bg-white/5 px-3 py-1.5 text-sm text-white/80 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-60"
      >
        {pending ? "Refreshing…" : "Refresh"}
      </button>
      <span className="text-[11px] text-white/40">
        {generatedAt ? (
          <>
            Updated <LocalTime iso={generatedAt} />
          </>
        ) : (
          "Not built yet"
        )}
      </span>
    </div>
  );
}
