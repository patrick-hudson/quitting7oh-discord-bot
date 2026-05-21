"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const TZ_OPTIONS = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Europe/London",
  "Europe/Berlin",
  "UTC",
];

export function SettingsForm({
  guildId,
  initial,
  roles,
}: {
  guildId: string;
  initial: { timezone: string; adminRoleId: string };
  roles: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [timezone, setTimezone] = useState(initial.timezone);
  const [adminRoleId, setAdminRoleId] = useState(initial.adminRoleId);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    const res = await fetch(`/api/guilds/${guildId}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timezone, adminRoleId: adminRoleId || null }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? `Failed (${res.status})`);
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6 rounded-2xl bg-white/[0.02] p-6 ring-1 ring-white/5">
      <div>
        <label className="mb-1 block text-sm text-white/80">Default timezone</label>
        <select
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          className="w-full rounded-lg bg-white/5 px-3 py-2 text-sm ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-500)]"
        >
          {TZ_OPTIONS.map((tz) => (
            <option key={tz} value={tz} className="bg-neutral-900">
              {tz}
            </option>
          ))}
          {!TZ_OPTIONS.includes(timezone) && (
            <option value={timezone} className="bg-neutral-900">
              {timezone}
            </option>
          )}
        </select>
        <p className="mt-1 text-xs text-white/40">
          Used to interpret cron expressions for posts that don't override it.
        </p>
      </div>

      <div>
        <label className="mb-1 block text-sm text-white/80">Admin role</label>
        <select
          value={adminRoleId}
          onChange={(e) => setAdminRoleId(e.target.value)}
          className="w-full rounded-lg bg-white/5 px-3 py-2 text-sm ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-500)]"
        >
          <option value="" className="bg-neutral-900">
            None (only bootstrap admins can manage)
          </option>
          {roles.map((r) => (
            <option key={r.id} value={r.id} className="bg-neutral-900">
              @{r.name}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-white/40">
          Discord users with this role gain access to this guild's posts in the portal.
        </p>
      </div>

      {error && (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300 ring-1 ring-red-500/20">
          {error}
        </p>
      )}
      {saved && (
        <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300 ring-1 ring-emerald-500/20">
          Saved.
        </p>
      )}

      <button
        type="submit"
        disabled={saving}
        className="rounded-lg bg-[color:var(--color-brand-600)] px-4 py-2 text-sm font-medium hover:bg-[color:var(--color-brand-500)] disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save settings"}
      </button>
    </form>
  );
}
