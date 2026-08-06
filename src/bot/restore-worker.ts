// Restore-assist worker. Processes RestoreJob rows: compares a stored
// GuildSnapshot against the guild's CURRENT structure and recreates what's
// missing. Strictly non-destructive — it only creates roles/channels and adds
// roles to members; it never deletes, renames, or strips anything.
//
// Pacing is deliberately glacial: Discord applies undocumented anti-nuke
// limits to role creation (tripping them can block the bot from creating
// roles for 24h+), so roles go out one per ROLE_PACE_MS and channels one per
// CHANNEL_PACE_MS. A nuked server takes minutes to rebuild; that's the cost
// of not getting the bot rate-banned mid-restore.

import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import {
  addMemberRole,
  createChannelRaw,
  createRoleRaw,
  listAllChannels,
  listGuildMembers,
  listRolesRaw,
} from "@/lib/discord-rest";
import type { GuildSnapshotData } from "@/lib/guild-snapshot";
import type { Prisma, RestoreJob } from "@prisma/client";

const POLL_MS = 15_000;
const ROLE_PACE_MS = 5_000;
const CHANNEL_PACE_MS = 1_500;
const MEMBER_ROLE_PACE_MS = 350;
// Discord channel type 4 = category. Categories must exist before children.
const CATEGORY_TYPE = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type RestoreOptions = {
  createRoles: boolean;
  createChannels: boolean;
  reapplyMemberRoles: boolean;
};

export function runRestoreWorker() {
  console.log(`[restore] polling every ${POLL_MS}ms`);
  prisma.restoreJob
    .updateMany({ where: { status: "running" }, data: { status: "pending" } })
    .catch((err) => console.warn("[restore] startup reset failed:", err));

  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (err) {
      console.error("[restore] tick failed:", err);
    } finally {
      running = false;
    }
  }, POLL_MS);
}

async function tick() {
  const job = await prisma.restoreJob.findFirst({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
  });
  if (!job) return;

  await prisma.restoreJob.update({
    where: { id: job.id },
    data: { status: "running", startedAt: new Date() },
  });
  const log: string[] = [];
  const pushLog = async (line: string) => {
    log.push(line);
    console.log(`[restore] ${job.id}: ${line}`);
    await prisma.restoreJob
      .update({
        where: { id: job.id },
        data: { log: log as unknown as Prisma.InputJsonValue },
      })
      .catch(() => {});
  };

  try {
    await runRestore(job, pushLog);
    await prisma.restoreJob.update({
      where: { id: job.id },
      data: { status: "done", finishedAt: new Date() },
    });
    audit(job.guildId, "restore.completed", "Restore-assist job finished", {
      jobId: job.id,
      snapshotId: job.snapshotId,
      steps: log.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[restore] job ${job.id} failed:`, err);
    await pushLog(`FAILED: ${message.slice(0, 300)}`);
    await prisma.restoreJob.update({
      where: { id: job.id },
      data: { status: "failed", finishedAt: new Date(), error: message.slice(0, 2000) },
    });
    audit(
      job.guildId,
      "restore.failed",
      "Restore-assist job failed",
      { jobId: job.id, error: message.slice(0, 500) },
      "error"
    );
  }
}

async function runRestore(job: RestoreJob, pushLog: (l: string) => Promise<void>) {
  const options = job.options as unknown as RestoreOptions;
  const snapshotRow = await prisma.guildSnapshot.findUnique({
    where: { id: job.snapshotId },
  });
  if (!snapshotRow || snapshotRow.guildId !== job.guildId) {
    throw new Error("Snapshot not found for this guild");
  }
  const snapshot = snapshotRow.data as unknown as GuildSnapshotData;
  const guildId = job.guildId;
  const reason = `Restore assist (snapshot ${job.snapshotId.slice(0, 8)})`;

  const [liveRoles, liveChannels] = await Promise.all([
    listRolesRaw(guildId),
    listAllChannels(guildId),
  ]);
  const liveRoleIds = new Set(liveRoles.map((r) => r.id));
  const liveChannelIds = new Set(liveChannels.map((c) => c.id));
  // Maps snapshot ids → live ids for things we recreate, so overwrites and
  // member role-reapply can reference recreated objects.
  const roleIdMap = new Map<string, string>();
  const channelIdMap = new Map<string, string>();

  await pushLog(
    `Starting restore from snapshot taken ${snapshotRow.createdAt.toISOString()}`
  );

  // ---- Roles (skip @everyone and integration-managed roles) ----
  if (options.createRoles) {
    const missing = snapshot.roles.filter(
      (r) => r.id !== guildId && !r.managed && !liveRoleIds.has(r.id)
    );
    await pushLog(`Roles: ${missing.length} missing`);
    // Recreate top-down so hierarchy lands roughly in snapshot order (new
    // roles appear near the bottom regardless; admins drag-order afterwards).
    for (const r of missing) {
      const created = await createRoleRaw(
        guildId,
        {
          name: r.name,
          color: r.color,
          hoist: r.hoist,
          mentionable: r.mentionable,
          permissions: r.permissions,
        },
        reason
      );
      roleIdMap.set(r.id, created.id);
      await pushLog(`  created role @${r.name}`);
      await sleep(ROLE_PACE_MS);
    }
  }

  // ---- Channels (categories first, then children) ----
  if (options.createChannels) {
    const missing = snapshot.channels.filter((c) => !liveChannelIds.has(c.id));
    const categories = missing.filter((c) => c.type === CATEGORY_TYPE);
    const others = missing.filter((c) => c.type !== CATEGORY_TYPE);
    await pushLog(
      `Channels: ${missing.length} missing (${categories.length} categories)`
    );

    const mapOverwrites = (c: (typeof missing)[number]) =>
      (c.permission_overwrites ?? [])
        .map((ow) => {
          // Role overwrites: remap recreated roles; keep surviving roles;
          // drop targets that no longer exist. Member overwrites (type 1)
          // pass through — Discord ignores ones for departed members.
          if (ow.type === 0) {
            const target = liveRoleIds.has(ow.id)
              ? ow.id
              : roleIdMap.get(ow.id);
            if (!target) return null;
            return { ...ow, id: target };
          }
          return ow;
        })
        .filter((ow): ow is NonNullable<typeof ow> => ow !== null);

    for (const c of categories) {
      const created = await createChannelRaw(
        guildId,
        {
          name: c.name,
          type: c.type,
          permission_overwrites: mapOverwrites(c),
        },
        reason
      );
      channelIdMap.set(c.id, created.id);
      await pushLog(`  created category ${c.name}`);
      await sleep(CHANNEL_PACE_MS);
    }
    for (const c of others) {
      // Parent: surviving category keeps its id; recreated ones remap; a
      // parent that's gone and wasn't recreated → channel lands at top level.
      const parent =
        c.parent_id === null
          ? null
          : liveChannelIds.has(c.parent_id)
            ? c.parent_id
            : (channelIdMap.get(c.parent_id) ?? null);
      const created = await createChannelRaw(
        guildId,
        {
          name: c.name,
          type: c.type,
          parent_id: parent,
          topic: c.topic ?? undefined,
          nsfw: c.nsfw,
          rate_limit_per_user: c.rate_limit_per_user,
          permission_overwrites: mapOverwrites(c),
        },
        reason
      );
      channelIdMap.set(c.id, created.id);
      await pushLog(`  created channel #${c.name}`);
      await sleep(CHANNEL_PACE_MS);
    }
  }

  // ---- Member role re-apply ----
  if (options.reapplyMemberRoles) {
    const members = await listGuildMembers(guildId);
    const present = new Map(members.map((m) => [m.user.id, new Set(m.roles)]));
    // Roles we can apply: survived, or recreated this run.
    const applicable = (id: string): string | null =>
      liveRoleIds.has(id) ? id : (roleIdMap.get(id) ?? null);

    let applied = 0;
    let membersTouched = 0;
    for (const snapMember of snapshot.members) {
      const current = present.get(snapMember.id);
      if (!current) continue; // left the server — nothing we can do
      const toAdd = snapMember.roles
        .map(applicable)
        .filter((id): id is string => id !== null && !current.has(id));
      if (toAdd.length === 0) continue;
      membersTouched++;
      for (const roleId of toAdd) {
        await addMemberRole(guildId, snapMember.id, roleId, reason);
        applied++;
        await sleep(MEMBER_ROLE_PACE_MS);
      }
    }
    await pushLog(
      `Member roles: re-applied ${applied} role assignment(s) across ${membersTouched} member(s)`
    );
  }

  await pushLog("Restore complete");
}
