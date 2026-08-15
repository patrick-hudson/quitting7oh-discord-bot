"use client";

// API-token management for the Settings page. Mints personal bearer tokens
// (plaintext shown exactly once), lists active ones, revokes. Tokens act as
// their creator across every guild they can manage — the card says so, since
// the guild-scoped page placement could suggest otherwise.

import { useCallback, useEffect, useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import { LocalTime } from "@/components/LocalTime";

type TokenRow = {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export function ApiTokens({ guildId }: { guildId: string }) {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [name, setName] = useState("");
  const [minted, setMinted] = useState<{ name: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/guilds/${guildId}/tokens`);
      if (!res.ok) return;
      const d = (await res.json()) as { tokens: TokenRow[] };
      setTokens(d.tokens);
    } catch {
      // list stays stale; the next action retries
    }
  }, [guildId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function mint() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/guilds/${guildId}/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const d = (await res.json().catch(() => ({}))) as {
        token?: string;
        name?: string;
        error?: string;
      };
      if (!res.ok || !d.token) throw new Error(d.error ?? "Couldn't create the token.");
      setMinted({ name: d.name ?? name.trim(), token: d.token });
      setName("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/guilds/${guildId}/tokens/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? "Revoke failed.");
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl bg-white/[0.02] p-6 ring-1 ring-white/5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
        API tokens
      </h2>
      <p className="mt-1 text-xs text-white/40">
        Bearer tokens for scripts and agents (see{" "}
        <code className="text-white/60">API.md</code>). A token acts as{" "}
        <span className="text-white/60">you</span> — same access, every guild you
        can manage, and its actions appear in the audit log under your ID.
        Revoke anything you stop using.
      </p>

      {minted && (
        <div className="mt-3 rounded-xl bg-amber-400/10 p-3 ring-1 ring-amber-400/25">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-amber-100">
              &ldquo;{minted.name}&rdquo; created — copy it now, it won&apos;t be
              shown again
            </p>
            <CopyButton text={minted.token} />
          </div>
          <p className="mt-1 break-all font-mono text-xs text-amber-100/80">
            {minted.token}
          </p>
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void mint()}
          placeholder="token name, e.g. claude-agent"
          className="min-w-0 flex-1 rounded-lg bg-white/5 px-3 py-1.5 text-sm ring-1 ring-white/10 placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-500)]"
        />
        <button
          type="button"
          disabled={busy || !name.trim()}
          onClick={() => void mint()}
          className="shrink-0 rounded-lg bg-[color:var(--color-brand-600)] px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          Create token
        </button>
      </div>

      {tokens.length > 0 && (
        <ul className="mt-4 divide-y divide-white/5 overflow-hidden rounded-xl ring-1 ring-white/10">
          {tokens.map((t) => (
            <li
              key={t.id}
              className="flex items-center gap-3 bg-white/[0.02] px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1 truncate text-white/80">{t.name}</span>
              <span className="shrink-0 font-mono text-xs text-white/40">
                {t.tokenPrefix}…
              </span>
              <span className="hidden shrink-0 text-[11px] text-white/40 sm:inline">
                {t.lastUsedAt ? (
                  <>
                    used <LocalTime iso={t.lastUsedAt} />
                  </>
                ) : (
                  "never used"
                )}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void revoke(t.id)}
                className="shrink-0 rounded-md px-2 py-1 text-xs text-red-300/80 ring-1 ring-red-400/20 hover:bg-red-400/10 disabled:opacity-50"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
