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
import { CopyButton } from "@/components/CopyButton";
import { RedactedShare } from "@/components/RedactedShare";
import { RECO, CONFIDENCE_LABEL } from "@/components/ai-review-meta";
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
  const reco = RECO[verdict.recommendation] ?? RECO.not_yet;

  return (
    <div className="min-w-0">
      {heading && (
        <p className="mb-2 text-[11px] uppercase tracking-wide text-white/40">
          {heading} · {job.createdAt.toISOString().slice(0, 10)}
        </p>
      )}

      {verdict.crisisFlag && (
        <div className="mb-4 rounded-xl bg-amber-400/10 p-3 ring-1 ring-amber-400/25">
          <p className="text-sm font-medium text-amber-100">
            ⚠ Possible crisis signal — for human review
          </p>
          {verdict.crisisNote && (
            <p className="mt-1 text-sm text-amber-100/80">{verdict.crisisNote}</p>
          )}
          <p className="mt-1 text-xs text-amber-100/60">
            Flagged for a person to look at with care. This is separate from the
            fit question and should not, on its own, count against the member.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-md px-2.5 py-1 text-sm font-semibold ring-1 ${reco.badge}`}
        >
          {reco.label}
        </span>
        <span className="rounded-md bg-white/5 px-2 py-1 text-xs text-white/60 ring-1 ring-white/10">
          {CONFIDENCE_LABEL[verdict.confidence] ?? verdict.confidence}
        </span>
      </div>
      <p className="mt-1 text-xs text-white/40">{reco.blurb}</p>

      {verdict.summary && (
        <p className="mt-4 text-sm leading-relaxed text-white/85">{verdict.summary}</p>
      )}

      <PointList title="Strengths" tone="pos" points={verdict.strengths} />
      <PointList title="Concerns" tone="neg" points={verdict.concerns} />

      {verdict.outreachMessage && (
        <div className="mt-6 rounded-xl bg-[color:var(--color-brand-600)]/[0.06] p-4 ring-1 ring-[color:var(--color-brand-600)]/20">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-white/60">
              Suggested outreach
            </h3>
            <CopyButton text={verdict.outreachMessage} />
          </div>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-white/85">
            {verdict.outreachMessage}
          </p>
          <p className="mt-2 text-[11px] text-white/35">
            A starting point to send this member — read it over and make it yours
            before sending. It intentionally doesn&apos;t mention any crisis flag.
          </p>
        </div>
      )}

      <p className="mt-6 border-t border-white/5 pt-3 text-[11px] text-white/35">
        {job.messagesAnalyzed.toLocaleString()} messages analyzed · source:{" "}
        {job.source ?? "—"} · {job.model ?? "—"} ·{" "}
        {(job.inputTokens + job.outputTokens).toLocaleString()} tokens
        {job.finishedAt && (
          <>
            {" "}
            · <LocalTime iso={job.finishedAt.toISOString()} />
          </>
        )}
      </p>
    </div>
  );
}

function PointList({
  title,
  tone,
  points,
}: {
  title: string;
  tone: "pos" | "neg";
  points: AiVerdict["strengths"];
}) {
  if (!points || points.length === 0) return null;
  const dot = tone === "pos" ? "bg-emerald-400/70" : "bg-red-400/70";
  return (
    <div className="mt-5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-white/50">
        {title}
      </h3>
      <ul className="mt-2 space-y-3">
        {points.map((p, i) => (
          <li key={i} className="flex gap-2.5">
            <span className={`mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
            <div className="min-w-0">
              <p className="text-sm text-white/85">{p.point}</p>
              {p.evidence && (
                <p className="mt-0.5 border-l-2 border-white/10 pl-2 text-xs italic text-white/55">
                  “{p.evidence}”
                  {p.context && (
                    <span className="not-italic text-white/35"> — {p.context}</span>
                  )}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
