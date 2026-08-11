function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  // Bootstrap allowlist — bypasses per-guild role check.
  bootstrapAdminIds(): Set<string> {
    return new Set(
      (process.env.BOOTSTRAP_ADMIN_USER_IDS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
  },
  schedulerPollSeconds(): number {
    return Number(process.env.SCHEDULER_POLL_SECONDS ?? "30");
  },
  redditPollSeconds(): number {
    return Number(process.env.REDDIT_POLL_SECONDS ?? "300");
  },

  // --- AI contributor-fit reviewer ---
  // Empty when unset; the ai-review worker no-ops (with an audit) rather than
  // crashing, so the rest of the bot is unaffected if the key isn't configured.
  anthropicApiKey(): string {
    return process.env.ANTHROPIC_API_KEY ?? "";
  },
  // Final synthesis model — quality where the verdict is written.
  aiReviewModel(): string {
    return process.env.AI_REVIEW_MODEL ?? "claude-sonnet-5";
  },
  // Cheap high-volume model for the per-chunk map step of long histories.
  aiReviewMapModel(): string {
    return process.env.AI_REVIEW_MAP_MODEL ?? "claude-haiku-4-5-20251001";
  },
  // Rough input-token ceiling that decides single-pass vs map-reduce, and
  // bounds the map chunk size. ~4 chars/token is the estimate used.
  aiReviewMaxInputTokens(): number {
    return Number(process.env.AI_REVIEW_MAX_INPUT_TOKENS ?? "150000");
  },
  // Hard cap on messages pulled per review (newest-first), so one prolific
  // member can't grind the worker or blow the token budget unbounded.
  aiReviewMaxMessages(): number {
    return Number(process.env.AI_REVIEW_MAX_MESSAGES ?? "60000");
  },
  required,
};
