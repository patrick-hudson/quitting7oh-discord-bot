"use client";

// crontab.guru-style feedback for a cron expression input:
//   - labeled chips showing what each of the 5 fields is set to
//   - a live English description via cronstrue ("At 09:00 PM, only on Sunday…")
//   - an optional collapsible legend of the syntax
// Purely presentational — validation still happens server-side (isValidCron).

import cronstrue from "cronstrue";

const FIELD_LABELS = ["minute", "hour", "day (month)", "month", "weekday"] as const;

export function CronHint({
  expr,
  showLegend = false,
}: {
  expr: string;
  showLegend?: boolean;
}) {
  const trimmed = expr.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/\s+/);
  const description = describe(trimmed);

  return (
    <div className="mt-2 space-y-2">
      {/* Field-by-field breakdown */}
      <div className="flex flex-wrap gap-1.5">
        {parts.slice(0, 5).map((part, i) => (
          <span
            key={i}
            className="inline-flex items-baseline gap-1 rounded-md bg-white/5 px-2 py-0.5 ring-1 ring-white/10"
          >
            <span className="text-[10px] uppercase tracking-wide text-white/40">
              {FIELD_LABELS[i]}
            </span>
            <span className="font-mono text-xs text-white/80">{part}</span>
          </span>
        ))}
        {parts.length > 5 && (
          <span className="inline-flex items-center rounded-md bg-red-500/10 px-2 py-0.5 text-xs text-red-300 ring-1 ring-red-500/20">
            {parts.length - 5} extra field{parts.length - 5 === 1 ? "" : "s"} — cron takes 5
          </span>
        )}
      </div>

      {/* English description (or the reason it doesn't parse) */}
      {description.ok ? (
        <p className="text-sm text-white/70">
          <span className="text-white/40">“</span>
          {description.text}
          <span className="text-white/40">”</span>
        </p>
      ) : (
        <p className="text-xs text-amber-300/80">
          Can&apos;t read this expression yet{description.text ? ` — ${description.text}` : ""}.
        </p>
      )}

      {showLegend && (
        <details className="text-xs text-white/50">
          <summary className="cursor-pointer select-none hover:text-white/80">
            Cron syntax legend
          </summary>
          <div className="mt-2 overflow-hidden rounded-md ring-1 ring-white/10">
            <table className="w-full text-left">
              <tbody className="divide-y divide-white/5">
                <LegendRow sym="*" desc="any value" />
                <LegendRow sym="," desc="value list separator (1,15)" />
                <LegendRow sym="-" desc="range of values (9-17)" />
                <LegendRow sym="/" desc="step values (*/15 = every 15)" />
                <LegendRow sym="minute" desc="0–59" />
                <LegendRow sym="hour" desc="0–23" />
                <LegendRow sym="day (month)" desc="1–31" />
                <LegendRow sym="month" desc="1–12 or JAN–DEC" />
                <LegendRow sym="weekday" desc="0–6 (0 = Sunday) or SUN–SAT" />
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

function LegendRow({ sym, desc }: { sym: string; desc: string }) {
  return (
    <tr className="bg-white/[0.02]">
      <td className="w-28 px-3 py-1 text-right font-mono text-white/70">{sym}</td>
      <td className="px-3 py-1 text-white/50">{desc}</td>
    </tr>
  );
}

function describe(expr: string): { ok: boolean; text: string } {
  try {
    return {
      ok: true,
      text: cronstrue.toString(expr, { use24HourTimeFormat: false }),
    };
  } catch (err) {
    // cronstrue throws strings/Errors with usable messages; trim the prefix.
    const raw = err instanceof Error ? err.message : String(err);
    const cleaned = raw.replace(/^Error:\s*/i, "").slice(0, 120);
    return { ok: false, text: cleaned };
  }
}
