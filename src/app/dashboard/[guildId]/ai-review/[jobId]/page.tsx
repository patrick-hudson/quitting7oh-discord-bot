// A single AI fit review. Shows the structured verdict (recommendation,
// strengths + concerns with quoted evidence, narrative, crisis flag) plus run
// metadata. Supports comparing timelines: ?compare=<otherJobId> renders this
// review beside another done review of the same member, side by side.

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireGuildAccess } from "@/lib/authz";
import { LocalTime } from "@/components/LocalTime";
import { AutoRefresh } from "@/components/AutoRefresh";
import { AiReviewButton } from "@/components/AiReviewControls";
import { RedactedShare } from "@/components/RedactedShare";
import { VerdictReport } from "@/components/VerdictReport";
import { RECO } from "@/components/ai-review-meta";
import type { AiVerdict } from "@/lib/ai-review";
import type { AiReviewJob } from "@prisma/client";

export default async function AiReviewDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ guildId: string; jobId: string }>;
  searchParams: Promise<{ compare?: string }>;
}) {
  const { guildId, jobId } = await params;
  const { compare } = await searchParams;
  await requireGuildAccess(guildId);

  const job = await prisma.aiReviewJob.findUnique({ where: { id: jobId } });
  if (!job || job.guildId !== guildId) notFound();

  const backLink = `/dashboard/${guildId}/ai-review`;
  const inProgress = job.status === "pending" || job.status === "running";

  // Other done reviews of the same member, for the compare picker.
  const others = await prisma.aiReviewJob.findMany({
    where: {
      guildId,
      targetUserId: job.targetUserId,
      status: "done",
      id: { not: job.id },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true, recommendation: true },
    take: 20,
  });

  const compareJob =
    compare && others.some((o) => o.id === compare)
      ? await prisma.aiReviewJob.findUnique({ where: { id: compare } })
      : null;

  return (
    <div className="mx-auto max-w-5xl">
      {inProgress && <AutoRefresh />}
      <div className="flex items-center justify-between gap-3">
        <Link href={backLink} className="text-sm text-white/50 hover:text-white/80">
          ← All reviews
        </Link>
        <span className="text-[11px] text-white/40">
          Requested <LocalTime iso={job.createdAt.toISOString()} />
        </span>
      </div>

      <div className="mt-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">
            {job.targetName ?? job.targetUserId}
          </h1>
          <p className="mt-0.5 font-mono text-xs text-white/40">{job.targetUserId}</p>
        </div>
        {!inProgress && (
          <AiReviewButton
            className="shrink-0"
            guildId={guildId}
            targetUserId={job.targetUserId}
            targetName={job.targetName}
            label="Re-run review"
          />
        )}
      </div>

      {inProgress && (
        <div className="mt-8 rounded-2xl border border-dashed border-white/10 p-10 text-center text-white/60">
          {job.status === "running" ? "Reviewing messages…" : "Queued…"} This page
          updates itself when the review is ready.
        </div>
      )}

      {job.status === "failed" && (
        <div className="mt-8 rounded-2xl bg-red-400/5 p-6 ring-1 ring-red-400/20">
          <p className="text-sm font-medium text-red-200">Review failed</p>
          <p className="mt-1 text-sm text-red-300/80">{job.error}</p>
        </div>
      )}

      {job.status === "done" && (
        <>
          <div
            className={`mt-6 grid gap-6 ${compareJob ? "md:grid-cols-2" : "grid-cols-1"}`}
          >
            <ReviewColumn job={job} heading={compareJob ? "This review" : null} />
            {compareJob && (
              <ReviewColumn
                job={compareJob}
                heading="Compared review"
              />
            )}
          </div>

          {(() => {
            const v = job.verdict as unknown as AiVerdict | null;
            return v ? (
              <RedactedShare
                verdict={v}
                targetName={job.targetName}
                targetUserId={job.targetUserId}
                finishedAt={job.finishedAt?.toISOString().slice(0, 10) ?? null}
                messagesAnalyzed={job.messagesAnalyzed}
              />
            ) : null;
          })()}

          {others.length > 0 && (
            <div className="mt-8 rounded-xl bg-white/[0.02] p-4 ring-1 ring-white/10">
              <p className="text-sm font-medium text-white/80">
                Compare timelines
              </p>
              <p className="mt-0.5 text-xs text-white/50">
                {job.targetName ?? "This member"} has {others.length} other
                completed review{others.length === 1 ? "" : "s"}. Open one beside
                this to see how the read changed over time.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {others.map((o) => {
                  const reco = o.recommendation ? RECO[o.recommendation] : null;
                  const active = o.id === compare;
                  return (
                    <Link
                      key={o.id}
                      href={
                        active
                          ? `${backLink}/${job.id}`
                          : `${backLink}/${job.id}?compare=${o.id}`
                      }
                      className={`rounded-lg px-2.5 py-1 text-xs ring-1 transition ${
                        active
                          ? "bg-[color:var(--color-brand-600)] text-white ring-transparent"
                          : "bg-white/5 text-white/70 ring-white/10 hover:bg-white/10"
                      }`}
                    >
                      {reco?.label ?? "review"} ·{" "}
                      {o.createdAt.toISOString().slice(0, 10)}
                    </Link>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ReviewColumn({
  job,
  heading,
}: {
  job: AiReviewJob;
  heading: string | null;
}) {
  const verdict = job.verdict as unknown as AiVerdict | null;
  if (!verdict) {
    return <p className="text-sm text-white/50">No verdict recorded.</p>;
  }
  return (
    <VerdictReport
      verdict={verdict}
      heading={heading}
      headingDate={heading ? job.createdAt.toISOString().slice(0, 10) : null}
      meta={{
        messagesAnalyzed: job.messagesAnalyzed,
        source: job.source,
        model: job.model,
        totalTokens: job.inputTokens + job.outputTokens,
        finishedAtIso: job.finishedAt?.toISOString() ?? null,
      }}
    />
  );
}
