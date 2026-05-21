# Dependency Upgrade Plan

This repo was scaffolded against late-2024 versions and has fallen behind. This file is the plan to get back to a current baseline so we're not chasing beta-25 bugs on a "brand new" project.

Order is **lowest-risk first** so each step can be verified independently before moving on. Each step says what to change, what could break, and how to verify it worked.

---

## Current vs target (as of 2026-05-21)

| Package | Now | Target | Major bump? |
| --- | --- | --- | --- |
| next | 15.1.3 | 16.2.6 | **yes** (15 → 16) |
| next-auth | 5.0.0-beta.25 | 5.0.0-beta.31 | no (still beta — upstream hasn't shipped stable) |
| @prisma/client | 6.1 | 7.8 | **yes** (6 → 7) |
| prisma (cli) | 6.1 | 7.8 | **yes** |
| zod | 3.24 | 4.4 | **yes** — touches `src/lib/post-schema.ts` |
| cron-parser | 4.9 | 5.5 | **yes** — touches `src/lib/cron.ts` |
| tailwindcss | 4.0.0-beta.8 | 4.3.0 | beta → stable |
| @tailwindcss/postcss | 4.0.0-beta.8 | 4.3.0 | beta → stable |
| typescript | 5.7 | 6.0 | **yes** |
| discord.js | 14.16 | 14.26 | patches only |
| react / react-dom | 19.0 | 19.2 | patches only |
| @auth/prisma-adapter | 2.7 | 2.11 | patches only |

**Hard blockers:** none. The only reason we're on a beta at all is `next-auth` v5 hasn't shipped stable; the v4 `latest` is a different API and would mean rewriting auth.

---

## Step 0: Snapshot before starting

```bash
git checkout -b upgrade-deps
git status   # should be clean
```

Each step below should be one commit so we can bisect if something breaks at boot.

---

## Step 1: Safe patch bumps

Lowest risk. No API changes expected.

**Edit `package.json`:**

```diff
- "@auth/prisma-adapter": "^2.7.4",
+ "@auth/prisma-adapter": "^2.11.2",
- "discord.js": "^14.16.3",
+ "discord.js": "^14.26.4",
- "next-auth": "5.0.0-beta.25",
+ "next-auth": "5.0.0-beta.31",
- "react": "^19.0.0",
- "react-dom": "^19.0.0",
+ "react": "^19.2.6",
+ "react-dom": "^19.2.6",
- "@tailwindcss/postcss": "^4.0.0-beta.8",
+ "@tailwindcss/postcss": "^4.3.0",
- "tailwindcss": "^4.0.0-beta.8",
+ "tailwindcss": "^4.3.0",
```

**Run:**

```bash
rm -rf node_modules package-lock.json
npm install --include=optional
docker compose up -d --build
```

**Verify:**
- Build succeeds.
- `docker compose logs web` shows `Ready in ...`.
- Sign in flow doesn't worsen (still might be broken by middleware/Prisma issue we're fixing in step 2).
- `npm run lint` clean.

If next-auth beta.31 alone fixes the `Invalid URL` + redirect-loop bug, great — you can park steps 2+ until later.

---

## Step 2: Next.js 15 → 16

**Why it matters now:** `nodeMiddleware` was experimental in 15.1 and is closer to stable in 16. There's a real chance bumping fixes the Edge-runtime/Prisma issue we hacked around in [next.config.mjs](next.config.mjs) and [src/middleware.ts](src/middleware.ts).

**Edit `package.json`:**

```diff
- "next": "^15.1.3",
+ "next": "^16.2.6",
- "eslint-config-next": "^15.1.3",
+ "eslint-config-next": "^16.2.6",
```

**Run the codemod** (Next ships one that handles most renames):

```bash
npx @next/codemod@latest upgrade
```

Then:

```bash
rm -rf node_modules package-lock.json .next
npm install --include=optional
```

**Things that may need adjustment:**

- `experimental.nodeMiddleware` may have graduated. Check Next 16 release notes; if it's stable, remove the flag from [next.config.mjs](next.config.mjs) and keep `runtime: "nodejs"` in [src/middleware.ts](src/middleware.ts).
- `experimental.serverActions.allowedOrigins` API may have moved to top-level `serverActions:` — codemod usually catches this.
- `serverExternalPackages` is stable in 16, should be fine.
- Production build: `npm run build` will surface any deprecated APIs.

**Verify:**
- `npm run build` succeeds without deprecation errors.
- Sign in → Discord → callback → dashboard, no redirect loop.
- Both web and bot containers stable for 5+ minutes.

**If Next 16 breaks something major and you can't fix it in 30 min:** drop back to `next@^15.5.x` (latest 15 patch). Captures most of the fixes without the major-version risk.

---

## Step 3: Prisma 6 → 7

**Why it matters:** stays current with security patches and tooling. Not urgent — Prisma 6 works fine.

**Pre-read:** [Prisma 6 → 7 migration guide](https://pris.ly/d/major-version-upgrade). Highlights to watch for:
- Dropped Node 18 support (we're on Node 20 — fine).
- Some generator output shape changes.
- `Json` field nullability shorthand removed in some configs.

**Edit `package.json`:**

```diff
- "@prisma/client": "^6.1.0",
+ "@prisma/client": "^7.8.0",
- "prisma": "^6.1.0",
+ "prisma": "^7.8.0",
```

**Run:**

```bash
rm -rf node_modules package-lock.json
npm install --include=optional
npx prisma generate
npx prisma migrate dev --name v7-upgrade   # only if you've already done the migration-files thing
```

**Verify:**
- `npx prisma generate` clean.
- `npm run build` clean (TypeScript may flag changed Prisma client types).
- Sign in flow still works end-to-end.
- Bot container connects and logs `[bot] logged in as ...`.

---

## Step 4: Move off `db push` to real migrations

**Why it matters:** prod (Lightsail) should run `prisma migrate deploy` against versioned migration files, not `db push`. Right now [docker-compose.yml](docker-compose.yml) uses `db push` because `prisma/migrations/` doesn't exist.

**On your dev machine** (with a running local postgres):

```bash
npx prisma migrate dev --name init
```

This generates `prisma/migrations/<timestamp>_init/` with the SQL. Commit it.

**Edit [docker-compose.yml](docker-compose.yml):**

```diff
- command: npx prisma db push --skip-generate
+ command: npx prisma migrate deploy
```

**Verify:**
- `docker compose down -v` (wipes Postgres volume).
- `docker compose up -d` — migrate service runs `migrate deploy`, applies the init migration, web and bot come up clean.
- `docker compose exec migrate sh -c "npx prisma migrate status"` reports up to date.

---

## Step 5: Strip the corp-CA hack

Local-only thing for the corp MITM. Has no place on Lightsail.

**Edit [Dockerfile](Dockerfile):**

Revert the base stage to:

```dockerfile
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat
```

Delete `corp-chain.pem` from the repo.

**Verify:**
- `docker compose up -d --build` succeeds on any non-corp network (or in CI). On the corp laptop this'll fail at `apk add` — that's expected and is why this step lives behind a "before deploy" line.

---

## Step 6 (optional): The "real code change" upgrades

Defer these until something needs them. Each is a real code edit, not a config bump.

### Zod 3 → 4

- API shape changed for `.refine`, `.transform`, and chaining order.
- `src/lib/post-schema.ts` is the only place we use it; expect to rewrite a few schemas.
- Verify with `npm run build` + manual create-post round trip.

### cron-parser 4 → 5

- v5 changed the import surface (`import { CronExpressionParser }` instead of `import parser from 'cron-parser'`).
- Touches `src/lib/cron.ts` and any cron-parser callers in `src/bot/scheduler.ts`.
- Verify by creating a recurring post and watching it fire.

### TypeScript 5 → 6

- Possible new strictness; ride along with the patch bump only if `npm run build` stays clean. If it surfaces real errors, fix them or defer.

---

## Step 7: Confirm we're not behind again

After all of the above:

```bash
npm outdated
```

Should be mostly empty. Anything left is something we deliberately deferred (zod 4, cron-parser 5, typescript 6, or anything pinned for a reason).

Also re-check beta status of `next-auth` — if v5 has shipped stable by the time you read this, drop the `beta` dist-tag and pin a real version.

---

## Notes for whoever picks this up

- **Run `npm install --include=optional`**, not bare `npm install`. Tailwind v4 has per-platform native binaries (`@tailwindcss/oxide-*`) and the Linux container needs entries the macOS host won't include by default.
- After each major bump, `docker compose up -d --build --no-cache` once to invalidate any cached layer that captured the old version.
- The bot service is independent of these changes for the most part — discord.js patches and Prisma client are its only direct deps. If web breaks but bot still runs, you can keep the bot live while fixing web.
- If you're touching `src/auth.ts`, remember the only reason `trustHost: true` is in the config is because the env-var form (`AUTH_TRUST_HOST=true`) wasn't reliably picked up in beta.25 — re-test once on a newer beta and remove the config line if env-var works.
