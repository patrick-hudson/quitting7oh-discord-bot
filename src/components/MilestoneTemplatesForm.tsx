"use client";

// Advanced bulk-editor for milestone message rosters. Renders one tall textarea
// per tier so every roster is visible at once — no expand-to-edit step — plus
// the two guild-level rosters (congrats fallback, ephemeral).
//
// Saves through the same PATCH /api/guilds/[guildId]/milestones endpoint as the
// main milestone form; we pass the existing config + per-tier metadata through
// unchanged and only mutate the rosters.

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RosterPreview } from "@/components/MessagePreview";

// Sample-value substitution for congrats/ephemeral previews. {user} renders
// as a plain @name (real sends use a mention pill).
function congratsPreviewSub(tierLabel: string, tierEmoji: string) {
  return (line: string) =>
    line
      .replaceAll("{user}", "**@Alex**")
      .replaceAll("{tier}", tierLabel)
      .replaceAll("{emoji}", tierEmoji)
      .replaceAll("{claimChannel}", "<#0>")
      .replaceAll("\\n", "\n");
}

function PreviewDetails({
  lines,
  substitute,
}: {
  lines: string[];
  substitute: (line: string) => string;
}) {
  if (lines.length === 0) return null;
  return (
    <details className="text-xs text-white/50">
      <summary className="cursor-pointer select-none hover:text-white/80">
        Rendered preview (sample values)
      </summary>
      <div className="mt-2">
        <RosterPreview lines={lines} substitute={substitute} />
      </div>
    </details>
  );
}

export type TemplatesTier = {
  id: string;
  label: string;
  emoji: string;
  roleId: string;
  sortOrder: number;
  congratsTemplates: string[];
};

export type TemplatesConfig = {
  channelId: string | null;
  title: string;
  description: string;
  congratsEnabled: boolean;
  congratsChannelId: string | null;
};

function rosterToText(roster: string[]): string {
  return roster.join("\n");
}
function textToRoster(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function MilestoneTemplatesForm({
  guildId,
  config,
  tiers: initialTiers,
  initialCongratsTemplates,
  initialEphemeralTemplates,
}: {
  guildId: string;
  config: TemplatesConfig;
  tiers: TemplatesTier[];
  initialCongratsTemplates: string[];
  initialEphemeralTemplates: string[];
}) {
  const router = useRouter();
  // Per-tier roster text, keyed by tier id. Stored as raw textarea strings so
  // intermediate edits (e.g. a trailing blank line) don't bounce in/out.
  const [tierText, setTierText] = useState<Record<string, string>>(() =>
    Object.fromEntries(initialTiers.map((t) => [t.id, rosterToText(t.congratsTemplates)]))
  );
  const [congratsText, setCongratsText] = useState(rosterToText(initialCongratsTemplates));
  const [ephemeralText, setEphemeralText] = useState(rosterToText(initialEphemeralTemplates));
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

  function setTier(id: string, text: string) {
    setTierText((m) => ({ ...m, [id]: text }));
    setIsDirty(true);
  }

  async function save() {
    setError(null);
    setSaving(true);

    // Re-assemble the full PATCH shape. The advanced page only edits rosters;
    // every other field travels through unchanged so the route's overwrite
    // semantics don't blow away channel/title/description/etc.
    const body = {
      channelId: config.channelId,
      title: config.title,
      description: config.description,
      congratsEnabled: config.congratsEnabled,
      congratsChannelId: config.congratsChannelId,
      congratsTemplates: textToRoster(congratsText),
      ephemeralTemplates: textToRoster(ephemeralText),
      tiers: initialTiers.map((t) => ({
        id: t.id,
        label: t.label,
        emoji: t.emoji,
        roleId: t.roleId,
        sortOrder: t.sortOrder,
        congratsTemplates: textToRoster(tierText[t.id] ?? ""),
      })),
    };

    const res = await fetch(`/api/guilds/${guildId}/milestones`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
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

  const tierCount = initialTiers.length;

  return (
    <div className="space-y-6">
      <div className="sticky top-0 z-10 -mx-1 flex items-center justify-between gap-3 rounded-xl bg-neutral-950/85 px-3 py-2 backdrop-blur ring-1 ring-white/10">
        <p className="text-xs text-white/50">
          {tierCount} tier{tierCount === 1 ? "" : "s"} · placeholders:{" "}
          <code className="text-white/70">{"{user}"}</code>{" "}
          <code className="text-white/70">{"{emoji}"}</code>{" "}
          <code className="text-white/70">{"{tier}"}</code>{" "}
          <code className="text-white/70">{"{claimChannel}"}</code>
        </p>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !isDirty}
          className="rounded-lg bg-[color:var(--color-brand-600)] px-4 py-2 text-sm font-medium hover:bg-[color:var(--color-brand-500)] disabled:cursor-not-allowed disabled:bg-white/5 disabled:text-white/40"
        >
          {saving ? "Saving…" : "Save all"}
        </button>
      </div>

      {error && (
        <div className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300 ring-1 ring-red-500/20">
          {error}
        </div>
      )}

      <div className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
          Per-tier congrats messages
        </h2>
        {initialTiers.length === 0 && (
          <p className="rounded-md bg-white/[0.03] px-3 py-3 text-sm text-white/60 ring-1 ring-white/5">
            No tiers configured yet. Add some on the{" "}
            <a
              href={`/dashboard/${guildId}/milestones`}
              className="text-[color:var(--color-brand-500)] hover:underline"
            >
              main milestones page
            </a>
            .
          </p>
        )}
        {initialTiers.map((t, i) => {
          const text = tierText[t.id] ?? "";
          const lines = textToRoster(text);
          const usesFallback = lines.length === 0;
          return (
            <section
              key={t.id}
              className="space-y-2 rounded-2xl bg-white/[0.02] p-4 ring-1 ring-white/5"
            >
              <header className="flex items-baseline justify-between gap-3">
                <div className="text-sm font-medium text-white">
                  <span className="mr-2 text-white/40">#{i + 1}</span>
                  <span className="mr-1">{t.emoji || "•"}</span>
                  {t.label || "(unlabeled tier)"}
                </div>
                <span
                  className={`text-xs ${
                    usesFallback ? "text-amber-300/80" : "text-white/40"
                  }`}
                  title={
                    usesFallback
                      ? "Empty — falls back to the guild-level congrats roster below"
                      : `${lines.length} message${lines.length === 1 ? "" : "s"}`
                  }
                >
                  {usesFallback ? "uses guild fallback" : `${lines.length} message${lines.length === 1 ? "" : "s"}`}
                </span>
              </header>
              <textarea
                value={text}
                onChange={(e) => setTier(t.id, e.target.value)}
                rows={Math.max(6, Math.min(lines.length + 2, 14))}
                placeholder="One message per line. Leave blank to use the guild fallback roster."
                className="block w-full rounded-lg bg-white/5 px-3 py-2 text-sm ring-1 ring-white/10 placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-500)]"
              />
              <PreviewDetails
                lines={lines}
                substitute={congratsPreviewSub(t.label || "milestone", t.emoji || "🎉")}
              />
            </section>
          );
        })}
      </div>

      <div className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
          Guild-level rosters
        </h2>

        <section className="space-y-2 rounded-2xl bg-white/[0.02] p-4 ring-1 ring-white/5">
          <header className="flex items-baseline justify-between gap-3">
            <div className="text-sm font-medium text-white">Congrats fallback</div>
            <span className="text-xs text-white/40">
              {textToRoster(congratsText).length} message
              {textToRoster(congratsText).length === 1 ? "" : "s"}
            </span>
          </header>
          <p className="text-xs text-white/40">
            Used when a tier above has no messages of its own. Leave blank to skip
            congrats for those tiers.
          </p>
          <textarea
            value={congratsText}
            onChange={(e) => {
              setCongratsText(e.target.value);
              setIsDirty(true);
            }}
            rows={Math.max(6, Math.min(textToRoster(congratsText).length + 2, 14))}
            placeholder="One message per line."
            className="block w-full rounded-lg bg-white/5 px-3 py-2 text-sm ring-1 ring-white/10 placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-500)]"
          />
          <PreviewDetails
            lines={textToRoster(congratsText)}
            substitute={congratsPreviewSub("30 days", "🌱")}
          />
        </section>

        <section className="space-y-2 rounded-2xl bg-white/[0.02] p-4 ring-1 ring-white/5">
          <header className="flex items-baseline justify-between gap-3">
            <div className="text-sm font-medium text-white">Ephemeral roster</div>
            <span className="text-xs text-white/40">
              {textToRoster(ephemeralText).length} message
              {textToRoster(ephemeralText).length === 1 ? "" : "s"}
            </span>
          </header>
          <p className="text-xs text-white/40">
            Shown only to the user who clicked the button. Leave blank to use the
            bot&apos;s built-in default.
          </p>
          <textarea
            value={ephemeralText}
            onChange={(e) => {
              setEphemeralText(e.target.value);
              setIsDirty(true);
            }}
            rows={Math.max(6, Math.min(textToRoster(ephemeralText).length + 2, 14))}
            placeholder="One message per line."
            className="block w-full rounded-lg bg-white/5 px-3 py-2 text-sm ring-1 ring-white/10 placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-500)]"
          />
          <PreviewDetails
            lines={textToRoster(ephemeralText)}
            substitute={congratsPreviewSub("30 days", "🌱")}
          />
        </section>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !isDirty}
          className="rounded-lg bg-[color:var(--color-brand-600)] px-4 py-2 text-sm font-medium hover:bg-[color:var(--color-brand-500)] disabled:cursor-not-allowed disabled:bg-white/5 disabled:text-white/40"
        >
          {saving ? "Saving…" : "Save all"}
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
