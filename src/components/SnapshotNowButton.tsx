"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SnapshotNowButton({ guildId }: { guildId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-3">
      {error && <span className="text-xs text-red-300">{error}</span>}
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const res = await fetch(`/api/guilds/${guildId}/snapshots`, {
            method: "POST",
          });
          setBusy(false);
          if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            setError(d.error ?? `Failed (${res.status})`);
            return;
          }
          router.refresh();
        }}
        className="rounded-lg bg-[color:var(--color-brand-600)] px-4 py-2 text-sm font-medium hover:bg-[color:var(--color-brand-500)] disabled:opacity-50"
      >
        {busy ? "Snapshotting…" : "Snapshot now"}
      </button>
    </div>
  );
}
