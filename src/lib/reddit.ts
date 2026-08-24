// Reddit reader for the new-post announcer. Two modes:
//
//   - OAuth (preferred): when REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET are set,
//     authenticates app-only (client_credentials) and reads the JSON listing
//     from oauth.reddit.com. The free tier allows 100 requests/minute — far
//     above what the poller needs — and is not subject to the aggressive
//     anonymous throttling that 429s datacenter IPs.
//   - Public RSS (fallback): credential-free Atom feed (/r/<sub>/new.rss).
//     Works fine from residential IPs but Reddit throttles anonymous requests
//     from server/datacenter IPs hard, so expect intermittent 429s there.
//
// Both modes poll politely (see REDDIT_POLL_SECONDS) and send an honest,
// descriptive User-Agent per Reddit's API rules. We never disguise the request
// as a browser — that violates Reddit's policy and risks an account/IP ban.
//
// Env:
//   REDDIT_USER_AGENT    descriptive UA; Reddit throttles generic/missing ones.
//   REDDIT_CLIENT_ID     from a "script" app at reddit.com/prefs/apps (optional)
//   REDDIT_CLIENT_SECRET the app's secret (optional; both or neither)

const PUBLIC_BASE = "https://www.reddit.com";
const OAUTH_BASE = "https://oauth.reddit.com";

// Reddit asks for a unique, descriptive User-Agent in the format
// "<platform>:<app id>:<version> (by /u/<username>)". Operators should set
// REDDIT_USER_AGENT with their own Reddit username; this is a last-resort default.
function userAgent(): string {
  return (
    process.env.REDDIT_USER_AGENT ||
    "discord:quitting7oh-discord-bot:1.0.0 (by /u/quitting7oh)"
  );
}

export type RedditPost = {
  id: string; // base36 id, e.g. "1abcde"
  title: string;
  author: string; // without the "/u/" prefix
  permalink: string; // full URL to the post on reddit
  createdAt: Date;
  // Plain-text selftext body, extracted from the feed's <content>. Empty for
  // link/image posts (which carry no body in the feed).
  body: string;
  // Score at fetch time. 0 from the RSS path (feeds carry no score) and for
  // fresh content generally — see refreshMaturingScores for settled values.
  score: number;
};

// Fetch the newest submissions for a subreddit, newest-first (feed order).
// Uses the authenticated JSON API when credentials are configured, else the
// public RSS feed.
export async function fetchNewPosts(subreddit: string): Promise<RedditPost[]> {
  if (hasOauthCreds()) return fetchViaOauth(subreddit);
  return fetchViaRss(subreddit);
}

async function fetchViaRss(subreddit: string): Promise<RedditPost[]> {
  const url = `${PUBLIC_BASE}/r/${encodeURIComponent(subreddit)}/new/.rss`;
  const res = await fetch(url, {
    headers: { "User-Agent": userAgent(), Accept: "application/atom+xml" },
  });
  if (!res.ok) {
    throw new Error(`reddit ${url} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return parseAtomFeed(await res.text());
}

// ---------------------------------------------------------------------------
// OAuth (app-only) mode
// ---------------------------------------------------------------------------

function hasOauthCreds(): boolean {
  return Boolean(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET);
}

// App-only bearer token, cached until shortly before expiry. Reddit issues
// ~1h tokens; a failed refresh throws and the poller just retries next tick.
let cachedToken: { token: string; expiresAtMs: number } | null = null;

async function getAppToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedToken && Date.now() < cachedToken.expiresAtMs) {
    return cachedToken.token;
  }
  const basic = Buffer.from(
    `${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`
  ).toString("base64");
  const res = await fetch(`${PUBLIC_BASE}/api/v1/access_token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "User-Agent": userAgent(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    throw new Error(
      `reddit oauth token ${res.status}: ${(await res.text()).slice(0, 200)}`
    );
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("reddit oauth token: no access_token in response");
  cachedToken = {
    token: data.access_token,
    // Refresh a minute early so we never race the expiry.
    expiresAtMs: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000,
  };
  return cachedToken.token;
}

// Authenticated GET with a one-shot token refresh on 401, parsed as JSON.
async function oauthJson<T>(url: string): Promise<T> {
  let res = await oauthGet(url, await getAppToken());
  if (res.status === 401) {
    // Token revoked/expired early — mint a fresh one and retry once.
    res = await oauthGet(url, await getAppToken(true));
  }
  if (!res.ok) {
    throw new Error(`reddit ${url} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

type RedditListing = { data?: { children?: Array<{ data?: RedditListingChild }> } };

async function fetchViaOauth(subreddit: string): Promise<RedditPost[]> {
  const listing = await oauthJson<RedditListing>(
    `${OAUTH_BASE}/r/${encodeURIComponent(subreddit)}/new.json?limit=25&raw_json=1`
  );
  const children = listing.data?.children ?? [];
  const posts: RedditPost[] = [];
  for (const c of children) {
    const d = c.data;
    if (!d?.id) continue;
    posts.push({
      id: d.id,
      title: d.title || "(untitled)",
      author: d.author || "[deleted]",
      permalink: d.permalink ? `${PUBLIC_BASE}${d.permalink}` : `${PUBLIC_BASE}/r/${subreddit}`,
      createdAt: d.created_utc ? new Date(d.created_utc * 1000) : new Date(),
      // selftext is markdown; fine as-is for a short embed snippet. Empty for
      // link/image posts, matching the RSS path's behavior.
      body: (d.selftext ?? "").trim(),
      score: d.score ?? 0,
    });
  }
  return posts;
}

function oauthGet(url: string, token: string): Promise<Response> {
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": userAgent(),
      Accept: "application/json",
    },
  });
}

// Whether the OAuth reader is configured. Comment sinking requires it —
// anonymous RSS can't sustain comment-volume polling from a server IP.
export function redditOauthEnabled(): boolean {
  return hasOauthCreds();
}

export type RedditComment = {
  id: string; // base36 id, e.g. "m1abcd"
  author: string;
  body: string; // markdown source, as written
  permalink: string; // full URL to the comment
  postUrl: string; // full URL to the parent thread (the post)
  postTitle: string; // title of the post the comment is on
  createdAt: Date;
  score: number; // at fetch time; see refreshMaturingScores
};

// A comment permalink is /r/<sub>/comments/<postid>/<slug>/<commentid>/ —
// dropping the trailing comment id yields the thread URL.
export function threadUrlFromCommentPermalink(permalink: string): string {
  const m = permalink.match(/^(.*\/comments\/[^/]+\/[^/]+\/)[^/]+\/?$/);
  return m ? m[1] : permalink;
}

// Newest comments across the whole subreddit (all threads), newest-first.
// OAuth-only — callers gate on redditOauthEnabled().
export async function fetchNewComments(subreddit: string): Promise<RedditComment[]> {
  const listing = await oauthJson<RedditListing>(
    `${OAUTH_BASE}/r/${encodeURIComponent(subreddit)}/comments.json?limit=100&raw_json=1`
  );
  const children = listing.data?.children ?? [];
  const out: RedditComment[] = [];
  for (const c of children) {
    const d = c.data;
    if (!d?.id) continue;
    const permalink = d.permalink
      ? `${PUBLIC_BASE}${d.permalink}`
      : `${PUBLIC_BASE}/r/${subreddit}`;
    out.push({
      id: d.id,
      author: d.author || "[deleted]",
      body: (d.body ?? "").trim(),
      permalink,
      postUrl: d.link_permalink ?? threadUrlFromCommentPermalink(permalink),
      postTitle: d.link_title ?? "",
      createdAt: d.created_utc ? new Date(d.created_utc * 1000) : new Date(),
      score: d.score ?? 0,
    });
  }
  return out;
}

type RedditListingChild = {
  id?: string;
  title?: string;
  author?: string;
  permalink?: string; // site-relative, e.g. "/r/foo/comments/..."
  created_utc?: number; // seconds
  score?: number;
  selftext?: string; // posts
  body?: string; // comments
  link_title?: string; // comments: the parent post's title
  link_permalink?: string; // comments: full URL of the parent post
};

// Current scores for up to 100 things per call (t3_/t1_ fullnames) via
// /api/info — the cheap way to re-read settled karma after votes accumulate.
// OAuth-only; callers gate on redditOauthEnabled().
export async function fetchInfoScores(
  fullnames: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < fullnames.length; i += 100) {
    const batch = fullnames.slice(i, i + 100);
    const listing = await oauthJson<{
      data?: { children?: Array<{ data?: { name?: string; score?: number } }> };
    }>(`${OAUTH_BASE}/api/info.json?id=${batch.join(",")}&raw_json=1`);
    for (const c of listing.data?.children ?? []) {
      if (c.data?.name) out.set(c.data.name, c.data.score ?? 0);
    }
  }
  return out;
}

// Minimal Atom parser for Reddit's RSS. Reddit emits stable, well-formed Atom,
// so a targeted per-<entry> extraction is enough — we avoid an XML dependency.
export function parseAtomFeed(xml: string): RedditPost[] {
  const posts: RedditPost[] = [];
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const entry = m[1];
    const fullname = pick(entry, /<id>([\s\S]*?)<\/id>/); // e.g. "t3_1abcde"
    const title = decodeEntities(pick(entry, /<title>([\s\S]*?)<\/title>/));
    const href = pick(entry, /<link[^>]*href="([^"]+)"/);
    const authorRaw = decodeEntities(pick(entry, /<author>[\s\S]*?<name>([\s\S]*?)<\/name>/));
    const published =
      pick(entry, /<published>([\s\S]*?)<\/published>/) ||
      pick(entry, /<updated>([\s\S]*?)<\/updated>/);
    const content = pick(entry, /<content[^>]*>([\s\S]*?)<\/content>/);
    if (!fullname || !href) continue; // skip malformed entries

    const ts = published ? new Date(published) : new Date(NaN);
    posts.push({
      id: fullname.replace(/^t3_/, ""),
      title: title || "(untitled)",
      author: authorRaw.replace(/^\/u\//, ""), // Reddit author names are "/u/name"
      permalink: href,
      createdAt: Number.isNaN(ts.getTime()) ? new Date() : ts,
      body: extractBody(content),
      score: 0,
    });
  }
  return posts;
}

// Pull the selftext body out of a feed entry's <content>. Reddit brackets the
// rendered body with "<!-- SC_OFF -->...<!-- SC_ON -->" comment markers, then
// appends a "submitted by ... [link] [comments]" footer. We take only what's
// between the markers (so the footer is dropped) and flatten it to plain text.
// Link/image posts have no such block, so this returns "".
function extractBody(rawContent: string): string {
  if (!rawContent) return "";
  // The <content> text is escaped HTML; decode once to get real HTML.
  const html = decodeEntities(rawContent);
  const block = html.match(/<!--\s*SC_OFF\s*-->([\s\S]*?)<!--\s*SC_ON\s*-->/);
  if (!block) return "";
  return htmlToText(block[1]);
}

// Best-effort HTML → plain text for a short embed snippet. Keeps line breaks
// from <br>/<p>/<li>, strips the rest, and decodes entities a second time
// (body-level entities were double-escaped in the feed).
function htmlToText(html: string): string {
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/(div|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function pick(s: string, re: RegExp): string {
  const m = s.match(re);
  return m ? m[1].trim() : "";
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
