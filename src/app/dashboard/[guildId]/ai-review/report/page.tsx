// Contributor fit report — a roster of every member ever reviewed, grouped by
// their LATEST completed review's recommendation. Archived reviews count
// (archiving is list housekeeping, not deletion), and failed/cancelled runs
// don't — someone's standing comes from their most recent finished verdict.
// Pure DB read; each row links to the underlying review.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireGuildAccess } from "@/lib/authz";
import { LocalTime } from "@/components/LocalTime";
import { RECO, CONFIDENCE_LABEL } from "@/components/ai-review-meta";
import type { Recommendation } from "@/lib/ai-review";

type ReportRow = {
  id: string;
  targetUserId: string;
  targetName: string | null;
  recommendation: string | null;
  confidence: string | null;
  crisisFlag: boolean;
  finishedAt: Date | null;
  messagesAnalyzed: number;
  reviewCount: number;
};

const GROUP_ORDER: Recommendation[] = [
  "strong_fit",
  "possible_fit",
  "not_yet",
  "concern",
];

export default async function AiReviewReportPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;
  await requireGuildAccess(guildId);

  // Latest done review per member. The window count runs before DISTINCT ON
  // picks the newest row, so reviewCount covers their whole history.
  const rows = await prisma.$queryRaw<ReportRow[]>`
    SELECT DISTINCT ON ("targetUserId")
      id,
      "targetUserId",
      "targetName",
      recommendation,
      verdict->>'confidence' AS confidence,
      COALESCE((verdict->>'crisisFlag')::boolean, false) AS "crisisFlag",
      "finishedAt",
      "messagesAnalyzed",
      COUNT(*) OVER (PARTITION BY "targetUserId")::int AS "reviewCount"
    FROM "AiReviewJob"
    WHERE "guildId" = ${guildId} AND status = 'done'
    ORDER BY "targetUserId", "finishedAt" DESC NULLS LAST
  `;

  const groups = GROUP_ORDER.map((rec) => ({
    rec,
    meta: RECO[rec],
    rows: rows
      .filter((r) => r.recommendation === rec)
      .sort(
        (a, b) => (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0)
      ),
  }));

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-center justify-between gap-3">
        <Link
          href={`/dashboard/${guildId}/ai-review`}
          className="text-sm text-white/50 hover:text-white/80"
        >
          ← All reviews
        </Link>
      </div>

      <h1 className="mt-3 text-2xl font-semibold tracking-tight">
        Contributor fit report
      </h1>
      <p className="mt-1 text-sm text-white/60">
        Everyone who has been reviewed, standing by their most recent completed
        review — {rows.length.toLocaleString()} member
        {rows.length === 1 ? "" : "s"} so far. A snapshot for planning, not a
        final word on anyone: people change, and so do reviews.
      </p>

      {rows.length === 0 ? (
        <div className="mt-8 rounded-2xl border border-dashed border-white/10 p-10 text-center text-white/60">
          No completed reviews yet — run one (or a batch) from the AI Reviews
          page and the report fills in.
        </div>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {groups.map((g) => (
              <div
                key={g.rec}
                className="rounded-xl bg-white/[0.02] p-3 ring-1 ring-white/10"
              >
                <p className="text-2xl font-semibold tabular-nums text-white/90">
                  {g.rows.length}
                </p>
                <span
                  className={`mt-1 inline-block rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ${g.meta.badge}`}
                >
                  {g.meta.label}
                </span>
              </div>
            ))}
          </div>

          {groups.map(
            (g) =>
              g.rows.length > 0 && (
                <section key={g.rec} className="mt-8">
                  <div className="flex items-center gap-2">
                    <h2
                      className={`rounded-md px-2 py-0.5 text-sm font-semibold ring-1 ${g.meta.badge}`}
                    >
                      {g.meta.label} · {g.rows.length}
                    </h2>
                    <p className="text-xs text-white/40">{g.meta.blurb}</p>
                  </div>
                  <ul className="mt-3 divide-y divide-white/5 overflow-hidden rounded-2xl ring-1 ring-white/10">
                    {g.rows.map((r) => (
                      <li key={r.targetUserId} className="bg-white/[0.02]">
                        <Link
                          href={`/dashboard/${guildId}/ai-review/${r.id}`}
                          className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03]"
                        >
                          <span className="min-w-0 flex-1 truncate text-sm text-white/90">
                            {r.targetName ?? r.targetUserId}
                            {r.crisisFlag && (
                              <span
                                className="ml-2 rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-200 ring-1 ring-amber-400/25"
                                title="This review raised a crisis signal for human follow-up"
                              >
                                ⚠ crisis flag
                              </span>
                            )}
                          </span>
                          <span className="hidden shrink-0 text-[11px] text-white/40 sm:inline">
                            {CONFIDENCE_LABEL[r.confidence ?? ""] ?? "—"}
                          </span>
                          <span className="hidden shrink-0 text-[11px] text-white/40 md:inline">
                            {r.messagesAnalyzed.toLocaleString()} msgs
                            {r.reviewCount > 1 && ` · ${r.reviewCount} reviews`}
                          </span>
                          <span className="shrink-0 text-[11px] text-white/40">
                            {r.finishedAt ? (
                              <LocalTime iso={r.finishedAt.toISOString()} />
                            ) : (
                              "—"
                            )}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              )
          )}
        </>
      )}
    </div>
  );
}
