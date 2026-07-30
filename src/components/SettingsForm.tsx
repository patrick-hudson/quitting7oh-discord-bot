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
  channels,
}: {
  guildId: string;
  initial: {
    timezone: string;
    adminRoleId: string;
    redditEnabled: boolean;
    redditSubreddit: string;
    redditChannelId: string;
    leaveEnabled: boolean;
    leaveChannelId: string;
    welcomeDmEnabled: boolean;
  };
  roles: Array<{ id: string; name: string }>;
  channels: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [timezone, setTimezone] = useState(initial.timezone);
  const [adminRoleId, setAdminRoleId] = useState(initial.adminRoleId);
  const [redditEnabled, setRedditEnabled] = useState(initial.redditEnabled);
  const [redditSubreddit, setRedditSubreddit] = useState(initial.redditSubreddit);
  const [redditChannelId, setRedditChannelId] = useState(initial.redditChannelId);
  const [leaveEnabled, setLeaveEnabled] = useState(initial.leaveEnabled);
  const [leaveChannelId, setLeaveChannelId] = useState(initial.leaveChannelId);
  const [welcomeDmEnabled, setWelcomeDmEnabled] = useState(initial.welcomeDmEnabled);
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
      body: JSON.stringify({
        timezone,
        adminRoleId: adminRoleId || null,
        redditEnabled,
        // Strip a leading "r/" if the user pastes it; server validates the rest.
        redditSubreddit: redditSubreddit.trim().replace(/^\/?r\//i, ""),
        redditChannelId: redditChannelId || null,
        leaveEnabled,
        leaveChannelId: leaveChannelId || null,
        welcomeDmEnabled,
      }),
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
          Used to interpret cron expressions for posts that don&apos;t override it.
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
          Discord users with this role gain access to this guild&apos;s posts in the portal.
        </p>
      </div>

      <div className="space-y-4 border-t border-white/10 pt-6">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
            Reddit announcements
          </h2>
          <p className="mt-1 text-xs text-white/40">
            Post an embed to a channel whenever your subreddit gets a new submission.
          </p>
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={redditEnabled}
            onChange={(e) => setRedditEnabled(e.target.checked)}
          />
          Announce new subreddit posts
        </label>

        <div>
          <label className="mb-1 block text-sm text-white/80">Subreddit</label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-white/40">r/</span>
            <input
              value={redditSubreddit}
              onChange={(e) => setRedditSubreddit(e.target.value)}
              placeholder="quitting7oh"
              className="w-full rounded-lg bg-white/5 px-3 py-2 text-sm ring-1 ring-white/10 placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-500)]"
            />
          </div>
          <p className="mt-1 text-xs text-white/40">
            Just the name — no <code className="text-white/60">r/</code> needed.
          </p>
        </div>

        <div>
          <label className="mb-1 block text-sm text-white/80">Announce in channel</label>
          <select
            value={redditChannelId}
            onChange={(e) => setRedditChannelId(e.target.value)}
            className="w-full rounded-lg bg-white/5 px-3 py-2 text-sm ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-500)]"
          >
            <option value="" className="bg-neutral-900">
              None
            </option>
            {channels.map((c) => (
              <option key={c.id} value={c.id} className="bg-neutral-900">
                #{c.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-4 border-t border-white/10 pt-6">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
            Member departures
          </h2>
          <p className="mt-1 text-xs text-white/40">
            Post a message when someone leaves the server. Fires the same for
            voluntary leaves, kicks, and bans — Discord doesn&apos;t distinguish.
            Edit the message roster on the Defaults page.
          </p>
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={leaveEnabled}
            onChange={(e) => setLeaveEnabled(e.target.checked)}
          />
          Announce member departures
        </label>

        <div>
          <label className="mb-1 block text-sm text-white/80">Announce in channel</label>
          <select
            value={leaveChannelId}
            onChange={(e) => setLeaveChannelId(e.target.value)}
            className="w-full rounded-lg bg-white/5 px-3 py-2 text-sm ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-500)]"
          >
            <option value="" className="bg-neutral-900">
              None
            </option>
            {channels.map((c) => (
              <option key={c.id} value={c.id} className="bg-neutral-900">
                #{c.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-white/40">
            Tip: a mods-only channel keeps departure logs private — a public
            &quot;X left&quot; can land hard in a recovery space.
          </p>
        </div>
      </div>

      <div className="space-y-4 border-t border-white/10 pt-6">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
            Welcome DM
          </h2>
          <p className="mt-1 text-xs text-white/40">
            DM a welcome message to each member when they join (every join,
            including rejoins). Members with DMs closed are silently skipped.
            Edit the message roster on the Defaults page.
          </p>
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={welcomeDmEnabled}
            onChange={(e) => setWelcomeDmEnabled(e.target.checked)}
          />
          Send a welcome DM to new members
        </label>
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
