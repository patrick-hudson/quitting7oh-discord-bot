// Shared presentation metadata for the Reddit sourcing screen — label and
// recommendation badges. Client-safe (no SDK imports), used by the screening
// page and the bot's Discord alerts so wording stays in lockstep.

export const SCREEN_RECO: Record<
  string,
  { label: string; badge: string; blurb: string; rank: number }
> = {
  ban: {
    label: "Ban",
    badge: "bg-red-400/15 text-red-200 ring-red-400/25",
    blurb: "Using the sub to source or push the drug, no credible recovery intent.",
    rank: 0,
  },
  warn: {
    label: "Warn",
    badge: "bg-amber-400/15 text-amber-200 ring-amber-400/25",
    blurb: "Real sourcing or promotion with mixed signals — remove and warn.",
    rank: 1,
  },
  support: {
    label: "Support",
    badge: "bg-sky-400/15 text-sky-200 ring-sky-400/25",
    blurb: "Struggling to quit; flagged content was relapse- or taper-driven.",
    rank: 2,
  },
  no_action: {
    label: "No action",
    badge: "bg-white/10 text-white/60 ring-white/15",
    blurb: "Flags look like false positives.",
    rank: 3,
  },
};

export const UNASSESSED = {
  label: "Not assessed",
  badge: "bg-white/5 text-white/45 ring-white/10",
  rank: 4,
};

export const SCREEN_LABEL: Record<string, { label: string; badge: string }> = {
  sourcing: { label: "Sourcing", badge: "bg-red-400/15 text-red-200 ring-red-400/25" },
  promoting_use: {
    label: "Promoting use",
    badge: "bg-orange-400/15 text-orange-200 ring-orange-400/25",
  },
  taper_sourcing: {
    label: "Taper sourcing",
    badge: "bg-amber-400/10 text-amber-200/90 ring-amber-400/20",
  },
  struggling: { label: "Struggling", badge: "bg-sky-400/15 text-sky-200 ring-sky-400/25" },
  ok: { label: "OK", badge: "bg-white/5 text-white/50 ring-white/10" },
  error: { label: "Not screened", badge: "bg-white/5 text-white/40 ring-white/10" },
};
