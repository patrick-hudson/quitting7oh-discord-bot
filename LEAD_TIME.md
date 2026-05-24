# Changing scheduled-post lead time

Every `ScheduledPost` row has two related fields:

- `cron` — when the announcement actually fires.
- `leadMinutes` — how many minutes after `cron` fires the meeting/event
  actually starts. This is what resolves `{meetingTime}` placeholders
  in the post body.

So the wall-clock meeting time equals `cron_fire_time + leadMinutes`.
To change how many minutes before the event the warning fires — e.g.,
from 5 to 15 — both fields have to move together. The meeting itself
stays put: `cron` shifts by `(oldLead − newLead)` minutes and
`leadMinutes` is set to the new value.

Two scripts handle this:

- [scripts/preview-lead-change.ts](scripts/preview-lead-change.ts) —
  pretty-prints what would change. **No DB writes.**
- [scripts/apply-lead-change.ts](scripts/apply-lead-change.ts) — writes
  the new `cron`, `leadMinutes`, and recomputes `nextFireAt`. **No
  confirmation prompt; the preview is the confirmation.**

## Scope

- **Cron posts only.** One-off posts (`runAt` set, `cron` null) are
  skipped — shifting them is a different operation.
- **Any guild, any post name.** Nothing in the scripts is hardcoded for
  KA meetings or any specific use case. Default scope is every
  cron-scheduled post in the guild; narrow with `NAME_FILTER`.
- **Posts with `leadMinutes = 0` are also in scope.** If you have any
  "fires AT the event" announcements that should not be promoted to
  warnings, exclude them with `NAME_FILTER` or eyeball the preview and
  abort.
- **Complex cron is rejected, not silently mishandled.** Lists, ranges,
  or steps in the minute or hour field (`0,30 9 * * *`, `0 9-17 * * *`,
  `*/5 * * * *`) produce an error line per post — fix those by hand.

## Env vars (both scripts)

| Var           | Default | Meaning                                               |
| ------------- | ------- | ----------------------------------------------------- |
| `GUILD_ID`    | (req)   | Discord guild snowflake.                              |
| `NEW_LEAD`    | `15`    | Target warning lead time in minutes (0–1440).         |
| `NAME_FILTER` | `""`    | Substring match on post name. Empty = all cron posts. |

## Run it in dev

```sh
# Preview — read-only
GUILD_ID=<your-guild-id> NEW_LEAD=15 \
  npx tsx scripts/preview-lead-change.ts

# Apply once the preview looks right
GUILD_ID=<your-guild-id> NEW_LEAD=15 \
  npx tsx scripts/apply-lead-change.ts
```

Use `NAME_FILTER` to scope to a subset:

```sh
GUILD_ID=<your-guild-id> NEW_LEAD=15 NAME_FILTER="Weekly Sync" \
  npx tsx scripts/preview-lead-change.ts
```

## Run it in prod (Docker)

The scripts are baked into the runner image via the
`COPY --from=builder /app/scripts ./scripts` line in
[Dockerfile](Dockerfile), so a one-off `docker compose run` against the
prod stack picks them up — no rebuild needed if you're using the
already-deployed image.

```sh
# 1. Preview — read-only, prints the plan and exits
docker compose -f docker-compose.prod.yml run --rm \
  -e GUILD_ID=<your-guild-id> \
  -e NEW_LEAD=15 \
  bot npx tsx scripts/preview-lead-change.ts
```

Inspect the output. Each post shows the new cron, the new lead, and the
(unchanged) meeting time. A `⚠ crosses midnight` line means the shift
would push the cron past midnight — the day-of-week / day-of-month
fields are **not** auto-adjusted, so resolve those manually in the
dashboard before or after applying.

If the plan looks right, apply with the same env vars:

```sh
# 2. Apply — writes new cron, leadMinutes, recomputes nextFireAt
docker compose -f docker-compose.prod.yml run --rm \
  -e GUILD_ID=<your-guild-id> \
  -e NEW_LEAD=15 \
  bot npx tsx scripts/apply-lead-change.ts
```

`--rm` deletes the throwaway container after exit. The running bot and
scheduler containers are untouched — the scheduler reads `cron` /
`leadMinutes` on each tick, so updates take effect on the next fire.

To run against a subset of posts in prod:

```sh
docker compose -f docker-compose.prod.yml run --rm \
  -e GUILD_ID=<your-guild-id> \
  -e NEW_LEAD=15 \
  -e NAME_FILTER="Weekly Sync" \
  bot npx tsx scripts/preview-lead-change.ts
```

## Reading the output

Preview prints a block per post:

```
  → Weekly Sync — Monday 10am
    meeting at ~10:00 (unchanged)
    cron:  55 9 * * 1  →  45 9 * * 1
    lead:  5 min  →  15 min

  · Quick Standup
    meeting ~09:00 — already at lead 15 min, skip

  ✗ Cron Salad
    cron "*/5 9 * * 1" — cannot shift: minute field "*/5" is not a single integer — complex cron not supported
```

Marker legend:

- `→` will be updated
- `·` already at target, skipped
- `✗` cannot shift (complex cron) — skipped, fix manually

Apply uses the same markers in single-line form and ends with
`Done: <updated> updated, <skipped> skipped`.

## Watch out for re-seeders

If a row was created by a seeder script (e.g.
[scripts/seed-ka-meetings.ts](scripts/seed-ka-meetings.ts)) that
hardcodes `leadMinutes`, re-running that seeder later will overwrite
the migrated value back to whatever the seeder hardcodes. To make a new
lead the permanent default in a seeder, edit the seeder's `leadMinutes`
constant and shift every `cron` in its `POSTS` array accordingly before
re-running.
