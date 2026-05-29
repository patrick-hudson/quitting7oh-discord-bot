# Reddit new-post announcements

The bot can watch **one subreddit per guild** and post an embed to a Discord
channel whenever that subreddit gets a new submission. Configure the subreddit
and channel on the guild's **Settings** page in the portal.

## No API key needed

This feature reads Reddit's **public RSS feed** (`/r/<sub>/new.rss`) — there's
no Reddit app, OAuth, or API key to set up. The only knob is an honest
User-Agent (below).

### Why not the official API?

Reddit's authenticated Data API is more robust, but creating an app now routes
through an approval/access process that isn't always available. The public RSS
feed needs no credentials. The trade-offs:

- **Less metadata.** RSS gives us the post title, author, permalink, timestamp,
  and — for self/text posts — the body. It does *not* expose a thumbnail or the
  NSFW flag as structured fields. Link/image posts carry no body in the feed, so
  those stay title-only; click through to see the link and comments.
- **Best-effort reliability.** Reddit may throttle unauthenticated requests,
  especially from datacenter IPs (i.e. a cloud host). We poll gently (default
  every 5 min) to stay under the radar. If Reddit starts returning 429/403, the
  bot logs it and retries on the next tick — it does not hammer or retry-spam.

### Honest User-Agent (important)

Reddit asks every client to send a unique, descriptive User-Agent and throttles
generic or missing ones. Set yours in `.env` (picked up by both compose stacks):

```sh
# Format: "<platform>:<app id>:<version> (by /u/<your-reddit-username>)"
REDDIT_USER_AGENT="discord:quitting7oh-discord-bot:1.0.0 (by /u/yourname)"
# How often each watched subreddit is polled, in seconds (default 300 = 5 min).
REDDIT_POLL_SECONDS="300"
```

**Do not** disguise the User-Agent as a web browser to dodge throttling — it
violates Reddit's [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)
("never lie about your User-Agent"; don't "mask how or why you are accessing
Reddit data") and risks getting your account and server IP banned. If the public
feed gets throttled, the right move is to obtain approved API access — not to
impersonate a browser.

## How it works

- The Guild row holds the config (`redditEnabled`, `redditSubreddit`,
  `redditChannelId`) plus a high-water mark (`redditLastPostAt`).
- The bot worker runs `runRedditPoller` alongside the post scheduler
  ([src/bot/reddit-poller.ts](src/bot/reddit-poller.ts)). Every
  `REDDIT_POLL_SECONDS` it fetches `/r/<sub>/new.rss` for each enabled guild.
- **First poll seeds a baseline** — it records the newest post's timestamp and
  announces nothing, so turning the feature on doesn't dump the last 25 posts.
- After that, every submission newer than `redditLastPostAt` is posted to the
  channel (oldest-first), then the mark advances. A submission is announced
  once; the mark guarantees no repeats even across restarts.
- Embeds are Reddit-orange, link to the post permalink, and show the author and
  subreddit. Self/text posts also include a ~300-char body snippet (extracted
  from the feed and stripped of HTML and Reddit's "submitted by" footer);
  link/image posts stay title-only.

Feed reader + parser: [src/lib/reddit.ts](src/lib/reddit.ts).

## Configure a guild

On the portal **Settings** page:

1. Tick **Announce new subreddit posts**.
2. Enter the **subreddit** name (no `r/` needed — a pasted `r/` is stripped).
3. Pick the **channel** to announce in.
4. Save. Within one poll interval the baseline is seeded; new posts from then on
   are announced.

Changing the subreddit later resets the high-water mark automatically, so the
new subreddit re-seeds its baseline instead of replaying old posts.

## Notes & limits

- **One subreddit per guild.** Watching multiple subs or fanning out to several
  channels isn't supported yet — it'd need a separate config table.
- **At-least-once-ish.** A transient Discord send failure drops that one
  announcement rather than blocking the feed (the mark still advances), mirroring
  the post scheduler's behavior.
- **Backlog cap.** Each poll reads one RSS page (~25 newest). If a subreddit
  posts more than that between polls, the oldest beyond the page are missed —
  a non-issue at the default 5-minute interval for normal subreddits.
- **The bot must be able to post** in the chosen channel (View Channel + Send
  Messages + Embed Links permissions).

## Migration

Additive only — three nullable columns + one boolean default on `Guild`,
applied by the `migrate` service's `prisma db push` on deploy. No backfill:
existing guilds default to `redditEnabled = false`. See [MIGRATIONS.md](MIGRATIONS.md).
