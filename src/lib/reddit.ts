// Minimal, credential-free Reddit reader for the new-post announcer.
//
// Reads a subreddit's public Atom feed (/r/<sub>/new.rss) — no API key, no
// OAuth. Reddit may throttle unauthenticated requests from datacenter IPs, so
// we poll politely (see REDDIT_POLL_SECONDS) and send an honest, descriptive
// User-Agent per Reddit's API rules. We never disguise the request as a browser
// — that violates Reddit's policy and risks an account/IP ban.
//
// Env:
//   REDDIT_USER_AGENT  descriptive UA; Reddit throttles generic/missing ones.

const PUBLIC_BASE = "https://www.reddit.com";

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
};

// Fetch the newest submissions for a subreddit, newest-first (feed order).
export async function fetchNewPosts(subreddit: string): Promise<RedditPost[]> {
  const url = `${PUBLIC_BASE}/r/${encodeURIComponent(subreddit)}/new/.rss`;
  const res = await fetch(url, {
    headers: { "User-Agent": userAgent(), Accept: "application/atom+xml" },
  });
  if (!res.ok) {
    throw new Error(`reddit ${url} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return parseAtomFeed(await res.text());
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
