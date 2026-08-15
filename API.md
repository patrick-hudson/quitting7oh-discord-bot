# HTTP API

Machine-consumable reference for driving the portal programmatically — written
so an agent (or a script) holding a bearer token can operate every feature the
portal exposes. Everything here is the same API the portal's own UI calls.

## Authentication

Mint a token in the portal: **Settings → API tokens → Create token**. The
plaintext (`q7t_…`) is shown once. Send it on every request:

```
Authorization: Bearer q7t_<hex>
```

- A token acts **as its creator**: same guild access (bootstrap admin or
  per-guild admin role), and every mutating action lands in the audit log
  under the creator's Discord ID.
- `401 {"error":"invalid or revoked API token"}` = bad/revoked token.
  `401 unauthorized` = no credential at all. `403` = authenticated but no
  access to that guild.
- Token management routes (`/tokens`) reject token auth — only a browser
  session can mint or revoke.

## Conventions

- Base URL is the deployment origin (local dev: `http://localhost:3000`).
  All paths below are relative to `/api`.
- JSON in, JSON out, except three file endpoints (marked *file*).
- IDs (guilds, channels, roles, users, messages) are Discord snowflakes as
  **strings**. Timestamps are ISO 8601.
- Errors: `{"error": "<message>"}` with a 4xx/5xx status. Schema failures:
  `400 {"error":"Validation failed","issues":[…]}` (Zod issue objects).
- **Async job pattern**: POSTs marked *job* enqueue work for the bot worker,
  which picks it up on its next poll (15–60 s). Poll the paired GET until the
  job's `status` reaches `done` / `failed`.
- Flags: 💸 spends Anthropic API credits. ⚠️ writes to the live Discord
  server or sends messages members will see. Treat both as confirm-with-a-
  human actions unless you've been told otherwise.

## Start here

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/guilds` | `{guilds:[{id,name,timezone}]}` — every guild this token can manage |

All remaining routes are guild-scoped: `/guilds/{guildId}/…`.

## Reference data

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/guilds/{g}/channels` | `{channels:[{id,name,type,parent_id}]}` — text channels the bot sees |
| GET | `/guilds/{g}/roles` | `{roles:[{id,name,color,position,managed}]}` — @everyone and bot roles excluded |
| GET | `/guilds/{g}/settings` | Current guild settings (same fields PATCH accepts, plus `id`/`name`) |
| GET | `/guilds/{g}/defaults` | Current default message rosters |
| GET | `/cron-preview?expr=<cron>&tz=<iana>` | `{next:[iso,…]}` — next 3 fire times; validate cron before creating posts |

## Scheduled posts

| Method | Path | Body / notes |
| --- | --- | --- |
| GET | `/guilds/{g}/posts` | All scheduled posts, full rows (schedule, content, skip/reminder config, `lastFiredAt`, `nextFireAt`, `lastError`) |
| GET | `/guilds/{g}/posts/{id}` | One post |
| POST | `/guilds/{g}/posts` | Create. Body below. Returns the created post row. |
| PATCH | `/guilds/{g}/posts/{id}` | Same body shape; full update. |
| DELETE | `/guilds/{g}/posts/{id}` | Remove the post. |
| POST | `/guilds/{g}/posts/{id}/toggle` | Flip `active`. No body. |
| POST | `/guilds/{g}/posts/{id}/fire-now` | ⚠️ Sends the post to its channels within ~30 s. No body. |

Create/update body:

```jsonc
{
  "name": "Friday meeting",             // 1–120 chars
  "channelIds": ["…"],                  // 1–25 channel snowflakes
  "scheduleKind": "cron",               // "cron" | "oneoff"
  "cron": "0 19 * * 5",                 // when scheduleKind=cron
  "runAt": "2026-09-01T23:00:00Z",      // when scheduleKind=oneoff
  "timezone": "America/New_York",
  "useEmbed": false,
  "content": "Meeting {meetingTime:R} at {meetingTime}",  // 1–4000 chars
  "embedTitle": "", "embedColor": "", "embedUrl": "", "embedImage": "",
  "mentionRoleId": "",                  // optional role ping
  "leadMinutes": 5,                     // 0–1440; {meetingTime} = send time + this
  "skipMode": "off",                    // "off" | "recent" | "auto"
  "skipIfRecentWithin": null,           // 1–100, only for skipMode=recent
  "reminderMinutes": null,              // 1–1439, must be < leadMinutes; null = off
  "reminderContent": null               // null = guild's default roster
}
```

`{meetingTime}` placeholders (`:t :T :d :D :f :F :R` variants) render as
Discord native timestamps in each viewer's timezone.

## Guild settings

| Method | Path | Body / notes |
| --- | --- | --- |
| PATCH | `/guilds/{g}/settings` | `{timezone, adminRoleId, redditEnabled, redditSubreddits:[names], redditFirehoseSubreddits:[names], redditChannelId, redditFirehoseChannelId, leaveEnabled, leaveChannelId, welcomeDmEnabled, archiveEnabled}` — full replace; ⚠️ a wrong `adminRoleId` can lock admins out. Two independent Reddit streams: `redditSubreddits` announce new POSTS to `redditChannelId` (public); `redditFirehoseSubreddits` stream every COMMENT to `redditFirehoseChannelId` (mod-only; requires Reddit OAuth creds). A sub may be on both lists. Each non-empty list requires its channel. |
| PATCH | `/guilds/{g}/defaults` | `{reminderTemplates:[…], leaveTemplates:[…], welcomeDmTemplates:[…]}` — each ≤20 entries × ≤2000 chars; empty array = baked-in defaults |
| GET | `/guilds/{g}/config-export` | Full portable config JSON (settings + posts + milestones) |
| POST | `/guilds/{g}/config-import` | ⚠️ `{config:<export blob>, sections:{settings,posts,milestones}}` — imported posts arrive inactive; `adminRoleId` is never imported |

## Milestones ⚠️

These write roles and messages in the live server.

| Method | Path | Body / notes |
| --- | --- | --- |
| GET | `/guilds/{g}/milestones` | Config + tiers (seeds defaults on first call) |
| PATCH | `/guilds/{g}/milestones` | `{channelId, title, description, tiers:[{id?,label,emoji,roleId,sortOrder,congratsTemplates}], congratsEnabled, congratsChannelId, congratsTemplates, ephemeralTemplates}` — replaces the tier set |
| POST | `/guilds/{g}/milestones/auto-create` | `{themeId, labels:[…], replaceAll, belowRoleId}` — creates Discord roles from a color theme; `replaceAll:true` deletes old linked roles first |
| POST | `/guilds/{g}/milestones/publish` | Sends (or edits in place) the claim button-message. No body. |
| POST | `/guilds/{g}/milestones/reorder` | Repositions linked roles top-down. No body. |
| POST | `/guilds/{g}/milestones/reset` | `{userId, note?}` — quietly removes a member's milestone roles (no congrats post) |

## Leaderboard

| Method | Path | Returns / notes |
| --- | --- | --- |
| GET | `/guilds/{g}/leaderboard` | `{generatedAt, computing, data:{rows:[…], channelNames}}` — cached; rows carry `authorId, name, present, total, d7, d30, activeDays, consistency, channels, tenureDays, lastSeen, roleNames` |
| POST | `/guilds/{g}/leaderboard/refresh` | *job* — request recompute |
| GET | `/guilds/{g}/leaderboard/refresh` | `{generatedAt, computing, refreshRequested}` — poll until `generatedAt` advances |
| GET | `/guilds/{g}/leaderboard/{userId}` | Per-channel message breakdown for one member |

## Server stats

| Method | Path | Returns / notes |
| --- | --- | --- |
| GET | `/guilds/{g}/stats` | `{generatedAt, computing, data:<ServerStatsData>}` — the full cached stats blob: tiles, messagesPerDay, heatmap, channels, weekly/monthly actives, memberSeries, joinLeave, joinsPerMonth, activation, cohorts, concentration, records, recovery, reactions, moderation. Shape: `ServerStatsData` in `src/lib/server-stats.ts`. |
| POST | `/guilds/{g}/stats/refresh` | *job* — request recompute (worker rebuilds within ~1 min) |
| GET | `/guilds/{g}/stats/refresh` | `{generatedAt, computing, refreshRequested}` |

## AI reviews 💸

Every review is a real Claude API call (roughly $0.03–$0.75 per member
depending on history size). Batches multiply that — always dry-run first.

| Method | Path | Body / notes |
| --- | --- | --- |
| POST | `/guilds/{g}/ai-review` | *job* 💸 `{targetUserId, targetName?, sinceAt?, untilAt?, channelIds:[]}` → `{job:{id,status}}`. 409 if an ad-hoc review is already in flight. |
| GET | `/guilds/{g}/ai-review` | Job list, summary fields. Filters: `?status=`, `?targetUserId=`, `?batchId=`, `?archived=true\|false`, `?limit=` (≤500) |
| GET | `/guilds/{g}/ai-review/report` | Fit report: every reviewed member's latest completed verdict — `{members:[{targetUserId, targetName, recommendation, confidence, crisisFlag, finishedAt, reviewCount, id}]}` |
| GET | `/guilds/{g}/ai-review/{jobId}` | Full job incl. `verdict` (`recommendation, confidence, summary, strengths[], concerns[], crisisFlag, crisisNote?, outreachMessage`), token spend, model |
| POST | `/guilds/{g}/ai-review/batch` | 💸 `{activeWithinDays=60, minMessages=10, skipReviewedWithinDays?, excludeRoleIds:[], dryRun}` → `{batchId?, counts:{matchedActivity, departed, excludedByRole, alreadyReviewed, overCap, toQueue}}`. **Call with `dryRun:true` first** and confirm the count; `dryRun:false` queues one job per member (cap 500). 409 while a batch is in flight. |
| DELETE | `/guilds/{g}/ai-review/batch?batchId=…` | Cancel a batch's still-pending jobs |
| POST | `/guilds/{g}/ai-review/archive` | `{archived:bool}` + `{ids:[…]}` or `{all:true}` — soft-archive finished reviews |
| PUT | `/guilds/{g}/ai-review/prompt` | `{prompt}` (≤20000 chars) — replaces the reviewer's system prompt for this guild; empty string restores the default. Keep the default's guardrails. |

Crisis note: a completed verdict may set `crisisFlag` with a `crisisNote`
quoting a possible self-harm signal. Surface it to a human moderator
immediately; never act on it automatically and never include it in outreach.

## Exports and archive

| Method | Path | Body / notes |
| --- | --- | --- |
| POST | `/guilds/{g}/export` | *file* `{channelIds:[1–25], limitPerChannel=10000, onlyPinned, includeMedia}` → zip of per-channel Markdown; synchronous, can take minutes |
| POST | `/guilds/{g}/user-export` | *job* `{targetUserId, sinceAt?, untilAt?, channelIds:[], includeMedia}` — one member's messages as a Markdown zip |
| GET | `/guilds/{g}/user-export` | Recent export jobs with status |
| POST | `/guilds/{g}/user-export/{jobId}/cancel` | Cancel a pending/running export |
| GET | `/guilds/{g}/user-export/{jobId}/download` | *file* — the finished zip |
| GET | `/guilds/{g}/archive` | Archive coverage per channel: message/media counts, backfill states |
| GET | `/guilds/{g}/archive/{channelId}/download` | *file* — a channel's raw archive JSONL |

## Snapshots and restore

| Method | Path | Body / notes |
| --- | --- | --- |
| POST | `/guilds/{g}/snapshots` | *job* — collect a structural snapshot now. No body. |
| GET | `/guilds/{g}/snapshots` | Recent snapshot JOBS with per-step progress |
| GET | `/guilds/{g}/snapshots/history?limit=` | Stored snapshots: `{snapshots:[{id, kind, createdAt, counts}]}` |
| GET | `/guilds/{g}/snapshots/{snapshotId}` | One snapshot's full data blob (settings, roles, channels + overwrites, emojis, member roles). Multi-MB on big guilds. |
| GET | `/guilds/{g}/snapshots/{snapshotId}/diff?against=` | Structural diff vs an older snapshot (`against` omitted = the one just before) |
| POST | `/guilds/{g}/restore` | *job* ⚠️ `{snapshotId, options:{createRoles, createChannels, reapplyMemberRoles}}` — creates/adds only, never deletes; still confirm with a human first |
| GET | `/guilds/{g}/restore` | Recent restore jobs with progress logs |

## Logs

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/guilds/{g}/audit?kind=&before=&limit=` | Bot audit log, newest first. `kind` is a category prefix (`post`, `reddit`, `milestone`, `leaderboard`, `stats`, `aireview`, `config`, `export`, `snapshot`, `archive`, `restore`, `welcome`, `leave`). Page older entries by passing the response's `nextBefore` as `before`. Pruned at 90 days. |
| GET | `/guilds/{g}/mod-log?kind=&before=&limit=` | Moderation log (bans, unbans, kicks, timeouts, message deletions with cached content). `kind` is exact. Never pruned — pages back to the beginning. |

## Raw activity queries

`GET /guilds/{g}/activity` runs bounded aggregates over the raw event tables,
for questions the cached stats blob doesn't answer:

```
?metric=messages|reactions|joins     (default messages)
&groupBy=day|week|month|channel|author   (default day)
&since=<iso>&until=<iso>             (optional window)
&channelId=<id>&authorId=<id>        (optional narrowing)
&limit=<n>                           (default 500, max 2000)
```

Returns `{metric, groupBy, timezone, rows:[{key, count, actors}]}` — `key` is
the date/week/month bucket (guild timezone) or the channel/author id; `actors`
is distinct people. Time groupings sort ascending, channel/author sort by
count. `joins` has no channel dimension. Examples:

- Messages per week in one channel: `?metric=messages&groupBy=week&channelId=…`
- Top reactors of July: `?metric=reactions&groupBy=author&since=2026-07-01T00:00:00Z&until=2026-08-01T00:00:00Z`
- One member's activity by month: `?groupBy=month&authorId=…`
- Joins per day since launch: `?metric=joins&groupBy=day`

## Tokens (session-only)

Documented for completeness — these reject bearer auth by design.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/guilds/{g}/tokens` | `{name}` → `{token, id, name, tokenPrefix}` — plaintext returned exactly once |
| GET | `/guilds/{g}/tokens` | Caller's active tokens (no hashes, no plaintext) |
| DELETE | `/guilds/{g}/tokens/{tokenId}` | Revoke |

## Recipes

**Review one member and read the verdict**

1. `POST /guilds/{g}/ai-review` with `{targetUserId}` → note `job.id`.
2. Poll `GET /guilds/{g}/ai-review/{jobId}` every ~15 s until `status` is
   `done` (or `failed` — the `error` field says why).
3. Read `verdict`. If `crisisFlag` is true, tell a human before anything else.

**Batch-review the active membership** 💸

1. `POST …/ai-review/batch` with `dryRun:true` → check `counts.toQueue`.
2. Confirm the spend with a human (`toQueue × ~$0.10` typical).
3. Re-POST with `dryRun:false` → note `batchId`.
4. Progress: `GET …/ai-review` and count statuses, or just wait — the
   requester gets a DM when the batch settles.

**Refresh and fetch stats**

1. `POST …/stats/refresh`; poll `GET …/stats/refresh` until `generatedAt`
   changes (~1 min).
2. `GET …/stats` → the full `ServerStatsData` blob.

**Create a weekly meeting reminder**

1. Validate: `GET /cron-preview?expr=0 19 * * 5&tz=America/New_York`.
2. `GET /guilds/{g}/channels` → pick channel ids.
3. `POST /guilds/{g}/posts` with the body above (posts are created active —
   use `"scheduleKind":"oneoff"` + a past `runAt` never; the schema rejects
   invalid combinations with a 400 explaining the field).

**Export a member's history**

1. `POST …/user-export` `{targetUserId}` → `job.id`.
2. Poll `GET …/user-export` until that job is `done`.
3. `GET …/user-export/{jobId}/download` → zip bytes.
