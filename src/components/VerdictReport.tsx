// Presentational render of an AI review verdict — the formatted report card
// (crisis banner, recommendation badge, summary, strengths/concerns with quoted
// evidence, optional outreach draft, footer meta). Shared by the full review
// and the redacted share view so both look identical; the redacted view just
// feeds it a de-identified verdict (see redactVerdict). No hooks, so it renders
// in both server and client trees.

import { LocalTime } from "@/components/LocalTime";
import { CopyButton } from "@/components/CopyButton";
import { RECO, CONFIDENCE_LABEL } from "@/components/ai-review-meta";
import type { AiVerdict } from "@/lib/ai-review";

export type VerdictMeta = {
  messagesAnalyzed: number;
  source?: string | null;
  model?: string | null;
  totalTokens?: number | null;
  finishedAtIso?: string | null;
};

export function VerdictReport({
  verdict,
  meta,
  heading,
  headingDate,
}: {
  verdict: AiVerdict;
  meta: VerdictMeta;
  heading?: string | null;
  headingDate?: string | null;
}) {
  const reco = RECO[verdict.recommendation] ?? RECO.not_yet;
  const footer: string[] = [`${meta.messagesAnalyzed.toLocaleString()} messages analyzed`];
  if (meta.source) footer.push(`source: ${meta.source}`);
  if (meta.model) footer.push(meta.model);
  if (meta.totalTokens != null) footer.push(`${meta.totalTokens.toLocaleString()} tokens`);

  return (
    <div className="min-w-0">
      {heading && (
        <p className="mb-2 text-[11px] uppercase tracking-wide text-white/40">
          {heading}
          {headingDate ? ` · ${headingDate}` : ""}
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
        {footer.join(" · ")}
        {meta.finishedAtIso && (
          <>
            {" "}
            · <LocalTime iso={meta.finishedAtIso} />
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
