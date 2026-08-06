// Pure structural diff between two guild snapshots (older → newer). Powers
// the Snapshots page's diff view and the restore-assist plan. Deliberately
// ignores position-only changes (drag-reorder noise) and per-member role
// churn (covered by joins/leaves + mod log); it reports what admins actually
// investigate: created/deleted/renamed things and permission changes.

import { PermissionsBitField } from "discord.js";
import type {
  GuildSnapshotData,
  SnapshotChannel,
  SnapshotRole,
} from "@/lib/guild-snapshot";

export type FieldChange = { field: string; from: string; to: string };

export type RoleChange = {
  id: string;
  name: string;
  changes: FieldChange[];
  permsGranted: string[];
  permsRevoked: string[];
};

export type OverwriteChange = {
  targetId: string; // role or member id
  kind: "added" | "removed" | "changed";
  allowGranted: string[];
  allowRevoked: string[];
  denyGranted: string[];
  denyRevoked: string[];
};

export type ChannelChange = {
  id: string;
  name: string;
  changes: FieldChange[];
  overwrites: OverwriteChange[];
};

export type SnapshotDiff = {
  settings: FieldChange[];
  roles: {
    added: SnapshotRole[];
    removed: SnapshotRole[];
    changed: RoleChange[];
  };
  channels: {
    added: SnapshotChannel[];
    removed: SnapshotChannel[];
    changed: ChannelChange[];
  };
  emojis: {
    added: Array<{ id: string; name: string }>;
    removed: Array<{ id: string; name: string }>;
  };
  memberCountDelta: number;
  isEmpty: boolean;
};

// Decode which permission names differ between two bitfield strings.
function permDelta(fromBits: string, toBits: string): { granted: string[]; revoked: string[] } {
  const from = BigInt(fromBits || "0");
  const to = BigInt(toBits || "0");
  const granted: string[] = [];
  const revoked: string[] = [];
  for (const [name, bit] of Object.entries(PermissionsBitField.Flags)) {
    const had = (from & bit) !== 0n;
    const has = (to & bit) !== 0n;
    if (!had && has) granted.push(name);
    if (had && !has) revoked.push(name);
  }
  return { granted, revoked };
}

function fieldChanges<T extends object>(
  a: T,
  b: T,
  fields: Array<keyof T & string>
): FieldChange[] {
  const out: FieldChange[] = [];
  for (const f of fields) {
    const av = a[f];
    const bv = b[f];
    if (String(av ?? "") !== String(bv ?? "")) {
      out.push({ field: f, from: String(av ?? "—"), to: String(bv ?? "—") });
    }
  }
  return out;
}

export function diffSnapshots(
  older: GuildSnapshotData,
  newer: GuildSnapshotData
): SnapshotDiff {
  // Settings
  const settings = fieldChanges(older.settings, newer.settings, [
    "name",
    "description",
    "verificationLevel",
    "afkChannelId",
    "afkTimeout",
    "systemChannelId",
    "rulesChannelId",
    "icon",
    "banner",
  ]);

  // Roles
  const oldRoles = new Map(older.roles.map((r) => [r.id, r]));
  const newRoles = new Map(newer.roles.map((r) => [r.id, r]));
  const rolesAdded = newer.roles.filter((r) => !oldRoles.has(r.id));
  const rolesRemoved = older.roles.filter((r) => !newRoles.has(r.id));
  const rolesChanged: RoleChange[] = [];
  for (const [id, oldR] of oldRoles) {
    const newR = newRoles.get(id);
    if (!newR) continue;
    const changes = fieldChanges(oldR, newR, ["name", "color", "hoist", "mentionable"]);
    const { granted, revoked } =
      oldR.permissions !== newR.permissions
        ? permDelta(oldR.permissions, newR.permissions)
        : { granted: [], revoked: [] };
    if (changes.length > 0 || granted.length > 0 || revoked.length > 0) {
      rolesChanged.push({
        id,
        name: newR.name,
        changes,
        permsGranted: granted,
        permsRevoked: revoked,
      });
    }
  }

  // Channels
  const oldCh = new Map(older.channels.map((c) => [c.id, c]));
  const newCh = new Map(newer.channels.map((c) => [c.id, c]));
  const channelsAdded = newer.channels.filter((c) => !oldCh.has(c.id));
  const channelsRemoved = older.channels.filter((c) => !newCh.has(c.id));
  const channelsChanged: ChannelChange[] = [];
  for (const [id, oldC] of oldCh) {
    const newC = newCh.get(id);
    if (!newC) continue;
    const changes = fieldChanges(oldC, newC, [
      "name",
      "parent_id",
      "topic",
      "nsfw",
      "rate_limit_per_user",
    ]);
    const overwrites = diffOverwrites(oldC, newC);
    if (changes.length > 0 || overwrites.length > 0) {
      channelsChanged.push({ id, name: newC.name, changes, overwrites });
    }
  }

  // Emojis
  const oldEm = new Map(older.emojis.map((e) => [e.id, e]));
  const newEm = new Map(newer.emojis.map((e) => [e.id, e]));
  const emojisAdded = newer.emojis.filter((e) => !oldEm.has(e.id));
  const emojisRemoved = older.emojis.filter((e) => !newEm.has(e.id));

  const diff: SnapshotDiff = {
    settings,
    roles: { added: rolesAdded, removed: rolesRemoved, changed: rolesChanged },
    channels: {
      added: channelsAdded,
      removed: channelsRemoved,
      changed: channelsChanged,
    },
    emojis: { added: emojisAdded, removed: emojisRemoved },
    memberCountDelta: newer.counts.members - older.counts.members,
    isEmpty: false,
  };
  diff.isEmpty =
    settings.length === 0 &&
    rolesAdded.length === 0 &&
    rolesRemoved.length === 0 &&
    rolesChanged.length === 0 &&
    channelsAdded.length === 0 &&
    channelsRemoved.length === 0 &&
    channelsChanged.length === 0 &&
    emojisAdded.length === 0 &&
    emojisRemoved.length === 0;
  return diff;
}

function diffOverwrites(a: SnapshotChannel, b: SnapshotChannel): OverwriteChange[] {
  const oldOw = new Map((a.permission_overwrites ?? []).map((o) => [o.id, o]));
  const newOw = new Map((b.permission_overwrites ?? []).map((o) => [o.id, o]));
  const out: OverwriteChange[] = [];

  for (const [id, ow] of newOw) {
    if (!oldOw.has(id)) {
      const allow = permDelta("0", ow.allow);
      const deny = permDelta("0", ow.deny);
      out.push({
        targetId: id,
        kind: "added",
        allowGranted: allow.granted,
        allowRevoked: [],
        denyGranted: deny.granted,
        denyRevoked: [],
      });
    }
  }
  for (const [id, ow] of oldOw) {
    const now = newOw.get(id);
    if (!now) {
      const allow = permDelta("0", ow.allow);
      const deny = permDelta("0", ow.deny);
      out.push({
        targetId: id,
        kind: "removed",
        allowGranted: [],
        allowRevoked: allow.granted,
        denyGranted: [],
        denyRevoked: deny.granted,
      });
      continue;
    }
    if (ow.allow !== now.allow || ow.deny !== now.deny) {
      const allow = permDelta(ow.allow, now.allow);
      const deny = permDelta(ow.deny, now.deny);
      out.push({
        targetId: id,
        kind: "changed",
        allowGranted: allow.granted,
        allowRevoked: allow.revoked,
        denyGranted: deny.granted,
        denyRevoked: deny.revoked,
      });
    }
  }
  return out;
}
