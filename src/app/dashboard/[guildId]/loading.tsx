// Route-segment loading UI for every page under /dashboard/[guildId].
//
// Next.js renders this as the React Suspense fallback the moment a navigation
// to any child route begins — before the server has even started rendering —
// so clicking a sidebar link feels instant. The sidebar lives in the parent
// layout, so only the inset content area swaps to this skeleton; the chrome
// stays put.

import { Skeleton } from "@/components/ui/skeleton";

export default function GuildLoading() {
  return (
    <div className="space-y-6" aria-label="Loading" aria-busy="true">
      {/* Header: title + subtitle */}
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-80" />
      </div>

      {/* A handful of content rows in a card-ish shape — generic enough to
          stand in for posts lists, settings panels, milestone grids, etc. */}
      <div className="space-y-3 rounded-2xl bg-white/[0.02] p-5 ring-1 ring-white/5">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-3/4" />
      </div>

      <div className="space-y-3 rounded-2xl bg-white/[0.02] p-5 ring-1 ring-white/5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  );
}
