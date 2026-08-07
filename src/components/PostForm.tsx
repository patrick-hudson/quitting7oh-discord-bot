"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChannelPicker } from "./ChannelPicker";
import { DiscordPreview } from "./DiscordPreview";
import { REMINDER_TEMPLATES } from "@/lib/reminder-templates";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CronHint } from "@/components/CronHint";

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
  // Anti-spam: skip a scheduled fire if the last post is still within the
  // channel's most recent N messages. null = always post.
  skipIfRecentWithin: number | null;
  // Reminder follow-up sent as a plain-text reply to the original message.
  // null = off. Must be 1..(leadMinutes - 1) when set.
  reminderMinutes: number | null;
  // Empty string = use the baked-in default roster on the bot side.
  reminderContent: string;
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
  initiallyDirty = false,
}: {
  guildId: string;
  initial?: Partial<PostFormValues>;
  guildTimezone: string;
  // True when `initial` is an imported starter (not a saved post) — the form
  // counts as dirty from the start so it can be saved without further edits.
  initiallyDirty?: boolean;
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
    skipIfRecentWithin: null,
    reminderMinutes: null,
    reminderContent: "",
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
  const [saving, setSaving] = useState<"stay" | "return" | null>(null);
  // Lead-time confirmation: when a user lowers leadMinutes such that the
  // currently-enabled reminder can no longer fire (reminderMinutes >= leadMinutes),
  // we ask before clearing it. `leadOnFocusRef` snapshots the value at focus so
  // Cancel can revert. The check fires on blur — not onChange — so typing "15"
  // doesn't briefly open a modal while passing through "1".
  const leadOnFocusRef = useRef<number>(initial?.leadMinutes ?? 0);
  const [leadConfirmOpen, setLeadConfirmOpen] = useState(false);
  // For the "Wrap in ansi block" toolbar action — needs the textarea node
  // to read selection start/end and to restore cursor after the value update.
  const contentTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  function wrapContentInAnsiBlock() {
    const ta = contentTextareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const before = values.content.slice(0, start);
    const selected = values.content.slice(start, end);
    const after = values.content.slice(end);
    const opener = "```ansi\n";
    const closer = "\n```";
    const insertion = selected ? opener + selected + closer : opener + closer;
    set("content", before + insertion + after);
    // React needs a tick to flush the new value into the textarea; restore
    // selection on the next frame so the cursor lands inside the block.
    requestAnimationFrame(() => {
      ta.focus();
      const innerStart = start + opener.length;
      const innerEnd = innerStart + selected.length;
      ta.setSelectionRange(innerStart, innerEnd);
    });
  }
  const [isDirty, setIsDirty] = useState(initiallyDirty);
  const [toast, setToast] = useState<{
    message: string;
    id: number;
    visible: boolean;
  } | null>(null);

  function showToast(message: string) {
    const id = Date.now();
    setToast({ message, id, visible: true });
    // Fade out, then unmount.
    setTimeout(() => {
      setToast((c) => (c?.id === id ? { ...c, visible: false } : c));
    }, 1800);
    setTimeout(() => {
      setToast((c) => (c?.id === id ? null : c));
    }, 2200);
  }

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
    setIsDirty(true);
  }

  async function save(mode: "stay" | "return") {
    setError(null);
    if (values.channelIds.length === 0) {
      setError("Pick at least one channel.");
      return;
    }
    setSaving(mode);
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
    if (!res.ok) {
      setSaving(null);
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? `Failed (${res.status})`);
      return;
    }

    showToast("Saved");

    if (mode === "return") {
      // Brief delay so the toast is visible before we navigate away.
      setTimeout(() => {
        router.push(`/dashboard/${guildId}/posts`);
        router.refresh();
      }, 600);
      return;
    }

    // Save and stay: for a new post, route to its edit page so further
    // saves update instead of creating duplicates. For an existing post,
    // just refresh in place.
    if (!initial?.id) {
      const data = await res.json().catch(() => ({}));
      const newId = data?.post?.id;
      if (newId) {
        setTimeout(() => {
          router.push(`/dashboard/${guildId}/posts/${newId}`);
          router.refresh();
        }, 600);
        return;
      }
    }
    setSaving(null);
    setIsDirty(false);
    router.refresh();
  }

  function onSubmit(e: React.FormEvent) {
    // Default submit (Enter key) acts as "save and return".
    e.preventDefault();
    void save("return");
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
            <Field label="Cron expression">
              <input
                value={values.cron}
                onChange={(e) => set("cron", e.target.value)}
                placeholder="0 19 * * 0"
                className={`${inputClass} font-mono`}
              />
              <CronHint expr={values.cron} showLegend />
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

        {values.scheduleKind === "cron" && (
          <div className="rounded-lg bg-white/[0.03] px-3 py-2 ring-1 ring-white/5">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={values.skipIfRecentWithin !== null}
                onChange={(e) =>
                  set("skipIfRecentWithin", e.target.checked ? 25 : null)
                }
              />
              Skip if still in recent messages
            </label>
            {values.skipIfRecentWithin !== null && (
              <div className="mt-2 flex items-center gap-2 text-sm">
                <span className="text-white/60">Don&apos;t repost if it&apos;s within the last</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={values.skipIfRecentWithin}
                  onChange={(e) =>
                    set(
                      "skipIfRecentWithin",
                      Math.min(100, Math.max(1, Number(e.target.value) || 1))
                    )
                  }
                  className={`${inputClass} w-20`}
                />
                <span className="text-white/60">messages of the channel.</span>
              </div>
            )}
            <p className="mt-1 text-xs text-white/40">
              For repetitive posts (like a scam warning) in quiet channels — the
              scheduled post is skipped while the previous one is still on screen.
              &quot;Fire now&quot; always posts regardless.
            </p>
          </div>
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
          <div className="mb-1 flex justify-end">
            <button
              type="button"
              onClick={wrapContentInAnsiBlock}
              title="Wrap the selected text in a ```ansi``` color block (or insert an empty one at the cursor)"
              className="rounded-md bg-white/5 px-2 py-1 font-mono text-[11px] text-white/60 ring-1 ring-white/10 hover:bg-white/10 hover:text-white"
            >
              ```ansi
            </button>
          </div>
          <textarea
            ref={contentTextareaRef}
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
          <p className="mt-2 text-xs text-white/40">
            Color tokens (inside a <code className="text-white/60">```ansi</code> code
            block):{" "}
            <code className="text-white/60">{`{red} {green} {yellow} {blue} {pink} {cyan} {gray} {white} {bold} {underline} {reset}`}</code>
            . Example:
            <code className="ml-1 text-white/60">{`{bold}{red}🚨 ALERT{reset}`}</code>
          </p>
        </Field>

        <Field label="Lead time (minutes before meeting)">
          <input
            type="number"
            min={0}
            max={1440}
            value={values.leadMinutes}
            onFocus={() => {
              leadOnFocusRef.current = values.leadMinutes;
            }}
            onChange={(e) =>
              set("leadMinutes", Math.max(0, Number(e.target.value) || 0))
            }
            onBlur={() => {
              if (
                values.reminderMinutes !== null &&
                values.leadMinutes <= values.reminderMinutes
              ) {
                setLeadConfirmOpen(true);
              }
            }}
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

      <Section title="Follow-up reminder">
        <div className="flex items-center gap-3 rounded-lg bg-white/[0.03] px-3 py-2 ring-1 ring-white/5">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={values.reminderMinutes !== null}
              // Only block ENABLING — unchecking is always allowed so a user
              // who lowers leadMinutes after enabling can still turn it off.
              disabled={
                values.reminderMinutes === null && values.leadMinutes < 2
              }
              onChange={(e) => {
                if (e.target.checked) {
                  // Default to 5 min, or half of leadMinutes if smaller (so it
                  // satisfies the < leadMinutes constraint out of the box).
                  const initial = Math.min(5, Math.max(1, values.leadMinutes - 1));
                  set("reminderMinutes", initial);
                } else {
                  set("reminderMinutes", null);
                  set("reminderContent", "");
                }
              }}
            />
            Send a plain-text reminder before the meeting
          </label>
          <p className="ml-auto text-xs text-white/40">
            {values.leadMinutes < 2
              ? "Set lead time ≥ 2 min to enable"
              : "Replies to the original message"}
          </p>
        </div>

        {values.reminderMinutes !== null && (
          <>
            <Field label="Fire reminder this many minutes before the meeting">
              <input
                type="number"
                min={1}
                max={Math.max(1, values.leadMinutes - 1)}
                value={values.reminderMinutes}
                onChange={(e) =>
                  set("reminderMinutes", Math.max(1, Number(e.target.value) || 1))
                }
                className={inputClass}
              />
              <p className="mt-1 text-xs text-white/40">
                Must be smaller than the lead time ({values.leadMinutes} min) — otherwise
                the reminder would fire before the original post.
              </p>
            </Field>

            <Field
              label="Reminder text (optional)"
              hint="Leave blank to use a random pick from the bot's baked-in roster. Same {meetingTime} placeholders as the body."
            >
              <textarea
                value={values.reminderContent}
                onChange={(e) => set("reminderContent", e.target.value)}
                rows={3}
                placeholder={REMINDER_TEMPLATES[0]}
                className={inputClass}
              />
            </Field>
          </>
        )}
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

        {values.reminderMinutes !== null && (
          <div className="mt-4">
            <p className="mb-2 text-xs text-white/40">
              Follow-up reminder — posts as a plain-text reply{" "}
              {values.reminderMinutes} min before the meeting.
              {!values.reminderContent.trim() &&
                " Text is a random pick from the bot's roster; one example shown."}
            </p>
            <div className="border-l-2 border-white/10 pl-3">
              <DiscordPreview
                useEmbed={false}
                content={values.reminderContent.trim() || REMINDER_TEMPLATES[0]}
                embedTitle=""
                embedColor=""
                embedUrl=""
                embedImage=""
                mentionRoleId=""
                leadMinutes={values.reminderMinutes}
                roles={roles}
                channels={channels}
              />
            </div>
          </div>
        )}
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
        <Link
          href={`/dashboard/${guildId}/posts`}
          className="rounded-lg px-4 py-2 text-sm text-white/70 hover:bg-white/5"
        >
          Cancel
        </Link>
        <button
          type="button"
          onClick={() => void save("stay")}
          disabled={saving !== null || !isDirty}
          className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15 disabled:cursor-not-allowed disabled:bg-white/5 disabled:text-white/40 disabled:hover:bg-white/5"
        >
          {saving === "stay" ? "Saving…" : "Save"}
        </button>
        <button
          type="submit"
          disabled={saving !== null || !isDirty}
          className="rounded-lg bg-[color:var(--color-brand-600)] px-4 py-2 text-sm font-medium hover:bg-[color:var(--color-brand-500)] disabled:cursor-not-allowed disabled:bg-white/5 disabled:text-white/40 disabled:hover:bg-white/5"
        >
          {saving === "return"
            ? "Saving…"
            : initial?.id
              ? "Save and return"
              : "Create and return"}
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

      <ConfirmDialog
        open={leadConfirmOpen}
        title="Disable the reminder?"
        description={
          <>
            A lead time of {values.leadMinutes} min can&apos;t fit the current
            reminder ({values.reminderMinutes} min before the meeting), since
            the reminder must fire <em>between</em> the post and the meeting.
            {values.reminderContent.trim().length > 0 && (
              <>
                {" "}
                Continuing will also clear the custom reminder text on this post.
              </>
            )}
          </>
        }
        confirmLabel="Disable reminder"
        destructive
        onCancel={() => {
          set("leadMinutes", leadOnFocusRef.current);
          setLeadConfirmOpen(false);
        }}
        onConfirm={() => {
          set("reminderMinutes", null);
          set("reminderContent", "");
          setLeadConfirmOpen(false);
        }}
      />
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
