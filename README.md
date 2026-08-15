# Quitting 7OH Bot

Discord bot plus admin portal for a kratom/7-OH recovery community. The bot posts meeting reminders, hands out milestone roles, announces subreddit activity, and records everything it sees. The portal manages all of it: scheduling, member analytics, AI-assisted contributor vetting, server stats, backups, and logs.

Three processes share one Postgres database:

- **Bot** (`src/bot`): a discord.js worker running ten polling loops and four gateway listeners (table below).
- **Portal** (`src/app`): Next.js 15 App Router, Discord OAuth via Auth.js. Server components read the DB; slow work goes through job tables the bot polls.
- **Postgres + Prisma**: schema in `prisma/schema.prisma`, synced with `db push` (no migration files, see [MIGRATIONS.md](MIGRATIONS.md)).

## Feature map

Grouped the way the portal sidebar groups them.

### Posting

| Page | Job |
| --- | --- |
| Posts / New post | Scheduled messages: cron or one-off, fan-out to multiple channels, plain or embed, role mentions, `{meetingTime}` placeholders that render in each viewer's timezone. "Fire now" button for out-of-band sends. |
| Bulk-edit posts | Edit lead times, reminders, and skip modes across many posts at once. |
| Defaults | The guild-wide reminder-template roster, used when a post has no reminder text of its own. |

Posts can skip a scheduled fire when the channel hasn't moved since the last one (`recent` mode counts scrollback, `auto` mode decides from real activity). An optional follow-up reminder replies to the original post N minutes before the meeting. Details in [REMINDERS.md](REMINDERS.md).

### Members

| Page | Job |
| --- | --- |
| Leaderboard | Top 250 contributors: totals, 7d/30d, active days, posting consistency, tenure, per-member channel drill-down. Precomputed in the background; departed members keep their last known name via snapshots. |
| Milestones | Self-claim recovery milestone roles from a button message (24h through 2+ years). Role auto-creation with color themes, congrats posts, quiet reset. Section below. |
| Bulk-edit templates | Congrats/ephemeral template rosters per tier. |
| AI reviews | Claude-backed contributor-fit reviews of a member's message history. Single, batch, report, and share views. Section below. |

The bot also DMs a welcome message on join (roster-based, skips closed DMs) and announces departures to a channel (`{user}`, `{count}`, `{profile}` placeholders; fires the same for leaves, kicks, and bans because Discord's gateway doesn't distinguish).

### Records

| Page | Job |
| --- | --- |
| Audit log | Every action the bot takes: post fires, DMs, claims, review runs, stats builds. Filter chips per category. Pruned after 90 days. |
| Mod log | Human moderation: bans, kicks, timeouts, message deletions with cached content. Never pruned. |
| Snapshots | Nightly + on-demand structural snapshots (roles, channels, permission overwrites, members, emojis) with a diff view. |
| Export | Per-user message exports as Markdown zips, optionally with attachment bytes. Config export/import lives on Settings. |

The restore page rebuilds missing roles/channels and re-applies member roles from a snapshot. It only creates and adds, never deletes. The full suite, including the continuous message archive, is documented in [BACKUPS.md](BACKUPS.md).

### Server

| Page | Job |
| --- | --- |
| Server stats | Activity, growth, retention, and reaction analytics. Section below. |
| Settings | Timezone, admin role, Reddit announcer, departure posts, welcome DMs, archive toggle, config backup/restore. |

The Reddit announcer watches up to 10 subreddits and posts each new submission into one channel as an embed. Per-subreddit high-water marks mean adding a subreddit never dumps its backlog, and one failed poll never blocks the others. It reads Reddit's public RSS by default and switches to OAuth when script-app credentials are set ([REDDIT.md](REDDIT.md)).

## Background workers

All run inside the bot process. Each polls the DB on its own cadence; none block another.

| Worker | Cadence | Job |
| --- | --- | --- |
| `scheduler` | 30s | Fire due posts, substitute placeholders, schedule reminders |
| `reddit-poller` | 5m | Announce new posts from watched subreddits |
| `user-export-worker` | poll | Build per-user Markdown zip exports |
| `archive-worker` | 1h | Continuous JSONL + media archive of every readable channel |
| `snapshot-worker` | poll + nightly | Collect structural snapshots with per-step progress |
| `restore-worker` | poll | Non-destructive rebuild from a snapshot |
| `leaderboard-worker` | 6h | Recompute the contributor leaderboard cache |
| `ai-review-worker` | 15s | Run queued AI fit reviews, one at a time |
| `stats-worker` | 60m | Recompute the server-stats cache |
| `reaction-backfill` | 5m | One-time crawl of archived messages to recover historical reactions |
| `leave-announcer`, `welcome-dm`, `mod-log`, `milestones` | event-driven | Gateway listeners |

The stats worker is gateway-free and can move to its own container if the bot ever needs the headroom: uncomment the `stats-worker` service in `docker-compose.prod.yml` and set `STATS_REFRESH_MINUTES=0` on the bot.

## Companion docs

- [KA_MEETINGS.md](KA_MEETINGS.md): the seeded Kratom Anonymous meeting posts + seeder script.
- [REMINDERS.md](REMINDERS.md): follow-up reminders and the bulk-enable scripts.
- [REDDIT.md](REDDIT.md): the Reddit announcer.
- [BACKUPS.md](BACKUPS.md): snapshots, diffs, config export/import, message archive, restore assist.
- [LEAD_TIME.md](LEAD_TIME.md): changing a post's warning lead time (preview/apply scripts).
- [MIGRATIONS.md](MIGRATIONS.md): schema-change workflow (manual SQL + additive `db push`).
- [LIGHTSAIL.md](LIGHTSAIL.md): moving from local Docker to AWS Lightsail.
- [UPGRADE_PLAN.md](UPGRADE_PLAN.md): staged dependency-upgrade plan.

## First-time setup

### 1. Create a Discord application

1. https://discord.com/developers/applications → "New Application".
2. **OAuth2 → General**: add redirect URL `http://localhost:3000/api/auth/callback/discord` (and your production URL later). Copy **Client ID** and **Client Secret**.
3. **Bot**: create a bot, copy the **Token**. Disable "Public Bot" if you want to be the only one who can invite it.
4. **Bot → Privileged Gateway Intents**: enable **Server Members Intent** (milestone roles, membership checks) and **Message Content Intent** (mod log records deleted messages with their text). The bot won't start without them. The non-privileged intents it uses (guilds, messages, moderation events, reactions) need no toggle.
5. Invite the bot. OAuth2 URL Generator: scope `bot`, permissions **View Channels**, **Send Messages**, **Embed Links**, **Manage Roles**, **Read Message History** (archive, exports, review scans), **View Audit Log** (mod-log attribution). Add **Mention @everyone, @here, and All Roles** if posts will ping roles.
6. Server Settings → Roles: drag the bot's role **above** every role it will manage. Discord only lets it create/edit/delete roles below its own.

### 2. Configure env

```bash
cp .env.example .env
```

Required: `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `AUTH_SECRET` (`openssl rand -base64 32`), `AUTH_TRUST_HOST=true`, and your own Discord user ID in `BOOTSTRAP_ADMIN_USER_IDS` (Developer Mode on → right-click your name → Copy User ID) so you can sign in.

Optional, per feature:

- `ANTHROPIC_API_KEY` turns on AI reviews. Without it, queued reviews fail with a clear error and everything else runs.
- `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` (free script app at reddit.com/prefs/apps) switch the Reddit announcer from anonymous RSS to OAuth. Set these when hosting on a VPS; Reddit rate-limits anonymous reads from datacenter IPs.
- Tuning knobs, all with sane defaults: `SCHEDULER_POLL_SECONDS`, `REDDIT_POLL_SECONDS`, `REDDIT_USER_AGENT`, `ARCHIVE_POLL_SECONDS`, `ARCHIVE_MEDIA_FILE_CAP_MB`, `ARCHIVE_DIR`, `USER_EXPORT_SCAN_LIMIT`, `POST_AUTO_SKIP_MIN_MESSAGES`, `LEADERBOARD_REFRESH_HOURS`, `STATS_REFRESH_MINUTES`, `AI_REVIEW_MODEL`, `AI_REVIEW_MAP_MODEL`, `AI_REVIEW_MAX_INPUT_TOKENS`, `AI_REVIEW_MAX_MESSAGES`. Each is documented in `.env.example`.

### 3. Run it

```bash
docker compose up --build
```

Four containers: `postgres`, `migrate` (one-shot `prisma db push`, then exits), `web` (Next.js on :3000), `bot`. `web` and `bot` wait for `migrate` to exit cleanly. Visit http://localhost:3000 and sign in with Discord; as a bootstrap admin you see every guild the bot is in.

### 4. Configure a guild

1. Pick the guild from the switcher.
2. **Settings**: timezone, admin role (anyone holding it in Discord can manage this guild in the portal), and the per-feature toggles (Reddit, departures, welcome DMs, archive).
3. **New post**: first meeting reminder.
4. **Milestones**: tiers, role auto-creation, publish the claim message.
5. Turn on the **archive** if you want exports, AI reviews, and reaction backfill to draw from full history instead of live scans.

## Local development

```bash
# Postgres (or: docker compose up postgres)
npm install
npx prisma db push

# two terminals
npm run dev        # portal on :3000
npm run bot        # worker, restarts on file change
```

## Project layout

```
prisma/schema.prisma        # all models: Guild, ScheduledPost, MilestoneConfig/Tier,
                            # MessageEvent, ReactionEvent, UserExportJob, AiReviewJob,
                            # BotAuditLog, ModerationLog, GuildSnapshot, SnapshotJob,
                            # ArchiveChannelState, RestoreJob, LeaderboardCache,
                            # StatsCache, Auth.js tables
src/
  app/
    dashboard/[guildId]/
      page.tsx              # post list
      new/, posts/          # create + edit + bulk-edit posts
      leaderboard/          # contributor leaderboard + drill-down
      stats/                # server stats dashboard
      ai-review/            # reviews list, detail/compare, fit report, prompt editor
      milestones/           # tiers, themes, publish; advanced/ = template rosters
      defaults/             # reminder-template roster
      export/               # user-message exports
      audit/, mod-log/      # logs
      snapshots/, restore/  # backups suite
      settings/             # guild settings + config backup
    api/guilds/[guildId]/   # one route group per feature (posts, milestones,
                            # leaderboard, stats, ai-review, export, user-export, snapshots,
                            # restore, archive, settings, config-export/import,
                            # channels, roles)
  bot/
    index.ts                # client, intents, event logging (messages + reactions)
    scheduler.ts            # due-post loop, placeholders, reminders, skip modes
    + workers listed in the table above
  components/               # portal UI; stats/ holds the recharts dashboard
  lib/
    ai-review.ts            # review gathering + model calls + default prompt
    server-stats.ts         # the stats aggregates
    leaderboard.ts, guild-snapshot.ts, snapshot-diff.ts, redact.ts
    discord-rest.ts         # every REST call the app makes
    authz.ts, api.ts, audit.ts, cron.ts, env.ts, db.ts
  middleware.ts             # sign-in gate
  auth.ts                   # Discord OAuth + Prisma adapter
```

## Scheduling model

A `ScheduledPost` has either a `cron` expression (recurring) or a `runAt` timestamp (one-off), plus an `active` flag. `nextFireAt` is pre-computed on every write so the scheduler's hot query is one indexed range scan:

```sql
SELECT * FROM ScheduledPost WHERE active = true AND nextFireAt <= now()
```

The bot polls every `SCHEDULER_POLL_SECONDS` (default 30). For each due post: substitute placeholders, fan out to every channel, update `lastFiredAt`, recompute `nextFireAt`. One-offs deactivate themselves after firing.

If every channel fails, `nextFireAt` moves forward 60s so a broken post isn't hammered each poll. If at least one channel succeeded the post advances normally; skipping the failing channel beats duplicating into the working ones. Semantics are at-least-once. For recovery-meeting reminders that's the right trade: a duplicate annoys, a miss hurts.

### Time placeholders

Post bodies and embed titles take `{meetingTime}` placeholders, replaced at send time with Discord timestamp markup (`<t:UNIX:X>`), which Discord renders in each viewer's timezone.

| Placeholder | Renders as |
| --- | --- |
| `{meetingTime}` | `9:00 PM` |
| `{meetingTime:T}` | `9:00:00 PM` |
| `{meetingTime:d}` | `5/21/2026` |
| `{meetingTime:D}` | `May 21, 2026` |
| `{meetingTime:f}` | `May 21, 2026 9:00 PM` |
| `{meetingTime:F}` | `Wednesday, May 21, 2026 9:00 PM` |
| `{meetingTime:R}` | `in 5 minutes` |

The meeting timestamp = send time + `leadMinutes`. A post firing 5 minutes early sets **Lead time** = `5` and writes `Meeting starting {meetingTime:R} at {meetingTime}`, which renders as `Meeting starting in 5 minutes at 9:00 PM`.

## Milestone roles

One pinned button message in a designated channel. Each button claims a recovery-time milestone; clicking grants the matching role and removes any other milestone role, so the badge always shows current tier. Honor-system by design: anyone can claim any tier, which fits a community where people legitimately restart their count. A quiet-reset path (portal action or self-service button) drops someone back without a congrats post.

The portal page manages the channel, message title/description, and tier list (label, emoji, role, sort order; defaults run 24 hours → 2+ years). **Auto-create roles** builds the Discord roles from a color theme (Earth, Wine, Slate, Autumn, Sandstone, Ember, Crimson, Rainbow), slotted directly below a chosen anchor role. Claims send a private ephemeral message (always) and, optionally, a public congrats post with `{user}`, `{tier}`, `{emoji}`, `{claimChannel}` placeholders, drawn from per-tier or guild-level template rosters.

"Replace existing" on auto-create deletes the old milestone roles first. A confirmation modal lists every role about to be deleted and is the only deletion path; only roles linked to milestone tiers can be touched.

## Leaderboard and AI reviews

`MessageEvent` records every message the bot sees (author, channel, timestamp, no content). The leaderboard aggregates it into a top-250 table, cached by the leaderboard worker so the page is a plain read, with a per-member drill-down and a "Run AI fit review" button on each row.

The AI reviewer reads one member's message history and asks Claude, framed as a careful hiring-manager reviewer for a peer-support role, for a structured verdict: recommendation (`strong_fit` / `possible_fit` / `not_yet` / `concern`), confidence, evidence-quoted strengths and concerns, a crisis flag routed separately from the fit question, and a ready-to-edit outreach draft. Histories that fit the token budget go to the verdict model in one pass; longer ones map-reduce through a cheaper model first. Messages come from the archive when enabled, live channel scans otherwise.

Around that core:

- **Batch reviews**: queue everyone active in the last N days (minimum-message floor, role exclusions via a chip picker, dry-run preview of the exact count before spending, cancel button, one summary DM at the end). Ad-hoc reviews jump the batch queue.
- **Fit report**: every member ever reviewed, grouped by their latest verdict.
- **Compare**: two reviews of the same member side by side, for tracking change over time.
- **Redacted share**: a de-identified copy of a review, safe to paste to other mods.
- **Bulk archive**: sweep finished reviews out of the list without deleting them.
- **Prompt editor**: the entire system prompt is overridable per guild; the default lives in `src/lib/ai-review.ts` and its guardrails (evidence discipline, no protected-characteristic inference, crisis routing) should survive any edit.

Reviews are decision support for humans, never an automated gate. Cost lives in the open: each review row records tokens spent and the model used.

## Server stats

The stats worker aggregates `MessageEvent`, `ReactionEvent`, nightly snapshots, and the logs into a cached dashboard: health tiles (members, online, weekly messages with trend, active members, engagement, stickiness), daily activity with a 7-day average, an hour×weekday heatmap in the guild's timezone, channel rankings with trends, member growth and joins/leaves, new-member activation, a retention cohort grid, posting-concentration buckets, a recovery pulse (milestone-tier distribution now and over time, claims per month, tenure of active members), reaction charts, all-time records, and a moderation trend.

Reactions are tracked live from the gateway, and a one-time backfill worker crawls the archive to recover who reacted to every archived message. Discord doesn't store when a reaction was added, so backfilled rows carry the message's timestamp and a `backfilled` flag.

## Access control

Two tiers, checked on every request in `src/lib/authz.ts`:

1. Discord IDs in `BOOTSTRAP_ADMIN_USER_IDS` manage every guild the bot is in.
2. A guild's `adminRoleId` (set in Settings) grants that guild to anyone holding the role in Discord.

Everything else is denied. There are no portal-side accounts to manage; Discord is the source of truth.

## Hosting

`docker compose -f docker-compose.prod.yml up -d` on a Lightsail VM works; images build via GitHub Actions. Pre-flight cleanup, persistent disk, HTTPS via Caddy, and ops basics live in [LIGHTSAIL.md](LIGHTSAIL.md).

## Deliberately absent

- Tests. Add Vitest when there's logic worth locking down; today the verification loop is typecheck + lint + smoke scripts against the dev DB.
- Slash commands. The bot posts and handles button interactions; it doesn't take commands.
- Email/password accounts. Discord OAuth plus the admin role covers it.
- Observability beyond `console.log` and the audit log. Hook up Pino + a shipper when traffic justifies it.
- Auto-promotion from a tracked "clean date." Milestone claims stay manual; auto-promotion would force admin-side relapse handling this community doesn't need.
