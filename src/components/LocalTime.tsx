"use client";

// Renders a timestamp in the viewer's local timezone. Server components format
// dates in the server's timezone (UTC in Docker), so any server-rendered page
// should use this instead of toLocaleString().
//
// Why the effect matters: with suppressHydrationWarning, React keeps the
// server-rendered text (UTC) after hydration and will NOT swap it for the
// client value on its own — so a hard refresh would stay stuck on UTC. The
// post-mount setState forces a re-render in the browser's timezone. (Soft
// client navigation renders fresh in the browser and was already correct; the
// refresh path is the one this fixes.)

import { useEffect, useState } from "react";

export function LocalTime({
  iso,
  className,
}: {
  iso: string;
  className?: string;
}) {
  const [text, setText] = useState(() => new Date(iso).toLocaleString());
  useEffect(() => {
    setText(new Date(iso).toLocaleString());
  }, [iso]);

  return (
    <time dateTime={iso} title={iso} className={className} suppressHydrationWarning>
      {text}
    </time>
  );
}
