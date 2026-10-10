# Migration record: smaller production host

The production bot was moved to a fresh **2 GiB Lightsail VM** on October 9,
2026 (America/Chicago). The same running application, PostgreSQL and Caddy
image digests were retained. No application upgrade or Prisma schema push was
performed. The old containers were stopped, then the old VM was shut down
through AWS at the owner's request. Nothing was deleted from the old host.

Account/resource identifiers, addresses, key names, DNS hostnames and detailed
backup inventory remain in the private operator records. Production secrets
and private Terraform state are excluded from this repository.

## Capacity decision

| Measure | Observation |
| --- | --- |
| Source bundle | 16 GiB; $84/month |
| Target bundle | 2 GiB, 2 vCPUs, 60 GB root disk; $12/month |
| Optional larger target | 4 GiB, 80 GB root disk; $24/month |
| Source host working memory | About 1.4 GiB |
| Source containers combined | About 466 MiB |
| New host after scheduled fire | 865 MiB used; 1,040 MiB available |
| New bot / web / PostgreSQL / Caddy | Approximately 96 / 199 / 192 / 54 MiB |
| Swap | 2 GiB enabled; 53 MiB retained from setup/restore; no active swapping in sampled steady operation |
| Disk after restore and preserved backups | About 36 GB available |
| Persisted archive | About 5 GiB |
| Source logical database | About 350 MiB |

Prices were returned by the regional AWS bundle API at migration time. The
instance-charge reduction is $72/month after the old host is deleted; old VM,
disk, snapshot, transfer and tax charges are separate. Stopped Lightsail VMs
still incur bundle charges.

The 2 GiB choice is supported by normal-load measurements and initial runtime
verification. It is not a worst-case guarantee for concurrent heavy jobs.
Observe at least 48–72 hours and exercise a representative export/backfill
before retiring the old resources. Pull CI images; do not build Next.js on
the smaller host.

## Completed checkpoints

- A manual snapshot of the old root disk became available before Terraform
  apply. Protected logical/configuration/archive/Caddy backups were retained on
  both hosts with validated backup checksums.
- A reviewed Terraform plan created exactly four resources for the new host;
  no old resource was modified or destroyed by Terraform. Bootstrap, Docker,
  swap, static addressing, firewall and daily snapshots were verified.
- A rehearsal DB/archive restore and valid origin HTTPS were verified while
  the new bot stayed stopped. Existing auth/Discord configuration was preserved;
  a new explicit DB password was generated on the new host and stored only in
  its protected production `.env`.
- All four job queues were idle before stopping old writers. The final
  PostgreSQL custom-format dump was restored in one transaction. All 27 table
  row counts matched. Every archive file path, size and SHA-256 matched, including
  a check for extra destination files.
- Cloudflare was verified as authoritative. The owner changed the proxied origin
  to the new host. HTTPS worked at the origin and public URL, and the owner
  confirmed the existing authenticated dashboard session worked.
- All old containers were stopped before the new bot started. The new bot
  logged in to Discord and activated the scheduler and workers. All four new
  containers had zero restarts and OOM kills; startup error checks were clear.
- The next natural scheduled post fired successfully at 19:45 CDT: one message,
  zero failures, and the next scheduled time advanced. No synthetic test message
  was sent.
- Temporary transfer-key authorization was revoked on the new host. Existing
  workstation access remained valid. Old files and data were preserved.
- Post-apply Terraform validation/drift verification returned no changes.
  A further manual snapshot of the new host was requested; consult the private
  AWS inventory for its current status.
- The old VM was subsequently confirmed `stopped` through AWS. Its dynamic
  public address must be checked after restart before any rollback.

## Recovery information

The new app directory is `/home/ubuntu/quitting7oh-bot`, with `compose.yml` and
mode-600 `.env`. The generated DB password is in that environment file; it is
not recorded here. The private operator inventory holds the protected backup
locations, manual snapshot names, current endpoints, original SSH-key path and
Terraform state. Preserve it independently of the application repository.

Use [the runbook](README.md#rollback-and-retention) for a state-preserving
rollback. The old DB is now stale: capture fresh new-host state before bringing
old writers back. The old host, disks and snapshots are retained for the owner
to delete separately after acceptance.
