// Structure snapshots: nightly (and manual) captures of roles, channels,
// permission overwrites, settings, emojis, and member role-assignments —
// with a diff view between any snapshot and its predecessor. The "what
// changed while I slept" page.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { LocalTime } from "@/components/LocalTime";
import { SnapshotRunner } from "@/components/SnapshotRunner";
import { diffSnapshots, type SnapshotDiff } from "@/lib/snapshot-diff";
import type { GuildSnapshotData } from "@/lib/guild-snapshot";

export default async function SnapshotsPage({
  params,
  searchParams,
}: {
  params: Promise<{ guildId: string }>;
  searchParams: Promise<{ a?: string; b?: string }>;
}) {
  const { guildId } = await params;
  const { a, b } = await searchParams;

  const snapshots = await prisma.guildSnapshot.findMany({
    where: { guildId },
    orderBy: { createdAt: "desc" },
    take: 60,
    select: { id: true, kind: true, createdAt: true, data: true },
  });

  // Diff view when ?a=&b= present (a = older, b = newer).
  let diff: SnapshotDiff | null = null;
  let diffLabel: { a: Date; b: Date } | null = null;
  let newerData: GuildSnapshotData | null = null;
  if (a && b) {
    const [rowA, rowB] = await Promise.all([
      prisma.guildSnapshot.findUnique({ where: { id: a } }),
      prisma.guildSnapshot.findUnique({ where: { id: b } }),
    ]);
    if (rowA && rowB && rowA.guildId === guildId && rowB.guildId === guildId) {
      const dataA = rowA.data as unknown as GuildSnapshotData;
      newerData = rowB.data as unknown as GuildSnapshotData;
      diff = diffSnapshots(dataA, newerData);
      diffLabel = { a: rowA.createdAt, b: rowB.createdAt };
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Structure snapshots</h1>
          <p className="mt-1 text-sm text-white/60">
            Nightly captures of roles, channels, permissions, settings, emojis,
            and member role-assignments. Pick any snapshot to see what changed
            since the one before it.
          </p>
        </div>
        <SnapshotRunner guildId={guildId} />
      </div>

      {diff && diffLabel && (
        <div className="mt-6 rounded-2xl bg-white/[0.02] p-5 ring-1 ring-white/10">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
              Changes
            </h2>
            <p className="text-xs text-white/40">
              <LocalTime iso={diffLabel.a.toISOString()} /> →{" "}
              <LocalTime iso={diffLabel.b.toISOString()} />
            </p>
          </div>
          {diff.isEmpty ? (
            <p className="mt-3 text-sm text-white/60">
              No structural changes between these snapshots.
            </p>
          ) : (
            <DiffView diff={diff} data={newerData} />
          )}
        </div>
      )}

      {snapshots.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-dashed border-white/10 p-12 text-center text-white/60">
          No snapshots yet — the bot takes one nightly, or click Snapshot now.
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-white/5 overflow-hidden rounded-2xl ring-1 ring-white/10">
          {snapshots.map((s, i) => {
            const counts = (s.data as unknown as GuildSnapshotData).counts;
            const prev = snapshots[i + 1];
            return (
              <li
                key={s.id}
                className="flex items-center gap-3 bg-white/[0.02] px-4 py-3"
              >
                <span
                  className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-medium ${
                    s.kind === "manual"
                      ? "bg-[color:var(--color-brand-600)]/25 text-[color:var(--color-brand-100)]"
                      : "bg-white/10 text-white/60"
                  }`}
                >
                  {s.kind}
                </span>
                <LocalTime
                  iso={s.createdAt.toISOString()}
                  className="text-sm text-white/80"
                />
                <span className="min-w-0 flex-1 truncate text-xs text-white/40">
                  {counts.roles} roles · {counts.channels} channels ·{" "}
                  {counts.emojis} emojis · {counts.members} members
                </span>
                {prev && (
                  <Link
                    href={`/dashboard/${guildId}/snapshots?a=${prev.id}&b=${s.id}`}
                    className="rounded-md px-2.5 py-1 text-xs text-white/70 ring-1 ring-white/10 hover:bg-white/5"
                  >
                    Diff vs previous
                  </Link>
                )}
                <Link
                  href={`/dashboard/${guildId}/restore?snapshot=${s.id}`}
                  className="rounded-md px-2.5 py-1 text-xs text-white/70 ring-1 ring-white/10 hover:bg-white/5"
                >
                  Restore…
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function DiffView({ diff, data }: { diff: SnapshotDiff; data: GuildSnapshotData | null }) {
  const roleName = (id: string) =>
    data?.roles.find((r) => r.id === id)?.name ?? id;
  return (
    <div className="mt-3 space-y-4 text-sm">
      {diff.settings.length > 0 && (
        <Section title="Server settings">
          {diff.settings.map((c) => (
            <li key={c.field}>
              <code className="text-white/60">{c.field}</code>: {c.from} →{" "}
              <span className="text-white/90">{c.to}</span>
            </li>
          ))}
        </Section>
      )}

      {(diff.roles.added.length > 0 ||
        diff.roles.removed.length > 0 ||
        diff.roles.changed.length > 0) && (
        <Section title="Roles">
          {diff.roles.added.map((r) => (
            <li key={r.id} className="text-emerald-300">
              + created @{r.name}
            </li>
          ))}
          {diff.roles.removed.map((r) => (
            <li key={r.id} className="text-red-300">
              − deleted @{r.name}
            </li>
          ))}
          {diff.roles.changed.map((r) => (
            <li key={r.id}>
              @{r.name}:{" "}
              {[
                ...r.changes.map((c) => `${c.field} ${c.from}→${c.to}`),
                ...r.permsGranted.map((p) => `granted ${p}`),
                ...r.permsRevoked.map((p) => `revoked ${p}`),
              ].join(", ")}
              {r.permsGranted.length > 0 && (
                <span className="ml-1 text-amber-300">⚠</span>
              )}
            </li>
          ))}
        </Section>
      )}

      {(diff.channels.added.length > 0 ||
        diff.channels.removed.length > 0 ||
        diff.channels.changed.length > 0) && (
        <Section title="Channels">
          {diff.channels.added.map((c) => (
            <li key={c.id} className="text-emerald-300">
              + created #{c.name}
            </li>
          ))}
          {diff.channels.removed.map((c) => (
            <li key={c.id} className="text-red-300">
              − deleted #{c.name}
            </li>
          ))}
          {diff.channels.changed.map((c) => (
            <li key={c.id}>
              #{c.name}:{" "}
              {[
                ...c.changes.map((ch) => `${ch.field} ${ch.from}→${ch.to}`),
                ...c.overwrites.map((o) => {
                  const bits = [
                    ...o.allowGranted.map((p) => `+allow ${p}`),
                    ...o.allowRevoked.map((p) => `−allow ${p}`),
                    ...o.denyGranted.map((p) => `+deny ${p}`),
                    ...o.denyRevoked.map((p) => `−deny ${p}`),
                  ].join(" ");
                  return `overwrite ${o.kind} for @${roleName(o.targetId)}${bits ? ` (${bits})` : ""}`;
                }),
              ].join("; ")}
            </li>
          ))}
        </Section>
      )}

      {(diff.emojis.added.length > 0 || diff.emojis.removed.length > 0) && (
        <Section title="Emojis">
          {diff.emojis.added.map((e) => (
            <li key={e.id} className="text-emerald-300">
              + :{e.name}:
            </li>
          ))}
          {diff.emojis.removed.map((e) => (
            <li key={e.id} className="text-red-300">
              − :{e.name}:
            </li>
          ))}
        </Section>
      )}

      {diff.memberCountDelta !== 0 && (
        <p className="text-xs text-white/50">
          Member count {diff.memberCountDelta > 0 ? "+" : ""}
          {diff.memberCountDelta}
        </p>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-white/40">
        {title}
      </h3>
      <ul className="space-y-0.5 text-white/75">{children}</ul>
    </div>
  );
}
