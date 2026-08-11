// Moderation log: human mod actions in this guild — bans, unbans, kicks,
// timeouts, and message deletions (with cached content when available).
// Server-rendered with link-based filters, mirroring the bot Audit page.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { listTextChannels } from "@/lib/discord-rest";
import { LocalTime } from "@/components/LocalTime";

const PAGE_SIZE = 100;

const FILTERS = [
  { key: "", label: "All" },
  { key: "ban", label: "Bans" },
  { key: "unban", label: "Unbans" },
  { key: "kick", label: "Kicks" },
  { key: "timeout", label: "Timeouts" },
  { key: "message_delete", label: "Deleted messages" },
  { key: "message_bulk_delete", label: "Bulk deletes" },
] as const;

const KIND_LABELS: Record<string, { label: string; tone: string }> = {
  ban: { label: "banned", tone: "text-red-300" },
  unban: { label: "unbanned", tone: "text-emerald-300" },
  kick: { label: "kicked", tone: "text-red-300" },
  timeout: { label: "timed out", tone: "text-amber-300" },
  timeout_removed: { label: "timeout removed for", tone: "text-emerald-300" },
  message_delete: { label: "deleted a message by", tone: "text-amber-300" },
  message_bulk_delete: { label: "bulk-deleted messages", tone: "text-red-300" },
};

export default async function ModLogPage({
  params,
  searchParams,
}: {
  params: Promise<{ guildId: string }>;
  searchParams: Promise<{ kind?: string; before?: string }>;
}) {
  const { guildId } = await params;
  const { kind, before } = await searchParams;

  const beforeDate = before ? new Date(before) : null;
  const [entries, channels] = await Promise.all([
    prisma.moderationLog.findMany({
      where: {
        guildId,
        // timeout filter covers both timeout + timeout_removed
        ...(kind === "timeout"
          ? { kind: { in: ["timeout", "timeout_removed"] } }
          : kind
            ? { kind }
            : {}),
        ...(beforeDate && !Number.isNaN(beforeDate.getTime())
          ? { createdAt: { lt: beforeDate } }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
    }),
    listTextChannels(guildId).catch(() => []),
  ]);
  const channelName = (id: string | null) =>
    id ? (channels.find((c) => c.id === id)?.name ?? id) : null;

  const filterHref = (k: string) =>
    k ? `/dashboard/${guildId}/mod-log?kind=${k}` : `/dashboard/${guildId}/mod-log`;
  const olderHref =
    entries.length === PAGE_SIZE
      ? `/dashboard/${guildId}/mod-log?${new URLSearchParams({
          ...(kind ? { kind } : {}),
          before: entries[entries.length - 1].createdAt.toISOString(),
        }).toString()}`
      : null;

  return (
    <div className="mx-auto max-w-7xl">
      <h1 className="text-2xl font-semibold tracking-tight">Moderation log</h1>
      <p className="mt-1 text-sm text-white/60">
        Actions taken by moderators — bans, kicks, timeouts, and message
        deletions with their content when the bot had it cached. Kept forever.
      </p>

      <div className="mt-6 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => {
          const active = (kind ?? "") === f.key;
          return (
            <Link
              key={f.key}
              href={filterHref(f.key)}
              className={`rounded-md px-2.5 py-1 text-xs ring-1 transition ${
                active
                  ? "bg-[color:var(--color-brand-600)] text-white ring-transparent"
                  : "bg-white/5 text-white/70 ring-white/10 hover:bg-white/10"
              }`}
            >
              {f.label}
            </Link>
          );
        })}
      </div>

      {entries.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-dashed border-white/10 p-12 text-center text-white/60">
          No moderation entries{kind ? " for this filter" : ""} yet.
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-white/5 overflow-hidden rounded-2xl ring-1 ring-white/10">
          {entries.map((e) => {
            const meta = KIND_LABELS[e.kind] ?? { label: e.kind, tone: "text-white/70" };
            const ch = channelName(e.channelId);
            return (
              <li key={e.id} className="bg-white/[0.02] px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                  <LocalTime
                    iso={e.createdAt.toISOString()}
                    className="shrink-0 font-mono text-[11px] text-white/40"
                  />
                  <span className="font-medium text-white/90">
                    {e.executorName ?? e.executorId ?? "Unknown / self"}
                  </span>
                  <span className={meta.tone}>{meta.label}</span>
                  {(e.targetName || e.targetId) && (
                    <span className="font-medium text-white/90">
                      {e.targetName ?? e.targetId}
                    </span>
                  )}
                  {ch && <span className="text-white/40">in #{ch}</span>}
                </div>
                {e.reason && (
                  <p className="mt-1 pl-1 text-xs text-white/60">
                    Reason: {e.reason}
                  </p>
                )}
                {e.content && (
                  <blockquote className="mt-2 rounded-md border-l-2 border-amber-500/40 bg-black/30 px-3 py-2 text-sm text-white/75">
                    {e.content}
                  </blockquote>
                )}
                {e.data != null && (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer select-none text-xs text-white/40 hover:text-white/70">
                      details
                    </summary>
                    <pre className="mt-1 overflow-x-auto rounded-md bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-white/70 ring-1 ring-white/10">
                      {JSON.stringify(e.data, null, 2)}
                    </pre>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {olderHref && (
        <div className="mt-4 flex justify-center">
          <Link
            href={olderHref}
            className="rounded-lg bg-white/5 px-4 py-2 text-sm text-white/70 ring-1 ring-white/10 hover:bg-white/10"
          >
            Older →
          </Link>
        </div>
      )}
    </div>
  );
}
