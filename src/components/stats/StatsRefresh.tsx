"use client";

// Refresh control for the Stats page — requests a recompute, polls the status
// endpoint until the worker lands a newer result, then reloads. Mirrors
// LeaderboardRefresh.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LocalTime } from "@/components/LocalTime";

export function StatsRefresh({
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

  useEffect(() => {
    if (!pending) return;
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/guilds/${guildId}/stats/refresh`);
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
    await fetch(`/api/guilds/${guildId}/stats/refresh`, { method: "POST" }).catch(
      () => {}
    );
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
          "Not built yet — the worker runs within a minute of boot"
        )}
      </span>
    </div>
  );
}
