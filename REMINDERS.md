# Follow-up reminders

A scheduled post can fire a **follow-up reminder**: a short plain-text reply to
the original announcement, posted a few minutes before the meeting/event starts.
Because it's a Discord reply, members can click it to jump back to the full
announcement (link, details, etc.).

```
[original post fires]  ── leadMinutes ──►  [meeting starts]
                  └── reminder fires ──┘
                     reminderMinutes before the meeting
```

## How it works

Each `ScheduledPost` has three reminder fields:

- `reminderMinutes: Int?` — fire the reminder this many minutes **before** the
  meeting. `null` = no reminder. Must be `< leadMinutes`, otherwise the reminder
  would fire before (or with) the original post.
- `reminderContent: String?` — the reminder body. `null` = pick from the
  built-in roster (see below). Same `{meetingTime}` placeholders as the post body.
- `lastReminderIndex: Int?` — internal: the last roster index used for this post,
  so the random picker avoids immediate repeats.

When a post fires, the scheduler records a `PostReminder` row capturing the exact
`(channelId, messageId)` pairs it posted, the snapshotted `meetingAt`, the chosen
body, and `remindAt = meetingAt − reminderMinutes`. On a later tick the scheduler
finds rows where `sentAt IS NULL AND remindAt <= now()`, replies to each original
message with `reply: { messageReference, failIfNotExists: false }`, and stamps
`sentAt`. Everything the reminder needs is snapshotted at fire time, so editing
or deleting the parent post afterwards never changes a queued reminder.

Code: [src/bot/scheduler.ts](src/bot/scheduler.ts) (`maybeScheduleReminder`,
`fireDueReminders`, `sendReminder`).

## Configure one post (dashboard)

Open a post in the dashboard and use the **Follow-up reminder** section:

1. Tick "Send a plain-text reminder before the meeting" (enabled once lead time
   is ≥ 2 min).
2. Set how many minutes before the meeting it fires (must be `< leadMinutes`).
3. Optionally type custom reminder text. Leave it blank to use the built-in
   roster. The Preview section shows both the original post and the reminder.

## Default reminder text (roster)

When `reminderContent` is blank, the bot picks a random line from
[src/lib/reminder-templates.ts](src/lib/reminder-templates.ts) each time the post
fires, avoiding the previous pick. All entries use `{meetingTime:R}` so they read
"starting in 5 minutes" regardless of the configured reminder lead. Edit that
file to change or extend the defaults.

## Bulk-enable across many posts

Two scripts enable reminders on many posts at once, mirroring the preview/apply
pattern of the lead-time scripts ([LEAD_TIME.md](LEAD_TIME.md)):

- [scripts/preview-reminder-enable.ts](scripts/preview-reminder-enable.ts) —
  pretty-prints the plan. **No DB writes.**
- [scripts/apply-reminder-enable.ts](scripts/apply-reminder-enable.ts) — sets
  `reminderMinutes` and clears `reminderContent` (→ default roster) on matched
  posts.

### Env vars (both scripts)

| Var                | Default | Meaning                                                |
| ------------------ | ------- | ------------------------------------------------------ |
| `GUILD_ID`         | (req)   | Discord guild snowflake.                               |
| `REMINDER_MINUTES` | `5`     | Minutes before the meeting the reminder fires (1–1439). |
| `NAME_FILTER`      | `""`    | Substring match on post name. Empty = all posts.       |

### Run it in dev

```sh
# Preview — read-only
GUILD_ID=<your-guild-id> npx tsx scripts/preview-reminder-enable.ts

# Apply once the preview looks right
GUILD_ID=<your-guild-id> npx tsx scripts/apply-reminder-enable.ts
```

Narrow the scope or change the lead:

```sh
GUILD_ID=<your-guild-id> NAME_FILTER="KA" REMINDER_MINUTES=5 \
  npx tsx scripts/preview-reminder-enable.ts
```

### Run it in prod (Docker)

The scripts ship in the runner image (`COPY --from=builder /app/scripts` in
[Dockerfile](Dockerfile)), so a one-off `docker compose run` against the prod
stack picks them up:

```sh
# 1. Preview — read-only
docker compose -f docker-compose.prod.yml run --rm \
  -e GUILD_ID=<your-guild-id> \
  -e REMINDER_MINUTES=5 \
  bot npx tsx scripts/preview-reminder-enable.ts

# 2. Apply with the same env vars
docker compose -f docker-compose.prod.yml run --rm \
  -e GUILD_ID=<your-guild-id> \
  -e REMINDER_MINUTES=5 \
  bot npx tsx scripts/apply-reminder-enable.ts
```

`--rm` deletes the throwaway container after exit; the running bot/scheduler
containers are untouched.

### Behavior notes

- **Lead-time guard.** Posts where `leadMinutes ≤ REMINDER_MINUTES` are skipped
  (`✗`) — the reminder must fire strictly before the meeting and after the
  original post. Raise the lead time (see [LEAD_TIME.md](LEAD_TIME.md)) first if
  you need a reminder on a short-lead post.
- **Clears custom text.** Any post with existing custom `reminderContent` is
  reset to the default roster. The preview flags these with `⚠` so it's visible
  before you apply.
- **No fire-time change.** Enabling a reminder doesn't alter when posts fire, so
  there's no `nextFireAt` recompute. `PostReminder` rows are created by the
  scheduler the next time each post fires — already-fired one-off posts won't
  retroactively get a reminder.
