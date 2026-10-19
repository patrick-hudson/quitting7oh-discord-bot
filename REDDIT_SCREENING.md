# Reddit sourcing screen

Recovery subreddits attract people who aren't quitting. They show up asking
where to buy, which vendor hits hardest, or whether a shop still carries
something, and some offer to sell. The screen finds them. It also has to leave
alone the members the sub exists for: people who relapsed yesterday, people in
withdrawal, and people who name the product they're hooked on while telling
their story.

The screen never bans, removes, or messages anyone. It builds a queue, and a
mod makes each call on reddit. Two reasons:

- The bot reads reddit with app-only OAuth, which can't moderate.
- A false positive on someone who is struggling does real harm in a recovery
  space.

## How it works

Worker: [src/bot/reddit-screen-worker.ts](src/bot/reddit-screen-worker.ts).
Prompts and model calls: [src/lib/reddit-screen.ts](src/lib/reddit-screen.ts).

1. **Collection.** Screened subreddits are collected like
   leaderboard-monitored ones: the poller stores new posts and comments, and the
   Arctic Shift backfill pulls history. The screen makes no extra Reddit API
   calls.
2. **Item screen (cheap model, every minute).** Each unscreened post or comment
   newer than the "start from" date gets one label. Items go 20 per call:

   | Label | Meaning |
   | --- | --- |
   | `sourcing` | Seeking, offering, or facilitating getting the drug for use: where to buy, vendor questions, "DM me", offers to sell or share, vendor links |
   | `promoting_use` | Glorifying or encouraging use with no recovery framing: dosing for effect, potency rankings, urging someone to relapse |
   | `taper_sourcing` | Someone clearly quitting who asks where to get a taper product. A gray zone that gets flagged but isn't ban-worthy by itself |
   | `struggling` | Recovery content that involves use: relapse, cravings, withdrawal, naming their product as part of their own story |
   | `ok` | Everything else, including warnings about vendors that don't point anyone to a source |

   Each item also gets a `recoveryIntent` flag. A relapsing member who asks
   where to buy is still labeled `sourcing`, but with `recoveryIntent=true`, so
   the next stage can treat them differently. Every item gets one row in
   `RedditScreenItem` and is never paid for twice.
3. **Queue.** A medium- or high-confidence sourcing, promotion, or taper flag
   puts the author in the queue (`RedditScreenUser`). Taper-only users wait
   for a mod to click "Assess now". Sourcing and promotion flags trigger an
   assessment automatically.
4. **User assessment (verdict model).** The model reads everything collected
   from that user across your collected subreddits, with the item labels
   inline, and recommends one of:
   - **Ban:** sourcing or promotion with no credible recovery intent.
   - **Warn:** a real violation with mixed signals.
   - **Support:** relapse- or taper-driven content from someone trying to quit.
   - **No action:** the flags were false positives.

   The result includes evidence and mitigating quotes linked to the original
   items, plus a draft ban, warning, or support message. A user is re-assessed
   at most once an hour, so a burst of comments costs one assessment.
5. **Alerts.** If an alert channel is set, ban and warn recommendations go to
   it (once per new recommendation). So do possible crisis signals, framed as
   needing a caring response, not moderation.

## Mod decisions

Each queued user gets these buttons on the portal page:

- **Ban on reddit ↗** opens the subreddit's ban list on reddit.
- **Mark banned**, **Watch**, and **Dismiss** record your decision.
- **Re-assess** queues a fresh assessment.

If a dismissed or watched user picks up a new sourcing or promotion flag, they
go back to the open queue. Banned users are never re-assessed.

## Configure

Open **Reddit screening** in the portal sidebar, under Members:

1. Tick **Screen these subreddits for sourcing** and add the subreddits.
2. **Start from:** how far back to screen content that's already collected.
   It defaults to 7 days. Older backfilled history is never labeled, but it
   still feeds the user assessments as context.
3. **Alert channel:** a private mod channel, or none.
4. **Notes for the screen:** your sub's rules and slang, in plain sentences.
   Both prompts follow these over their defaults, for example "Plain-leaf
   taper questions are allowed here" or "'the green stuff' is slang for a
   specific vendor's product".

Requirements: `ANTHROPIC_API_KEY`, and `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET`
for comments. Without the OAuth reader only posts are collected and screened.

Models: `AI_SCREEN_MODEL` (item screen) and `AI_SCREEN_ASSESS_MODEL`
(assessment). They default to `AI_REVIEW_MAP_MODEL` and `AI_REVIEW_MODEL`.
The calls use `tool_choice: "auto"`, so newer models that reject forced tool
use work as well.

## Cost

The item screen sends about 20 items per call to the cheap model, so a busy
subreddit costs cents per day. Assessments run only for flagged users and are
capped at about 40k input tokens of history each. Per guild, each tick screens
at most 200 items and runs at most 5 assessments, so a large lookback works
through its backlog gradually instead of all at once. Token counts for each
pass land in the audit log (`redditscreen.screened`, `redditscreen.assessed`).

## Limits

- The screen classifies text only. Images, links to vendor sites without
  surrounding text, and DMs are invisible to it.
- RedditPost/RedditComment ids are global, so the same subreddit can't be
  screened by two guilds. That's the same limit the leaderboard has.
- Model output is decision support. Check the linked items before you ban.

## Migration

Additive only: five new `Guild` columns and two new tables
(`RedditScreenItem`, `RedditScreenUser`), applied by `prisma db push` on
deploy. See [MIGRATIONS.md](MIGRATIONS.md).
