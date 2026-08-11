// Shared presentation metadata for AI review recommendations — label + badge
// styling, keyed by the recommendation enum. Used by the reviews list and the
// review detail/compare views so the two stay in lockstep.

export const RECO: Record<
  string,
  { label: string; badge: string; blurb: string }
> = {
  strong_fit: {
    label: "Strong fit",
    badge: "bg-emerald-400/15 text-emerald-200 ring-emerald-400/25",
    blurb: "Clear, well-rounded evidence they'd be an asset now.",
  },
  possible_fit: {
    label: "Possible fit",
    badge: "bg-sky-400/15 text-sky-200 ring-sky-400/25",
    blurb: "Promising, with gaps worth watching or a short conversation first.",
  },
  not_yet: {
    label: "Not yet",
    badge: "bg-white/10 text-white/60 ring-white/15",
    blurb: "Not enough positive signal yet — worth revisiting later.",
  },
  concern: {
    label: "Concern",
    badge: "bg-red-400/15 text-red-200 ring-red-400/25",
    blurb: "Something in the messages argues against the role right now.",
  },
};

export const CONFIDENCE_LABEL: Record<string, string> = {
  low: "Low confidence",
  medium: "Medium confidence",
  high: "High confidence",
};
