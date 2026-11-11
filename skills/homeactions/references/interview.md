# The interview

Twelve topics, in this order. Every answer fills a field of `kit/profile.schema.json`; the tables below say which. Nothing is rendered or written to the repo until the profile validates **and** the user approves the plan (`plan-template.md`).

## Rules

- **Batch: at most 4 questions per `AskUserQuestion` call, at most 4 options per question.** Put the recommended option first and say "(recommended)". The tool adds "Other" itself. `AskUserQuestion` exists only in the main thread: never fork this skill or run the interview in a subagent.
- **No `AskUserQuestion`?** (Codex, Cursor, Copilot, a subagent, an eval.) Ask the same questions as a plain numbered list, options as `a) b) c)`, and stop to wait for the answer. Never invent the answer.
- **Read before asking.** Anything the repo or a read-only probe can tell you (lockfiles, workflow files, `gh repo view`), detect first and ask the user only to confirm.
- **"I don't know" / "not sure" → measure, read-only.** Run the probes listed under the topic (over `ssh <alias> '...'` for a remote host), show the raw result in one or two lines, state the value you will use, and ask to confirm. A probe that fails is reported as `unreadable`, never as "none".
- **"Skip the questions" / "just do it"** → fill every field from detection, probes and the defaults below, mark each one `(default)` or `(measured)` in the plan summary, and still ask the plan's yes/no.
- **Never ask for tokens, passwords or keys.** Never put an IP address or `user@host` in the profile: remote hosts are an alias from the user's `~/.ssh/config`.
- **Linux is beta.** Say so the moment the user picks Linux.
- Keep a scratch draft (`${CLAUDE_PLUGIN_DATA}/drafts/<owner>-<repo>.json` or your temp dir). Validate it with the snippet in `SKILL.md` after each batch.

## Batches

| Call | Topics | Questions |
|---|---|---|
| A | 1, 2 | machine kind; local or remote; always-on and power; offer to measure |
| B | 3, 4 | repository visibility and fork PRs (confirm); which jobs move; hosted fallback |
| C | 5, 6, 7 | stack (confirm detected); databases; browsers |
| D | 8, 9 | other workloads and co-tenant; isolation |
| E | 10, 11, 12 | who is admin; budget, tolerance and watchdog; secrets |

---

## 1. The machine

**Ask (batch A):**

1. "Which machine will run your CI?" — a) This Mac (the one I'm running on) · b) Another Mac I can ssh into · c) A Linux box I can ssh into (beta) · d) This Linux machine (beta)
2. "Is it on all the time?" — a) Yes, always on, wired network (recommended) · b) Mostly; it sleeps or travels sometimes · c) It's my daily laptop · d) I don't know
3. "Shall I measure its cores, memory, disk, disk encryption and power settings? (read-only, nothing changes)" — a) Yes, measure (recommended) · b) No, I'll tell you

A laptop that sleeps is allowed but the plan says plainly that jobs fall back to hosted (or queue) while it sleeps.

**Fills:** `host.os`, `host.arch`, `host.cores`, `host.memoryGb`, `host.diskEncryption`, `host.autoRestart`, and seeds `diskFloorGb` and `caps`.

**Probes (read-only):**

| Fact | macOS | Linux |
|---|---|---|
| OS, version | `sw_vers` | `cat /etc/os-release` |
| arch | `uname -m` (`arm64` → `arm64`, `x86_64` → `x64`) | `uname -m` (`aarch64` → `arm64`, `x86_64` → `x64`) |
| cores | `sysctl -n hw.ncpu hw.perflevel0.physicalcpu hw.perflevel1.physicalcpu` | `nproc` |
| RAM | `sysctl -n hw.memsize` (bytes) | `grep MemTotal /proc/meminfo` |
| disk free | `df -g /` | `df -BG /` |
| swap now | `sysctl vm.swapusage` | `free -m` |
| disk encryption | `fdesetup status` → `filevault` / `none` | `lsblk -o NAME,TYPE,FSTYPE` (a `crypt` row or `crypto_LUKS` → `luks`) |
| auto-restart after power loss | `pmset -g | grep -i autorestart` (1 → true, 0 → false) | not readable without firmware access → `null`, and ask |
| model (optional) | `sysctl -n hw.model` | `cat /sys/devices/virtual/dmi/id/product_name` (may be unreadable) |

**FileVault/LUKS + no auto-login means nothing runs after a power cut until someone types the disk password.** Say this in the plan when `diskEncryption` is `filevault` or `luks`; it is the owner's choice, not a reason to turn encryption off.

**Defaults:** `diskFloorGb` = max(20, 10 % of the disk), `caps.nice` = 10, `caps.openFiles` = 10240, `caps.nextBuildCpus` / `turboConcurrency` = max(1, floor(cores / 4)) on a shared machine or floor(cores / 2) on a dedicated one, `jestMaxWorkers` / `playwrightWorkers` = 1 when RAM ≤ 16 GB or co-tenants exist, else 2.

## 2. Local or remote

**Ask (batch A):** "How do you reach it?" — a) It's this machine · b) ssh, with a Host alias in my ~/.ssh/config (recommended for remote) · c) ssh by address (I'll add an alias)

For c), ask them to add a `Host` entry to `~/.ssh/config` themselves and tell you the alias. Never record an address.

**Fills:** `host.access` (`local` / `ssh`), `host.sshAlias`.

**Probes:** `ssh -G <alias> | head -5` (reads the config, does not connect); `ssh -o BatchMode=yes -o ConnectTimeout=5 <alias> true` (connects, runs nothing). If BatchMode fails, the user's key needs a passphrase or agent: they fix that; you do not handle keys.

## 3. Repository host and visibility

**Detect, then confirm (batch B):** `gh repo view --json nameWithOwner,visibility,isFork,defaultBranchRef`; `grep -n "pull_request" .github/workflows/*.yml`.

1. "This is `<owner/name>`, a `<visibility>` repository. Right?" — a) Yes · b) No, it's another repo
2. Only if public: "Do your workflows run for pull requests from forks?" — a) Yes · b) No, only branches in this repo · c) I don't know (→ measure: `pull_request` triggers in a public repo mean yes)

**Public with fork PRs → refuse self-hosted for those workflows.** Explain: anyone who opens a PR would run code on this machine. Offer the audit, the optimisation PR, and keeping those workflows hosted (public repos get free hosted minutes anyway).

**Fills:** `repo.slug`, `repo.visibility`, `repo.forkPrs`.

## 4. CI provider and workflows

**Detect:** `ls .github/workflows/`; the audit's workflow and job inventory; its infrastructure findings (I1 heavy jobs that suit the runner, I2 jobs that should stay hosted). Only GitHub Actions is supported; other providers end the setup with the audit only.

**Ask (batch B):**

3. "Which jobs should move to your machine?" (multi-select, from the audit's I1 list; up to 4 options, the rest in "Other") — default: every job the audit marks I1.
4. "Keep a one-switch fallback to GitHub-hosted runners?" — a) Yes, a repository variable flips jobs back to hosted (recommended) · b) Yes, and PR labels can force either side per PR (recommended for canaries) · c) No fallback (not recommended)

Jobs the audit marks I2 (tiny, needs secrets, needs an OS the host lacks, release jobs) stay hosted, with the reason shown. The watchdog and the closed-PR reaper never run on the machine they watch.

**Fills:** `workflows.hostedOnlyJobs` (`<file>.yml#<job>`), `workflows.fallbackVariable` (default `<REPO>_CI_RUNNER`, uppercased, `-` → `_`), `workflows.selfValue` (default `self`), `workflows.selfLabel` (default `ci:self`), `workflows.hostedLabel` (default `ci:hosted`), `optimizations[]` (the selected audit ids with their targets: code/budget → `optimise-pr`, infrastructure → `runner-pr`, owner UI items such as B5 → `owner-checklist`).

**Measured, never asked:** `runner.version` and `runner.sha256.*` from the latest `actions/runner` release: `gh api repos/actions/runner/releases/latest --jq '.tag_name, .body'` (the release notes carry the SHA-256 of every tarball). Pin the exact version.

## 5. Languages and test stack

**Detect:** lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lockb`, `poetry.lock`, `uv.lock`, `requirements*.txt`, `go.sum`, `Cargo.lock`); `package.json` (`packageManager`, `engines`, scripts); `.nvmrc`, `.node-version`, `.python-version`, `.tool-versions`, `go.mod`, `rust-toolchain.toml`; `turbo.json`, `nx.json`, `lerna.json`; test configs (`jest.config.*`, `vitest.config.*`, `playwright.config.*`, `pytest.ini`, `pyproject.toml`).

**Ask (batch C):** "I found `<pnpm 9, Node 24.10.0, turbo, jest + Playwright>`. Right?" — a) Yes · b) Mostly; I'll correct it

Pin runtimes to an exact `x.y.z` (a floating major such as `24` resolves to a different patch release on the next install). If the repo pins only a major, say so and propose the exact version the hosted runs used (from the audit's job logs) or the current one.

**Fills:** `stack.packageManager`, `stack.runtimes` (`{"node": "24.10.0"}`), `stack.monorepoTool`, `caps.jestMaxWorkers`, `caps.playwrightWorkers`, `caps.turboConcurrency`, `caps.nextBuildCpus`.

## 6. Databases

**Detect:** `services:` blocks in workflows (`postgres:16`, `redis:7`), `DATABASE_URL`/`REDIS_URL` in workflow env, docker-compose files.

**Ask (batch C):** "Your CI uses `<Postgres 16>`. On your machine each job gets its own instance on a private port, started and stopped by the job. OK?" — a) Yes (recommended) · b) We also need Redis · c) No database in CI · d) Something else (Other)

Docker is not used. On macOS, services are built from source into the CI user's home; on Linux they come from the distro's versioned package or from source (`services.md`).

**Fills:** `services[]` (`kind`, `version` as `x.y` or `x.y.z`, `port`, `install`, `sourceSha256` for source builds), and adds each service port to `ports[]`. Default ports: Postgres 5442, Redis 6390, unless the port probe in topic 8 shows them taken.

## 7. Browsers

**Detect:** Playwright/Cypress/Puppeteer configs and `projects`.

**Ask (batch C):** "Which browsers do your end-to-end tests need on this machine?" — a) Chromium only (recommended on a shared machine) · b) Chromium + Firefox · c) Chromium + Firefox + WebKit · d) None

WebKit on a Linux host needs system libraries the CI user cannot install: keep WebKit jobs hosted there (`hostedOnlyJobs`).

**Fills:** `stack.browsers`; app server ports used by e2e (`webServer.port` in Playwright configs) go into `ports[]`.

## 8. Other workloads on the machine

**Ask (batch D):**

1. "Does anything else run on this machine?" — a) No, it's dedicated to CI (recommended) · b) Yes: my own work / dev servers · c) Yes: another CI runner or automation · d) I don't know (→ measure)
2. Only for c): "Does the other workload mark when it's busy, so CI can wait?" — a) Yes, it writes marker files in a folder · b) Yes, a command tells me if it's busy · c) No · d) I don't know (→ measure)

**Probes (read-only):**

| Fact | macOS | Linux |
|---|---|---|
| human and admin accounts | `dscl . -list /Users UniqueID` (UID ≥ 500); `dscl . -read /Groups/admin GroupMembership` | `getent passwd` (UID ≥ 1000); `getent group sudo wheel admin` |
| free UID/GID for the tenant | `dscl . -list /Users UniqueID`, `dscl . -list /Groups PrimaryGroupID` (pick unused, 401–499 hides it from the login window) | `getent passwd <n>`, `getent group <n>` (system range below 1000) |
| listening ports | `netstat -anv -p tcp | grep LISTEN` (all users) and `lsof -nP -iTCP -sTCP:LISTEN` (your own only: say "partial") | `ss -ltn` (ports; process names need root: say "partial") |
| existing runners | `pgrep -fl Runner.Listener`; `ls -d /Users/*/actions-runner* 2>/dev/null`; `gh api repos/<o>/<r>/actions/runners` | same with `/home/*` and `/var/lib/*` |
| system jobs | `ls /Library/LaunchDaemons /Library/LaunchAgents`; `launchctl list` (yours) | `systemctl list-units --type=service --state=running --no-pager`; `ls /etc/systemd/system` |
| busy signals | look for marker folders the other workload documents (often under `/Users/Shared` or `/var/lib`); `ls -l <dir>` | same |
| current load | `uptime`; `sysctl vm.swapusage`; `memory_pressure -Q` | `uptime`; `free -m`; `cat /proc/pressure/memory` |

Another user's home or marker folder may be unreadable to you: report "unreadable" and ask the user what is there.

**Fills:** `host.otherAdmins`, `tenant.uid`, `tenant.gid`, `ports[]` (avoid every port already listening), `cotenant.mode` (`none` / `marker-dir` / `command`), `cotenant.markerDir`, `cotenant.pidGlob` (markers judged live by their JSON pid), `cotenant.epochFile` + `epochBoundSeconds` (an intent marker judged by its age), `cotenant.command` (exit 0 = clear), `cotenant.workerProbe` (another CI user's `Runner.Worker` processes, counted in the banner, never touched), `cotenant.yieldBudgetSeconds` (default 900), `cotenant.pollSeconds` (default 15), `cotenant.swapYieldMb` (default 0; on a 16 GB machine with co-tenants, about 10 % of RAM).

**Tenant names (defaults, shown in the plan, user may rename):** `tenant.name` and `tenant.user` = `<repo>-ci` (lowercase, ≤ 31 chars), `tenant.group` = same, `tenant.home` = `/Users/<user>` (macOS) or `/var/lib/<user>` (Linux), `tenant.labelPrefix` = `local.homeactions.<name>`, `tenant.rootDir` = `/Library/HomeactionsCI-<name>` (macOS) or `/opt/homeactions-<name>` (Linux), `tenant.runnerName` = `<short machine name>-<name>-1`, `tenant.runnerLabels` = `["<name>"]`.

## 9. Isolation

**Ask (batch D):** "How strictly should CI be kept away from the rest of this machine?" — a) Full: its own user, no access to other users' files, network limited to the internet and its own ports (recommended) · b) Files only, no network rules · c) Explain the difference first

Network isolation is on by default. Turn it off only if the user chooses b), and say what that means (`isolation.md`).

**Fills:** `isolation.network`, `isolation.privateRanges` (default: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10`, `fc00::/7`, `fe80::/10`), `isolation.probeTargets` (`127.0.0.1:<port>` for ports other workloads listen on, plus `127.0.0.1:22`; each is checked before every job and must be unreachable), `isolation.forbiddenReadPaths` (the home of each account in `host.otherAdmins`, plus any marker folder that must stay private).

## 10. Who has admin

**Ask (batch E):**

1. "Who can run admin (sudo) commands on that machine?" — a) Me · b) Someone else (I'll pass them the steps) · c) I don't know (→ measure: `id -Gn` contains `admin`, `sudo` or `wheel`)
2. "Who is an admin of the GitHub repository (can add runners and repository variables)?" — a) Me · b) Someone else · c) I don't know (→ measure: `gh api repos/<o>/<r> --jq .permissions.admin`)

Record roles, never names: "you", "your IT admin", "the repository owner".

**Fills:** `roles.machineAdmin`, `roles.repoAdmin`.

## 11. Budget and tolerance

**Ask (batch E):**

1. "If your machine is off or broken, what should happen to CI?" — a) Jobs fall back to GitHub-hosted once someone removes the variable (recommended) · b) Jobs wait in the queue until the machine is back
2. "Where should the watchdog live (it must not live on the machine it watches)?" — a) A scheduled cloud agent or routine (recommended) · b) A tiny scheduled GitHub-hosted workflow · c) A scheduled task on my laptop · d) None for now — see `watchdog.md` for what each sees
3. "Job time limits: when a job hangs, stop it after…" — a) 2× its longest green run, rounded up to 5 minutes, minimum 10 (recommended) · b) Keep my current limits

**Fills:** `watchdog.placement` (`cloud-routine` / `hosted-cron` / `laptop-task` / `watcher-user` / `none`), `watchdog.thresholdMinutes` (default 30), `watchdog.reapClosedPrs` (default true), `maintenance.cron` (default weekly at a quiet hour the user names; `homeMaxGb` default 30; `diagRetentionDays` default 14), `diskFloorGb` (confirm the topic-1 default), and the B1 timeout budgets in the optimisation PR.

## 12. Secrets

**Detect:** `grep -n "secrets\." .github/workflows/*.yml`.

**Ask (batch E):** "These jobs use secrets: `<list>`. On your machine, any PR from someone with write access could read secrets passed to its jobs. What should we do?" — a) No secrets on the self-hosted runner; those jobs stay hosted (recommended) · b) Allow the listed ones, and I accept the risk

**Fills:** `secretsPolicy` (`none` / `allow-listed`). Jobs that use secrets under `none` are added to `workflows.hostedOnlyJobs`.

---

## Field coverage

Every required field of `profile.schema.json` and where it comes from:

| Field | Topic / source |
|---|---|
| `schemaVersion` | constant 1 |
| `tenant.*` | 8 (names, ids), defaults above |
| `host.*` | 1, 2, 8 (`otherAdmins`) |
| `repo.*` | 3 |
| `runner.*` | measured (topic 4) |
| `workflows.*` | 4, 12 |
| `stack.*` | 5, 7 |
| `caps.*` | 1, 5, 8 |
| `services[]` | 6 |
| `ports[]` | 6, 7, 8 |
| `isolation.*` | 8, 9 |
| `cotenant.*` | 8 |
| `diskFloorGb` | 1, 11 |
| `maintenance.*` | 11 |
| `secretsPolicy` | 12 |
| `watchdog.*` | 11 |
| `roles.*` | 10 |
| `optimizations[]` | step 0 (audit selection) |
