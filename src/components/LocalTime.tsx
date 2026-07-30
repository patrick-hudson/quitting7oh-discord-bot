"use client";

// Renders a timestamp in the viewer's local timezone. Server components format
// dates in the server's timezone (UTC in Docker), so any server-rendered page
// should use this instead of toLocaleString(). suppressHydrationWarning lets
// the client re-render with the browser's timezone without a hydration error.

export function LocalTime({
  iso,
  className,
}: {
  iso: string;
  className?: string;
}) {
  return (
    <time dateTime={iso} title={iso} className={className} suppressHydrationWarning>
      {new Date(iso).toLocaleString()}
    </time>
  );
}
