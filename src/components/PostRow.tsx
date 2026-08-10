"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { LocalTime } from "@/components/LocalTime";

type Post = {
  id: string;
  name: string;
  channelIds: string[];
  cron: string | null;
  runAt: Date | null;
  timezone: string | null;
  active: boolean;
  lastFiredAt: Date | null;
  nextFireAt: Date | null;
};

export function PostRow({
  post,
  guildId,
  channelNames,
}: {
  post: Post;
  guildId: string;
  channelNames: Record<string, string>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [active, setActive] = useState(post.active);
  // "queued" shows for a few seconds after Fire-now succeeds, then auto-clears.
  // The scheduler delivers within one poll interval (~30s); we don't try to
  // know exactly when it lands, just show that the request was accepted.
  const [fireState, setFireState] = useState<"idle" | "firing" | "queued" | "error">(
    "idle"
  );

  async function toggle() {
    const next = !active;
    setActive(next);
    const res = await fetch(`/api/guilds/${guildId}/posts/${post.id}/toggle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: next }),
    });
    if (!res.ok) setActive(!next);
    startTransition(() => router.refresh());
  }

  async function fireNow() {
    if (
      !confirm(
        `Fire "${post.name}" now? Members in its channels will see the message immediately.`
      )
    )
      return;
    setFireState("firing");
    const res = await fetch(`/api/guilds/${guildId}/posts/${post.id}/fire-now`, {
      method: "POST",
    });
    if (!res.ok) {
      setFireState("error");
      setTimeout(() => setFireState("idle"), 3000);
      return;
    }
    setFireState("queued");
    setTimeout(() => setFireState("idle"), 5000);
    startTransition(() => router.refresh());
  }

  async function remove() {
    if (!confirm(`Delete "${post.name}"? This can't be undone.`)) return;
    const res = await fetch(`/api/guilds/${guildId}/posts/${post.id}`, {
      method: "DELETE",
    });
    if (res.ok) startTransition(() => router.refresh());
  }

  return (
    <li className="flex items-center gap-4 bg-white/[0.02] px-5 py-4 hover:bg-white/[0.04]">
      <button
        onClick={toggle}
        disabled={pending}
        title={active ? "Active — click to pause" : "Paused — click to activate"}
        className={`relative h-6 w-11 shrink-0 rounded-full transition ${
          active ? "bg-emerald-500/80" : "bg-white/10"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${
            active ? "left-[22px]" : "left-0.5"
          }`}
        />
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/dashboard/${guildId}/posts/${post.id}`}
            className="truncate font-medium hover:underline"
          >
            {post.name}
          </Link>
          {post.channelIds.slice(0, 3).map((id) => (
            <span
              key={id}
              className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-white/60"
            >
              #{channelNames[id] ?? id.slice(-6)}
            </span>
          ))}
          {post.channelIds.length > 3 && (
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-white/50">
              +{post.channelIds.length - 3} more
            </span>
          )}
        </div>
        <div className="mt-0.5 text-xs text-white/50">
          {post.cron ? (
            <>
              <span className="font-mono">{post.cron}</span>
              {post.timezone && <span className="ml-2">({post.timezone})</span>}
            </>
          ) : post.runAt ? (
            <>One-off: <LocalTime iso={new Date(post.runAt).toISOString()} /></>
          ) : (
            <>No schedule set</>
          )}
          {post.nextFireAt && (
            <span className="ml-3 text-white/70">
              · next <LocalTime iso={new Date(post.nextFireAt).toISOString()} />
            </span>
          )}
          {post.lastFiredAt && (
            <span className="ml-3 text-white/40">
              · last <LocalTime iso={new Date(post.lastFiredAt).toISOString()} />
            </span>
          )}
        </div>
      </div>

      <Link
        href={`/dashboard/${guildId}/posts/${post.id}`}
        className="rounded-md px-2.5 py-1 text-xs text-white/70 ring-1 ring-white/10 hover:bg-white/5"
      >
        Edit
      </Link>
      <button
        onClick={fireNow}
        disabled={fireState === "firing" || fireState === "queued"}
        title="Send this post immediately, without affecting its schedule"
        className={`rounded-md px-2.5 py-1 text-xs ring-1 disabled:cursor-not-allowed ${
          fireState === "queued"
            ? "text-emerald-300 ring-emerald-500/30"
            : fireState === "error"
              ? "text-red-300 ring-red-500/30"
              : "text-white/70 ring-white/10 hover:bg-white/5"
        }`}
      >
        {fireState === "firing"
          ? "…"
          : fireState === "queued"
            ? "Queued ~30s"
            : fireState === "error"
              ? "Failed"
              : "Fire now"}
      </button>
      <button
        onClick={remove}
        className="rounded-md px-2.5 py-1 text-xs text-red-300/80 ring-1 ring-red-500/20 hover:bg-red-500/10"
      >
        Delete
      </button>
    </li>
  );
}
