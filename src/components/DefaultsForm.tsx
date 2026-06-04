"use client";

// Per-guild defaults form. Currently scoped to the reminder-template roster
// the scheduler picks from when a ScheduledPost has no reminderContent of its
// own. Designed to grow more sections (e.g. default lead time) without
// restructuring — each setting is its own section with its own state slice.

import { useRouter } from "next/navigation";
import { useState } from "react";

function rosterToText(roster: string[]): string {
  return roster.join("\n");
}
function textToRoster(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function DefaultsForm({
  guildId,
  initialReminderTemplates,
  builtInReminderTemplates,
}: {
  guildId: string;
  initialReminderTemplates: string[];
  builtInReminderTemplates: string[];
}) {
  const router = useRouter();
  const [reminderText, setReminderText] = useState(
    rosterToText(initialReminderTemplates)
  );
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; id: number; visible: boolean } | null>(
    null
  );

  function showToast(message: string) {
    const id = Date.now();
    setToast({ message, id, visible: true });
    setTimeout(() => setToast((c) => (c?.id === id ? { ...c, visible: false } : c)), 1800);
    setTimeout(() => setToast((c) => (c?.id === id ? null : c)), 2200);
  }

  async function save() {
    setError(null);
    setSaving(true);
    const res = await fetch(`/api/guilds/${guildId}/defaults`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reminderTemplates: textToRoster(reminderText) }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? `Failed (${res.status})`);
      return;
    }
    setIsDirty(false);
    showToast("Saved");
    router.refresh();
  }

  const customLines = textToRoster(reminderText);
  const usingBuiltIns = customLines.length === 0;

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-2xl bg-white/[0.02] p-5 ring-1 ring-white/5">
        <header className="flex items-baseline justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
              Reminder follow-up messages
            </h2>
            <p className="mt-1 text-xs text-white/40">
              One message per line. The scheduler picks one at random (avoiding
              the last one used per post) whenever a post fires a reminder and
              has no custom text of its own.
            </p>
            <p className="mt-1 text-xs text-white/40">
              Placeholders: <code className="text-white/60">{`{meetingTime}`}</code>{" "}
              <code className="text-white/60">{`{meetingTime:R}`}</code>{" "}
              <code className="text-white/60">{`{meetingTime:F}`}</code>
            </p>
          </div>
          <span
            className={`shrink-0 text-xs ${
              usingBuiltIns ? "text-amber-300/80" : "text-white/40"
            }`}
          >
            {usingBuiltIns
              ? "using built-in defaults"
              : `${customLines.length} custom message${customLines.length === 1 ? "" : "s"}`}
          </span>
        </header>

        <textarea
          value={reminderText}
          onChange={(e) => {
            setReminderText(e.target.value);
            setIsDirty(true);
          }}
          rows={Math.max(8, Math.min(customLines.length + 2, 16))}
          placeholder="Leave blank to use the bot's built-in defaults (shown below)."
          className="block w-full rounded-lg bg-white/5 px-3 py-2 text-sm ring-1 ring-white/10 placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-500)]"
        />

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setReminderText(rosterToText(builtInReminderTemplates));
              setIsDirty(true);
            }}
            className="rounded-md bg-white/5 px-3 py-1.5 text-xs text-white/80 ring-1 ring-white/10 hover:bg-white/10"
            title="Populate the textarea with the built-in defaults so you can edit them"
          >
            Copy built-ins into editor
          </button>
          <button
            type="button"
            onClick={() => {
              setReminderText("");
              setIsDirty(true);
            }}
            className="rounded-md bg-white/5 px-3 py-1.5 text-xs text-white/80 ring-1 ring-white/10 hover:bg-white/10"
            title="Clear the textarea so the bot falls back to built-in defaults (after save)"
          >
            Reset to built-ins
          </button>
        </div>

        <details className="text-xs text-white/50">
          <summary className="cursor-pointer hover:text-white/80">
            Built-in defaults (used when this is blank)
          </summary>
          <ul className="mt-2 space-y-1 rounded-md bg-white/[0.03] p-3 ring-1 ring-white/5">
            {builtInReminderTemplates.map((t, i) => (
              <li key={i}>· {t}</li>
            ))}
          </ul>
        </details>
      </section>

      {error && (
        <div className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300 ring-1 ring-red-500/20">
          {error}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !isDirty}
          className="rounded-lg bg-[color:var(--color-brand-600)] px-4 py-2 text-sm font-medium hover:bg-[color:var(--color-brand-500)] disabled:cursor-not-allowed disabled:bg-white/5 disabled:text-white/40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`pointer-events-none fixed bottom-6 right-6 z-50 rounded-lg bg-emerald-500/15 px-4 py-2 text-sm text-emerald-200 shadow-lg ring-1 ring-emerald-500/30 backdrop-blur transition-opacity duration-300 ${
            toast.visible ? "opacity-100" : "opacity-0"
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
