// Best-effort redaction for sharing an AI review without identifying the
// member. Deterministic and framework-free so it runs client-side on already
// stored reviews (no extra model call). It reliably strips the SUBJECT's own
// identifiers — their display name, user id, and any ids/emails/links in the
// text. It cannot know third-party first names typed as plain prose inside a
// quote, so the UI pairs it with a "skim before sharing" note.

import type { AiVerdict } from "@/lib/ai-review";

export type RedactOpts = {
  names?: Array<string | null | undefined>;
  ids?: Array<string | null | undefined>;
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactString(text: string, opts: RedactOpts): string {
  if (!text) return text;
  let out = text;
  // Links and emails first (before id/digit masking eats parts of them).
  out = out.replace(/https?:\/\/\S+/gi, "[link]");
  out = out.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "[email]");
  // Explicit ids we know, then any remaining Discord-snowflake-length digit run.
  for (const id of opts.ids ?? []) {
    const v = (id ?? "").trim();
    if (v) out = out.replace(new RegExp(escapeRegExp(v), "g"), "[id]");
  }
  out = out.replace(/\b\d{17,21}\b/g, "[id]");
  // The member's name (and any aliases), case-insensitive. Guard against very
  // short names that would over-redact common words.
  for (const name of opts.names ?? []) {
    const v = (name ?? "").trim();
    if (v.length >= 3) out = out.replace(new RegExp(escapeRegExp(v), "gi"), "[member]");
  }
  return out;
}

export type RedactedReportMeta = {
  name: string | null;
  userId: string;
  recoLabel: string;
  confidenceLabel: string;
  finishedAt: string | null;
  messagesAnalyzed: number;
};

// A plain-text, de-identified version of the review suitable for pasting into a
// mod channel or doc. Deliberately omits the outreach draft (it's a direct,
// named message to the member) and the crisis detail (a human-only quote) —
// leaving only a flag that one exists.
export function buildRedactedReport(
  verdict: AiVerdict,
  meta: RedactedReportMeta
): string {
  const R = (t?: string) =>
    redactString(t ?? "", { names: [meta.name], ids: [meta.userId] });
  const lines: string[] = [];
  lines.push("AI contributor-fit review — [member]");
  if (meta.finishedAt) lines.push(`Generated ${meta.finishedAt}`);
  lines.push("");
  lines.push(`Recommendation: ${meta.recoLabel} (${meta.confidenceLabel})`);
  lines.push("");

  if (verdict.summary) {
    lines.push("Summary:");
    lines.push(R(verdict.summary));
    lines.push("");
  }

  const section = (title: string, points: AiVerdict["strengths"]) => {
    if (!points || points.length === 0) return;
    lines.push(`${title}:`);
    for (const p of points) {
      lines.push(`- ${R(p.point)}`);
      if (p.evidence) {
        lines.push(`    "${R(p.evidence)}"${p.context ? ` — ${R(p.context)}` : ""}`);
      }
    }
    lines.push("");
  };
  section("Strengths", verdict.strengths);
  section("Concerns", verdict.concerns);

  if (verdict.crisisFlag) {
    lines.push(
      "⚠ A safety/crisis signal was flagged for internal review (details withheld from this shared copy)."
    );
    lines.push("");
  }

  lines.push(`Based on ${meta.messagesAnalyzed.toLocaleString()} messages.`);
  return lines.join("\n").trim();
}
