"use client";

// Renders a timestamp in the viewer's local timezone. Server components format
// dates in the server's timezone (UTC in Docker), so any server-rendered page
// should use this instead of toLocaleString().
//
// The subtlety: React keeps the server-rendered DOM text after hydration but
// records the *client's* render value in its virtual tree. If the client
// render computed the local value directly, every later render would also
// compute local — matching React's vdom — so React sees "no change" and never
// patches the stale UTC text in the DOM (this bit us twice).
//
// Fix: render a DETERMINISTIC UTC value pre-mount (so server and the first
// client render genuinely agree — vdom == DOM), then switch to the browser's
// local zone after mount. Now the vdom text actually changes (UTC → local),
// forcing React to patch the DOM. Cost: the first paint shows UTC for a moment
// before it snaps to local — acceptable, and reliable.

import { useEffect, useState } from "react";

export function LocalTime({
  iso,
  className,
}: {
  iso: string;
  className?: string;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const d = new Date(iso);
  const text = mounted
    ? d.toLocaleString()
    : d.toLocaleString("en-US", { timeZone: "UTC" });

  return (
    <time dateTime={iso} title={iso} className={className} suppressHydrationWarning>
      {text}
    </time>
  );
}
