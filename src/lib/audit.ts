// Fire-and-forget audit logging for bot actions. Every observable thing the
// bot does gets a row: what happened (kind + summary), how it went (status),
// and the structured details a mod would want when investigating (data).
//
// Contract: audit() NEVER throws and never blocks the caller — a DB hiccup
// must not break a Discord send. Failures degrade to a console warning.

import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

export type AuditStatus = "ok" | "warn" | "error";

export function audit(
  guildId: string,
  kind: string,
  summary: string,
  data?: Record<string, unknown>,
  status: AuditStatus = "ok"
): void {
  prisma.botAuditLog
    .create({
      data: {
        guildId,
        kind,
        status,
        summary,
        data: (data ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    })
    .catch((err) => {
      console.warn(`[audit] write failed for ${kind}:`, err);
    });
}
