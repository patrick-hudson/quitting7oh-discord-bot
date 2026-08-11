"use client";

// A collapsible "Share (redacted)" panel that sits alongside the full review.
// Renders a de-identified copy of the verdict through the SAME formatted report
// component, so it looks exactly like the real report — just with the member's
// name, id, links and emails removed, and the outreach draft + crisis detail
// left out. Also offers a plain-text copy for pasting where markup won't
// render (a Discord message, a doc). No model call — works on any review.

import { useState } from "react";
import { buildRedactedReport, redactVerdict } from "@/lib/redact";
import { RECO, CONFIDENCE_LABEL } from "@/components/ai-review-meta";
import { VerdictReport } from "@/components/VerdictReport";
import { CopyButton } from "@/components/CopyButton";
import type { AiVerdict } from "@/lib/ai-review";

export function RedactedShare({
  verdict,
  targetName,
  targetUserId,
  finishedAt,
  messagesAnalyzed,
}: {
  verdict: AiVerdict;
  targetName: string | null;
  targetUserId: string;
  finishedAt: string | null; // ISO date (yyyy-mm-dd), for the plaintext copy
  messagesAnalyzed: number;
}) {
  const [open, setOpen] = useState(false);

  const redacted = redactVerdict(verdict, { name: targetName, userId: targetUserId });
  const reco = RECO[verdict.recommendation] ?? RECO.not_yet;
  const plaintext = buildRedactedReport(verdict, {
    name: targetName,
    userId: targetUserId,
    recoLabel: reco.label,
    confidenceLabel: CONFIDENCE_LABEL[verdict.confidence] ?? verdict.confidence,
    finishedAt,
    messagesAnalyzed,
  });

  return (
    <div className="mt-8 rounded-xl bg-white/[0.02] ring-1 ring-white/10">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-sm font-medium text-white/80">
          Share (redacted)
          <span className="ml-2 text-xs font-normal text-white/45">
            de-identified copy to share
          </span>
        </span>
        <span className="text-white/40">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="border-t border-white/5 p-4">
          <div className="mb-4 flex items-center justify-between gap-2">
            <p className="text-xs text-white/50">
              Name, user ID, links and emails removed. The outreach draft and the
              crisis detail are left out of the shared copy.
            </p>
            <CopyButton
              text={plaintext}
              label="Copy as text"
              className="shrink-0 rounded-md bg-[color:var(--color-brand-600)] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90"
            />
          </div>

          <div className="rounded-xl bg-black/20 p-4 ring-1 ring-white/10">
            <VerdictReport
              verdict={redacted}
              meta={{
                messagesAnalyzed,
                finishedAtIso: null,
              }}
            />
          </div>

          <p className="mt-2 text-[11px] text-amber-200/70">
            Quotes may still contain a first name someone typed in plain text —
            skim the copy before sharing it externally.
          </p>
        </div>
      )}
    </div>
  );
}
