# Smaller Lightsail host

Terraform provisions a fresh Ubuntu 24.04 VM for the existing Docker Compose
stack. The default bundle has **2 GiB RAM, 2 vCPUs and a 60 GB root disk**;
`medium_3_0` provides 4 GiB and an 80 GB disk. This is a Lightsail VM running
containers. The current PostgreSQL bind mount and shared archive volume require
persistent host storage; moving to the managed Container Service would require
separate database and archive storage.

The completed migration and measured capacity are recorded in
[MIGRATION.md](MIGRATION.md). Deployment identifiers and credentials are kept
in the private operator inventory.

## What Terraform owns

Four resources: a new VM, static address, address attachment and firewall.
The VM and static address have `prevent_destroy`. DNS, application secrets,
data transfer and the old host remain operator-managed.

Bootstrap installs Docker/Compose and rsync, adds the supplied public SSH key,
stages the Compose/Caddy configuration, enables 2 GiB swap and bounds Docker
logs. It creates a `HOST_READY` marker after setup succeeds. It does not start
production services. PostgreSQL is the only service in the default Compose
profile; web, bot and Caddy require explicit selection with the `live` profile.
The optional `maintenance` profile runs a schema push and must not be used for
a same-release restore.

SSH is restricted to the operator's private allowlist. HTTP/HTTPS are public.
PostgreSQL has no published port; the web port binds to loopback. All application,
PostgreSQL and Caddy image references must use immutable SHA-256 digests from
the source release. Daily instance snapshots are enabled at the configured UTC
hour. The source private SSH key and production `.env` never enter Terraform.

## Private inputs and planning

```bash
cd infra/lightsail
umask 077
cp terraform.tfvars.example terraform.tfvars
# Fill the required values privately before continuing.
chmod 600 terraform.tfvars
terraform init
terraform fmt -check -recursive
terraform validate
terraform plan -out=host.tfplan
chmod 600 host.tfplan
terraform show host.tfplan
```

The example intentionally has blank values and an empty SSH/account allowlist.
It cannot provision a host until those inputs are supplied. Reuse an existing
Lightsail key pair in the selected region and verify that it matches the
operator's `.pub` file. Pin the running image digests; choosing a newer release
would combine infrastructure migration with an application/schema upgrade.

Real `terraform.tfvars`, state, plans, rendered templates, keys, secrets and the
`private/` directory are ignored by Git. Keep AWS account IDs, resource names,
addresses, domains, SSH fingerprints and backup locations in that private
inventory. Sensitive markings hide selected CLI values, but **state and saved
plans still contain deployment identifiers**. Protect them and do not attach
raw plan output to a public PR.

For a new deployment the reviewed plan should contain exactly four additions
and no existing-resource changes. Apply only the selected fresh plan:

```bash
terraform apply host.tfplan
chmod 600 terraform.tfstate
```

### Working with the already-deployed host

This module does not adopt existing resources automatically. Restore the secure
existing state and configure inputs to match that deployment before planning.
Match the region/AZ, names, key pair, public key, application domain and all image
digests. Changing launch configuration or bundle can require replacement;
`prevent_destroy` blocks that replacement. Do not apply a stale creation plan
or remove the guard to make an unexpected replacement proceed. Take a backup
and plan a separate host migration when a larger bundle is required.

The private operator checkout retains the state and exact deployed values. The
repository contains the parameterized module and sanitized runbook only.

## Backup and migration procedure

Use private operator variables for both SSH endpoints, the SSH key path,
application domain, AWS region, instance names and backup IDs. Do not put their
resolved values into committed files or PR metadata.

1. Take a **manual instance snapshot before changing production** and wait for
   it to become available. Capture a PostgreSQL custom-format dump, production
   configuration, archives and Caddy data/config in a mode-700 backup directory
   with mode-600 files. Validate `pg_restore --list`, gzip integrity and SHA-256
   checksums. Preserve an off-host copy.
2. Confirm where PostgreSQL is actually stored with `findmnt` and Docker mount
   inspection. In this migration `/mnt/pgdata` was on the root filesystem;
   an attached disk was not the active data source. A snapshot of that attached
   disk alone would have missed the production database.
3. Provision the new host, verify its SSH host key, and wait for cloud-init and
   `HOST_READY`. Check Docker/Compose, memory, swap and free disk space. A fresh
   logical restore is needed when moving to a smaller root disk; the larger
   instance snapshot cannot be restored into the smaller bundle.
4. Transfer production configuration directly to the new host with an approved
   private transfer method. Preserve existing Discord/OAuth credentials and the
   auth secret. Generate an explicit PostgreSQL password on the new host and
   append it to its mode-600 `.env`; a 48-character random hex value is safe in
   the Compose connection URL. Keep the private SSH key on the workstation.
5. Pull the pinned images and start **only PostgreSQL**. Restore an online
   rehearsal backup with the new bot stopped. Copy archives and Caddy volumes,
   then start only web/Caddy. Check HTTPS with `curl --resolve` against the new
   origin and verify the login page and provider callback.
6. Drain active jobs and announce the cutover window. Stop old bot/web/Caddy;
   keep old PostgreSQL running for the final logical dump. Stop new web/Caddy
   before restoring again. Capture a final dump, archive/Caddy backups, all-table
   row counts and a per-file archive SHA-256 manifest. Transfer over the private
   network. Never delete source files.
7. Restore the final DB in one transaction. Compare all table counts and archive
   paths, sizes and hashes before starting writers. Overlaying an archive copy
   alone can retain stale destination files; exact manifest comparison must
   detect extras as well as missing/changed files. If destination cleanup is
   necessary, stop the destination writers and review that cleanup separately.
8. Start new web/Caddy, verify the origin, and update the **authoritative DNS
   provider**. Check public NS records first: a Route 53 zone existing in the
   account does not prove it is authoritative. The completed migration used
   Cloudflare; proxied public A records show edge addresses, not the origin.
9. Confirm all old containers are stopped before starting the new bot. Verify
   Discord login, scheduler/worker startup, runtime errors, restart/OOM counts
   and normal scheduled activity. Check the public portal and authenticated
   dashboard. Revoke any dedicated transfer-key authorization on the new host;
   preserve the old host's data and files.
10. At the operator's request, stop the old VM through AWS and verify `stopped`.
    Keep its disks and manual snapshots. Its dynamic public IP can change on
    restart; retrieve the current address before a rollback DNS update.

On the **new host**, selected commands are:

```bash
cd /home/ubuntu/quitting7oh-bot
docker compose --profile live pull postgres web bot caddy
docker compose up -d --wait postgres
# Feed only the verified final custom-format dump into this restore:
docker compose exec -T postgres pg_restore \
  -U postgres -d quitting7oh --clean --if-exists --no-owner --no-privileges \
  --exit-on-error --single-transaction < "$FINAL_DUMP"
# Finish row-count/archive verification before bringing up web/Caddy.
docker compose --profile live up -d --wait web caddy < /dev/null
# Start only after the old worker is confirmed stopped:
docker compose --profile live up -d --wait bot < /dev/null
```

When running these inside an SSH heredoc, explicitly redirect no-input commands
from `/dev/null`; otherwise nested SSH or interactive `docker compose exec` can
consume the remaining script. A restore's explicit dump-file redirection is
intentional. Never run bare `--profile live up -d` during rehearsal.

## Rollback and retention

After the new host has processed events or portal writes, the old DB is stale.
Restarting it without transferring the new state can lose changes and replay
sent jobs. Stop new writers first, capture fresh DB/archive backups, then start
the old VM and retrieve its current address. Keep its writers stopped while
restoring that fresh state. Replacing old data requires separate authorization;
preserve another backup before that restore. Verify data and switch the
Cloudflare origin before starting only the old worker.

Lightsail **manual snapshots survive deleting their source host** until manually
deleted. Automatic snapshots are removed when their source host is deleted;
copy any automatic snapshot to a manual one before retiring its source.
Snapshot storage continues billing. Stopping a VM does not stop its bundle
charges; deleting the old VM and optional disk is a separate owner action.

Observe normal operation and representative exports/backfills for 48–72 hours.
The measured normal load fits 2 GiB; sustained swapping or memory pressure
calls for the 4 GiB option. Continue independent DB/archive backups; daily
instance snapshots are crash-consistent. Monitor free space and archive growth.

References: [AWS Lightsail pricing](https://aws.amazon.com/lightsail/pricing/),
[AWS snapshots](https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-snapshots-in-amazon-lightsail.html),
[AWS snapshot sizing](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-faq-snapshots.html),
[Terraform Lightsail instance](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lightsail_instance).
