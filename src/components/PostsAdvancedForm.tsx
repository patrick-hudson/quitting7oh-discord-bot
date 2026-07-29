"use client";

// Bulk editor for scheduled posts: one always-open card per post with the
// commonly-edited fields visible inline (name, schedule, channels, lead,
// reminder, mention, active, content) plus an "Embed options" expander for the
// embed-specific fields. Saves via the same per-post PATCH endpoint as the
// single-post edit form; only dirty rows are sent on Save all.

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChannelPicker } from "./ChannelPicker";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CronHint } from "@/components/CronHint";

type Channel = { id: string; name: string; parent_id: string | null };
type Role = { id: string; name: string; color: number };

export type PostRowValues = {
  id: string;
  name: string;
  channelIds: string[];
  scheduleKind: "cron" | "oneoff";
  cron: string;
  runAt: string; // ISO from server; converted to datetime-local on mount
  timezone: string;
  useEmbed: boolean;
  content: string;
  embedTitle: string;
  embedColor: string;
  embedUrl: string;
  embedImage: string;
  mentionRoleId: string;
  leadMinutes: number;
  reminderMinutes: number | null;
  reminderContent: string;
  active: boolean;
};

type RowStatus = { state: "idle" | "saving" | "saved" | "error"; error?: string };

export function PostsAdvancedForm({
  guildId,
  initialPosts,
  channels,
  roles,
}: {
  guildId: string;
  initialPosts: PostRowValues[];
  channels: Channel[];
  roles: Role[];
}) {
  const router = useRouter();
  const [posts, setPosts] = useState<PostRowValues[]>(() =>
    initialPosts.map((p) => ({
      ...p,
      runAt: p.runAt ? isoToLocalInput(p.runAt) : "",
    }))
  );
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Record<string, RowStatus>>({});
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [expandedChannels, setExpandedChannels] = useState<Set<string>>(new Set());
  const [expandedEmbed, setExpandedEmbed] = useState<Set<string>>(new Set());
  // Per-post focus-time snapshot of leadMinutes (keyed by post id), so a
  // cancelled confirmation can revert the lead value the user just typed.
  // Single shared confirmation state — at most one open at a time since the
  // user can only be editing one input at a moment.
  const leadOnFocusRef = useRef<Record<string, number>>({});
  const [leadConfirm, setLeadConfirm] = useState<{ postId: string } | null>(null);

  function update(id: string, patch: Partial<PostRowValues>) {
    setPosts((arr) => arr.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    setDirty((s) => {
      const next = new Set(s);
      next.add(id);
      return next;
    });
    // Clear the "saved"/"error" badge as soon as the user edits again.
    setStatuses((m) => (m[id] ? { ...m, [id]: { state: "idle" } } : m));
  }

  function toggleSet(setter: typeof setExpandedChannels, id: string) {
    setter((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return posts;
    return posts.filter((p) => p.name.toLowerCase().includes(q));
  }, [posts, filter]);

  async function saveAll() {
    if (dirty.size === 0) return;
    setSaving(true);
    const ids = Array.from(dirty);
    setStatuses((m) => {
      const next = { ...m };
      for (const id of ids) next[id] = { state: "saving" };
      return next;
    });

    const results = await Promise.all(
      ids.map(async (id) => {
        const post = posts.find((p) => p.id === id);
        if (!post) return { id, ok: true as const };
        const payload = {
          name: post.name,
          channelIds: post.channelIds,
          scheduleKind: post.scheduleKind,
          cron: post.cron,
          // datetime-local is timezone-naive; convert to ISO so the server
          // stores the moment the user actually meant.
          runAt:
            post.scheduleKind === "oneoff" && post.runAt
              ? new Date(post.runAt).toISOString()
              : "",
          timezone: post.timezone,
          useEmbed: post.useEmbed,
          content: post.content,
          embedTitle: post.embedTitle,
          embedColor: post.embedColor,
          embedUrl: post.embedUrl,
          embedImage: post.embedImage,
          mentionRoleId: post.mentionRoleId,
          leadMinutes: post.leadMinutes,
          reminderMinutes: post.reminderMinutes,
          reminderContent: post.reminderContent,
          active: post.active,
        };
        const res = await fetch(`/api/guilds/${guildId}/posts/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          return { id, ok: false as const, error: d.error ?? `HTTP ${res.status}` };
        }
        return { id, ok: true as const };
      })
    );

    setSaving(false);
    setDirty((prev) => {
      const next = new Set(prev);
      for (const r of results) if (r.ok) next.delete(r.id);
      return next;
    });
    setStatuses((prev) => {
      const next = { ...prev };
      for (const r of results) {
        next[r.id] = r.ok ? { state: "saved" } : { state: "error", error: r.error };
      }
      return next;
    });
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-10 -mx-1 flex items-center gap-3 rounded-xl bg-neutral-950/85 px-3 py-2 backdrop-blur ring-1 ring-white/10">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name…"
          className="min-w-0 flex-1 rounded-md bg-white/5 px-2 py-1 text-sm ring-1 ring-white/10 placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-500)]"
        />
        <span className="text-xs text-white/40">
          {dirty.size === 0
            ? `${posts.length} post${posts.length === 1 ? "" : "s"}`
            : `${dirty.size} unsaved`}
        </span>
        <button
          type="button"
          onClick={() => void saveAll()}
          disabled={saving || dirty.size === 0}
          className="rounded-lg bg-[color:var(--color-brand-600)] px-4 py-1.5 text-sm font-medium hover:bg-[color:var(--color-brand-500)] disabled:cursor-not-allowed disabled:bg-white/5 disabled:text-white/40"
        >
          {saving ? "Saving…" : dirty.size === 0 ? "All saved" : `Save ${dirty.size}`}
        </button>
      </div>

      {filtered.length === 0 && (
        <div className="rounded-2xl bg-white/[0.02] p-4 text-sm text-white/60 ring-1 ring-white/5">
          {posts.length === 0 ? "No scheduled posts yet." : "No posts match that filter."}
        </div>
      )}

      {filtered.map((p, i) => {
        const isDirty = dirty.has(p.id);
        const st = statuses[p.id];
        const isChOpen = expandedChannels.has(p.id);
        const isEmbedOpen = expandedEmbed.has(p.id);
        return (
          <section
            key={p.id}
            className={`space-y-3 rounded-2xl bg-white/[0.02] p-4 ring-1 ${
              isDirty ? "ring-amber-500/40" : "ring-white/5"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs text-white/40">#{i + 1}</span>
              <input
                value={p.name}
                onChange={(e) => update(p.id, { name: e.target.value })}
                className="min-w-0 flex-1 rounded-md bg-white/5 px-2 py-1 text-sm font-medium text-white ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-500)]"
              />
              <label className="flex items-center gap-1 text-xs text-white/70">
                <input
                  type="checkbox"
                  checked={p.active}
                  onChange={(e) => update(p.id, { active: e.target.checked })}
                />
                active
              </label>
              <RowBadge status={st?.state ?? "idle"} error={st?.error} dirty={isDirty} />
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <div className="flex gap-1">
                  <Tab
                    active={p.scheduleKind === "cron"}
                    onClick={() => update(p.id, { scheduleKind: "cron" })}
                  >
                    Cron
                  </Tab>
                  <Tab
                    active={p.scheduleKind === "oneoff"}
                    onClick={() => update(p.id, { scheduleKind: "oneoff" })}
                  >
                    One-off
                  </Tab>
                </div>
                {p.scheduleKind === "cron" ? (
                  <>
                    <input
                      value={p.cron}
                      onChange={(e) => update(p.id, { cron: e.target.value })}
                      placeholder="0 19 * * 0"
                      className={`${inputCls} font-mono`}
                    />
                    <CronHint expr={p.cron} />
                    <input
                      value={p.timezone}
                      onChange={(e) => update(p.id, { timezone: e.target.value })}
                      placeholder="America/New_York"
                      className={inputCls}
                    />
                  </>
                ) : (
                  <input
                    type="datetime-local"
                    value={p.runAt}
                    onChange={(e) => update(p.id, { runAt: e.target.value })}
                    className={inputCls}
                  />
                )}
              </div>

              <div className="space-y-2">
                <div className="rounded-md bg-white/[0.03] px-2 py-1.5 ring-1 ring-white/5">
                  <button
                    type="button"
                    onClick={() => toggleSet(setExpandedChannels, p.id)}
                    className="flex w-full items-center justify-between text-left text-xs text-white/70 hover:text-white"
                  >
                    <span>Channels: {channelSummary(p.channelIds, channels)}</span>
                    <span className="text-white/40">{isChOpen ? "▾" : "▸"}</span>
                  </button>
                  {isChOpen && (
                    <div className="mt-2">
                      <ChannelPicker
                        channels={channels}
                        selectedIds={p.channelIds}
                        onChange={(next) => update(p.id, { channelIds: next })}
                      />
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label>Mention</Label>
                    <select
                      value={p.mentionRoleId}
                      onChange={(e) => update(p.id, { mentionRoleId: e.target.value })}
                      className={inputCls}
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
                  </div>
                  <div>
                    <Label>Lead (min)</Label>
                    <input
                      type="number"
                      min={0}
                      max={1440}
                      value={p.leadMinutes}
                      onFocus={() => {
                        leadOnFocusRef.current[p.id] = p.leadMinutes;
                      }}
                      onChange={(e) =>
                        update(p.id, { leadMinutes: Math.max(0, Number(e.target.value) || 0) })
                      }
                      onBlur={() => {
                        if (
                          p.reminderMinutes !== null &&
                          p.leadMinutes <= p.reminderMinutes
                        ) {
                          setLeadConfirm({ postId: p.id });
                        }
                      }}
                      className={inputCls}
                    />
                  </div>
                </div>

                <div className="rounded-md bg-white/[0.03] px-2 py-1.5 ring-1 ring-white/5">
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-white/80">
                    <input
                      type="checkbox"
                      checked={p.reminderMinutes !== null}
                      // Only block ENABLING — unchecking is always allowed.
                      disabled={p.reminderMinutes === null && p.leadMinutes < 2}
                      onChange={(e) => {
                        if (e.target.checked) {
                          const initial = Math.min(5, Math.max(1, p.leadMinutes - 1));
                          update(p.id, { reminderMinutes: initial });
                        } else {
                          update(p.id, { reminderMinutes: null, reminderContent: "" });
                        }
                      }}
                    />
                    Reminder
                    {p.reminderMinutes !== null && (
                      <span className="text-white/40">— {p.reminderMinutes} min before</span>
                    )}
                    {p.reminderMinutes === null && p.leadMinutes < 2 && (
                      <span className="ml-auto text-[10px] text-white/30">lead ≥ 2 to enable</span>
                    )}
                  </label>
                  {p.reminderMinutes !== null && (
                    <div className="mt-2 space-y-1.5">
                      <input
                        type="number"
                        min={1}
                        max={Math.max(1, p.leadMinutes - 1)}
                        value={p.reminderMinutes}
                        onChange={(e) =>
                          update(p.id, {
                            reminderMinutes: Math.max(1, Number(e.target.value) || 1),
                          })
                        }
                        className={`${inputCls} w-24`}
                      />
                      <textarea
                        value={p.reminderContent}
                        onChange={(e) => update(p.id, { reminderContent: e.target.value })}
                        rows={2}
                        placeholder="Default roster used when blank"
                        className={inputCls}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div>
              <Label>{p.useEmbed ? "Embed description" : "Message content"}</Label>
              <textarea
                value={p.content}
                onChange={(e) => update(p.id, { content: e.target.value })}
                rows={5}
                className={inputCls}
              />
            </div>

            <button
              type="button"
              onClick={() => toggleSet(setExpandedEmbed, p.id)}
              className="text-xs text-white/50 hover:text-white"
            >
              {isEmbedOpen ? "▾" : "▸"} Embed options
            </button>
            {isEmbedOpen && (
              <div className="space-y-2 rounded-md bg-white/[0.02] p-2 ring-1 ring-white/5">
                <label className="flex items-center gap-2 text-xs text-white/80">
                  <input
                    type="checkbox"
                    checked={p.useEmbed}
                    onChange={(e) => update(p.id, { useEmbed: e.target.checked })}
                  />
                  Use rich embed
                </label>
                {p.useEmbed && (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label>Title</Label>
                      <input
                        value={p.embedTitle}
                        onChange={(e) => update(p.id, { embedTitle: e.target.value })}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <Label>Color</Label>
                      <input
                        type="color"
                        value={p.embedColor || "#5865F2"}
                        onChange={(e) => update(p.id, { embedColor: e.target.value })}
                        className="h-8 w-full rounded bg-white/5 ring-1 ring-white/10"
                      />
                    </div>
                    <div>
                      <Label>Link</Label>
                      <input
                        value={p.embedUrl}
                        onChange={(e) => update(p.id, { embedUrl: e.target.value })}
                        placeholder="https://…"
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <Label>Image</Label>
                      <input
                        value={p.embedImage}
                        onChange={(e) => update(p.id, { embedImage: e.target.value })}
                        placeholder="https://…"
                        className={inputCls}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}

      {(() => {
        const p = leadConfirm
          ? posts.find((x) => x.id === leadConfirm.postId)
          : null;
        return (
          <ConfirmDialog
            open={p !== null && p !== undefined}
            title="Disable the reminder?"
            description={
              p ? (
                <>
                  <span className="text-white/80">{p.name}</span>: a lead time
                  of {p.leadMinutes} min can&apos;t fit the current reminder
                  ({p.reminderMinutes} min before the meeting). Continuing will
                  disable the reminder
                  {p.reminderContent.trim().length > 0
                    ? " and clear its custom text."
                    : "."}
                </>
              ) : null
            }
            confirmLabel="Disable reminder"
            destructive
            onCancel={() => {
              if (!p) return;
              const prev = leadOnFocusRef.current[p.id];
              if (typeof prev === "number") {
                update(p.id, { leadMinutes: prev });
              }
              setLeadConfirm(null);
            }}
            onConfirm={() => {
              if (!p) return;
              update(p.id, { reminderMinutes: null, reminderContent: "" });
              setLeadConfirm(null);
            }}
          />
        );
      })()}
    </div>
  );
}

const inputCls =
  "block w-full rounded-md bg-white/5 px-2 py-1 text-sm ring-1 ring-white/10 placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-500)]";

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-0.5 text-xs text-white/50">{children}</div>;
}

function Tab({
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
      className={`rounded px-2 py-0.5 text-xs ${
        active ? "bg-white/10 text-white" : "text-white/50 hover:bg-white/5"
      }`}
    >
      {children}
    </button>
  );
}

function RowBadge({
  status,
  error,
  dirty,
}: {
  status: "idle" | "saving" | "saved" | "error";
  error?: string;
  dirty: boolean;
}) {
  if (status === "saving") return <span className="text-xs text-white/50">saving…</span>;
  if (status === "saved") return <span className="text-xs text-emerald-300">saved</span>;
  if (status === "error")
    return (
      <span className="text-xs text-red-300" title={error}>
        error
      </span>
    );
  if (dirty) return <span className="text-xs text-amber-300">unsaved</span>;
  return null;
}

function channelSummary(ids: string[], all: Channel[]): string {
  if (ids.length === 0) return "none";
  const names = ids.map((id) => all.find((c) => c.id === id)?.name ?? id);
  if (names.length <= 3) return names.map((n) => `#${n}`).join(", ");
  return `${names
    .slice(0, 2)
    .map((n) => `#${n}`)
    .join(", ")}, +${names.length - 2} more`;
}

// Convert an ISO timestamp into "YYYY-MM-DDTHH:mm" for <input type="datetime-local">,
// in the browser's local timezone. Mirrors the helper in PostForm.
function isoToLocalInput(iso: string): string {
  if (!iso) return "";
  if (!/Z|[+-]\d\d:?\d\d$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
