// AI contributor-fit reviews — list of past reviews + controls to start a new
// one and to customize the reviewer's prompt. Reviews are kept indefinitely so
// the same member can be re-reviewed over time and the timelines compared
// (from a review's detail page). Pure read of AiReviewJob rows.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireGuildAccess } from "@/lib/authz";
import { NewReviewForm } from "@/components/AiReviewControls";
import { BatchReviewForm, CancelBatchButton } from "@/components/AiReviewBatch";
import { AiReviewList } from "@/components/AiReviewList";
import { AiReviewPromptEditor } from "@/components/AiReviewPromptEditor";
import { AutoRefresh } from "@/components/AutoRefresh";
import { DEFAULT_REVIEW_PROMPT, resolveReviewPrompt } from "@/lib/ai-review";
import { listRoles } from "@/lib/discord-rest";

// Progress of the most recent batch, if it's still working. Rendered as a
// summary card instead of flooding the reviews list with queued rows.
async function loadActiveBatch(guildId: string) {
  const latest = await prisma.aiReviewJob.findFirst({
    where: { guildId, batchId: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { batchId: true },
  });
  if (!latest?.batchId) return null;
  const byStatus = await prisma.aiReviewJob.groupBy({
    by: ["status"],
    where: { guildId, batchId: latest.batchId },
    _count: { _all: true },
  });
  const count = (s: string) => byStatus.find((r) => r.status === s)?._count._all ?? 0;
  const pending = count("pending");
  const running = count("running");
  if (pending + running === 0) return null; // finished — the list tells the story
  const done = count("done");
  const failed = count("failed");
  const cancelled = count("cancelled");
  return {
    batchId: latest.batchId,
    pending,
    running,
    done,
    failed,
    cancelled,
    total: pending + running + done + failed + cancelled,
  };
}

export default async function AiReviewListPage({
  params,
  searchParams,
}: {
  params: Promise<{ guildId: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { guildId } = await params;
  const { view } = await searchParams;
  const archivedView = view === "archived";
  await requireGuildAccess(guildId);

  const [guild, jobs, batch, archivedCount, roles] = await Promise.all([
    prisma.guild.findUnique({
      where: { id: guildId },
      select: { aiReviewPrompt: true },
    }),
    prisma.aiReviewJob.findMany({
      where: {
        guildId,
        archivedAt: archivedView ? { not: null } : null,
        // Batch jobs appear here once they actually run (or get skipped);
        // still-queued ones are summarized by the batch progress card.
        NOT: { batchId: { not: null }, status: "pending" },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        targetUserId: true,
        targetName: true,
        status: true,
        recommendation: true,
        messagesAnalyzed: true,
        source: true,
        createdAt: true,
        error: true,
      },
    }),
    loadActiveBatch(guildId),
    prisma.aiReviewJob.count({
      where: { guildId, archivedAt: { not: null } },
    }),
    // For the batch form's role-exclusion picker. Best-effort: the form
    // degrades to "no role exclusions" if Discord is unreachable.
    listRoles(guildId).catch(() => []),
  ]);

  const anyInFlight =
    batch !== null ||
    jobs.some((j) => j.status === "pending" || j.status === "running");
  const effectivePrompt = resolveReviewPrompt(guild?.aiReviewPrompt);
  const isCustom = Boolean(guild?.aiReviewPrompt?.trim());

  return (
    <div className="mx-auto max-w-4xl">
      {anyInFlight && <AutoRefresh />}
      <h1 className="text-2xl font-semibold tracking-tight">AI fit reviews</h1>
      <p className="mt-1 text-sm text-white/60">
        A professional-style read on whether a member would suit a contributor /
        peer-mentor role, grounded in their actual messages. Decision-support for
        you — not a clinical or final judgment of anyone.
      </p>

      {batch && (
        <div className="mt-6 rounded-xl bg-[color:var(--color-brand-600)]/[0.06] p-4 ring-1 ring-[color:var(--color-brand-600)]/20">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-white/85">
                Batch review in progress —{" "}
                {batch.done + batch.failed + batch.cancelled} of {batch.total}
              </p>
              <p className="mt-0.5 text-xs text-white/55">
                {batch.done} done
                {batch.failed > 0 && ` · ${batch.failed} failed`}
                {batch.cancelled > 0 && ` · ${batch.cancelled} skipped`}
                {" · "}
                {batch.pending + batch.running} to go. Reviews run one at a time
                in the background; you&apos;ll get a DM when the batch finishes.
              </p>
            </div>
            <CancelBatchButton
              guildId={guildId}
              batchId={batch.batchId}
              pendingCount={batch.pending}
            />
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-[color:var(--color-brand-600)] transition-all"
              style={{
                width: `${Math.round(
                  ((batch.done + batch.failed + batch.cancelled) / batch.total) * 100
                )}%`,
              }}
            />
          </div>
        </div>
      )}

      <div className="mt-6 space-y-4">
        <NewReviewForm guildId={guildId} />
        <BatchReviewForm
          guildId={guildId}
          roles={roles.map((r) => ({ id: r.id, name: r.name }))}
        />
        <AiReviewPromptEditor
          guildId={guildId}
          initial={effectivePrompt}
          isCustom={isCustom}
          defaultPrompt={DEFAULT_REVIEW_PROMPT}
        />
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-white/50">
            {archivedView ? "Archived reviews" : "Recent reviews"}
          </h2>
          {(archivedCount > 0 || archivedView) && (
            <Link
              href={
                archivedView
                  ? `/dashboard/${guildId}/ai-review`
                  : `/dashboard/${guildId}/ai-review?view=archived`
              }
              className="rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-white/60 ring-1 ring-white/10 hover:bg-white/10 hover:text-white/85"
            >
              {archivedView ? "← Back to recent" : `Archived (${archivedCount})`}
            </Link>
          )}
        </div>
        <Link
          href={`/dashboard/${guildId}/ai-review/report`}
          className="text-sm text-[color:var(--color-brand-500)] hover:underline"
        >
          Fit report →
        </Link>
      </div>
      {jobs.length === 0 ? (
        <div className="mt-3 rounded-2xl border border-dashed border-white/10 p-10 text-center text-white/60">
          {archivedView
            ? "Nothing archived yet."
            : "No reviews yet. Start one above or from the leaderboard."}
        </div>
      ) : (
        <AiReviewList
          guildId={guildId}
          archivedView={archivedView}
          jobs={jobs.map((j) => ({
            id: j.id,
            targetUserId: j.targetUserId,
            targetName: j.targetName,
            status: j.status,
            recommendation: j.recommendation,
            messagesAnalyzed: j.messagesAnalyzed,
            source: j.source,
            createdAtIso: j.createdAt.toISOString(),
            error: j.error,
          }))}
        />
      )}
    </div>
  );
}
