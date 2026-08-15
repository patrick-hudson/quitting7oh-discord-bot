// Minimal Arctic Shift client for the one-time historical backfill. Arctic
// Shift (arctic-shift.photon-reddit.com) archives Reddit from 2005 to the
// present and serves it free of charge — "this is a free service, so be
// considerate", so the backfill worker paces requests and backs off the moment
// it sees a 429, a slow-down 422, or a 5xx while the service is degraded.
// Scores in the archive are settled values, which is exactly what
// the karma leaderboard wants for history.

import type { RedditComment, RedditPost } from "@/lib/reddit";

const BASE = "https://arctic-shift.photon-reddit.com";
const PUBLIC_BASE = "https://www.reddit.com";

function userAgent(): string {
  return (
    process.env.REDDIT_USER_AGENT ||
    "discord:quitting7oh-discord-bot:1.0.0 (by /u/quitting7oh)"
  );
}

// Any condition where the right response is "wait and retry": 429s, their
// 422 "maybe slow down" query timeouts, 5xx while the service is degraded,
// and network-level fetch failures. resetAtMs comes from X-RateLimit-Reset /
// X-RateLimit-Reset-At when the server sent one; null otherwise.
export class ArcticTransientError extends Error {
  constructor(detail: string, public resetAtMs: number | null) {
    super(`arctic shift unavailable, backing off (${detail})`);
    this.name = "ArcticTransientError";
  }
}

// X-RateLimit-Reset is "seconds until reset"; X-RateLimit-Reset-At is a
// timestamp. Prefer whichever parses.
function resetFromHeaders(res: Response): number | null {
  const secs = Number(res.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(secs) && secs > 0) return Date.now() + secs * 1000;
  const at = res.headers.get("x-ratelimit-reset-at");
  if (at) {
    const num = Number(at);
    const ts = Number.isFinite(num) && num > 1e9 ? num * (num < 1e12 ? 1000 : 1) : Date.parse(at);
    if (Number.isFinite(ts) && ts > Date.now()) return ts;
  }
  return null;
}

type ArcticItem = {
  id?: string;
  author?: string;
  subreddit?: string;
  created_utc?: number;
  score?: number;
  title?: string;
  selftext?: string;
  body?: string;
  permalink?: string;
  link_id?: string; // comments: "t3_<postid>"
};

async function search(
  kind: "posts" | "comments",
  subreddit: string,
  afterEpoch: number
): Promise<ArcticItem[]> {
  const params = new URLSearchParams({ subreddit, limit: "100", sort: "asc" });
  // First page has no cursor yet; the API rejects epoch 0 as a date.
  if (afterEpoch > 0) params.set("after", String(afterEpoch));
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/${kind}/search?${params.toString()}`, {
      headers: { "User-Agent": userAgent(), Accept: "application/json" },
    });
  } catch (err) {
    // DNS / connection / TLS-level failure — the service (or the network to
    // it) is down, which is transient by definition.
    throw new ArcticTransientError(
      `network: ${(err as Error).message?.slice(0, 80)}`,
      null
    );
  }
  // 429 = rate limited; 422 "Timeout. Maybe slow down a bit" is a server-side
  // query timeout under load; 5xx = the service is degraded outright. All
  // mean the same thing for us: cool off, don't error-spam. The docs say to
  // wait for the X-RateLimit-Reset(-At) headers when present.
  if (res.status === 429 || res.status >= 500) {
    throw new ArcticTransientError(String(res.status), resetFromHeaders(res));
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    if (res.status === 422 && /slow down|timeout/i.test(text)) {
      throw new ArcticTransientError(`422 ${text.slice(0, 60)}`, resetFromHeaders(res));
    }
    throw new Error(`arctic ${kind} ${res.status}: ${text}`);
  }
  const body = (await res.json()) as { data?: ArcticItem[] } | ArcticItem[];
  return Array.isArray(body) ? body : (body.data ?? []);
}

// Oldest-first page of posts created after `afterEpoch` (unix seconds).
export async function fetchArcticPosts(
  subreddit: string,
  afterEpoch: number
): Promise<RedditPost[]> {
  const items = await search("posts", subreddit, afterEpoch);
  const out: RedditPost[] = [];
  for (const d of items) {
    if (!d.id) continue;
    out.push({
      id: d.id,
      title: d.title || "(untitled)",
      author: d.author || "[deleted]",
      permalink: d.permalink
        ? `${PUBLIC_BASE}${d.permalink}`
        : `${PUBLIC_BASE}/r/${subreddit}/comments/${d.id}/`,
      createdAt: d.created_utc ? new Date(d.created_utc * 1000) : new Date(0),
      body: (d.selftext ?? "").trim(),
      score: d.score ?? 0,
    });
  }
  return out;
}

export async function fetchArcticComments(
  subreddit: string,
  afterEpoch: number
): Promise<RedditComment[]> {
  const items = await search("comments", subreddit, afterEpoch);
  const out: RedditComment[] = [];
  for (const d of items) {
    if (!d.id) continue;
    const postId = d.link_id?.replace(/^t3_/, "");
    out.push({
      id: d.id,
      author: d.author || "[deleted]",
      body: (d.body ?? "").trim(),
      permalink: d.permalink
        ? `${PUBLIC_BASE}${d.permalink}`
        : postId
          ? `${PUBLIC_BASE}/r/${subreddit}/comments/${postId}/_/${d.id}/`
          : `${PUBLIC_BASE}/r/${subreddit}`,
      postTitle: "", // the archive's comment records don't carry the post title
      createdAt: d.created_utc ? new Date(d.created_utc * 1000) : new Date(0),
      score: d.score ?? 0,
    });
  }
  return out;
}
