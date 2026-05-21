# Quitting 7OH Bot

Discord bot + admin portal for posting scheduled recovery-meeting reminders to a Discord server.

- **Bot** (`src/bot`) — discord.js worker. Polls the DB every 30s for due posts and sends them.
- **Portal** (`src/app`) — Next.js 15 App Router. Manage posts, set schedules, configure per-guild settings. Discord OAuth via Auth.js.
- **DB** — Postgres + Prisma. Shared by both processes.

## First-time setup

### 1. Create a Discord application

1. Go to https://discord.com/developers/applications → "New Application".
2. Under **OAuth2 → General**: add redirect URL `http://localhost:3000/api/auth/callback/discord` (and your production URL later). Copy **Client ID** and **Client Secret**.
3. Under **Bot**: create a bot, copy the **Token**. Disable "Public Bot" if you want to be the only one who can invite it.
4. Invite the bot to your server. Use OAuth2 URL Generator: scopes = `bot`, permissions = `Send Messages`, `Embed Links`, `Mention @everyone, @here, and All Roles`. Open the generated URL and add it to your guild.

### 2. Configure env

```bash
cp .env.example .env
# Fill in: DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET
# Generate AUTH_SECRET:   openssl rand -base64 32
# Put your own Discord user ID in BOOTSTRAP_ADMIN_USER_IDS so you can sign in.
#   (Right-click your username in Discord with Developer Mode on → "Copy User ID".)
```

### 3. Run it

```bash
docker compose up --build
```

This starts three containers: `postgres`, `web` (Next.js on :3000), `bot` (discord.js worker).
The `web` container runs `prisma migrate deploy` on startup, so the schema is created automatically.

Visit http://localhost:3000, sign in with Discord. Because you're in `BOOTSTRAP_ADMIN_USER_IDS`, you'll see every guild the bot is in.

### 4. Configure a guild

1. Pick the guild from the switcher (top-right).
2. Open **Settings** — set the default timezone and, optionally, an admin role. Anyone with that role in Discord can then sign in and manage this guild's posts.
3. Open **New Post** — create your first scheduled meeting reminder.

## Local development (non-Docker)

```bash
# 1. Start Postgres (or use docker compose up postgres)
# 2. Install + generate
npm install
npx prisma migrate dev

# 3. Two terminals:
npm run dev        # Next.js portal on :3000
npm run bot        # discord.js worker, auto-restart on file change
```

## Project layout

```
prisma/
  schema.prisma           # Guild, ScheduledPost, Auth.js tables
src/
  app/
    login/page.tsx
    dashboard/
      page.tsx                       # redirects to first accessible guild
      [guildId]/
        layout.tsx                   # nav + access check
        page.tsx                     # post list
        new/page.tsx                 # create
        posts/[id]/page.tsx          # edit
        settings/page.tsx            # per-guild timezone + admin role
    api/
      auth/[...nextauth]/route.ts
      guilds/[guildId]/channels      # GET — Discord channel list
      guilds/[guildId]/roles         # GET — Discord role list
      guilds/[guildId]/posts         # POST — create
      guilds/[guildId]/posts/[id]    # PATCH — edit, DELETE — remove
      guilds/[guildId]/posts/[id]/toggle  # POST — active/inactive
      guilds/[guildId]/settings      # PATCH — timezone + admin role
      cron-preview                   # GET — next-3-fires for the form
  bot/
    index.ts            # discord.js client + guild upsert listeners
    scheduler.ts        # poll loop: send due posts, advance nextFireAt
  components/
    Nav, GuildSwitcher, PostRow, PostForm, SettingsForm
  lib/
    db.ts               # Prisma singleton
    cron.ts             # cron-parser wrappers
    discord-rest.ts     # REST calls to /guilds, /channels, /roles, /members
    authz.ts            # checkGuildAccess + requireGuildAccess + listAccessibleGuilds
    api.ts              # withErrors wrapper for route handlers
    post-schema.ts      # Zod schema for post create/edit
    env.ts              # typed env access
  middleware.ts         # gates all non-public routes behind sign-in
  auth.ts               # NextAuth config (Discord provider + Prisma adapter)
```

## Scheduling model

A `ScheduledPost` has either a `cron` expression (recurring) or a `runAt` timestamp (one-off), plus an `active` flag.

`nextFireAt` is pre-computed on every write so the scheduler's hot query is a single indexed range scan:

```sql
SELECT * FROM ScheduledPost
WHERE active = true AND nextFireAt <= now()
```

The bot polls this every `SCHEDULER_POLL_SECONDS` (default 30). For each due post: send → update `lastFiredAt` + recompute `nextFireAt`. One-offs deactivate themselves after firing.

If a send fails, `nextFireAt` is pushed forward 60s so we don't hammer a broken post every poll. Semantics are **at-least-once**; for recovery-meeting reminders this is the right trade — a duplicate is annoying, a miss is bad.

## Hosting on AWS Lightsail

`docker compose up -d` on a Lightsail container instance or VM works. You'll want to:

- Put the Postgres data volume on a persistent disk and snapshot it nightly.
- Front Next.js with HTTPS — either Lightsail's load balancer, or Caddy/nginx-proxy as a fourth container.
- Update the Discord OAuth redirect URL in the developer portal to match your prod hostname.
- Update `NEXTAUTH_URL` in `.env` to the prod URL.

If you outgrow same-host Postgres, swap `DATABASE_URL` for an RDS connection string — no schema changes required.

## What's NOT in this scaffold

Deliberately deferred until needed:

- Test suite — add Vitest when there's logic worth testing.
- Audit log / post history beyond `lastFiredAt`.
- Slash commands. The bot only posts; it doesn't respond to commands yet.
- Multi-user invites with email/password. Discord OAuth + the per-guild admin role covers the use case.
- Observability beyond `console.log`. Hook up Pino + a log shipper when traffic justifies it.
