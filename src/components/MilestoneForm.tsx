"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Tier = {
  id?: string;
  label: string;
  emoji: string;
  roleId: string;
  sortOrder: number;
  congratsTemplate: string;
};

type ThemeOption = {
  id: string;
  name: string;
  description: string;
  colors: string[];
};

export function MilestoneForm({
  guildId,
  initial,
  channels,
  roles,
  themes,
}: {
  guildId: string;
  initial: {
    channelId: string;
    title: string;
    description: string;
    tiers: Tier[];
    messageId: string | null;
    congratsEnabled: boolean;
    congratsChannelId: string;
    congratsTemplate: string;
    ephemeralTemplate: string;
  };
  channels: Array<{ id: string; name: string }>;
  roles: Array<{ id: string; name: string; color: number }>;
  themes: ThemeOption[];
}) {
  const router = useRouter();
  const [channelId, setChannelId] = useState(initial.channelId);
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [tiers, setTiers] = useState<Tier[]>(initial.tiers);
  const [messageId, setMessageId] = useState(initial.messageId);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [autoCreating, setAutoCreating] = useState(false);
  const [themeId, setThemeId] = useState(themes[0]?.id ?? "");
  const [replaceAll, setReplaceAll] = useState(false);
  const [belowRoleId, setBelowRoleId] = useState("");
  const [congratsEnabled, setCongratsEnabled] = useState(initial.congratsEnabled);
  const [congratsChannelId, setCongratsChannelId] = useState(initial.congratsChannelId);
  const [congratsTemplate, setCongratsTemplate] = useState(initial.congratsTemplate);
  const [ephemeralTemplate, setEphemeralTemplate] = useState(initial.ephemeralTemplate);
  const [pendingDeletes, setPendingDeletes] = useState<
    Array<{ id: string; name: string; color: number }> | null
  >(null);
  const [expandedTier, setExpandedTier] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  function setTier(i: number, patch: Partial<Tier>) {
    setTiers((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  }
  function addTier() {
    setTiers((prev) => [
      ...prev,
      { label: "", emoji: "✨", roleId: "", sortOrder: prev.length, congratsTemplate: "" },
    ]);
  }
  function removeTier(i: number) {
    setTiers((prev) =>
      prev.filter((_, idx) => idx !== i).map((t, idx) => ({ ...t, sortOrder: idx }))
    );
  }
  function move(i: number, dir: -1 | 1) {
    setTiers((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const copy = [...prev];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy.map((t, idx) => ({ ...t, sortOrder: idx }));
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    setInfo(null);
    const res = await fetch(`/api/guilds/${guildId}/milestones`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelId: channelId || null,
        title,
        description,
        tiers,
        congratsEnabled,
        congratsChannelId: congratsChannelId || null,
        congratsTemplate: congratsTemplate || null,
        ephemeralTemplate: ephemeralTemplate || null,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      let msg = d.error ?? `Save failed (${res.status})`;
      if (Array.isArray(d.issues) && d.issues.length > 0) {
        const details = d.issues
          .slice(0, 3)
          .map((i: { path?: unknown[]; message?: string }) => {
            const path = (i.path ?? []).join(".") || "(root)";
            return `${path}: ${i.message}`;
          })
          .join("; ");
        msg += ` — ${details}`;
      }
      setError(msg);
      return false;
    }
    const data = await res.json();
    // Refresh tier ids so the next publish references the saved rows.
    setTiers(data.tiers);
    setInfo("Saved.");
    router.refresh();
    return true;
  }

  // Two-step: clicking the button runs requestAutoCreate, which either pops a
  // confirmation (when replaceAll would delete real roles) or calls runAutoCreate
  // immediately.
  async function requestAutoCreate() {
    setError(null);
    setInfo(null);
    if (replaceAll) {
      const linkedRoleIds = tiers
        .map((t) => t.roleId)
        .filter((id): id is string => Boolean(id));
      const willDelete = linkedRoleIds
        .map((id) => roles.find((r) => r.id === id))
        .filter((r): r is { id: string; name: string; color: number } => Boolean(r));
      if (willDelete.length > 0) {
        setPendingDeletes(willDelete);
        return;
      }
    }
    await runAutoCreate();
  }

  async function runAutoCreate() {
    setPendingDeletes(null);
    setAutoCreating(true);
    setError(null);
    setInfo(null);
    // Auto-create works against persisted rows so it needs the tier IDs to
    // exist on the server. Save first.
    const ok = await save();
    if (!ok) {
      setAutoCreating(false);
      return;
    }
    const res = await fetch(`/api/guilds/${guildId}/milestones/auto-create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        themeId,
        labels: tiers.map((t) => t.label),
        replaceAll,
        belowRoleId: belowRoleId || null,
      }),
    });
    setAutoCreating(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      let msg = d.error ?? `Auto-create failed (${res.status})`;
      if (Array.isArray(d.issues) && d.issues.length > 0) {
        const details = d.issues
          .slice(0, 3)
          .map((i: { path?: unknown[]; message?: string }) => {
            const path = (i.path ?? []).join(".") || "(root)";
            return `${path}: ${i.message}`;
          })
          .join("; ");
        msg += ` — ${details}`;
      }
      setError(msg);
      return;
    }
    const data = await res.json();
    setTiers(data.tiers);
    const s = data.stats ?? { created: 0, preserved: 0, deleted: 0, replacedButNotDeleted: 0 };
    const parts: string[] = [];
    if (s.created > 0) parts.push(`created ${s.created} role(s)`);
    if (s.preserved > 0) parts.push(`kept ${s.preserved} existing`);
    if (s.deleted > 0) parts.push(`deleted ${s.deleted} old`);
    let msg =
      parts.length > 0
        ? `Done — ${parts.join(", ")}.`
        : "Nothing to do. All tiers are already linked; check 'Replace existing' to recreate them with the new theme.";
    if (s.replacedButNotDeleted > 0) {
      msg += ` ${s.replacedButNotDeleted} old role(s) couldn't be deleted (likely above the bot in the role list) — delete them by hand.`;
    }
    setInfo(msg);
    router.refresh();
  }

  async function reorder() {
    setReordering(true);
    setError(null);
    setInfo(null);
    const res = await fetch(`/api/guilds/${guildId}/milestones/reorder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ belowRoleId: belowRoleId || null }),
    });
    setReordering(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? `Reorder failed (${res.status})`);
      return;
    }
    const data = await res.json();
    const detail = data.summary ? ` (${data.summary})` : "";
    setInfo(
      `Reordered ${data.repositioned} milestone role(s)${detail}. ` +
        `Refresh Discord if the order doesn't change immediately — client caches role positions.`
    );
  }

  async function publish() {
    setPublishing(true);
    setError(null);
    setInfo(null);
    // Save first so the server publishes what's on screen, not stale state.
    const ok = await save();
    if (!ok) {
      setPublishing(false);
      return;
    }
    const res = await fetch(`/api/guilds/${guildId}/milestones/publish`, { method: "POST" });
    setPublishing(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? `Publish failed (${res.status})`);
      return;
    }
    const data = await res.json();
    setMessageId(data.config.messageId);
    setInfo(messageId ? "Republished — existing message updated." : "Published to channel.");
    router.refresh();
  }

  const inputClass =
    "w-full rounded-lg bg-white/5 px-3 py-2 text-sm ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-500)]";

  const canPublish =
    !!channelId &&
    tiers.length > 0 &&
    tiers.every((t) => t.label && t.emoji && t.roleId);

  return (
    <div className="space-y-6 rounded-2xl bg-white/[0.02] p-6 ring-1 ring-white/5">
      {pendingDeletes && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl bg-neutral-900 p-6 ring-1 ring-white/10">
            <h2 className="text-lg font-semibold">Replace existing milestone roles?</h2>
            <p className="mt-2 text-sm text-white/60">
              The following {pendingDeletes.length} Discord role
              {pendingDeletes.length === 1 ? "" : "s"} will be deleted and replaced with
              fresh ones from the selected theme. Anyone currently holding one of these
              roles will lose it and need to re-claim from the milestones message.
            </p>
            <ul className="mt-4 space-y-1 rounded-lg bg-white/[0.03] p-3 ring-1 ring-white/5">
              {pendingDeletes.map((r) => (
                <li key={r.id} className="flex items-center gap-2 text-sm">
                  <span
                    className="block h-3 w-3 rounded-sm ring-1 ring-white/10"
                    style={{
                      backgroundColor: r.color
                        ? `#${r.color.toString(16).padStart(6, "0")}`
                        : "#5865F2",
                    }}
                  />
                  <span className="text-white/80">@{r.name}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-white/40">
              Only roles currently linked to milestone tiers are affected — no other
              roles in the server are touched.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDeletes(null)}
                className="rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/15"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={runAutoCreate}
                className="rounded-lg bg-red-500/80 px-4 py-2 text-sm font-medium hover:bg-red-500"
              >
                Delete and replace
              </button>
            </div>
          </div>
        </div>
      )}

      <div>
        <label className="mb-1 block text-sm text-white/80">Channel</label>
        <select
          value={channelId}
          onChange={(e) => setChannelId(e.target.value)}
          className={inputClass}
        >
          <option value="" className="bg-neutral-900">
            — pick a channel —
          </option>
          {channels.map((c) => (
            <option key={c.id} value={c.id} className="bg-neutral-900">
              #{c.name}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-white/40">
          The milestone-claim message will live in this channel. Pin it once published.
        </p>
      </div>

      <div>
        <label className="mb-1 block text-sm text-white/80">Title</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={inputClass}
        />
      </div>

      <div>
        <label className="mb-1 block text-sm text-white/80">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          className={inputClass}
        />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm text-white/80">Tiers ({tiers.length})</span>
          <button
            type="button"
            onClick={addTier}
            className="text-xs text-white/60 hover:text-white"
          >
            + Add tier
          </button>
        </div>
        <p className="mb-3 text-xs text-white/40">
          Up to 25 buttons total. Discord renders 5 per row.
        </p>
        <div className="space-y-2">
          {tiers.map((t, i) => (
            <div
              key={t.id ?? `new-${i}`}
              className="rounded-lg bg-white/[0.03] p-2 ring-1 ring-white/5"
            >
              <div className="grid grid-cols-[40px_1fr_2fr_auto] items-center gap-2">
                <input
                  value={t.emoji}
                  onChange={(e) => setTier(i, { emoji: e.target.value })}
                  maxLength={8}
                  className={`${inputClass} text-center`}
                  aria-label="Emoji"
                />
                <input
                  value={t.label}
                  onChange={(e) => setTier(i, { label: e.target.value })}
                  placeholder="Label, e.g. 30 days"
                  className={inputClass}
                  aria-label="Label"
                />
                <select
                  value={t.roleId}
                  onChange={(e) => setTier(i, { roleId: e.target.value })}
                  className={inputClass}
                  aria-label="Role"
                >
                  <option value="" className="bg-neutral-900">
                    — pick a role —
                  </option>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id} className="bg-neutral-900">
                      @{r.name}
                    </option>
                  ))}
                </select>
                <div className="flex gap-1 text-xs text-white/40">
                  <button
                    type="button"
                    onClick={() => setExpandedTier(expandedTier === i ? null : i)}
                    className={`rounded px-1.5 py-1 hover:bg-white/10 ${
                      t.congratsTemplate ? "text-emerald-300" : ""
                    }`}
                    aria-label={t.congratsTemplate ? "Custom message set" : "Set custom message"}
                    title={
                      t.congratsTemplate
                        ? "Custom congrats message set — click to edit"
                        : "Add a custom congrats message for this tier"
                    }
                  >
                    ✉
                  </button>
                  <button
                    type="button"
                    onClick={() => move(i, -1)}
                    disabled={i === 0}
                    className="rounded px-1.5 py-1 hover:bg-white/10 disabled:opacity-30"
                    aria-label="Move up"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(i, 1)}
                    disabled={i === tiers.length - 1}
                    className="rounded px-1.5 py-1 hover:bg-white/10 disabled:opacity-30"
                    aria-label="Move down"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => removeTier(i)}
                    className="rounded px-1.5 py-1 text-red-300 hover:bg-red-500/10"
                    aria-label="Remove"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {expandedTier === i && (
                <div className="mt-2 border-t border-white/5 pt-2">
                  <label className="mb-1 block text-xs text-white/60">
                    Custom congrats message for <strong>{t.label || "this tier"}</strong>
                  </label>
                  <textarea
                    value={t.congratsTemplate}
                    onChange={(e) => setTier(i, { congratsTemplate: e.target.value })}
                    rows={3}
                    placeholder="Leave blank to fall back to the global template below."
                    className={inputClass}
                  />
                  <p className="mt-1 text-xs text-white/40">
                    Placeholders:
                    <code className="ml-1 text-white/60">{`{user}`}</code>
                    <code className="ml-1 text-white/60">{`{tier}`}</code>
                    <code className="ml-1 text-white/60">{`{emoji}`}</code>
                    <code className="ml-1 text-white/60">{`{claimChannel}`}</code>. Wins
                    over the global template when set.
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl bg-white/[0.02] p-4 ring-1 ring-white/5">
        <div className="mb-1 text-sm text-white/80">Auto-create roles in Discord</div>
        <p className="mb-3 text-xs text-white/40">
          Pick a color theme, then click below. The bot creates one Discord role per
          tier (named from the labels above) and wires it up automatically. Existing
          roleIds are preserved unless &quot;Replace existing&quot; is checked.
        </p>

        <div className="space-y-2">
          {themes.map((theme) => (
            <label
              key={theme.id}
              className="flex cursor-pointer items-start gap-3 rounded-lg p-2 hover:bg-white/5"
            >
              <input
                type="radio"
                name="theme"
                value={theme.id}
                checked={themeId === theme.id}
                onChange={() => setThemeId(theme.id)}
                className="mt-1"
              />
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-white/90">{theme.name}</span>
                  <div className="flex gap-1">
                    {theme.colors.map((c, i) => (
                      <span
                        key={i}
                        className="block h-4 w-4 rounded-sm ring-1 ring-white/10"
                        style={{ backgroundColor: c }}
                        title={c}
                      />
                    ))}
                  </div>
                </div>
                <p className="text-xs text-white/40">{theme.description}</p>
              </div>
            </label>
          ))}
        </div>

        <div className="mt-4">
          <label className="mb-1 block text-sm text-white/80">
            Place new roles below
          </label>
          <select
            value={belowRoleId}
            onChange={(e) => setBelowRoleId(e.target.value)}
            className={inputClass}
          >
            <option value="" className="bg-neutral-900">
              Top of @everyone (default — just above @everyone)
            </option>
            {roles.map((r) => (
              <option key={r.id} value={r.id} className="bg-neutral-900">
                @{r.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-white/40">
            Pick a staff/anchor role like @Moderator. New milestone roles slot directly
            below it in the role list (highest milestone closest to the anchor). The
            bot can only place roles below its own — if the anchor is above the bot,
            the reposition step silently no-ops and you&apos;ll drag them by hand.
          </p>
        </div>

        <label className="mt-3 flex items-center gap-2 text-xs text-white/60">
          <input
            type="checkbox"
            checked={replaceAll}
            onChange={(e) => setReplaceAll(e.target.checked)}
          />
          Replace existing roleIds (creates new Discord roles even for tiers already linked)
        </label>

        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={requestAutoCreate}
            disabled={autoCreating || saving || publishing || reordering}
            className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium hover:bg-white/15 disabled:opacity-50"
          >
            {autoCreating ? "Creating roles…" : "Create roles in Discord"}
          </button>
          <button
            type="button"
            onClick={reorder}
            disabled={autoCreating || saving || publishing || reordering}
            className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium hover:bg-white/15 disabled:opacity-50"
            title="Reposition the already-linked Discord roles so 2+ years sits on top and 24 hours sits at the bottom. Doesn't touch role colors, names, or membership."
          >
            {reordering ? "Reordering…" : "Fix role order"}
          </button>
        </div>
      </div>

      <div className="rounded-xl bg-white/[0.02] p-4 ring-1 ring-white/5">
        <div className="mb-1 text-sm text-white/80">
          Private message after claiming (only the clicker sees this)
        </div>
        <p className="mb-3 text-xs text-white/40">
          Shown ephemerally to the user who clicked. Always sent — there&apos;s no
          toggle, since something needs to confirm the click worked.
        </p>
        <textarea
          value={ephemeralTemplate}
          onChange={(e) => setEphemeralTemplate(e.target.value)}
          rows={3}
          className={inputClass}
        />
        <p className="mt-1 text-xs text-white/40">
          Placeholders:
          <code className="ml-1 text-white/60">{`{tier}`}</code> the label,
          <code className="ml-1 text-white/60">{`{emoji}`}</code> the tier emoji.
          No <code className="text-white/60">{`{user}`}</code> here — they already
          know who they are.
        </p>
      </div>

      <div className="rounded-xl bg-white/[0.02] p-4 ring-1 ring-white/5">
        <label className="flex items-center gap-2 text-sm text-white/80">
          <input
            type="checkbox"
            checked={congratsEnabled}
            onChange={(e) => setCongratsEnabled(e.target.checked)}
          />
          Post a congrats message when someone claims a milestone
        </label>

        {congratsEnabled && (
          <div className="mt-4 space-y-4">
            <div>
              <label className="mb-1 block text-sm text-white/80">
                Channel for congrats messages
              </label>
              <select
                value={congratsChannelId}
                onChange={(e) => setCongratsChannelId(e.target.value)}
                className={inputClass}
              >
                <option value="" className="bg-neutral-900">
                  — pick a channel —
                </option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id} className="bg-neutral-900">
                    #{c.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-sm text-white/80">Template</label>
              <textarea
                value={congratsTemplate}
                onChange={(e) => setCongratsTemplate(e.target.value)}
                rows={3}
                className={inputClass}
              />
              <p className="mt-1 text-xs text-white/40">
                Placeholders:
                <code className="ml-1 text-white/60">{`{user}`}</code> mentions the
                claimer,
                <code className="ml-1 text-white/60">{`{tier}`}</code> is the label
                (&quot;30 days&quot;),
                <code className="ml-1 text-white/60">{`{emoji}`}</code> is the tier
                emoji,
                <code className="ml-1 text-white/60">{`{claimChannel}`}</code> links
                to the channel where the claim message lives (the &quot;Channel&quot;
                field at the top). Posts only fire when a user actually swaps to a
                new tier — no spam if they re-click their current one.
              </p>
            </div>
          </div>
        )}
      </div>

      {error && (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300 ring-1 ring-red-500/20">
          {error}
        </p>
      )}
      {info && !error && (
        <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300 ring-1 ring-emerald-500/20">
          {info}
        </p>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || publishing}
          className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium hover:bg-white/15 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={publish}
          disabled={!canPublish || saving || publishing}
          className="rounded-lg bg-[color:var(--color-brand-600)] px-4 py-2 text-sm font-medium hover:bg-[color:var(--color-brand-500)] disabled:opacity-50"
        >
          {publishing ? "Publishing…" : messageId ? "Republish" : "Publish to Discord"}
        </button>
        {messageId && (
          <span className="self-center text-xs text-white/40">
            Currently published — republish overwrites the existing message.
          </span>
        )}
      </div>
    </div>
  );
}
