import parser from "cron-parser";

export function isValidCron(expr: string): boolean {
  try {
    parser.parseExpression(expr);
    return true;
  } catch {
    return false;
  }
}

// Returns the next UTC fire time for a cron expression interpreted in `tz`.
// Returns null if the expression is invalid.
export function nextFireForCron(expr: string, tz: string, from = new Date()): Date | null {
  try {
    const it = parser.parseExpression(expr, { tz, currentDate: from });
    return it.next().toDate();
  } catch {
    return null;
  }
}

// Given a post's schedule fields, compute its next fire time.
//   - cron + (timezone || guildTz)  -> next cron occurrence
//   - runAt                         -> runAt itself, if still in the future
//   - neither                       -> null
export function computeNextFireAt(opts: {
  cron: string | null;
  runAt: Date | null;
  timezone: string | null;
  guildTimezone: string;
  from?: Date;
}): Date | null {
  const from = opts.from ?? new Date();
  if (opts.cron) {
    return nextFireForCron(opts.cron, opts.timezone || opts.guildTimezone, from);
  }
  if (opts.runAt) {
    return opts.runAt > from ? opts.runAt : null;
  }
  return null;
}

// Friendly preview of "next 3 occurrences" for the UI.
export function previewCron(expr: string, tz: string, count = 3): string[] {
  try {
    const it = parser.parseExpression(expr, { tz });
    return Array.from({ length: count }, () =>
      it.next().toDate().toLocaleString("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "short" })
    );
  } catch {
    return [];
  }
}
