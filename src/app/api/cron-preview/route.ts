import { NextResponse } from "next/server";
import { withErrors } from "@/lib/api";
import { requireSession } from "@/lib/authz";
import { previewCron } from "@/lib/cron";

export const GET = withErrors(async (req: Request) => {
  await requireSession();
  const url = new URL(req.url);
  const expr = url.searchParams.get("expr") ?? "";
  const tz = url.searchParams.get("tz") ?? "UTC";
  return NextResponse.json({ next: previewCron(expr, tz, 3) });
});
