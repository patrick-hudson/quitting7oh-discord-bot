# Quitting 7OH Bot

Discord bot + admin portal for a recovery community. Two features:

1. **Scheduled posts** — recurring or one-off meeting reminders, fanned out to one or more channels. Discord-timestamp placeholders so each user sees the time in their local timezone.
2. **Milestone roles** — a button-message in a configured channel where members self-claim recovery milestones (24h → 2+ years). Auto-creates the Discord roles with a chosen color theme, position-aware, with an optional public congrats post.

Pieces:

- **Bot** (`src/bot`) — discord.js worker. Polls the DB for due posts and sends them; also handles milestone-button interactions.
- **Portal** (`src/app`) — Next.js 15 App Router. Manage posts, milestones, and per-guild settings. Discord OAuth via Auth.js.
- **DB** — Postgres + Prisma. Shared by both processes.

Companion docs:

- [KA_MEETINGS.md](KA_MEETINGS.md) — the seeded Kratom Anonymous meeting posts + seeder script.
- [REMINDERS.md](REMINDERS.md) — follow-up reminders and the bulk-enable scripts.
- [LEAD_TIME.md](LEAD_TIME.md) — changing a post's warning lead time (preview/apply scripts).
- [MIGRATIONS.md](MIGRATIONS.md) — schema-change workflow (manual SQL + additive `db push`).
- [LIGHTSAIL.md](LIGHTSAIL.md) — checklist for moving from local Docker to AWS Lightsail.
- [UPGRADE_PLAN.md](UPGRADE_PLAN.md) — staged dependency-upgrade plan.

## First-time setup

### 1. Create a Discord application

1. Go to https://discord.com/developers/applications → "New Application".
2. Under **OAuth2 → General**: add redirect URL `http://localhost:3000/api/auth/callback/discord` (and your production URL later). Copy **Client ID** and **Client Secret**.
3. Under **Bot**: create a bot, copy the **Token**. Disable "Public Bot" if you want to be the only one who can invite it.
4. Still under **Bot** → **Privileged Gateway Intents**: enable **Server Members Intent**. Required for milestone-role assignment; the bot won't start without it.
5. Invite the bot to your server. Use OAuth2 URL Generator: scope = `bot`, permissions = **View Channels**, **Send Messages**, **Embed Links**, **Manage Roles**. Add **Mention @everyone, @here, and All Roles** if any of your posts will ping a role. Open the generated URL and add it to your guild.
6. In Server Settings → Roles, drag the bot's role **above** every role it will manage. Discord enforces strict role hierarchy — the bot can only create/edit/delete roles below its own.

### 2. Configure env

```bash
cp .env.example .env
# Fill in: DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET
# Generate AUTH_SECRET:   openssl rand -base64 32
# Put your own Discord user ID in BOOTSTRAP_ADMIN_USER_IDS so you can sign in.
#   (Right-click your username in Discord with Developer Mode on → "Copy User ID".)
# Set AUTH_TRUST_HOST=true so Auth.js doesn't reject the host in production builds.
```

### 3. Run it

```bash
docker compose up --build
```

This starts four containers: `postgres`, `migrate` (one-shot — pushes the Prisma schema and exits), `web` (Next.js on :3000), `bot` (discord.js worker). `web` and `bot` only start after `migrate` exits cleanly.

Local compose uses `prisma db push` so you don't need migration files committed — handy for iterating on the schema. For real prod, switch to `prisma migrate deploy` against committed migrations (see step 4 of [UPGRADE_PLAN.md](UPGRADE_PLAN.md) and section 0 of [LIGHTSAIL.md](LIGHTSAIL.md)).

Visit http://localhost:3000, sign in with Discord. Because you're in `BOOTSTRAP_ADMIN_USER_IDS`, you'll see every guild the bot is in.

### 4. Configure a guild

1. Pick the guild from the switcher (top-right).
2. **Settings** — set the default timezone and, optionally, an admin role. Anyone holding that role in Discord can sign in and manage this guild.
3. **New Post** — create your first scheduled meeting reminder.
4. **Milestones** (optional) — configure the per-tier roles, auto-create them with a color theme, and publish the claim message.

## Local development (non-Docker)

```bash
# 1. Start Postgres (or use docker compose up postgres)
# 2. Install + push schema
npm install
npx prisma db push

# 3. Two terminals:
npm run dev        # Next.js portal on :3000
npm run bot        # discord.js worker, auto-restart on file change
```

## Project layout

```
prisma/
  schema.prisma          # Guild, ScheduledPost, MilestoneConfig/Tier, Auth.js tables
src/
  app/
    login/page.tsx
    dashboard/
      page.tsx                       # redirects to first accessible guild
      [guildId]/
        layout.tsx                   # nav + access check
        page.tsx                     # post list
        new/page.tsx                 # create post
        posts/[id]/page.tsx          # edit post
        milestones/page.tsx          # milestone roles config + publish
        settings/page.tsx            # per-guild timezone + admin role
    api/
      auth/[...nextauth]/route.ts
      guilds/[guildId]/channels                  # GET — Discord channel list
      guilds/[guildId]/roles                     # GET — Discord role list
      guilds/[guildId]/posts                     # POST — create
      guilds/[guildId]/posts/[id]                # PATCH — edit, DELETE — remove
      guilds/[guildId]/posts/[id]/toggle         # POST — active/inactive
      guilds/[guildId]/milestones                # GET/PATCH — config + tiers
      guilds/[guildId]/milestones/publish        # POST — send/update the claim message
      guilds/[guildId]/milestones/auto-create    # POST — bulk-create roles from a theme
      guilds/[guildId]/settings                  # PATCH — timezone + admin role
      cron-preview                               # GET — next-3-fires for the form
  bot/
    index.ts            # discord.js client + guild upsert listeners
    scheduler.ts        # poll loop: send due posts, substitute placeholders
    milestones.ts       # button-interaction handler for milestone claims
  components/
    Nav, GuildSwitcher, PostRow, PostForm, MilestoneForm, SettingsForm
  lib/
    db.ts               # Prisma singleton
    cron.ts             # cron-parser wrappers
    discord-rest.ts     # REST calls — channels, roles, messages, role create/delete/position
    milestone-themes.ts # color palettes for auto-created milestone roles
    authz.ts            # checkGuildAccess + requireGuildAccess + listAccessibleGuilds
    api.ts              # withErrors wrapper for route handlers
    post-schema.ts      # Zod schema for post create/edit
    env.ts              # typed env access
  middleware.ts         # gates all non-public routes behind sign-in (Node runtime)
  auth.ts               # NextAuth config (Discord provider + Prisma adapter, trustHost)
```

## Scheduling model

A `ScheduledPost` has either a `cron` expression (recurring) or a `runAt` timestamp (one-off), plus an `active` flag.

`nextFireAt` is pre-computed on every write so the scheduler's hot query is a single indexed range scan:

```sql
SELECT * FROM ScheduledPost
WHERE active = true AND nextFireAt <= now()
```

The bot polls this every `SCHEDULER_POLL_SECONDS` (default 30). For each due post: substitute placeholders → fan out to every channel → update `lastFiredAt` + recompute `nextFireAt`. One-offs deactivate themselves after firing.

If a send fails for *all* channels, `nextFireAt` is pushed forward 60s so we don't hammer a broken post every poll. If at least one channel succeeded, the post advances normally — we'd rather skip the failing channel than duplicate to the working ones. Overall semantics are **at-least-once**; for recovery-meeting reminders this is the right trade — a duplicate is annoying, a miss is bad.

### Time placeholders

Post bodies and embed titles can include `{meetingTime}` placeholders, which the bot replaces with Discord's native timestamp markup (`<t:UNIX:X>`) at send time. Discord then renders the time in each viewer's local timezone.

| Placeholder | Renders as |
| --- | --- |
| `{meetingTime}` | `9:00 PM` |
| `{meetingTime:T}` | `9:00:00 PM` |
| `{meetingTime:d}` | `5/21/2026` |
| `{meetingTime:D}` | `May 21, 2026` |
| `{meetingTime:f}` | `May 21, 2026 9:00 PM` |
| `{meetingTime:F}` | `Wednesday, May 21, 2026 9:00 PM` |
| `{meetingTime:R}` | `in 5 minutes` |

The meeting timestamp = actual send time + `leadMinutes` (a per-post field). So for a post that fires 5 minutes before the meeting:

- Set **Lead time** = `5`.
- Write `Recovery meeting starting {meetingTime:R} at {meetingTime} — see you there.`
- Renders per viewer as `Recovery meeting starting in 5 minutes at 9:00 PM — see you there.`

## Milestone roles

A single pinned button-message in a designated channel. Each button claims a recovery-time milestone — clicking grants the matching Discord role and removes any other milestone role the user holds, so the badge always reflects current tier. Honor-system by design: anyone can claim any tier, which fits a recovery community where people legitimately restart their count.

**What the portal page lets you do:**

- Pick the **channel** the message lives in.
- Edit the **title + description** of the message.
- Manage the **tier list** (label, emoji, role, sort order). Defaults are 7 tiers: 24 hours → 30 days → 60 days → 90 days → 6 months → 1 year → 2+ years.
- **Auto-create roles in Discord** from a chosen color theme. Themes include Earth, Wine, Slate, Autumn, Sandstone, Ember, Crimson, and Rainbow — all picked to stay readable on Discord's dark mode, and (except Rainbow) to avoid clashing with typical staff role colors.
- Pick an **anchor role** (e.g. `@Moderator`) — newly-created milestone roles slot directly below it in the guild's role list, highest milestone closest to the anchor.
- Configure a **private (ephemeral) message** shown only to the user who claimed. Always sent.
- Optionally configure a **public congrats message** posted to a chosen channel when someone swaps to a new tier (not when they re-click their current one).
- **Publish to Discord** — sends the button-message; subsequent publishes edit it in place.

**Placeholders** available in the public congrats template:

| | |
| --- | --- |
| `{user}` | mention of the claimer |
| `{tier}` | tier label, e.g. "30 days" |
| `{emoji}` | tier emoji |
| `{claimChannel}` | link to the channel where the claim message lives |

Ephemeral template supports `{tier}` and `{emoji}` (the user already knows who they are).

**Safety:** "Replace existing" on auto-create will delete the old milestone Discord roles before creating new ones. A confirmation modal lists every role about to be deleted, with color swatches, and is the only path to actually delete. Only roles linked to milestone tiers can be touched — nothing else in the server is affected.

## Hosting on AWS Lightsail

The short version: `docker compose up -d` on a Lightsail VM or container instance works. The long version — pre-flight cleanup, persistent disk, HTTPS via Caddy, Discord portal updates, ops basics — lives in [LIGHTSAIL.md](LIGHTSAIL.md).

## What's NOT in this scaffold

Deliberately deferred until needed:

- Test suite — add Vitest when there's logic worth testing.
- Audit log / post history beyond `lastFiredAt`.
- Slash commands. The bot only posts; it doesn't respond to slash commands. (It *does* handle button interactions for milestones.)
- Multi-user invites with email/password. Discord OAuth + the per-guild admin role covers the use case.
- Observability beyond `console.log`. Hook up Pino + a log shipper when traffic justifies it.
- Auto-promotion based on a tracked "clean date." Milestone claims are deliberately manual; auto-promotion would force admin-side relapse handling that this community doesn't need.
