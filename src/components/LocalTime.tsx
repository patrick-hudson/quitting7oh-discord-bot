"use client";

// Renders a timestamp in the viewer's local timezone. Server components format
// dates in the server's timezone (UTC in Docker), so any server-rendered page
// should use this instead of toLocaleString().
//
// Why the mounted flag: with suppressHydrationWarning, React keeps the
// server-rendered text (UTC) after hydration and won't swap it for the client
// value on its own. We need a real state transition to force one post-hydration
// re-render in the browser — where toLocaleString() resolves to local time and
// React patches the text node. A boolean that flips false→true does that; a
// setState with the already-local value would be a no-op (React bails on equal
// state) and leave the UTC text stuck, which is the bug this replaces.

import { useEffect, useState } from "react";

export function LocalTime({
  iso,
  className,
}: {
  iso: string;
  className?: string;
}) {
  // The value is unused in render — the state flip alone forces one
  // post-hydration re-render, on which toLocaleString() resolves to local.
  const [, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <time dateTime={iso} title={iso} className={className} suppressHydrationWarning>
      {new Date(iso).toLocaleString()}
    </time>
  );
}
