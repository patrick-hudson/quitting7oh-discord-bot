# Backups & disaster recovery

Four layers, built to cover the four different things "Discord backup" can
mean. None of them require third-party services; everything lives in this
stack (Postgres + the archive volume).

| Layer | What it protects | Where it lives |
| --- | --- | --- |
| Structure snapshots | roles, channels, permissions, settings, member role-assignments | `GuildSnapshot` (Postgres) |
| Config export/import | the bot's own configuration | JSON download |
| Export media | attachments in channel/user export zips | inside the zip |
| Full message archive | every message + attachment, continuously | archive volume |
| Restore assist | rebuilding nuked structure | worker + snapshots |

## Structure snapshots (portal → Snapshots)

The scheduler enqueues a full structural snapshot **nightly** per guild, and
"Snapshot now" enqueues one on demand. Either way the bot's snapshot worker
runs it as a visible job — the page shows **each step live** (server settings,
roles, channels & permissions, emojis, members, store) with a spinner/✓ per
step and how long each took. A snapshot captures server settings, all roles
(including permission bitfields), all channels with permission overwrites,
emojis, and every member's role assignments and nickname. Retention: newest 60
scheduled snapshots; manual snapshots are kept until deleted by hand.

The **diff view** ("Diff vs previous") decodes exactly what changed between
two snapshots — roles created/deleted, permissions granted (flagged ⚠),
channel and overwrite changes by permission name, settings and emoji changes.
Pairs with the Mod log for "who nuked what, and when."

## Config export/import (portal → Settings → Config backup)

Downloads the bot's configuration as portable JSON: guild settings + template
rosters, all scheduled posts, milestone config and tiers. Import is
section-selective and safe by default:

- imported **posts arrive inactive** — review and enable each one;
- **adminRoleId is never imported** (a bad value would lock admins out);
- milestones keep the currently-published `messageId` until you republish.

Importing posts into a guild that already has them creates duplicates — best
used on a fresh guild or after clearing the old ones.

## Media in exports (portal → Export)

Discord attachment URLs are **signed and expire in ~24 hours** — any export
that stores links silently rots within a day. The channel and user exports
have an "Include media files" option that downloads attachment bytes into the
zip (`media/`) and rewrites links to zip-relative paths. Caps (env-tunable):

```sh
EXPORT_MEDIA_FILE_CAP_MB="10"    # per file
EXPORT_MEDIA_TOTAL_CAP_MB="200"  # per export
```

Files over a cap fall back to the (expiring) CDN link and are counted in the
export's summary line.

## Full message archive (Settings toggle → Export page status)

When **Archive all messages continuously** is enabled in Settings, the bot's
archive worker incrementally copies every text channel's history to disk:

```
ARCHIVE_DIR/<guildId>/<channelId>.jsonl   # one raw API message per line
ARCHIVE_DIR/<guildId>/media/<id>-<name>   # attachment bytes
```

- **Incremental**: a per-channel cursor (`ArchiveChannelState`) means each
  hourly run only fetches new messages. The first run walks all history,
  bounded to ~30k messages per channel per run; subsequent runs finish the
  catch-up.
- **Crash-safe**: media and JSONL are written before the cursor advances, so
  an interruption re-fetches at most one page.
- **Storage**: the `archive_data` Docker volume, mounted read-write in the bot
  and read-only in the web container. Per-channel JSONL downloads stream from
  the Export page; media files are pulled via host-level backup (scp/rsync of
  the volume), not the browser.
- **Env**: `ARCHIVE_POLL_SECONDS` (default 3600), `ARCHIVE_MEDIA_FILE_CAP_MB`
  (default 25), `ARCHIVE_DIR` (set by compose; `./archive-data` for bare dev).

**Community note**: this stores all message text the bot can see. Tell your
community before enabling — same conversation as the mod log, one step
further.

## Restore assist (portal → Snapshots → Restore…)

Break-glass tooling for a nuked server. Pick a snapshot; the Restore page
shows the **plan** — exactly which roles and channels are missing versus the
live server — then queues a worker job that:

1. recreates missing roles (name, color, hoist, mentionable, permissions),
2. recreates missing categories, then channels, with permission overwrites
   remapped through the recreated role ids,
3. optionally re-applies snapshot role assignments to members still present.

**Strictly non-destructive**: nothing existing is deleted or modified.
**Deliberately slow**: Discord applies undocumented anti-nuke throttles to
role creation (tripping them can block the bot from creating roles for
24h+), so the worker paces at ~5s per role and ~1.5s per channel. A big
rebuild takes minutes; watch the live log on the Restore page.

**Hard to trigger by accident**: launching a restore requires a prominent
warning, two acknowledgement checkboxes, and typing the server's name to
confirm — the button stays disabled until all three pass, and the gates reset
after each run. It's break-glass, and it's built to feel like it.

**What cannot be restored** (Discord API limits, not ours): message history
(only lossy webhook reposting exists, deliberately not implemented), departed
members, boosts, invites, and exact role ordering (drag-order after).

## The unglamorous foundation

The Postgres volume is the backup of record for everything bot-side (posts,
milestones, logs, snapshots). None of the above replaces an off-box database
dump:

```sh
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U postgres quitting7oh | gzip > backup-$(date +%F).sql.gz
```

Cron that to somewhere off the host, and include the `archive_data` volume in
host backups if the full message archive is enabled.
