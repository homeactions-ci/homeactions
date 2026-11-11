# Isolation

What keeps CI jobs away from the rest of the machine, and what does not. The owner's scripts set all of it up; the agent only reads it back (`provision.sh verify`, `doctor`).

## The layers

| Layer | macOS | Linux (beta) | Profile fields |
|---|---|---|---|
| **A dedicated CI user** | own group; hidden (UID below 500); not admin, not staff; no ssh login; no secure token (cannot unlock FileVault) | system user (`useradd -r`), own group, no login shell, not in `sudo`/`wheel` | `tenant.user`, `group`, `uid`, `gid`, `home` |
| **The runner daemon runs as that user** | a LaunchDaemon generated from the runner's own template (not `svc.sh install`, which makes a LaunchAgent that dies without a login session), `UserName` = tenant | a hardened systemd unit: `User=`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ReadWritePaths=` the tenant home only, `PrivateTmp=yes`, `Nice=`, `IOSchedulingClass=idle`, `LimitNOFILE=` | `tenant.labelPrefix`, `caps.*` |
| **Root-owned hooks and config** | `ACTIONS_RUNNER_HOOK_JOB_STARTED/COMPLETED` point at scripts under `rootDir`, owned by root, not writable by the tenant | same | `tenant.rootDir` |
| **Immutable runner env** | the runner's `.env` and `.path` are root-owned and flagged immutable (`chflags uchg`), so a job cannot redirect the hooks or `PATH` | `chattr +i` | — |
| **Other people's files** | a deny ACE for the tenant on each other admin's home (`chmod +a "user:<tenant> deny read,list,search,…"`) | home directories `0750`/`0700` and the tenant outside their groups | `host.otherAdmins`, `isolation.forbiddenReadPaths` |
| **Network** | a pf anchor where **every** rule carries `user <tenant>`: loopback only on the tenant's own ports, DNS, the internet; private ranges and other loopback ports blocked | nftables rules matched on `meta skuid <uid>`, same policy | `isolation.network`, `privateRanges`, `ports[]` |
| **Checked before every job** | the job-started hook connects to each `probeTargets` entry and fails the job if any is reachable, reads each `forbiddenReadPaths` entry and fails if any is readable, and checks the ports it needs are free | same | `isolation.probeTargets` |
| **Clean slate per job** | the job-completed hook wipes the job workspace, kills every process of the tenant UID (services first, gently), and frees the tenant's SysV IPC | same | — |
| **No indexing storms** | runner, temp and cache directories end in `.noindex` so Spotlight skips them (no `mdutil`, which is machine-wide and needs root) | n/a | — |
| **Resource caps** | `nice`, open-file limit, CPU caps for builds and test workers, a disk floor, co-tenant yielding | same, plus idle I/O class | `caps.*`, `diskFloorGb`, `cotenant.*` |

## Isolation is one-way

The CI user cannot read your files, reach your local network or your other services, or gain admin rights. **You can still reach the CI user**: an admin can read its home, kill its processes and read its logs. That is intended (it is how `doctor` and the owner's fixes work).

## What is NOT isolated

- **The same kernel.** A kernel or hardware exploit escapes any user boundary. This is not a VM.
- **CPU, memory and disk are shared.** Caps and yielding reduce contention; they do not remove it. A machine you also work on will feel CI.
- **The internet.** Jobs can reach the internet (they must, to fetch dependencies). Anything a job can read, it can send out.
- **The job's GitHub token and any secrets passed to the job.** A PR from anyone with write access runs code that sees them. That is why the default is no secrets on self-hosted (`threat-model.md`).
- **Everything the CI user owns**: its caches, its package store, its built services. One job can poison the next job's cache. The workspace wipe narrows this; the shared store remains.

## Network isolation off

If the user chose "files only" (`isolation.network: false`), say in the plan: a job can then connect to anything on the local network and to every service listening on this machine's loopback (databases, dev servers, admin panels). Recommend turning it back on unless something specific needs the LAN; if so, prefer keeping it on and keeping that job hosted.

## Reading it back (agent, read-only)

- `bash <kit>/provision.sh verify` (no sudo) reports each layer as ok / FAIL / unreadable.
- The last job's banner (`homeactions[<tenant>]` lines in the job log) shows the probe results for that job.
- `doctor` puts both in its table. A probe that cannot run is `unreadable`, not "isolated".
