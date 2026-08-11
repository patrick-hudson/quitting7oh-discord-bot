"use client";

// Editor for the AI reviewer's ENTIRE system prompt (persona + criteria +
// guardrails). Saving an empty value clears the override and falls back to the
// baked-in default. Collapsed by default so the page leads with reviews.

import { useState } from "react";
import { useRouter } from "next/navigation";

export function AiReviewPromptEditor({
  guildId,
  initial,
  isCustom,
  defaultPrompt,
}: {
  guildId: string;
  initial: string; // current effective prompt (override or default)
  isCustom: boolean;
  defaultPrompt: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save(next: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/guilds/${guildId}/ai-review/prompt`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: next }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        custom?: boolean;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Save failed.");
      setMsg(data.custom ? "Saved custom prompt." : "Reset to the default prompt.");
      router.refresh();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl bg-white/[0.02] ring-1 ring-white/10">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-sm font-medium text-white/80">
          Reviewer prompt{" "}
          <span
            className={`ml-2 rounded px-1.5 py-0.5 text-[10px] ${
              isCustom
                ? "bg-amber-400/15 text-amber-200 ring-1 ring-amber-400/20"
                : "bg-white/5 text-white/50 ring-1 ring-white/10"
            }`}
          >
            {isCustom ? "customized" : "default"}
          </span>
        </span>
        <span className="text-white/40">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="border-t border-white/5 p-4">
          <p className="mb-2 text-xs text-white/50">
            This is the full system prompt sent to the model. Edit anything, but
            keep the guardrails (no protected-characteristic inference, crisis
            routing, evidence-based, decision-support only). Clearing the box and
            saving restores the default.
          </p>
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
            className="h-80 w-full resize-y rounded-lg bg-black/40 p-3 font-mono text-[12px] leading-relaxed text-white/85 ring-1 ring-white/10 focus:outline-none focus:ring-white/25"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void save(value)}
              className="rounded-lg bg-[color:var(--color-brand-600)] px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save prompt"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setValue(defaultPrompt);
              }}
              className="rounded-lg bg-white/5 px-3 py-1.5 text-sm text-white/70 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-50"
            >
              Load default
            </button>
            {isCustom && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setValue(defaultPrompt);
                  void save("");
                }}
                className="rounded-lg px-3 py-1.5 text-sm text-red-300/80 ring-1 ring-red-400/20 hover:bg-red-400/10 disabled:opacity-50"
              >
                Reset to default
              </button>
            )}
            {msg && <span className="text-xs text-white/50">{msg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
