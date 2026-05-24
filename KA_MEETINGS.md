# Kratom Anonymous virtual meetings — bot reference

Schedule of the 15 weekly KA meetings the bot announces, plus the seed
script that creates them in one shot.

Source: <https://www.kratom-anonymous.org/>
Last verified: 2026-05-23

## Quick facts

- **Timezone:** `America/New_York`. All cron expressions below are in ET.
  DST is handled automatically by `cron-parser` — no edits in March/November.
- **Lead time:** 5 minutes (cron fires 5 min before each meeting so
  `{meetingTime:R}` reads "in 5 minutes").
- **Primary link:** the `cutt.ly` short URL goes in the embed `Link` field
  so the title is clickable. The raw Zoom URL is in the body as a backup
  in case KA rotates a passcode and the short link breaks (rare).
- **Image:** add manually via the dashboard after seeding — the script
  leaves `embedImage = null`.
- **Channel:** the seeder posts everything to a single channel (passed as
  `SEED_CHANNEL_ID`). If you want fan-out, edit the posts in the dashboard
  after seeding to add more channels.

## Zoom room map

The 17-line schedule on the KA site uses only 4 Zoom rooms; multiple
time-slots share a room. Each room has its own cutt.ly:

| Slot pattern                 | Cutt.ly                             | Zoom URL (with passcode) |
| ---------------------------- | ----------------------------------- | ------------------------ |
| Weekday 10:00 AM ET (Mon–Fri) | <https://cutt.ly/ctg55sR6>          | <https://us06web.zoom.us/j/85416304667?pwd=pkbSAebEMTzfj65ldpcbekavV2Yi0k.1> |
| Weekday 9:00 PM ET (Mon–Fri)  | <https://cutt.ly/8tgmCNjd>          | <https://us06web.zoom.us/j/85310604948?pwd=G4oCebuIbCvJ0aVCYmyebe8jRyfHg6.1> |
| Thursday 6:45 PM ET (only)    | <https://cutt.ly/4tgmVje8>          | <https://us06web.zoom.us/j/86106557739?pwd=b4ARPZhF3q7ROSabq65a1tQjNXhMYw.1> |
| Weekend (Sat+Sun, 1 PM + 5 PM ET) | <https://cutt.ly/xtgmVDlr>      | <https://us06web.zoom.us/j/83187735602?pwd=dn36p4BHboNxaAZLrbbS7yAKlsRemV.1> |

## The 15 posts (schedule + colors)

| #  | Post name                                       | Cron          | Format     | Color     |
| -- | ----------------------------------------------- | ------------- | ---------- | --------- |
|  1 | ☕ Monday KA — 10:00 AM ET (Discussion)         | `55 9 * * 1`  | Discussion | `#D4A95E` |
|  2 | 🌙 Monday KA — 9:00 PM ET (Step)                | `55 20 * * 1` | Step       | `#5B6D9B` |
|  3 | ☕ Tuesday KA — 10:00 AM ET (Step)              | `55 9 * * 2`  | Step       | `#7AB069` |
|  4 | 🌙 Tuesday KA — 9:00 PM ET (Discussion)         | `55 20 * * 2` | Discussion | `#A576C2` |
|  5 | ☕ Wednesday KA — 10:00 AM ET (Discussion)      | `55 9 * * 3`  | Discussion | `#E5B07C` |
|  6 | 🌙 Wednesday KA — 9:00 PM ET (Step)             | `55 20 * * 3` | Step       | `#4F8FA6` |
|  7 | ☕ Thursday KA — 10:00 AM ET (Step)             | `55 9 * * 4`  | Step       | `#9CB76A` |
|  8 | 🌆 Thursday KA — 6:45 PM ET (Discussion)        | `40 18 * * 4` | Discussion | `#E08B5F` |
|  9 | 🌙 Thursday KA — 9:00 PM ET (Discussion)        | `55 20 * * 4` | Discussion | `#7F9AB3` |
| 10 | ☕ Friday KA — 10:00 AM ET (Discussion)         | `55 9 * * 5`  | Discussion | `#F0C46E` |
| 11 | 🌙 Friday KA — 9:00 PM ET (Step)                | `55 20 * * 5` | Step       | `#B19CD9` |
| 12 | 🪴 Saturday KA — 1:00 PM ET (Step)              | `55 12 * * 6` | Step       | `#6CB2A8` |
| 13 | 🌅 Saturday KA — 5:00 PM ET (Discussion)        | `55 16 * * 6` | Discussion | `#C97B5C` |
| 14 | 🪴 Sunday KA — 1:00 PM ET (Discussion)          | `55 12 * * 0` | Discussion | `#8FA86D` |
| 15 | 🌅 Sunday KA — 5:00 PM ET (Step)                | `55 16 * * 0` | Step       | `#5B8BB0` |

### Color chart (paired with each post's embed image)

Use this when generating/picking the embed image so the image's accent
color matches the embed strip. Hex codes are exactly what's in the DB.

| Post | Color | Swatch hex | Vibe |
| ---- | ----- | ---------- | ---- |
|  1 | Warm gold       | `#D4A95E` | Morning sun |
|  2 | Deep blue       | `#5B6D9B` | Monday night |
|  3 | Sage green      | `#7AB069` | Grounded morning |
|  4 | Muted lavender  | `#A576C2` | Reflective evening |
|  5 | Peach           | `#E5B07C` | Midweek warmth |
|  6 | Ocean blue      | `#4F8FA6` | Steady |
|  7 | Moss green      | `#9CB76A` | Almost-Friday calm |
|  8 | Terracotta      | `#E08B5F` | Early evening |
|  9 | Slate blue      | `#7F9AB3` | Cool evening |
| 10 | Friday gold     | `#F0C46E` | Bright |
| 11 | Soft purple     | `#B19CD9` | Wind-down |
| 12 | Seafoam teal    | `#6CB2A8` | Weekend afternoon |
| 13 | Burnt orange    | `#C97B5C` | Sunset |
| 14 | Olive           | `#8FA86D` | Sunday afternoon |
| 15 | Steel blue      | `#5B8BB0` | Sunday wind-down |

## Body template

All 15 posts use this structure, varying only the opener / ET-PT line /
links / bullets:

```
[Opener — 1–2 sentences, time-of-day appropriate]

⏰ **Starting {meetingTime:R} — {meetingTime:t} your time**
([ET / PT times]). Runs about an hour.

🔗 **How to join**
Click the title link above, or: [cutt.ly URL]
Direct Zoom (if the short link is down): [Zoom URL]

💬 **What to expect**
[5 bullets — Discussion or Step variant]

🌐 **About KA**
Full schedule + resources at https://www.kratom-anonymous.org/
```

The exact strings (opener variants, bullet sets) live in
[scripts/seed-ka-meetings.ts](scripts/seed-ka-meetings.ts). Edit there
and re-seed if you want to revise the copy.

## How to seed

The seeder is a one-shot TypeScript script that creates all 15
`ScheduledPost` rows for a given guild + channel.

### Get the IDs you need

1. In Discord, turn on **User Settings → Advanced → Developer Mode**.
2. Right-click your **server name → Copy Server ID** — this is your `SEED_GUILD_ID`.
3. Right-click the **channel** you want the announcements posted to →
   **Copy Channel ID** — this is your `SEED_CHANNEL_ID`.

### Run it in dev

```sh
SEED_GUILD_ID=<your-guild-id> SEED_CHANNEL_ID=<your-channel-id> \
  npx tsx scripts/seed-ka-meetings.ts
```

You'll see a line per post with its next fire time. If the guild row
doesn't exist yet (bot hasn't joined the server), the script fails
loudly before inserting anything.

### Run it in prod

The bot image already contains `tsx` and the seed script (it's just a
TS file in the repo), so the cleanest way is a one-off `docker compose
run`:

```sh
docker compose -f docker-compose.prod.yml run --rm \
  -e SEED_GUILD_ID=<your-guild-id> \
  -e SEED_CHANNEL_ID=<your-channel-id> \
  bot npx tsx scripts/seed-ka-meetings.ts
```

This spins up a throwaway container with the same env and DB connection
as the running bot, runs the seeder, prints the per-post results, and
exits. Doesn't touch the running services.

### Re-running to refresh copy or fix a typo

The script is **idempotent** — it upserts by `(guildId, name)`. Re-run it
any time you tweak the openers, bullets, color palette, or schedule. On
update it refreshes these fields:

- `cron`, `timezone`, `nextFireAt`
- `content` (description body)
- `embedTitle`, `embedColor`, `embedUrl`
- `useEmbed`, `leadMinutes`, `active`

…and deliberately **leaves these alone** so your dashboard edits survive:

- `embedImage` (you set this per post)
- `channelIds` (you may have fanned out to multiple channels)
- `mentionRoleId`

To re-run, just invoke the seeder again with the same env vars.

If you want a fully clean re-seed (drop and recreate), delete the rows
first via the dashboard search (`KA — ` matches all 15) or by SQL:

```sql
DELETE FROM "ScheduledPost"
WHERE "guildId" = '<your-guild-id>' AND name LIKE '%KA — %';
```

### After seeding

- The posts come in **active** with `nextFireAt` already computed by
  `computeNextFireAt`, so they'll fire on the next scheduler tick that's
  past their next scheduled time. No further action needed.
- Embed images are left empty. Open each post in the dashboard to paste
  in an image URL — use the color chart above to match the embed strip.
- If you want to ping a role, set it on each post in the dashboard
  (the seeder leaves `mentionRoleId = null`).
