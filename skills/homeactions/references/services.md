# Services: Postgres and Redis per job

Hosted workflows usually get databases from `services:` containers. homeactions does not use Docker. Instead each job starts its **own** instance, on the tenant's fixed loopback port, and stops it when the job ends.

## How it works

| Step | What happens |
|---|---|
| install (owner, once) | macOS: `provision.sh install` builds the pinned version from source (checksum `services[].sourceSha256`) into the CI user's home, so nothing depends on a shared package manager. Linux (beta): the distro's versioned package (`install: package`) or source. |
| job start | a workflow step runs the rendered service script (`start`): a fresh data directory in the job's temp folder, `listen_addresses = 127.0.0.1`, **no unix socket**, port = `services[].port`. It refuses a port that is busy or not in `ports[]`. |
| job | tests connect to `127.0.0.1:<port>` (`DATABASE_URL` / `REDIS_URL` set by the step). |
| job end | a step under `if: always()` stops it. Whatever survives, the job-completed hook reaps: every tenant process (Postgres first, gently), then the tenant's SysV shared memory and semaphores. |

Exact script paths and step snippets are in the rendered runbook in the runner PR. The workflow rewriter replaces `services:`/`container:` blocks with these steps for jobs that move; hosted jobs keep their containers.

## Rules

- **One instance per job, never shared between jobs.** No state leaks from one PR into another.
- **Loopback and tenant ports only.** The network rules allow the tenant to connect to its own ports and nothing else on loopback.
- **Fixed ports mean one job at a time per port set.** homeactions registers one runner per tenant. Jobs that both need port 5442 cannot run at once on the same tenant; order them with `needs:` (never with a `concurrency:` group, which cancels the pending job and shows red).
- **App servers too.** If e2e tests start an app server, its port is in `ports[]`, and the test config must not reuse a server left by another job (Playwright: `reuseExistingServer: !process.env.CI`).
- **Versions are pinned** like runtimes: what the hosted container ran (`postgres:16` → pick the exact `16.x`), recorded in the profile.

## Troubleshooting

- "port … busy" in the job banner → `troubleshooting.md` § Port held.
- leftover `postgres` processes or "could not create shared memory segment" → § Orphaned processes.
- slow first job after install → expected once per runner (builds and caches warm up).
