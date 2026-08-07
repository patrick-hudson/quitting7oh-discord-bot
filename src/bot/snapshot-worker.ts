// Processes SnapshotJob rows: walks each collection step (settings, roles,
// channels, emojis, members, store), recording live per-step status + timing
// into the job's `steps` array so the portal can show exactly what the bot is
// doing and how long each part takes. On success, stores the GuildSnapshot and
// links it back on the job.

import { performance } from "node:perf_hooks";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import {
  collectGuildSnapshotStepwise,
  type GuildSnapshotData,
  type SnapshotStep,
} from "@/lib/guild-snapshot";
import type { Prisma } from "@prisma/client";

const POLL_MS = 5_000;
// Keep the most recent N jobs per guild — they're small (just the step log).
const KEEP_JOBS_PER_GUILD = 25;

type StepRow = {
  name: string;
  status: "running" | "done" | "failed";
  ms?: number;
  detail?: string;
  error?: string;
};

export function runSnapshotWorker() {
  console.log(`[snapshot] polling every ${POLL_MS}ms`);
  prisma.snapshotJob
    .updateMany({ where: { status: "running" }, data: { status: "pending" } })
    .catch((err) => console.warn("[snapshot] startup reset failed:", err));

  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (err) {
      console.error("[snapshot] tick failed:", err);
    } finally {
      running = false;
    }
  }, POLL_MS);
}

async function tick() {
  const job = await prisma.snapshotJob.findFirst({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
  });
  if (!job) return;

  await prisma.snapshotJob.update({
    where: { id: job.id },
    data: { status: "running", startedAt: new Date() },
  });

  const steps: StepRow[] = [];
  const persist = () =>
    prisma.snapshotJob
      .update({
        where: { id: job.id },
        data: { steps: steps as unknown as Prisma.InputJsonValue },
      })
      .catch(() => {});

  const step: SnapshotStep = async (name, fn, detail) => {
    const row: StepRow = { name, status: "running" };
    steps.push(row);
    await persist();
    const t0 = performance.now();
    try {
      const result = await fn();
      row.status = "done";
      row.ms = Math.round(performance.now() - t0);
      if (detail) row.detail = detail(result);
      await persist();
      return result;
    } catch (err) {
      row.status = "failed";
      row.ms = Math.round(performance.now() - t0);
      row.error = (err as Error).message?.slice(0, 300);
      await persist();
      throw err;
    }
  };

  try {
    const data = await collectGuildSnapshotStepwise(job.guildId, step);
    const snapshotId = await step(
      "Store snapshot",
      async () => {
        const row = await prisma.guildSnapshot.create({
          data: {
            guildId: job.guildId,
            kind: job.kind,
            data: data as unknown as Prisma.InputJsonValue,
          },
        });
        return row.id;
      },
      () => "saved"
    );

    await prisma.snapshotJob.update({
      where: { id: job.id },
      data: { status: "done", finishedAt: new Date(), snapshotId },
    });
    audit(
      job.guildId,
      "snapshot.taken",
      `${job.kind === "manual" ? "Manual" : "Nightly"} structure snapshot`,
      { snapshotId, kind: job.kind, jobId: job.id, counts: summarize(data) }
    );
    if (job.kind === "scheduled") await enforceSnapshotRetention(job.guildId);
    await pruneSnapshotJobs(job.guildId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[snapshot] job ${job.id} failed:`, err);
    await prisma.snapshotJob.update({
      where: { id: job.id },
      data: { status: "failed", finishedAt: new Date(), error: message.slice(0, 2000) },
    });
    audit(
      job.guildId,
      "snapshot.failed",
      `${job.kind === "manual" ? "Manual" : "Nightly"} snapshot failed`,
      { jobId: job.id, error: message.slice(0, 500) },
      "error"
    );
  }
}

function summarize(d: GuildSnapshotData) {
  return d.counts;
}

// Newest 60 scheduled snapshots per guild (manual kept until deleted by hand).
async function enforceSnapshotRetention(guildId: string) {
  const excess = await prisma.guildSnapshot.findMany({
    where: { guildId, kind: "scheduled" },
    orderBy: { createdAt: "desc" },
    skip: 60,
    select: { id: true },
  });
  if (excess.length > 0) {
    await prisma.guildSnapshot.deleteMany({
      where: { id: { in: excess.map((s) => s.id) } },
    });
  }
}

async function pruneSnapshotJobs(guildId: string) {
  const excess = await prisma.snapshotJob.findMany({
    where: { guildId },
    orderBy: { createdAt: "desc" },
    skip: KEEP_JOBS_PER_GUILD,
    select: { id: true },
  });
  if (excess.length > 0) {
    await prisma.snapshotJob.deleteMany({
      where: { id: { in: excess.map((j) => j.id) } },
    });
  }
}
