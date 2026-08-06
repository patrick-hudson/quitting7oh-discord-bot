// Restore assist: pick a snapshot (usually via the Snapshots page's
// "Restore…" link), see exactly what's missing versus the live server, and
// queue a non-destructive rebuild. Break-glass tooling — hopefully never used.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { listAllChannels, listRolesRaw } from "@/lib/discord-rest";
import { LocalTime } from "@/components/LocalTime";
import { RestoreLauncher } from "@/components/RestoreLauncher";
import type { GuildSnapshotData } from "@/lib/guild-snapshot";

export default async function RestorePage({
  params,
  searchParams,
}: {
  params: Promise<{ guildId: string }>;
  searchParams: Promise<{ snapshot?: string }>;
}) {
  const { guildId } = await params;
  const { snapshot: snapshotId } = await searchParams;

  const snapshots = await prisma.guildSnapshot.findMany({
    where: { guildId },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, kind: true, createdAt: true },
  });

  const selected = snapshotId
    ? await prisma.guildSnapshot.findUnique({ where: { id: snapshotId } })
    : null;
  const snapshot =
    selected && selected.guildId === guildId
      ? (selected.data as unknown as GuildSnapshotData)
      : null;

  // Compute the plan: what the snapshot has that the live server doesn't.
  let missingRoles: string[] = [];
  let missingChannels: string[] = [];
  if (snapshot) {
    const [liveRoles, liveChannels] = await Promise.all([
      listRolesRaw(guildId).catch(() => []),
      listAllChannels(guildId).catch(() => []),
    ]);
    const liveRoleIds = new Set(liveRoles.map((r) => r.id));
    const liveChannelIds = new Set(liveChannels.map((c) => c.id));
    missingRoles = snapshot.roles
      .filter((r) => r.id !== guildId && !r.managed && !liveRoleIds.has(r.id))
      .map((r) => r.name);
    missingChannels = snapshot.channels
      .filter((c) => !liveChannelIds.has(c.id))
      .map((c) => c.name);
  }

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-semibold tracking-tight">Restore assist</h1>
      <p className="mt-1 text-sm text-white/60">
        Rebuild missing roles and channels from a structure snapshot, and
        re-apply role assignments to members still in the server. Strictly
        additive — nothing existing is deleted or changed, and message history
        can&apos;t be restored (Discord doesn&apos;t allow it).
      </p>

      {!snapshot ? (
        <div className="mt-8 rounded-2xl bg-white/[0.02] p-5 ring-1 ring-white/10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
            Pick a snapshot
          </h2>
          {snapshots.length === 0 ? (
            <p className="mt-2 text-sm text-white/60">
              No snapshots yet — take one on the{" "}
              <Link
                href={`/dashboard/${guildId}/snapshots`}
                className="text-[color:var(--color-brand-500)] hover:underline"
              >
                Snapshots page
              </Link>
              .
            </p>
          ) : (
            <ul className="mt-3 space-y-1">
              {snapshots.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/dashboard/${guildId}/restore?snapshot=${s.id}`}
                    className="text-sm text-white/80 hover:underline"
                  >
                    <LocalTime iso={s.createdAt.toISOString()} />{" "}
                    <span className="text-xs text-white/40">({s.kind})</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          <div className="mt-8 rounded-2xl bg-white/[0.02] p-5 ring-1 ring-white/10">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
                Plan — snapshot from{" "}
                <LocalTime iso={selected!.createdAt.toISOString()} />
              </h2>
              <Link
                href={`/dashboard/${guildId}/restore`}
                className="text-xs text-white/50 hover:text-white"
              >
                pick different snapshot
              </Link>
            </div>

            {missingRoles.length === 0 && missingChannels.length === 0 ? (
              <p className="mt-3 text-sm text-emerald-300">
                Nothing missing — the live server has every role and channel in
                this snapshot. (Member role re-apply is still available below.)
              </p>
            ) : (
              <div className="mt-3 grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
                <div>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-white/40">
                    Missing roles ({missingRoles.length})
                  </h3>
                  <ul className="space-y-0.5 text-white/75">
                    {missingRoles.map((n) => (
                      <li key={n}>@{n}</li>
                    ))}
                    {missingRoles.length === 0 && (
                      <li className="text-white/40">none</li>
                    )}
                  </ul>
                </div>
                <div>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-white/40">
                    Missing channels ({missingChannels.length})
                  </h3>
                  <ul className="space-y-0.5 text-white/75">
                    {missingChannels.map((n) => (
                      <li key={n}>#{n}</li>
                    ))}
                    {missingChannels.length === 0 && (
                      <li className="text-white/40">none</li>
                    )}
                  </ul>
                </div>
              </div>
            )}
          </div>

          <div className="mt-6">
            <RestoreLauncher
              guildId={guildId}
              snapshotId={selected!.id}
              missingRoles={missingRoles.length}
              missingChannels={missingChannels.length}
            />
          </div>
        </>
      )}
    </div>
  );
}
