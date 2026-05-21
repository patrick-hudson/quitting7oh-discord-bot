# Moving to AWS Lightsail

This document covers everything you need to do to take what's running locally and put it on a Lightsail instance for real users. It assumes the local `docker compose up` flow in the README works for you.

---

## 0. Pre-flight: undo local-only hacks

Before you deploy, walk back the things in this repo that exist only to make the corp-network laptop work.

### Remove the corp CA from the Dockerfile

The base stage in [Dockerfile](Dockerfile) currently injects `corp-chain.pem` into the image so `apk` and `npm` trust a MITM cert. Lightsail's network has none of that — the COPY will fail outright if the file isn't checked in, and trusting an unknown CA on a public host is a real (small) security smell.

Revert the base stage to:

```dockerfile
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat
```

And delete `corp-chain.pem` from the repo (it shouldn't be committed anyway).

### Switch from `db push` to real migrations

Current [docker-compose.yml](docker-compose.yml) uses `npx prisma db push --skip-generate`. That's fine for local dev because `prisma/migrations/` doesn't exist yet, but in prod you want versioned migrations so schema changes are auditable and reversible.

One-time, on your dev machine:

```bash
# Generates prisma/migrations/<timestamp>_init/migration.sql against your local DB
npx prisma migrate dev --name init
```

Commit the `prisma/migrations/` directory. Then change the `migrate` service command in `docker-compose.yml` back to:

```yaml
command: npx prisma migrate deploy
```

`migrate deploy` is non-interactive, idempotent, and never rewrites or drops schema — exactly what you want at boot on a prod host.

### Verify `.env` has no dev values

In particular:
- `NEXTAUTH_URL` must be the public HTTPS URL (e.g. `https://bot.example.com`), not `http://localhost:3000`.
- `BOOTSTRAP_ADMIN_USER_IDS` should be only the real admins.
- `AUTH_SECRET` should be a fresh `openssl rand -base64 32` — don't reuse the dev one.
- `DATABASE_URL` is fine to leave as the in-compose value; it's only used inside the docker network.

`.env` is in `.dockerignore` and `.gitignore` for a reason — keep it out of the image and out of git. Copy it to the server by hand.

---

## 1. Pick a Lightsail flavor

| Option | When it fits |
| --- | --- |
| **Lightsail VM (Ubuntu) + `docker compose`** | Default. Cheapest, full control, you SSH in and run things. Recommended for this scaffold. |
| **Lightsail Container Service** | Managed runtime, built-in HTTPS, but you still need a DB somewhere and per-resource cost is higher. Worth it if you don't want to manage a host. |
| **VM + Lightsail Managed Database** | Use this when same-host Postgres starts being a liability (backups, point-in-time recovery, bigger working set). |

The rest of this document assumes the **VM + `docker compose`** path. The container-service path is mostly the same minus the HTTPS section.

---

## 2. Provision the VM

1. **Create instance**: Lightsail console → Create instance → OS Only → Ubuntu 24.04 LTS. Pick a plan with at least 1 GB RAM (Next.js build is hungry); 2 GB is more comfortable. Same region as your users.
2. **Static IP**: Lightsail → Networking → Create static IP, attach to the instance. Do not skip this — without it the IP changes on stop/start and your DNS rots.
3. **Firewall**: Lightsail's per-instance firewall, allow:
    - 22/TCP (SSH) — restrict to your IP if possible
    - 80/TCP (HTTP → for Let's Encrypt ACME challenges and redirect)
    - 443/TCP (HTTPS)
    - Leave 3000 and 5432 closed — those are internal-only.
4. **DNS**: Point your domain at the static IP. An `A` record on `bot.example.com` is enough; no `CNAME` games needed.

---

## 3. Provision a persistent disk for Postgres

If Postgres data lives only in the VM's root volume, you can't snapshot it independently and you can't easily migrate to a bigger instance. Attach a separate block storage disk.

1. Lightsail → Storage → Create disk in the same AZ as the instance. 20 GB is plenty for a long while.
2. Attach to instance.
3. On the instance, format and mount:

```bash
sudo mkfs.ext4 /dev/xvdf       # confirm the device name with `lsblk`
sudo mkdir /mnt/pgdata
sudo mount /dev/xvdf /mnt/pgdata

# persist across reboots
echo "/dev/xvdf /mnt/pgdata ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab
```

4. Update [docker-compose.yml](docker-compose.yml) to use a bind mount instead of a named volume:

```yaml
volumes:
  - /mnt/pgdata:/var/lib/postgresql/data
```

(Remove the `postgres_data:` named volume entry under top-level `volumes:` if you do this.)

5. **Snapshot schedule**: Lightsail → Storage → your disk → Enable automatic snapshots, daily, 02:00 local. Retention 7 days. Nightly snapshots have saved more bacon than any other single thing in ops.

---

## 4. Install Docker and bring the app up

On the instance:

```bash
# Docker Engine + compose plugin (Ubuntu 24.04)
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# let your user run docker without sudo
sudo usermod -aG docker $USER
newgrp docker
```

Then get the code and env onto the box:

```bash
git clone <your-repo-url> quitting7oh-bot
cd quitting7oh-bot
scp local-machine:~/quitting7oh-bot/.env .       # or however you ship .env
docker compose up -d --build
docker compose logs -f
```

Watch for the `migrate` service to exit cleanly, then `web` and `bot` to start. The bot logs `[bot] logged in as <name>` when it's actually connected to Discord.

---

## 5. HTTPS termination

Two reasonable options. Pick one.

### Option A: Caddy as a fourth container (recommended for this scaffold)

Caddy gets you automatic Let's Encrypt certs with zero config. Add this to [docker-compose.yml](docker-compose.yml):

```yaml
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - web

volumes:
  caddy_data:
  caddy_config:
```

And a `Caddyfile` in the repo root:

```
bot.example.com {
    reverse_proxy web:3000
}
```

That's the whole HTTPS story. Caddy renews certs on its own. First boot takes ~30s while it provisions the cert from Let's Encrypt — make sure DNS already resolves before you start it, or ACME will fail.

### Option B: Lightsail Load Balancer

Console → Networking → Create load balancer → attach instance → enable HTTPS, request a cert through Lightsail (DNS validation), point your domain at the LB instead of the instance. About $18/mo. Worth it only if you also want LB-level health checks or expect to add more instances behind it.

After HTTPS is up, set `NEXTAUTH_URL=https://bot.example.com` in `.env` and `docker compose up -d` to pick it up. Auth.js is strict about this matching — if it doesn't, OAuth callbacks will 400.

---

## 6. Update Discord developer portal

1. https://discord.com/developers/applications → your app → **OAuth2 → General**.
2. Add the prod redirect URL: `https://bot.example.com/api/auth/callback/discord`.
3. Leave the localhost one in place — it doesn't hurt and you'll keep using it.
4. **Installation contexts**: confirm **Guild Install** is checked (User Install is irrelevant for this bot).

---

## 7. Operational basics

### Logs

`docker compose logs -f bot` and `docker compose logs -f web` are enough until they aren't. When they aren't, the README's "Pino + log shipper" note is the path — bind `/var/lib/docker/containers/*/log.json` into a Vector or Fluent Bit container and ship to wherever (CloudWatch, Loki, Datadog). Not worth doing until log volume actually warrants it.

### Restarts and updates

```bash
cd ~/quitting7oh-bot
git pull
docker compose up -d --build
```

`restart: unless-stopped` on each service means containers come back after the instance reboots. No systemd unit needed.

### Backups beyond disk snapshots

Disk snapshots cover the Postgres data dir but assume the DB was in a quiescent state when taken — that's usually fine for a low-write app like this, but if you want belt-and-suspenders, add a nightly `pg_dump` to S3:

```bash
# cron on the host, 03:00 local
0 3 * * * docker compose exec -T postgres pg_dump -U postgres quitting7oh | \
  gzip | aws s3 cp - s3://<bucket>/quitting7oh/$(date +\%F).sql.gz
```

You'll need an IAM user with `s3:PutObject` on that bucket and `aws configure` set up on the instance.

### When to graduate Postgres off the host

Move `DATABASE_URL` to a Lightsail Managed Database or RDS when any of these are true:
- You want point-in-time recovery (snapshots only give you whole-day granularity).
- The DB working set no longer fits in the VM's RAM and queries get slow.
- You want to run more than one app server.

The schema doesn't change — just swap the connection string and re-run `docker compose up -d`. The `migrate` service will run `migrate deploy` against the new DB on next boot.

---

## 8. First-deploy checklist

- [ ] Reverted Dockerfile corp-CA block, deleted `corp-chain.pem`.
- [ ] Generated `prisma/migrations/` locally, committed it, switched compose to `migrate deploy`.
- [ ] `.env` on the server has prod values (real `NEXTAUTH_URL`, fresh `AUTH_SECRET`, correct admin IDs).
- [ ] Static IP attached, DNS resolving, firewall lets in 80/443 only.
- [ ] Persistent disk mounted at `/mnt/pgdata`, daily snapshots on.
- [ ] HTTPS working — `curl -I https://bot.example.com` returns 200 or 302.
- [ ] Discord OAuth redirect URL updated in the dev portal.
- [ ] Sign in once as the bootstrap admin to confirm the auth loop closes.
- [ ] Create one test scheduled post a minute or two out, watch the bot log it firing.

---

## 9. Things deliberately not in scope here

These are the same gaps the README's "What's NOT in this scaffold" section flags. Worth knowing they remain unfixed in prod:

- **No HA**: one VM, one Postgres, one bot worker. A 10-minute reboot = 10 minutes of missed posts.
- **At-least-once delivery**: a network hiccup mid-send can produce a duplicate post. Acceptable trade for "never miss a reminder" — don't try to fix it without a clear reason.
- **No alerting**: if the bot crashloops, you find out the next time you check Discord. Add an uptime ping (UptimeRobot on `https://bot.example.com`) as a cheap floor.
- **No staging environment**: changes go from your laptop straight to prod. For a small bot this is fine; if it stops being fine, spin up a second Lightsail instance with a separate Discord application and point a second domain at it.
