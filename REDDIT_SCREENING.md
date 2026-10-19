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

## Calibrate first

Before you turn the screen on, check its labels against your sub's real
content. [scripts/preview-reddit-screen.ts](scripts/preview-reddit-screen.ts)
runs the item screen over the newest collected posts and comments and prints
what it would label them. It writes nothing, so nothing gets queued, and the
worker still screens those items when you enable it.

The script only reads content that's already collected. A sub on the
screening list isn't collected until the screen is on. To calibrate first,
add the sub to the leaderboard's monitored subreddits, then let the poller
and backfill run.

```sh
# Dry run: shows the item count and estimated cost. Makes no API calls.
npx tsx scripts/preview-reddit-screen.ts <guildId> quittingcatsclaw --limit 100

# Classify for real (costs money; ~100 items on the default model is cents).
npx tsx scripts/preview-reddit-screen.ts <guildId> quittingcatsclaw --limit 100 --yes

# Try draft notes without saving them in the portal.
npx tsx scripts/preview-reddit-screen.ts <guildId> quittingcatsclaw --yes \
  --notes "Plain-leaf taper questions are allowed here."
```

Run it where the bot runs (same `DATABASE_URL`, `ANTHROPIC_API_KEY`, and
`AI_SCREEN_MODEL`). Without `--notes` it uses the guild's saved notes, and
`--notes ""` runs with none.

Flagged rows print first, each with the model's reason. The rows to check:

- **⚠** marks a flagged item whose author shows recovery intent. Most false
  positives you need to catch show up here, like a member in withdrawal who
  names the shop they relapsed at and gets labeled `sourcing`.
- **!!** marks a possible crisis signal.
- `stored label was:` appears when the worker already screened the item and
  labeled it differently. Use it to compare a notes change against the
  current labels.

After the table it prints label counts, how many items would queue a user,
and the actual token usage and cost. If struggling members keep getting
flagged, put the pattern in plain words in `--notes` and re-run until the
labels look right. Then save those notes in the portal and enable the screen.

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
