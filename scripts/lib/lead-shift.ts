// Shared helpers for the lead-time migration scripts
// (preview-lead-change.ts and apply-lead-change.ts).
//
// A scheduled post has two related fields:
//   - `cron`         — when the announcement fires
//   - `leadMinutes`  — how many minutes after the cron fires the actual
//                       meeting starts. {meetingTime} placeholders use this.
//
// So: meeting_time = cron_fire_time + leadMinutes.
//
// To change the *warning* lead time while keeping the meeting itself at
// the same wall-clock moment, the cron has to shift by (oldLead - newLead)
// minutes (negative if increasing lead — cron fires earlier).
//
// This module only supports cron expressions whose minute and hour
// fields are single integers. Lists, ranges, and steps in those fields
// would produce ambiguous output and are rejected with a clear error.

export type ShiftResult =
  | {
      ok: true;
      newCron: string;
      newMinute: number;
      newHour: number;
      // 0 if the shift stayed within the same day; +1/-1 if it wrapped
      // past midnight. Day-field semantics (DOW, DOM) are *not* adjusted
      // automatically — the caller needs to flag this for human review.
      dayShift: number;
    }
  | { ok: false; error: string };

export function shiftCronByMinutes(expr: string, deltaMinutes: number): ShiftResult {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { ok: false, error: `expected 5 cron fields, got ${parts.length}` };
  }
  const [mStr, hStr, ...rest] = parts;
  if (!/^\d+$/.test(mStr)) {
    return {
      ok: false,
      error: `minute field "${mStr}" is not a single integer — complex cron not supported`,
    };
  }
  if (!/^\d+$/.test(hStr)) {
    return {
      ok: false,
      error: `hour field "${hStr}" is not a single integer — complex cron not supported`,
    };
  }
  const minute = Number(mStr);
  const hour = Number(hStr);
  if (minute > 59 || hour > 23) {
    return { ok: false, error: `cron has out-of-range hour/minute: ${hour}:${minute}` };
  }

  const totalMin = hour * 60 + minute + deltaMinutes;
  const dayMinutes = 24 * 60;
  const dayShift = Math.floor(totalMin / dayMinutes);
  const normalized = ((totalMin % dayMinutes) + dayMinutes) % dayMinutes;
  const newHour = Math.floor(normalized / 60);
  const newMinute = normalized % 60;

  return {
    ok: true,
    newCron: `${newMinute} ${newHour} ${rest.join(" ")}`,
    newMinute,
    newHour,
    dayShift,
  };
}

// Pretty-print "HH:MM" from a cron-style hour/minute.
export function formatHM(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// Compute the meeting time implied by (cronHour, cronMinute, leadMinutes),
// normalized into the same day. Returns null for complex cron.
export function meetingTimeFromCron(
  expr: string,
  leadMinutes: number
): { hour: number; minute: number } | null {
  const shifted = shiftCronByMinutes(expr, leadMinutes);
  if (!shifted.ok) return null;
  return { hour: shifted.newHour, minute: shifted.newMinute };
}
