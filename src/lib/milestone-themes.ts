// Color palettes for auto-creating milestone roles in Discord. Each theme is
// exactly 7 colors, in milestone order (24h → 30d → 60d → 90d → 6mo → 1yr → 2+yr).

export type Theme = {
  id: string;
  name: string;
  description: string;
  colors: string[]; // hex strings with #
};

// These palettes are deliberately picked to NOT conflict with common Discord
// staff role colors (Admin green, Mod purple, Booster/Head-mod pink, Verified
// blue, Retired-Staff teal, Contributor yellow). All themes live in color
// spaces those roles avoid: browns, wines, slates, rusts, warm neutrals.
// Color floor: Discord's dark theme background is roughly #313338. Any role
// color below ~30% HSL lightness disappears against it. Every theme's darkest
// tone is lifted to stay readable on dark mode.
// Color floor: Discord's dark theme background is roughly #313338. Any role
// color below ~30% HSL lightness disappears against it. Every theme's darkest
// tone is lifted to stay readable on dark mode. Each theme has 10 colors,
// matching the default tier set (24h, 3d, 1wk, 2wk, 30d, 60d, 90d, 6mo, 1yr,
// 2+yr).
export const THEMES: Theme[] = [
  {
    id: "earth",
    name: "Earth",
    description: "Cream → caramel → walnut. Grounded, recovery-themed browns.",
    colors: ["#F5E6CC", "#F0DDC0", "#EBD4B4", "#E5CBA7", "#E0C29B", "#C49968", "#A88157", "#896641", "#6F5132", "#5C4128"],
  },
  {
    id: "wine",
    name: "Wine",
    description: "Soft coral → burgundy. Warm reds, no pinks.",
    colors: ["#F5D5C0", "#F1CAB6", "#EDBEAD", "#E9B3A3", "#E5A799", "#C97C7A", "#B05F65", "#8A444B", "#6E3439", "#562930"],
  },
  {
    id: "slate",
    name: "Slate",
    description: "Steel blue → silver. Cool, composed. Reads as 'emerging into the light.'",
    colors: ["#7C8AA3", "#8794AD", "#919EB6", "#9CA8BE", "#A8B3C5", "#B6C0D0", "#C8D1DD", "#D6DDE7", "#DDE3EC", "#E8EDF3"],
  },
  {
    id: "autumn",
    name: "Autumn",
    description: "Peach → terracotta → russet. Seasonal warmth, distinct from yellow.",
    colors: ["#FFE0BB", "#FCD9B0", "#F9CDA1", "#F6C28D", "#F2B173", "#D87C3A", "#B66238", "#945030", "#783E27", "#5E3220"],
  },
  {
    id: "sandstone",
    name: "Sandstone",
    description: "Ivory → umber. Lighter mid-tones than Earth; warm neutral throughout.",
    colors: ["#F8EFE0", "#F3E9D6", "#EEE2CC", "#EADCC1", "#E5D5B7", "#C9AE82", "#A78554", "#8A6638", "#704D28", "#5A3D1F"],
  },
  {
    id: "ember",
    name: "Ember",
    description: "Bright peach → orange → fire → crimson. Saturated, alive.",
    colors: ["#FFC180", "#FFB572", "#FFA964", "#FF9D56", "#FF9248", "#FF6432", "#E83815", "#B82210", "#8E1F0C", "#6B1A09"],
  },
  {
    id: "crimson",
    name: "Crimson",
    description: "Light red → deep crimson. Pure reds, no pink shift — vivid and direct.",
    colors: ["#FF6B6B", "#FB6161", "#F75757", "#F34D4D", "#EF4444", "#DC2626", "#B91C1C", "#931A1A", "#761818", "#5A1616"],
  },
  {
    id: "rainbow",
    name: "Rainbow",
    description: "All ten colors. Wild, joyful, no rules. Will share shades with staff roles — pick this when that's the vibe.",
    colors: ["#FF3B30", "#FF5124", "#FF6818", "#FF7E0C", "#FF9500", "#FFD60A", "#34C759", "#007AFF", "#AF52DE", "#FF2D7E"],
  },
];

export function getTheme(id: string): Theme | undefined {
  return THEMES.find((t) => t.id === id);
}

// Discord stores role colors as integers, not strings. Convert "#RRGGBB" → int.
export function hexToInt(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  return Number.isNaN(n) ? 0 : n;
}
