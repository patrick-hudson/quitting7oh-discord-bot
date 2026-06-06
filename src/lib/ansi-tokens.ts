// Friendly {token} → ANSI escape mapping used by both the scheduler (when
// sending to Discord) and the post preview (so admins see colors before
// publishing). Discord only renders these inside ```ansi``` code blocks; the
// substitution runs unconditionally, so tokens outside such a block just emit
// invisible escape bytes that Discord ignores in plain text.
export const ANSI_COLOR_TOKENS: Record<string, string> = {
  // Foregrounds (Discord's documented 30–37 palette)
  gray: "[30m",
  red: "[31m",
  green: "[32m",
  yellow: "[33m",
  blue: "[34m",
  pink: "[35m",
  cyan: "[36m",
  white: "[37m",
  // Styles
  bold: "[1m",
  underline: "[4m",
  reset: "[0m",
};

export function substituteAnsiColorTokens(text: string): string {
  return text.replace(/\{(\w+)\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(ANSI_COLOR_TOKENS, name)
      ? ANSI_COLOR_TOKENS[name]
      : m
  );
}
