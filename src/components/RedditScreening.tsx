"use client";

// Client pieces of the Reddit sourcing-screen page:
//   - RedditScreenConfig: on/off, screened subreddits, lookback, alert
//     channel, and mod notes (PATCH /reddit-screening).
//   - RedditScreenQueue: one card per flagged user with the assessment,
//     evidence links, flagged items, draft message, and decision buttons
//     (POST /reddit-screening/users/[username]).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SubredditListEditor } from "@/components/SubredditListEditor";
import { LocalTime } from "@/components/LocalTime";
import { CopyButton } from "@/components/CopyButton";
import { SCREEN_LABEL, SCREEN_RECO, UNASSESSED } from "@/components/reddit-screen-meta";
import type { ScreenEvidence, ScreenVerdict } from "@/lib/reddit-screen";

const LOOKBACKS = [0, 1, 7, 30, 90];

export function RedditScreenConfig({
  guildId,
  initial,
  channels,
  oauthReady,
  apiKeyReady,
}: {
  guildId: string;
  initial: {
    enabled: boolean;
    subreddits: string[];
    since: string | null;
    alertChannelId: string;
    notes: string;
  };
  channels: { id: string; name: string }[];
  oauthReady: boolean;
  apiKeyReady: boolean;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [subs, setSubs] = useState(initial.subreddits);
  const [alertChannelId, setAlertChannelId] = useState(initial.alertChannelId);
  const [notes, setNotes] = useState(initial.notes);
  const [lookbackDays, setLookbackDays] = useState(7);
  const [applyLookback, setApplyLookback] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/guilds/${guildId}/reddit-screening`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          subreddits: subs,
          alertChannelId: alertChannelId || null,
          notes: notes || null,
          lookbackDays,
          applyLookback,
        }),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "Save failed.");
      setApplyLookback(false);
      setMsg(enabled ? "Saved. The bot picks this up within a minute." : "Saved. Screening is off.");
      router.refresh();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const showLookback = enabled && (!initial.enabled || applyLookback);

  return (
    <div className="rounded-2xl bg-white/[0.02] p-5 ring-1 ring-white/10">
      <label className="flex items-center gap-2 text-sm font-medium text-white/85">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Screen these subreddits for sourcing
      </label>

      <div className="mt-4">
        <SubredditListEditor
          label="Screened subreddits"
          hint="New posts and comments here are collected and screened. Their full history is backfilled too, which gives the per-user assessments more context."
          placeholder="quittingcatsclaw"
          list={subs}
          setList={setSubs}
        />
      </div>

      {!apiKeyReady && (
        <p className="mt-2 text-xs text-amber-200/80">
          ANTHROPIC_API_KEY is not set. Screening stays paused until it is.
        </p>
      )}
      {!oauthReady && (
        <p className="mt-2 text-xs text-amber-200/80">
          REDDIT_CLIENT_ID/SECRET are not set, so only posts get screened.
          Comments need the OAuth reader.
        </p>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <span className="block text-xs font-medium text-white/70">Start from</span>
          {initial.enabled && initial.since && !applyLookback ? (
            <p className="mt-1 text-xs text-white/55">
              Screening items posted since <LocalTime iso={initial.since} />.{" "}
              <button
                type="button"
                onClick={() => setApplyLookback(true)}
                className="text-white/75 underline hover:text-white"
              >
                Change
              </button>
            </p>
          ) : (
            <select
              value={lookbackDays}
              onChange={(e) => setLookbackDays(Number(e.target.value))}
              disabled={!showLookback}
              className="mt-1 w-full rounded-lg bg-black/30 px-2.5 py-1.5 text-sm text-white/90 ring-1 ring-white/10 disabled:opacity-50"
            >
              {LOOKBACKS.map((d) => (
                <option key={d} value={d}>
                  {d === 0 ? "Now (new content only)" : `${d} day${d > 1 ? "s" : ""} back`}
                </option>
              ))}
            </select>
          )}
          <p className="mt-1 text-[11px] text-white/40">
            Already-collected items in this window get screened. Nothing is
            ever screened twice.
          </p>
        </div>
        <div>
          <span className="block text-xs font-medium text-white/70">Alert channel</span>
          <select
            value={alertChannelId}
            onChange={(e) => setAlertChannelId(e.target.value)}
            className="mt-1 w-full rounded-lg bg-black/30 px-2.5 py-1.5 text-sm text-white/90 ring-1 ring-white/10"
          >
            <option value="">No Discord alerts</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-white/40">
            Pick a private mod channel. It gets ban and warn recommendations
            plus possible crisis signals.
          </p>
        </div>
      </div>

      <div className="mt-4">
        <span className="block text-xs font-medium text-white/70">Notes for the screen</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          maxLength={4000}
          placeholder={"e.g. Plain-leaf taper questions are allowed here.\nVendor names are always removed, even in warnings."}
          className="mt-1 w-full rounded-lg bg-black/30 px-2.5 py-1.5 text-sm text-white/90 ring-1 ring-white/10 placeholder:text-white/25 focus:outline-none focus:ring-white/25"
        />
        <p className="mt-1 text-[11px] text-white/40">
          Your sub&apos;s rules and slang. Both the item screen and the user
          assessments follow these notes over their defaults.
        </p>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="rounded-lg bg-[color:var(--color-brand-600)] px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {msg && <span className="text-xs text-white/50">{msg}</span>}
      </div>
    </div>
  );
}

export type QueueItem = {
  id: string;
  kind: string;
  subreddit: string;
  label: string;
  confidence: string;
  recoveryIntent: boolean;
  reason: string;
  evidence: string;
  permalink: string;
  createdAt: string;
};

export type QueueUser = {
  username: string;
  displayName: string;
  status: string;
  flagCount: number;
  lastFlaggedAt: string | null;
  recommendation: string | null;
  confidence: string | null;
  verdict: ScreenVerdict | null;
  verdictAt: string | null;
  assessPending: boolean;
  assessError: string | null;
  itemsAnalyzed: number;
  decidedAt: string | null;
  items: QueueItem[];
};

type Action = "banned" | "watching" | "dismissed" | "open" | "reassess";

export function RedditScreenQueue({
  guildId,
  users,
  subreddits,
}: {
  guildId: string;
  users: QueueUser[];
  subreddits: string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(username: string, action: Action) {
    setBusy(username);
    setError(null);
    try {
      const res = await fetch(
        `/api/guilds/${guildId}/reddit-screening/users/${encodeURIComponent(username)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        }
      );
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? "Action failed.");
      }
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-xs text-red-300">{error}</p>}
      {users.map((u) => (
        <UserCard
          key={u.username}
          user={u}
          subreddits={subreddits}
          busy={busy === u.username}
          onAction={(a) => void act(u.username, a)}
        />
      ))}
    </div>
  );
}

function UserCard({
  user: u,
  subreddits,
  busy,
  onAction,
}: {
  user: QueueUser;
  subreddits: string[];
  busy: boolean;
  onAction: (a: Action) => void;
}) {
  const [showItems, setShowItems] = useState(false);
  const reco = u.recommendation ? SCREEN_RECO[u.recommendation] : null;
  const v = u.verdict;
  // Default ban target: the sub with the most flagged items.
  const banSub =
    Object.entries(
      u.items.reduce<Record<string, number>>((m, it) => {
        m[it.subreddit] = (m[it.subreddit] ?? 0) + 1;
        return m;
      }, {})
    ).sort((a, b) => b[1] - a[1])[0]?.[0] ?? subreddits[0];

  const btn =
    "rounded-md px-2 py-1 text-xs ring-1 ring-white/10 text-white/60 hover:bg-white/5 disabled:opacity-50";

  return (
    <div className="rounded-2xl bg-white/[0.02] p-4 ring-1 ring-white/10">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={`https://www.reddit.com/user/${encodeURIComponent(u.displayName)}`}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-white/90 hover:underline"
        >
          u/{u.displayName}
        </a>
        <span
          className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ${reco?.badge ?? UNASSESSED.badge}`}
          title={reco?.blurb}
        >
          {reco?.label ?? UNASSESSED.label}
        </span>
        {u.confidence && (
          <span className="text-[11px] text-white/45">{u.confidence} confidence</span>
        )}
        {v?.crisisFlag && (
          <span className="rounded-md bg-sky-400/15 px-1.5 py-0.5 text-[11px] text-sky-200 ring-1 ring-sky-400/25">
            ⚠ crisis signal
          </span>
        )}
        <span className="ml-auto text-[11px] text-white/40">
          {u.flagCount} flag{u.flagCount === 1 ? "" : "s"}
          {u.lastFlaggedAt && (
            <>
              {" "}
              · last <LocalTime iso={u.lastFlaggedAt} />
            </>
          )}
        </span>
      </div>

      {u.assessPending && (
        <p className="mt-2 text-xs text-white/45">
          Assessment queued. It runs within a few minutes.
        </p>
      )}
      {u.assessError && !u.assessPending && (
        <p className="mt-2 text-xs text-red-300/80">Last assessment failed: {u.assessError}</p>
      )}

      {v && (
        <div className="mt-3 space-y-3 text-sm">
          <p className="text-white/75">{v.summary}</p>
          {v.crisisFlag && v.crisisNote && (
            <p className="rounded-lg bg-sky-400/[0.06] px-3 py-2 text-xs text-sky-100/80 ring-1 ring-sky-400/15">
              {v.crisisNote}
            </p>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <EvidenceList title="Argues for action" points={v.evidence} />
            <EvidenceList title="Mitigating" points={v.mitigating} />
          </div>
          {v.modNote && (
            <div className="rounded-lg bg-black/20 p-3 ring-1 ring-white/10">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-white/45">
                  Draft message
                </span>
                <CopyButton text={v.modNote} />
              </div>
              <p className="whitespace-pre-wrap text-xs text-white/70">{v.modNote}</p>
            </div>
          )}
          {u.verdictAt && (
            <p className="text-[11px] text-white/35">
              Assessed <LocalTime iso={u.verdictAt} /> from {u.itemsAnalyzed} item
              {u.itemsAnalyzed === 1 ? "" : "s"}. This is decision support. Check
              the linked posts before acting.
            </p>
          )}
        </div>
      )}

      {u.items.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowItems((s) => !s)}
            className="text-xs text-white/55 hover:text-white/80"
          >
            {showItems ? "▾" : "▸"} {u.items.length} flagged item{u.items.length === 1 ? "" : "s"}
          </button>
          {showItems && (
            <ul className="mt-2 space-y-2">
              {u.items.map((it) => (
                <li key={it.id} className="text-xs">
                  <span
                    className={`mr-1.5 rounded px-1 py-0.5 text-[10px] ring-1 ${SCREEN_LABEL[it.label]?.badge ?? SCREEN_LABEL.ok.badge}`}
                  >
                    {SCREEN_LABEL[it.label]?.label ?? it.label}
                  </span>
                  {it.recoveryIntent && (
                    <span className="mr-1.5 text-[10px] text-sky-200/70">recovery intent</span>
                  )}
                  <a
                    href={it.permalink}
                    target="_blank"
                    rel="noreferrer"
                    className="text-white/75 hover:underline"
                  >
                    “{it.evidence || "(no quote)"}”
                  </a>
                  <span className="text-white/35">
                    {" "}
                    · r/{it.subreddit} {it.kind} · <LocalTime iso={it.createdAt} />
                  </span>
                  <div className="mt-0.5 text-white/45">{it.reason}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        {banSub && (
          <a
            href={`https://www.reddit.com/r/${encodeURIComponent(banSub)}/about/banned`}
            target="_blank"
            rel="noreferrer"
            className="rounded-md bg-red-500/80 px-2 py-1 text-xs font-medium text-white hover:bg-red-500"
            title="Open the subreddit's ban list on reddit (mod tools)"
          >
            Ban on reddit ↗
          </a>
        )}
        {u.status !== "banned" && (
          <button type="button" disabled={busy} onClick={() => onAction("banned")} className={btn}>
            Mark banned
          </button>
        )}
        {u.status !== "watching" && (
          <button type="button" disabled={busy} onClick={() => onAction("watching")} className={btn}>
            Watch
          </button>
        )}
        {u.status !== "dismissed" && (
          <button type="button" disabled={busy} onClick={() => onAction("dismissed")} className={btn}>
            Dismiss
          </button>
        )}
        {u.status !== "open" && (
          <button type="button" disabled={busy} onClick={() => onAction("open")} className={btn}>
            Reopen
          </button>
        )}
        <button
          type="button"
          disabled={busy || u.assessPending}
          onClick={() => onAction("reassess")}
          className={`${btn} ml-auto`}
        >
          {u.verdict ? "Re-assess" : "Assess now"}
        </button>
      </div>
    </div>
  );
}

function EvidenceList({ title, points }: { title: string; points: ScreenEvidence[] }) {
  return (
    <div>
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-white/45">{title}</h3>
      {points.length === 0 ? (
        <p className="mt-1 text-xs text-white/35">None noted.</p>
      ) : (
        <ul className="mt-1 space-y-1.5">
          {points.map((p, i) => (
            <li key={i} className="text-xs text-white/70">
              <span className="text-white/85">{p.point}</span>
              {p.quote && (
                <>
                  {" "}
                  {p.permalink ? (
                    <a
                      href={p.permalink}
                      target="_blank"
                      rel="noreferrer"
                      className="text-white/55 hover:underline"
                    >
                      “{p.quote}”
                    </a>
                  ) : (
                    <span className="text-white/55">“{p.quote}”</span>
                  )}
                </>
              )}
              {p.date && <span className="text-white/35"> · {p.date}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
