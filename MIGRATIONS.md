# Database migrations

This project uses `prisma db push` (not Prisma's migration files) to keep the
schema in sync. That works fine for additive changes — adding columns, tables,
indexes — but **destructive changes** (dropping columns, narrowing types, etc.)
need to be done by hand so existing data is preserved.

Hand-written, transactional SQL for those cases lives in
[prisma/manual-migrations/](prisma/manual-migrations/). Each file is dated and
self-contained: applies new schema, backfills data, drops the old shape.

## When to write a manual migration

You need one when a schema change in `prisma/schema.prisma` would otherwise
require `prisma db push --accept-data-loss` and you actually care about the
data. Examples:

- Renaming a column (the rename looks like drop-old + add-new to Prisma).
- Splitting one column into many.
- Changing a column type in a way that needs a conversion (e.g. `text` → `text[]`).
- Adding a `NOT NULL` column with no default to a table that already has rows.

Pure additions (new optional column, new table) don't need one — `prisma db
push` handles those losslessly.

## Authoring a manual migration

1. Update `prisma/schema.prisma` to the desired final state.
2. Write a SQL file at `prisma/manual-migrations/YYYY-MM-DD-short-name.sql` that:
   - Wraps everything in `BEGIN; ... COMMIT;` so a partial failure rolls back.
   - Adds new columns first (with safe defaults so the table stays valid).
   - Backfills data from the old columns.
   - Drops the old columns last.
3. Test it locally before pushing the schema change — see the next section.

The goal: once the SQL runs in prod, the live schema already matches
`schema.prisma`, so the deploy's `prisma db push` is a no-op and doesn't need
`--accept-data-loss`.

## Applying a manual migration in dev

After pulling a branch that contains a new SQL file and a corresponding
`schema.prisma` change:

```sh
# 1. Apply the SQL to the dev database (preserves any data you had locally).
docker compose exec -T postgres \
  psql -U postgres -d quitting7oh -v ON_ERROR_STOP=1 \
  < prisma/manual-migrations/<file>.sql

# 2. Regenerate the Prisma client so types match the new schema.
npx prisma generate
```

If your local DB has nothing precious in it, you can skip the SQL and just run
`npx prisma db push --accept-data-loss` instead — same result, but it wipes the
affected columns.

## Applying a manual migration in prod

The flow assumes a Lightsail-style host running `docker-compose.prod.yml`.

1. **SSH to the prod host** and `cd` to the directory with `docker-compose.prod.yml`.

2. **Snapshot the database first** — cheap insurance.
   ```sh
   docker compose -f docker-compose.prod.yml exec -T postgres \
     pg_dump -U postgres quitting7oh > pre-<short-name>.sql
   ```

3. **Copy the SQL into the postgres container and apply it.**
   ```sh
   docker compose -f docker-compose.prod.yml cp \
     prisma/manual-migrations/<file>.sql postgres:/tmp/migration.sql

   docker compose -f docker-compose.prod.yml exec -T postgres \
     psql -U postgres -d quitting7oh -v ON_ERROR_STOP=1 -f /tmp/migration.sql
   ```
   You should see `BEGIN` / `ALTER TABLE` / `UPDATE n` / `COMMIT`. If anything
   errors, the transaction rolls back and the schema is unchanged.

4. **Verify the schema** matches what the new code expects:
   ```sh
   docker compose -f docker-compose.prod.yml exec -T postgres \
     psql -U postgres -d quitting7oh -c '\d "<TableName>"'
   ```

5. **Roll the new image.**
   ```sh
   docker compose -f docker-compose.prod.yml pull
   docker compose -f docker-compose.prod.yml up -d
   ```
   `migrate` runs `prisma db push` and exits cleanly because the live schema
   already matches.

### Minimizing the error window

Between step 3 (old columns dropped) and step 5 (new image live), the
**already-running** bot and web containers will hit `column does not exist`
errors for code paths that touch the changed columns. Two options:

- **Quick downtime**: `docker compose -f docker-compose.prod.yml stop bot web`
  before step 3, then `up -d` at step 5. ~30s of "bot offline."
- **Live-roll**: skip the stop, accept a noisy log window during the deploy.
  For low-traffic features this is usually fine.

### If something goes wrong

- The SQL is transactional, so a failed `psql` invocation leaves the DB
  unchanged. Investigate the error, fix the SQL, re-run.
- If you've already applied a bad migration: restore from the snapshot you took
  in step 2:
  ```sh
  docker compose -f docker-compose.prod.yml cp \
    pre-<short-name>.sql postgres:/tmp/restore.sql
  docker compose -f docker-compose.prod.yml exec -T postgres \
    psql -U postgres -d quitting7oh -f /tmp/restore.sql
  ```
  This reimports the whole DB, so only do it if nothing important has been
  written since the snapshot.

## Index of manual migrations

| Date       | File                                        | Summary |
| ---------- | ------------------------------------------- | ------- |
| 2026-05-22 | `2026-05-22-milestone-rosters.sql`          | Schema change: convert `MilestoneTier.congratsTemplate` and `MilestoneConfig.{congrats,ephemeral}Template` from single text columns to `text[]` rosters with `lastIndex` counters. |
| 2026-05-22 | `2026-05-22-milestone-default-rosters.sql`  | Data-only backfill: expand the per-tier congrats roster from 1 entry to ~7 variants. Skips any tier that already has 2+ entries (i.e. customized). Optional — only run if you want the new defaults on existing guilds. |
| 2026-05-22 | `2026-05-22-milestone-global-congrats-roster.sql` | Data-only backfill: expand the guild-level fallback congrats roster from 1 entry to 15 variants. Skips guilds whose roster already has 2+ entries. Mostly dormant if per-tier rosters are populated, but worth running so the fallback is current. |

## Additive schema changes (auto-applied by `prisma db push`)

Schema changes that only *add* optional columns (or new tables) don't need a
manual SQL file — the `migrate` service's `prisma db push --skip-generate`
applies them losslessly on the next deploy. Log them here for visibility so it's
obvious what each deploy changed.

| Date       | Change                                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-22 | `ScheduledPost.lastFailedAt: DateTime?` and `ScheduledPost.lastError: String?` — scheduler stamps these on send failure so the dashboard can surface the most recent error. |
| 2026-05-22 | `User.lastSignInAt: DateTime?` — stamped by Auth.js `events.signIn` on each sign-in. Powers the dashboard "Recently signed in" panel. |
| 2026-05-22 | New table `MessageEvent` — one row per observed Discord message (id, guildId, channelId, authorId, isBot, sentAt). Powers the dashboard activity graph. Bot also needs the `GuildMessages` intent (non-privileged, in code only — no portal toggle). |
| 2026-05-24 | `ScheduledPost.reminderMinutes: Int?`, `reminderContent: String?`, `lastReminderIndex: Int?` — opt-in follow-up reminder (null `reminderMinutes` = off). New table `PostReminder` (postId, firedAt, meetingAt, remindAt, sentAt, content, channelIds[], messageIds[], lastFailedAt, lastError) — one row per fire that wants a reminder; the scheduler replies to the original message(s) at `remindAt`. Auto-applied by the `migrate` service. No backfill needed — existing posts default to no reminder. |
| 2026-05-24 | `Guild.redditEnabled: Boolean @default(false)`, `redditSubreddit: String?`, `redditChannelId: String?`, `redditLastPostAt: DateTime?` — per-guild Reddit new-post announcer config + high-water mark. Auto-applied by the `migrate` service. No backfill — existing guilds default to disabled. Reads Reddit's public RSS feed (no API key); set `REDDIT_USER_AGENT`. See [REDDIT.md](REDDIT.md). |
| 2026-06-04 | `Guild.reminderTemplates: String[] @default([])` — per-guild override for the scheduler's reminder roster (empty = use baked-in defaults in `src/lib/reminder-templates.ts`). Editable on the new portal Defaults page. Auto-applied by the `migrate` service. No backfill — existing guilds start empty and keep using the built-ins until edited. |
| 2026-06-05 | `ScheduledPost.manualFireRequested: Boolean @default(false)` — flag the portal sets when an admin clicks "Fire now" on a post. The scheduler picks these up alongside its regular due-by-time loop, sends the post via the same code path (including any reminder), and clears the flag. Does not touch cron / runAt / nextFireAt, so the normal schedule is unaffected. Auto-applied by the `migrate` service. No backfill — existing posts default to false. |
| 2026-06-05 | New table `UserExportJob` — background jobs for exporting one member's messages as a Markdown zip (guildId, targetUserId, since/until, channelIds[], status, zip blob in `output` Bytes, requestedBy, counts). Portal queues; the bot's user-export worker processes one at a time, stores the zip, and DMs the requester a download link. Worker prunes finished jobs after 7 days. Auto-applied by the `migrate` service. |
| 2026-07-29 | `Guild.leaveEnabled: Boolean @default(false)`, `leaveChannelId: String?`, `leaveTemplates: String[] @default([])`, `lastLeaveIndex: Int?` — member-departure announcements (GuildMemberRemove listener; same message for leaves/kicks/bans). Toggle + channel on Settings, roster on Defaults (empty = built-ins in `src/lib/leave-templates.ts`). Auto-applied by the `migrate` service. No backfill — existing guilds default to disabled. |
| 2026-07-29 | `Guild.welcomeDmEnabled: Boolean @default(false)`, `welcomeDmTemplates: String[] @default([])`, `lastWelcomeDmIndex: Int?` — welcome DMs on join (every join incl. rejoins; screening-aware via pending→false; closed DMs silently skipped and logged). Toggle on Settings, roster on Defaults (empty = built-ins in `src/lib/welcome-templates.ts`). Auto-applied by the `migrate` service. No backfill — existing guilds default to disabled. |
| 2026-07-29 | New table `BotAuditLog` (guildId, kind, status, summary, data Json, createdAt) — one row per bot action (post fires, reminders, Reddit announcements, welcome DMs, departures, milestone claims, exports), written fire-and-forget via `src/lib/audit.ts`. Powers the portal's Audit page; pruned after 90 days by the scheduler. Auto-applied by the `migrate` service. |
| 2026-07-29 | `UserExportJob.cancelRequested: Boolean @default(false)` + new `cancelled` status — portal Cancel button for queued/running exports; the worker checks between scan pages (throttled to one DB read per ~2s) and winds down. Auto-applied by the `migrate` service. |
| 2026-08-07 | `ScheduledPost.skipMode: String @default("off")` + `skipIfRecentWithin: Int?` + `lastMessageIds: Json?` — anti-spam for scheduled fires. `off` = always post; `recent` = skip while the previous message is within the channel's last N messages; `auto` = skip unless ≥ `POST_AUTO_SKIP_MIN_MESSAGES` non-bot messages (from `MessageEvent`) since the bot last posted there, using the stored message id's snowflake timestamp as the boundary. `lastMessageIds` maps channelId → last-sent message id. Manual "Fire now" ignores all of it. Additive, auto-applied by the `migrate` service. |
| 2026-08-10 | `ArchiveChannelState.eventsBackfilledAt: DateTime?` — one-time reconciliation flag: the archive worker streams each channel's already-on-disk JSONL into MessageEvent once (skipDuplicates), so leaderboard/activity stats include messages archived before MessageEvent-feeding existed. Additive, auto-applied by the `migrate` service. |
| 2026-08-10 | New table `LeaderboardCache` (guildId, data Json, generatedAt, computing, refreshRequested) — precomputed contributor leaderboard so the page is an instant read instead of running the aggregate + Discord name lookups per request (which took 15-30s). The leaderboard worker recomputes on a schedule (`LEADERBOARD_REFRESH_HOURS`, default 6) and on demand. Additive, auto-applied by the `migrate` service. |
| 2026-08-10 | New index `MessageEvent(guildId, authorId)` — speeds up the contributor leaderboard's group-by-author aggregate. Index-only, auto-applied by the `migrate` service. |
| 2026-08-07 | `ArchiveChannelState.oldestMessageId: String?` + `backfillComplete: Boolean @default(false)` — fixes the full-message archive only capturing the newest ~100 messages. The worker now walks history in both directions (forward for new messages, backward from `oldestMessageId` to the channel start). Existing stuck channels self-heal on the next run — backfill re-walks from their forward cursor, which duplicates ~100 message lines in the JSONL once (dedupe by message id on read). Additive, auto-applied by the `migrate` service. |
| 2026-08-07 | New table `SnapshotJob` (guildId, kind, status, steps Json, snapshotId, timing) — structure snapshots now run as a visible job processed by the bot's snapshot worker, so the portal shows live per-step progress + timing. The scheduler enqueues nightly jobs instead of collecting inline; manual "Snapshot now" enqueues too. Additive, auto-applied by the `migrate` service. |
| 2026-08-05 | Backups suite (see [BACKUPS.md](BACKUPS.md)): new tables `GuildSnapshot` (nightly + manual structure snapshots powering the Snapshots diff page and restore assist), `ArchiveChannelState` (per-channel cursors for the continuous message archive; files live on the new `archive_data` Docker volume — compose change required), `RestoreJob` (non-destructive rebuild queue); new columns `Guild.archiveEnabled` and `UserExportJob.includeMedia`. All additive, auto-applied by the `migrate` service. The archive volume mounts bot-rw / web-ro with `ARCHIVE_DIR=/data/archive`. |
| 2026-07-29 | New table `ModerationLog` — human mod actions: bans/unbans/kicks/timeouts (via the real-time GuildAuditLogEntryCreate gateway event) and message deletions with cached content. Powers the portal's Mod log page; never pruned (accountability records keep forever). **Requires**: Message Content privileged intent enabled in the Discord dev portal, and the bot role granted View Audit Log in the server. This deliberately reverses the earlier "bot never sees message text" stance — deleted-message content is now persisted for mod accountability; regular messages are still not stored. Auto-applied by the `migrate` service. |
