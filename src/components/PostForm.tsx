"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ChannelPicker } from "./ChannelPicker";
import { DiscordPreview } from "./DiscordPreview";

type Channel = { id: string; name: string; parent_id: string | null };
type Role = { id: string; name: string; color: number };

export type PostFormValues = {
  id?: string;
  name: string;
  channelIds: string[];
  scheduleKind: "cron" | "oneoff";
  cron: string;
  runAt: string; // datetime-local
  timezone: string;
  useEmbed: boolean;
  content: string;
  embedTitle: string;
  embedColor: string;
  embedUrl: string;
  embedImage: string;
  mentionRoleId: string;
  leadMinutes: number;
  active: boolean;
};

const CRON_PRESETS: Array<{ label: string; expr: string }> = [
  { label: "Every day, 7pm", expr: "0 19 * * *" },
  { label: "Mon–Fri, 9am", expr: "0 9 * * 1-5" },
  { label: "Sunday, 7pm", expr: "0 19 * * 0" },
  { label: "Every Wednesday, 8pm", expr: "0 20 * * 3" },
];

export function PostForm({
  guildId,
  initial,
  guildTimezone,
}: {
  guildId: string;
  initial?: Partial<PostFormValues>;
  guildTimezone: string;
}) {
  const router = useRouter();
  const [values, setValues] = useState<PostFormValues>({
    name: "",
    channelIds: [],
    scheduleKind: "cron",
    cron: "0 19 * * 0",
    timezone: guildTimezone,
    useEmbed: false,
    content: "",
    embedTitle: "",
    embedColor: "#5865F2",
    embedUrl: "",
    embedImage: "",
    mentionRoleId: "",
    leadMinutes: 0,
    active: true,
    ...initial,
    // `initial.runAt` arrives as an ISO string from the server. Convert to
    // browser-local "YYYY-MM-DDTHH:mm" for the datetime-local input.
    runAt: initial?.runAt ? isoToLocalInput(initial.runAt) : "",
  });
  const [channels, setChannels] = useState<Channel[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [preview, setPreview] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/guilds/${guildId}/channels`)
      .then((r) => r.json())
      .then((d) => setChannels(d.channels ?? []))
      .catch(() => {});
    fetch(`/api/guilds/${guildId}/roles`)
      .then((r) => r.json())
      .then((d) => setRoles(d.roles ?? []))
      .catch(() => {});
  }, [guildId]);

  // Re-fetch cron preview whenever the expression or timezone changes.
  useEffect(() => {
    if (values.scheduleKind !== "cron" || !values.cron) {
      setPreview([]);
      return;
    }
    const t = setTimeout(() => {
      fetch(
        `/api/cron-preview?expr=${encodeURIComponent(values.cron)}&tz=${encodeURIComponent(values.timezone)}`
      )
        .then((r) => r.json())
        .then((d) => setPreview(d.next ?? []))
        .catch(() => setPreview([]));
    }, 250);
    return () => clearTimeout(t);
  }, [values.cron, values.timezone, values.scheduleKind]);

  function set<K extends keyof PostFormValues>(k: K, v: PostFormValues[K]) {
    setValues((s) => ({ ...s, [k]: v }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (values.channelIds.length === 0) {
      setError("Pick at least one channel.");
      return;
    }
    setSaving(true);
    const method = initial?.id ? "PATCH" : "POST";
    const url = initial?.id
      ? `/api/guilds/${guildId}/posts/${initial.id}`
      : `/api/guilds/${guildId}/posts`;

    // datetime-local is timezone-naive. Convert to ISO with the browser's
    // offset so the server stores the moment the user actually meant.
    const payload = {
      ...values,
      runAt:
        values.scheduleKind === "oneoff" && values.runAt
          ? new Date(values.runAt).toISOString()
          : "",
    };

    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? `Failed (${res.status})`);
      return;
    }
    router.push(`/dashboard/${guildId}`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-8">
      <Section title="Basics">
        <Field label="Name">
          <input
            required
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Sunday 7pm Recovery Meeting"
            className={inputClass}
          />
        </Field>

        <Field
          label="Channels"
          hint="The bot will post the same message to every selected channel."
        >
          <ChannelPicker
            channels={channels}
            selectedIds={values.channelIds}
            onChange={(next) => set("channelIds", next)}
          />
        </Field>
      </Section>

      <Section title="Schedule">
        <div className="flex gap-2">
          <TabButton
            active={values.scheduleKind === "cron"}
            onClick={() => set("scheduleKind", "cron")}
          >
            Recurring (cron)
          </TabButton>
          <TabButton
            active={values.scheduleKind === "oneoff"}
            onClick={() => set("scheduleKind", "oneoff")}
          >
            One-off
          </TabButton>
        </div>

        {values.scheduleKind === "cron" ? (
          <>
            <Field label="Cron expression" hint="minute hour day-of-month month day-of-week">
              <input
                value={values.cron}
                onChange={(e) => set("cron", e.target.value)}
                placeholder="0 19 * * 0"
                className={`${inputClass} font-mono`}
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {CRON_PRESETS.map((p) => (
                  <button
                    type="button"
                    key={p.expr}
                    onClick={() => set("cron", p.expr)}
                    className="rounded-md bg-white/5 px-2 py-1 text-xs text-white/70 hover:bg-white/10"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Timezone">
              <input
                value={values.timezone}
                onChange={(e) => set("timezone", e.target.value)}
                placeholder="America/New_York"
                className={inputClass}
              />
            </Field>
            {preview.length > 0 && (
              <div className="rounded-lg bg-white/[0.03] p-3 text-xs text-white/60 ring-1 ring-white/5">
                <p className="mb-1 text-white/40">Next fires:</p>
                <ul className="space-y-0.5">
                  {preview.map((t, i) => (
                    <li key={i}>· {t}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <Field label="Run at" hint="Interpreted in your browser's local timezone.">
            <input
              type="datetime-local"
              value={values.runAt}
              onChange={(e) => set("runAt", e.target.value)}
              className={inputClass}
            />
          </Field>
        )}
      </Section>

      <Section title="Message">
        <div className="flex items-center gap-3 rounded-lg bg-white/[0.03] px-3 py-2 ring-1 ring-white/5">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={values.useEmbed}
              onChange={(e) => set("useEmbed", e.target.checked)}
            />
            Use rich embed
          </label>
          <p className="ml-auto text-xs text-white/40">
            {values.useEmbed
              ? "Posts as a colored Discord embed card"
              : "Posts as a plain text message"}
          </p>
        </div>

        {values.useEmbed && (
          <>
            <Field label="Embed title">
              <input
                value={values.embedTitle}
                onChange={(e) => set("embedTitle", e.target.value)}
                placeholder="Recovery meeting starting now"
                className={inputClass}
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Color">
                <input
                  type="color"
                  value={values.embedColor}
                  onChange={(e) => set("embedColor", e.target.value)}
                  className="h-10 w-full rounded-lg bg-white/5 ring-1 ring-white/10"
                />
              </Field>
              <Field label="Link (optional)">
                <input
                  value={values.embedUrl}
                  onChange={(e) => set("embedUrl", e.target.value)}
                  placeholder="https://…"
                  className={inputClass}
                />
              </Field>
            </div>
            <Field label="Image URL (optional)">
              <input
                value={values.embedImage}
                onChange={(e) => set("embedImage", e.target.value)}
                placeholder="https://…"
                className={inputClass}
              />
            </Field>
          </>
        )}

        <Field label={values.useEmbed ? "Embed description" : "Message content"}>
          <textarea
            required
            value={values.content}
            onChange={(e) => set("content", e.target.value)}
            rows={5}
            placeholder="Join us at the link in #meetings for tonight's recovery meeting."
            className={inputClass}
          />
          <p className="mt-1 text-xs text-white/40">
            Use <code className="text-white/60">{`{meetingTime}`}</code> to insert the
            meeting time in each viewer&apos;s local timezone. Suffixes:
            <code className="ml-1 text-white/60">{`{meetingTime:R}`}</code> relative
            (&quot;in 5 minutes&quot;),
            <code className="ml-1 text-white/60">{`{meetingTime:F}`}</code> full date+time.
            Set the lead time below so &quot;in 5 minutes&quot; renders correctly.
          </p>
        </Field>

        <Field label="Lead time (minutes before meeting)">
          <input
            type="number"
            min={0}
            max={1440}
            value={values.leadMinutes}
            onChange={(e) => set("leadMinutes", Number(e.target.value) || 0)}
            className={inputClass}
          />
          <p className="mt-1 text-xs text-white/40">
            How many minutes the meeting starts <em>after</em> this post fires. Used
            to resolve <code className="text-white/60">{`{meetingTime}`}</code>.
            Leave at 0 if the post fires when the meeting starts.
          </p>
        </Field>

        <Field label="Mention role (optional)">
          <select
            value={values.mentionRoleId}
            onChange={(e) => set("mentionRoleId", e.target.value)}
            className={inputClass}
          >
            <option value="" className="bg-neutral-900">
              None
            </option>
            {roles.map((r) => (
              <option key={r.id} value={r.id} className="bg-neutral-900">
                @{r.name}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      <Section title="Preview">
        <p className="mb-2 text-xs text-white/40">
          What this will look like in Discord. Timestamps use your local clock
          and the current lead time; each viewer sees them in their own
          timezone when the bot actually fires.
        </p>
        <DiscordPreview
          useEmbed={values.useEmbed}
          content={values.content}
          embedTitle={values.embedTitle}
          embedColor={values.embedColor}
          embedUrl={values.embedUrl}
          embedImage={values.embedImage}
          mentionRoleId={values.mentionRoleId}
          leadMinutes={values.leadMinutes}
          roles={roles}
          channels={channels}
        />
      </Section>

      <Section title="State">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={values.active}
            onChange={(e) => set("active", e.target.checked)}
          />
          Active — bot will post on schedule
        </label>
      </Section>

      {error && (
        <div className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300 ring-1 ring-red-500/20">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-3">
        <button
          type="button"
          onClick={() => router.push(`/dashboard/${guildId}`)}
          className="rounded-lg px-4 py-2 text-sm text-white/70 hover:bg-white/5"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-[color:var(--color-brand-600)] px-4 py-2 text-sm font-medium hover:bg-[color:var(--color-brand-500)] disabled:opacity-50"
        >
          {saving ? "Saving…" : initial?.id ? "Save changes" : "Create post"}
        </button>
      </div>
    </form>
  );
}

// Converts an ISO timestamp ("2024-05-20T23:00:00.000Z") to the
// "YYYY-MM-DDTHH:mm" form expected by <input type="datetime-local">, using
// the browser's local timezone.
function isoToLocalInput(iso: string): string {
  if (!iso) return "";
  // Already in datetime-local format (no Z, no offset) — pass through.
  if (!/Z|[+-]\d\d:?\d\d$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const inputClass =
  "w-full rounded-lg bg-white/5 px-3 py-2 text-sm ring-1 ring-white/10 placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-500)]";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4 rounded-2xl bg-white/[0.02] p-5 ring-1 ring-white/5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">{title}</h2>
      {children}
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-white/80">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-white/40">{hint}</span>}
    </label>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-sm transition ${
        active ? "bg-white/10 text-white" : "text-white/60 hover:bg-white/5"
      }`}
    >
      {children}
    </button>
  );
}
