// Audit log: every action the bot has taken in this guild, newest first.
// Server-rendered with link-based filters — ?kind=<category prefix> narrows to
// one feature area, ?before=<ISO> pages older. Rich per-row details live in an
// expandable JSON block.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { LocalTime } from "@/components/LocalTime";

const PAGE_SIZE = 100;

// Category chips — matched as a prefix against `kind` (e.g. "post" covers
// post.fired / post.manual_fired / post.fire_failed).
const CATEGORIES = [
  { key: "", label: "All" },
  { key: "post", label: "Posts" },
  { key: "reminder", label: "Reminders" },
  { key: "reddit", label: "Reddit" },
  { key: "welcome", label: "Welcome DMs" },
  { key: "leave", label: "Departures" },
  { key: "milestone", label: "Milestones" },
  { key: "export", label: "Exports" },
  { key: "snapshot", label: "Snapshots" },
  { key: "archive", label: "Archive" },
  { key: "restore", label: "Restore" },
] as const;

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ guildId: string }>;
  searchParams: Promise<{ kind?: string; before?: string }>;
}) {
  const { guildId } = await params;
  const { kind, before } = await searchParams;

  const beforeDate = before ? new Date(before) : null;
  const entries = await prisma.botAuditLog.findMany({
    where: {
      guildId,
      ...(kind ? { kind: { startsWith: kind + "." } } : {}),
      ...(beforeDate && !Number.isNaN(beforeDate.getTime())
        ? { createdAt: { lt: beforeDate } }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: PAGE_SIZE,
  });

  const filterHref = (k: string) =>
    k ? `/dashboard/${guildId}/audit?kind=${k}` : `/dashboard/${guildId}/audit`;
  const olderHref =
    entries.length === PAGE_SIZE
      ? `/dashboard/${guildId}/audit?${new URLSearchParams({
          ...(kind ? { kind } : {}),
          before: entries[entries.length - 1].createdAt.toISOString(),
        }).toString()}`
      : null;

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
      <p className="mt-1 text-sm text-white/60">
        Every action the bot takes — post fires, reminders, DMs, announcements,
        milestone claims, exports. Kept for 90 days.
      </p>

      <div className="mt-6 flex flex-wrap gap-1.5">
        {CATEGORIES.map((c) => {
          const active = (kind ?? "") === c.key;
          return (
            <Link
              key={c.key}
              href={filterHref(c.key)}
              className={`rounded-md px-2.5 py-1 text-xs ring-1 transition ${
                active
                  ? "bg-[color:var(--color-brand-600)] text-white ring-transparent"
                  : "bg-white/5 text-white/70 ring-white/10 hover:bg-white/10"
              }`}
            >
              {c.label}
            </Link>
          );
        })}
      </div>

      {entries.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-dashed border-white/10 p-12 text-center text-white/60">
          No audit entries{kind ? " for this filter" : ""} yet. Actions appear
          here as the bot takes them.
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-white/5 overflow-hidden rounded-2xl ring-1 ring-white/10">
          {entries.map((e) => (
            <li key={e.id} className="bg-white/[0.02] px-4 py-3">
              <div className="flex items-baseline gap-3">
                <StatusDot status={e.status} />
                <LocalTime
                  iso={e.createdAt.toISOString()}
                  className="shrink-0 font-mono text-[11px] text-white/40"
                />
                <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-white/50 ring-1 ring-white/10">
                  {e.kind}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-white/85">
                  {e.summary}
                </span>
              </div>
              {e.data != null && (
                <details className="mt-1.5 pl-6">
                  <summary className="cursor-pointer select-none text-xs text-white/40 hover:text-white/70">
                    details
                  </summary>
                  <pre className="mt-1 overflow-x-auto rounded-md bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-white/70 ring-1 ring-white/10">
                    {JSON.stringify(e.data, null, 2)}
                  </pre>
                </details>
              )}
            </li>
          ))}
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

function StatusDot({ status }: { status: string }) {
  const color =
    status === "error"
      ? "bg-red-400"
      : status === "warn"
        ? "bg-amber-400"
        : "bg-emerald-400/80";
  return (
    <span
      className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${color}`}
      title={status}
    />
  );
}
