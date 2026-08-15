"use client";

// Client pieces of the Reddit leaderboard page:
//   - RedditLeaderboardConfig: monitored-subreddits editor (PATCH
//     /reddit-leaderboard).
//   - RedditLeaderboardTable: contributor table with an activity ⇄ karma
//     ranking toggle, per-row "Mod review" (queues a platform=reddit AI
//     review) and Discord identity linking (PUT/DELETE /link).
// Rows come precomputed from the server component; ranking re-sorts locally.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SubredditListEditor } from "@/components/SubredditListEditor";
import { LocalTime } from "@/components/LocalTime";
import type { RedditLeaderboardRow } from "@/lib/reddit-store";

export function RedditLeaderboardConfig({
  guildId,
  initial,
  oauthReady,
}: {
  guildId: string;
  initial: string[];
  oauthReady: boolean;
}) {
  const router = useRouter();
  const [subs, setSubs] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/guilds/${guildId}/reddit-leaderboard`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subreddits: subs }),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "Save failed.");
      setMsg(
        "Saved. Live collection starts on the next poll; the Arctic Shift backfill pulls full history in the background."
      );
      router.refresh();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl bg-white/[0.02] p-5 ring-1 ring-white/10">
      <SubredditListEditor
        label="Monitored subreddits"
        hint="Posts and comments from these subs are collected for the leaderboard and for reddit AI reviews. Subs already announced or firehosed share the same fetches — no extra Reddit API cost."
        placeholder="quitting7oh"
        list={subs}
        setList={setSubs}
      />
      {!oauthReady && (
        <p className="mt-2 text-xs text-amber-200/80">
          REDDIT_CLIENT_ID/SECRET are not set — live collection covers posts
          only until the OAuth reader is configured; comments need it.
        </p>
      )}
      <div className="mt-3 flex items-center gap-2">
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

type RankMode = "activity" | "karma";

export function RedditLeaderboardTable({
  guildId,
  rows,
  links,
}: {
  guildId: string;
  rows: RedditLeaderboardRow[];
  links: Record<string, string>; // reddit username (lower) → discord user id
}) {
  const router = useRouter();
  const [mode, setMode] = useState<RankMode>("activity");
  const [busy, setBusy] = useState<string | null>(null); // author being acted on
  const [linking, setLinking] = useState<string | null>(null);
  const [linkDraft, setLinkDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const sorted = [...rows].sort((a, b) =>
    mode === "activity" ? b.total - a.total : b.karma - a.karma
  );

  async function review(author: string) {
    setBusy(author);
    setError(null);
    try {
      const res = await fetch(`/api/guilds/${guildId}/ai-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: "reddit",
          targetUserId: author,
          targetName: `u/${author}`,
        }),
      });
      const d = (await res.json().catch(() => ({}))) as {
        job?: { id: string };
        error?: string;
      };
      if (!res.ok || !d.job) throw new Error(d.error ?? "Couldn't queue the review.");
      router.push(`/dashboard/${guildId}/ai-review/${d.job.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  async function saveLink(author: string) {
    if (!/^\d{17,21}$/.test(linkDraft.trim())) {
      setError("Paste a Discord user ID (17–21 digits).");
      return;
    }
    setBusy(author);
    setError(null);
    try {
      const res = await fetch(`/api/guilds/${guildId}/reddit-leaderboard/link`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redditUsername: author,
          discordUserId: linkDraft.trim(),
        }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? "Link failed.");
      }
      setLinking(null);
      setLinkDraft("");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function unlink(author: string) {
    setBusy(author);
    setError(null);
    try {
      await fetch(
        `/api/guilds/${guildId}/reddit-leaderboard/link?redditUsername=${encodeURIComponent(author)}`,
        { method: "DELETE" }
      );
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs text-white/40">
          Karma uses settled scores (re-read once content is 6h+ old). Linked
          rows include the member&apos;s Discord history in reddit AI reviews.
        </p>
        <div className="flex shrink-0 gap-1">
          {(["activity", "karma"] as RankMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-md px-2.5 py-1 text-xs ring-1 transition ${
                mode === m
                  ? "bg-white/10 text-white/90 ring-white/20"
                  : "text-white/50 ring-white/10 hover:bg-white/5"
              }`}
            >
              Rank by {m}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="mb-2 text-xs text-red-300">{error}</p>}
      <div className="overflow-x-auto rounded-2xl ring-1 ring-white/10">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="bg-white/[0.03] text-left text-[11px] uppercase tracking-wide text-white/45">
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">Contributor</th>
              <th className="px-3 py-2 text-right">Posts</th>
              <th className="px-3 py-2 text-right">Comments</th>
              <th className="px-3 py-2 text-right">Karma</th>
              <th className="px-3 py-2 text-right">Avg</th>
              <th className="px-3 py-2 text-right">Active days</th>
              <th className="px-3 py-2 text-right">Last seen</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {sorted.map((r, i) => {
              const linked = links[r.author.toLowerCase()];
              return (
                <tr key={r.author} className="bg-white/[0.01] hover:bg-white/[0.03]">
                  <td className="px-3 py-2 tabular-nums text-white/40">{i + 1}</td>
                  <td className="px-3 py-2">
                    <a
                      href={`https://www.reddit.com/user/${encodeURIComponent(r.author)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-white/85 hover:underline"
                    >
                      u/{r.author}
                    </a>
                    {linked && (
                      <span
                        className="ml-1.5 rounded bg-[color:var(--color-brand-600)]/20 px-1 text-[10px] text-white/60"
                        title={`Linked to Discord member ${linked}`}
                      >
                        🔗 discord
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-white/70">
                    {r.posts.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-white/70">
                    {r.comments.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-white/85">
                    {r.karma.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-white/55">
                    {r.avgScore}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-white/70">
                    {r.activeDays}
                  </td>
                  <td className="px-3 py-2 text-right text-[11px] text-white/45">
                    <LocalTime iso={r.lastSeen} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    {linking === r.author ? (
                      <span className="inline-flex items-center gap-1">
                        <input
                          value={linkDraft}
                          onChange={(e) => setLinkDraft(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && void saveLink(r.author)}
                          placeholder="discord user id"
                          inputMode="numeric"
                          className="w-40 rounded-md bg-black/30 px-2 py-1 font-mono text-xs text-white/90 ring-1 ring-white/10 focus:outline-none"
                        />
                        <button
                          type="button"
                          disabled={busy === r.author}
                          onClick={() => void saveLink(r.author)}
                          className="rounded-md bg-white/10 px-2 py-1 text-xs text-white/80 hover:bg-white/15"
                        >
                          Link
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setLinking(null);
                            setLinkDraft("");
                          }}
                          className="px-1 text-xs text-white/40 hover:text-white/70"
                        >
                          ✕
                        </button>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={busy === r.author}
                          onClick={() => void review(r.author)}
                          className="rounded-md bg-[color:var(--color-brand-600)]/90 px-2 py-1 text-xs font-medium text-white hover:bg-[color:var(--color-brand-600)] disabled:opacity-60"
                        >
                          {busy === r.author ? "Queuing…" : "Mod review"}
                        </button>
                        {linked ? (
                          <button
                            type="button"
                            disabled={busy === r.author}
                            onClick={() => void unlink(r.author)}
                            title="Remove the Discord identity link"
                            className="rounded-md px-2 py-1 text-xs text-white/45 ring-1 ring-white/10 hover:bg-white/5"
                          >
                            Unlink
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setLinking(r.author);
                              setLinkDraft("");
                            }}
                            title="Link to a Discord member (their Discord history joins reddit reviews)"
                            className="rounded-md px-2 py-1 text-xs text-white/45 ring-1 ring-white/10 hover:bg-white/5"
                          >
                            Link
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
