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
  required,
};
