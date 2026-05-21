import { NextResponse } from "next/server";
import { AuthError } from "@/lib/authz";
import { ZodError } from "zod";

// Wrap a route handler so thrown AuthError/ZodError become clean JSON.
export function withErrors<T extends (...args: never[]) => Promise<Response>>(handler: T): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof AuthError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      if (err instanceof ZodError) {
        return NextResponse.json({ error: "Validation failed", issues: err.issues }, { status: 400 });
      }
      console.error("API error:", err);
      const msg = err instanceof Error ? err.message : "Internal error";
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }) as T;
}
