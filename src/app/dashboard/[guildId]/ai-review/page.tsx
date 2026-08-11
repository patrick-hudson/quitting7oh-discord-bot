// AI contributor-fit reviews — list of past reviews + controls to start a new
// one and to customize the reviewer's prompt. Reviews are kept indefinitely so
// the same member can be re-reviewed over time and the timelines compared
// (from a review's detail page). Pure read of AiReviewJob rows.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireGuildAccess } from "@/lib/authz";
import { LocalTime } from "@/components/LocalTime";
import { NewReviewForm } from "@/components/AiReviewControls";
import { AiReviewPromptEditor } from "@/components/AiReviewPromptEditor";
import { AutoRefresh } from "@/components/AutoRefresh";
import { DEFAULT_REVIEW_PROMPT, resolveReviewPrompt } from "@/lib/ai-review";
import { RECO } from "@/components/ai-review-meta";

export default async function AiReviewListPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;
  await requireGuildAccess(guildId);

  const [guild, jobs] = await Promise.all([
    prisma.guild.findUnique({
      where: { id: guildId },
      select: { aiReviewPrompt: true },
    }),
    prisma.aiReviewJob.findMany({
      where: { guildId },
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
  ]);

  const anyInFlight = jobs.some(
    (j) => j.status === "pending" || j.status === "running"
  );
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

      <div className="mt-6 space-y-4">
        <NewReviewForm guildId={guildId} />
        <AiReviewPromptEditor
          guildId={guildId}
          initial={effectivePrompt}
          isCustom={isCustom}
          defaultPrompt={DEFAULT_REVIEW_PROMPT}
        />
      </div>

      <h2 className="mt-8 text-sm font-medium uppercase tracking-wide text-white/50">
        Recent reviews
      </h2>
      {jobs.length === 0 ? (
        <div className="mt-3 rounded-2xl border border-dashed border-white/10 p-10 text-center text-white/60">
          No reviews yet. Start one above or from the leaderboard.
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-white/5 overflow-hidden rounded-2xl ring-1 ring-white/10">
          {jobs.map((j) => {
            const reco = j.recommendation ? RECO[j.recommendation] : null;
            const inProgress = j.status === "pending" || j.status === "running";
            return (
              <li key={j.id} className="bg-white/[0.02]">
                <Link
                  href={`/dashboard/${guildId}/ai-review/${j.id}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03]"
                >
                  <span
                    className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ${
                      reco
                        ? reco.badge
                        : inProgress
                          ? "bg-white/5 text-white/60 ring-white/10"
                          : "bg-red-400/10 text-red-300 ring-red-400/20"
                    }`}
                  >
                    {reco
                      ? reco.label
                      : j.status === "failed"
                        ? "failed"
                        : j.status === "running"
                          ? "running…"
                          : "queued…"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-white/90">
                    {j.targetName ?? j.targetUserId}
                  </span>
                  {j.status === "done" && (
                    <span className="hidden shrink-0 text-[11px] text-white/40 sm:inline">
                      {j.messagesAnalyzed.toLocaleString()} msgs · {j.source}
                    </span>
                  )}
                  <span className="shrink-0 text-[11px] text-white/40">
                    <LocalTime iso={j.createdAt.toISOString()} />
                  </span>
                </Link>
                {j.status === "failed" && j.error && (
                  <p className="px-4 pb-3 text-[11px] text-red-300/80">{j.error}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
