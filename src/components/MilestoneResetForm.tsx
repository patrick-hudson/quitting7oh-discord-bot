"use client";

// Mod-side quiet milestone reset. Removes only milestone-tier roles from the
// given member (mod/verified/other roles untouched), sends nothing to Discord
// beyond the role change itself, and records the action in the bot audit log.

import { useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";

export function MilestoneResetForm({ guildId }: { guildId: string }) {
  const [userId, setUserId] = useState("");
  const [note, setNote] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    | { kind: "ok"; removed: string[] }
    | { kind: "error"; message: string }
    | null
  >(null);

  async function doReset() {
    setConfirmOpen(false);
    setBusy(true);
    setResult(null);
    const res = await fetch(`/api/guilds/${guildId}/milestones/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: userId.trim(), note }),
    });
    setBusy(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setResult({ kind: "error", message: d.error ?? `Failed (${res.status})` });
      return;
    }
    const d = (await res.json()) as { removed: string[] };
    setResult({ kind: "ok", removed: d.removed });
    if (d.removed.length > 0) setUserId("");
  }

  return (
    <section className="space-y-3 rounded-2xl bg-white/[0.02] p-5 ring-1 ring-white/5">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
          Quiet milestone reset
        </h2>
        <p className="mt-1 text-xs text-white/40">
          Removes a member&apos;s milestone role(s) with no announcement, DM, or
          congrats. Only milestone roles are touched — mod, verified, and all
          other roles stay. Members can also reset themselves via the
          &quot;Start over&quot; button on the milestones message (republish to
          add it).
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm text-white/80">Discord user ID</label>
          <input
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="e.g. 1340918920860930099"
            className="w-full rounded-lg bg-white/5 px-3 py-2 font-mono text-sm ring-1 ring-white/10 placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-500)]"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm text-white/80">Note (optional, audit-log only)</label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="e.g. requested via DM"
            className="w-full rounded-lg bg-white/5 px-3 py-2 text-sm ring-1 ring-white/10 placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-500)]"
          />
        </div>
      </div>

      {result?.kind === "ok" && (
        <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300 ring-1 ring-emerald-500/20">
          {result.removed.length > 0
            ? `Reset complete — removed: ${result.removed.join(", ")}.`
            : "That member has no milestone role — nothing to remove."}
        </p>
      )}
      {result?.kind === "error" && (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300 ring-1 ring-red-500/20">
          {result.message}
        </p>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          disabled={busy || !/^\d{17,21}$/.test(userId.trim())}
          onClick={() => setConfirmOpen(true)}
          className="rounded-lg bg-white/5 px-4 py-2 text-sm text-white/80 ring-1 ring-white/10 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Resetting…" : "Reset milestone"}
        </button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Reset this member's milestone?"
        description={
          <>
            Their milestone role(s) will be removed quietly — no announcement,
            no DM. All other roles (mod, verified, …) are untouched. They can
            claim a milestone again anytime.
          </>
        }
        confirmLabel="Reset quietly"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void doReset()}
      />
    </section>
  );
}
