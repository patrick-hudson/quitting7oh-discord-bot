import { NextResponse } from "next/server";
import { auth } from "@/auth";

// Protect all routes except /login, auth API, and Next.js internals.
export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isPublic =
    pathname === "/login" ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico";
  if (isPublic) return NextResponse.next();

  // API requests presenting a bearer token skip the cookie gate — the route
  // handlers validate the token via requireSession/requireGuildAccess
  // (src/lib/authz.ts), which 401s bad tokens. Only our token format passes;
  // everything else still needs a session.
  if (
    pathname.startsWith("/api/") &&
    req.headers.get("authorization")?.startsWith("Bearer q7t_")
  ) {
    return NextResponse.next();
  }

  if (!req.auth) {
    // A browser gets sent to sign in; an API caller gets a JSON 401 (a login
    // redirect is useless to a script and hides the real problem).
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "unauthorized — send Authorization: Bearer <token> (see API.md)" },
        { status: 401 }
      );
    }
    const url = new URL("/login", req.nextUrl.origin);
    url.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
  runtime: "nodejs",
};
