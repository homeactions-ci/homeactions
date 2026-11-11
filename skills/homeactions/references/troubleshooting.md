# Troubleshooting

One entry per hook message and per common symptom: **what you see → cause → fix → who runs it**. The agent diagnoses read-only; every fix that needs admin rights is handed to the owner as an exact command. `doctor` prints the matching entry for each failing row.

Hook messages start with `homeactions[<tenant>]`. A failure is printed as `::error::homeactions[<tenant>] <message>` and fails the job before any step runs; a warning is printed and the job continues. The quoted message fragments below are from the rendered hooks (`host/hooks/`); `<…>` parts vary.

Placeholders: `<tenant>` = `tenant.user`, `<label>` = the daemon label (`<tenant.labelPrefix>.runner`), `<unit>` = the systemd unit, `<kit>` = where the owner copied the kit, `<runner dir>` = the tenant's `actions-runner` directory.

Owner scripts are run **as the owner, without `sudo` in front**: they refuse to run as root and call `sudo` themselves (`owner-checklist.md`).

---

## Hook failures (the job fails before any step)

### "running as `<user>`, not `<tenant>`" / "uid is …" / "primary group is …"
- **Cause:** the runner was started by something other than the generated daemon (for example the vendor's `svc.sh install`, which creates a per-login LaunchAgent), or registered under another account, or the tenant's group was changed.
- **Fix:** owner re-runs `bash <kit>/provision.sh install --dry-run`, then without `--dry-run` (idempotent; it rewrites the user, group and daemon). Remove any extra runner service the vendor script created.
- **Who:** owner.

### "`<tenant>` is a member of group `<group>` (admin-equivalent): remove it"
- **Cause:** someone added the CI user to `admin`, `wheel`, `sudo` or a similar group. That would give every PR author admin rights.
- **Fix:** owner removes it from that group (macOS `sudo dseditgroup -o edit -d <tenant> -t user <group>`, Linux `sudo gpasswd -d <tenant> <group>`), then the agent runs `verify`.
- **Who:** owner.

### "`<file>` is missing" / "is not owned by root" / "is not immutable" / "is group/other-writable" / "`<dir>` is writable by `<tenant>`"
- **Cause:** the runner's `.env`/`.path`, the hooks or the config directory lost their root ownership or immutable flag: a manual re-registration, a restore, or someone editing them. A job could then redirect the hooks or its `PATH`.
- **Fix:** owner re-runs `bash <kit>/provision.sh install` (rewrites and re-locks them); if the runner's config is gone, `register` again. Then the agent runs `verify`.
- **Who:** owner.

### "network isolation is not active: `<tenant>` reached `<host:port>` (owner: re-apply the … rules)"
- **Cause:** the pf anchor / nftables table is not loaded: after a reboot before the loader ran, a macOS update that rewrote `/etc/pf.conf`, or pf disabled by another tool.
- **Fix:** owner reloads the rules: `bash <kit>/provision.sh firewall --dry-run`, then `bash <kit>/provision.sh firewall`. Then the agent runs `bash <kit>/provision.sh verify`.
- **Who:** owner (reload), agent (verify).

### "`<path>` is readable by `<tenant>`"
- **Cause:** a path from `isolation.forbiddenReadPaths` lost its deny ACE (macOS) or its home permissions (Linux): a new admin account, a migration or restore that reset ACLs, or a home recreated.
- **Fix:** add the account to the profile if it is new (`host.otherAdmins`), re-render, then owner re-runs `bash <kit>/provision.sh install`.
- **Who:** agent (profile + PR), owner (install).

### "co-tenant markers UNREADABLE: …" / "`<marker dir>` is writable by `<tenant>`"
- **Cause:** unreadable: the tenant cannot list or read the other workload's markers (wrong mode or group, or the group was granted after the daemon started: group membership is fixed when a process starts). Writable: the tenant could forge or delete the other workload's markers.
- **Fix:** owner sets the marker directory readable but not writable by the tenant (group or ACL, as the other workload documents), then restarts the daemon: macOS `sudo launchctl kickstart -k system/<label>`, Linux `sudo systemctl restart <unit>`. An unreadable signal is never treated as "clear", so jobs fail until this is fixed (or the owner removes the co-tenant from the profile and re-renders).
- **Who:** owner.

### "a tenant port is held by another process: …"
- **Cause:** a process from an earlier job survived (the job-completed hook did not run: the daemon was killed or the machine crashed), or another program started listening on a port in `ports[]`.
- **Fix:** find the holder read-only: macOS `netstat -anv -p tcp | grep '\.<port> '` (PID column), Linux `ss -ltn 'sport = :<port>'`; then `ps -o user,pid,etime,command -p <pid>`. A tenant process: the owner runs `sudo pkill -u <tenant>`. Another program: move that program, or pick another port in the profile and re-render.
- **Who:** agent (diagnose), owner (kill or move).

### "free disk `<n>` GB is under the `<m>` GB floor"
- **Cause:** caches, browser downloads, `_diag` logs and package stores grew; or something else on the machine filled the disk.
- **Fix:** dispatch the maintenance workflow (agent, with the user's yes: `gh workflow run homeactions-runner-maintenance.yml`); it prunes the tenant's stores and logs and reports `du`. If the space is used outside the tenant, the owner frees it. Lower `maintenance.homeMaxGb` or the floor only if the disk is genuinely small.
- **Who:** agent (dispatch, after yes), owner (anything outside the tenant).

### "cannot read `<tenant.conf | lib.sh>`"
- **Cause:** the root-owned config or hook library is missing or unreadable to the tenant (a partial install or a manual change of modes).
- **Fix:** owner re-runs `bash <kit>/provision.sh install`.
- **Who:** owner.

### Job-completed: "a listener of this job was bound off loopback: …"
- **Cause:** a server started by the job listened on all interfaces (`0.0.0.0`/`::`) instead of `127.0.0.1`, exposing it to the network for the job's duration.
- **Fix:** bind the server to `127.0.0.1` in the workflow or test config (for example `HOST=127.0.0.1`, `--hostname 127.0.0.1`).
- **Who:** agent (workflow PR).

## Hook warnings (the job continues)

### "co-tenant signal became unreadable …; starting without waiting (fail-open)"
- **Cause:** the marker directory or command became unreadable while the job was waiting.
- **Fix:** as for "co-tenant markers UNREADABLE" above. One occurrence is harmless; the next job start fails if it persists.
- **Who:** owner.

### Waited for the co-tenant for the whole budget, then started
- **Cause:** the other workload was busy for the whole `cotenant.yieldBudgetSeconds`.
- **Fix:** none needed once. If it happens on most jobs, move CI to quieter hours, raise the budget, or measure the co-run cost again (setup step 9).
- **Who:** user (decision).

### "workspace … not wiped" / "listener check UNREADABLE (no lsof or ss)"
- **Cause:** the workspace path looked unsafe to delete (outside the runner's work root, a symlink, not a plain path), or neither `lsof` nor `ss` was available to check listeners.
- **Fix:** read the path in the warning; usually a workflow that changed `working-directory` or checkout `path` to somewhere outside the work root. Keep checkouts under the default work root. Install `lsof`/`ss` (owner) if missing.
- **Who:** agent (workflow), owner (tools).

### No banner at all
- **Cause:** jobs run but print no `homeactions[<tenant>]` lines: the runner's `.env` lost the hook variables (a re-registration by hand, or the immutable flag removed and the file rewritten).
- **Fix:** owner re-runs `bash <kit>/provision.sh install`, then the agent runs `verify`.
- **Who:** owner.

---

## Symptoms

### Jobs queued forever
- **You see:** jobs sit in `Queued` and never start.
- **Cause, in order of likelihood:** (1) no runner online (machine off, asleep, rebooted behind FileVault); (2) the runner is online but wedged (below); (3) a label mismatch: the job's `runs-on` labels are not all on the runner; (4) the runner is busy with a long or abandoned job (closed-PR runs, below).
- **Diagnose (read-only):** `gh api repos/<o>/<r>/actions/runners` (status, busy, labels); `gh api repos/<o>/<r>/actions/runs/<id>/jobs --jq '.jobs[] | {name, labels, status}'`; compare labels exactly.
- **Fix:** per cause. Immediate relief for all of them: the owner deletes the repository variable `<fallbackVariable>` so new jobs go to hosted (if minutes allow).
- **Who:** agent (diagnose), owner (variable, machine).

### Wedged listener ("Job message not found")
- **You see:** the runner is online and idle in the API, jobs stay queued, there is no `Runner.Worker` process, and the newest `<runner dir>/_diag/Runner_*.log` repeats `Job message not found '<id>'`.
- **Cause:** the listener lost its session with GitHub's broker and keeps polling a stale job message.
- **Fix:** only when no `Runner.Worker` process exists (`pgrep -u <tenant> -fl Runner.Worker` prints nothing), the owner restarts the daemon: macOS `sudo launchctl kickstart -k system/<label>`, Linux `sudo systemctl restart <unit>`.
- **Who:** owner.

### Offline after a reboot (FileVault / LUKS)
- **You see:** the runner is offline after an update or power cut; nothing on the machine answers ssh.
- **Cause:** with disk encryption, the machine waits at the pre-boot unlock screen and no daemon starts until someone types the password. If `host.autoRestart` is false, it may not even power back on after a power cut.
- **Fix:** owner unlocks it (at the screen, or with remote unlock if they set one up). For planned restarts on macOS, the owner can use `sudo fdesetup authrestart`. To come back after power cuts, the owner sets `sudo pmset autorestart 1`. Turning encryption off is the owner's call and not recommended.
- **Who:** owner.

### Runner offline, machine fine
- **You see:** ssh works, the runner is offline.
- **Cause:** the daemon is not loaded or keeps crashing.
- **Diagnose (read-only):** macOS `launchctl print system/<label>` (state, last exit code) and the daemon log in the tenant's log directory; Linux `systemctl status <unit> --no-pager`, `journalctl -u <unit> -n 50 --no-pager`.
- **Fix:** owner `bash <kit>/provision.sh install` (reloads the daemon). If the log says the registration was removed, owner re-registers: `bash <kit>/provision.sh register` (fresh token at the hidden prompt).
- **Who:** owner.

### `node: command not found` (or python, pnpm) under the daemon
- **You see:** a step fails with a missing tool, but the same command works in your terminal.
- **Cause:** the daemon's `PATH` is not your login shell's `PATH` (no Homebrew, no fnm/nvm/pyenv shims). The runner's `.path` is fixed and root-owned on purpose.
- **Fix:** the workflow installs its own runtime with `actions/setup-node` / `setup-python` at the exact pinned version (it lands in the runner's tool cache and persists). Never point the job at a host install. Always measure through the daemon, not a login shell.
- **Who:** agent (workflow PR).

### Cache steps stall on self-hosted
- **You see:** `setup-node` / `actions/cache` hangs at "Received 0 of `<n>`" or a restore takes minutes.
- **Cause:** a `cache:` input or `actions/cache` on a persistent runner: saves race and the remote cache is pointless when the package store is already on disk.
- **Fix:** remove `cache:` and `actions/cache` for self-hosted jobs (keep them for hosted ones, gated on the runner type). The workflow rewriter does this; check nothing re-added it.
- **Who:** agent (workflow PR).

### Spotlight / indexing load (macOS)
- **You see:** high load with `mds`, `mds_stores`, `mdworker` or `mediaanalysisd` near the top during jobs.
- **Cause:** a directory the jobs write heavily is being indexed.
- **Fix:** check every heavy tenant directory ends in `.noindex` (`ls -d <tenant home>/*`); if a tool writes elsewhere (for example a browser cache outside the cache dir), point it into a `.noindex` directory in the workflow env and re-render. The owner can also add the tenant home to System Settings → Spotlight → Privacy. Never `mdutil` (machine-wide, needs root).
- **Who:** agent (workflow / profile), owner (Spotlight privacy).

### Orphaned processes
- **You see:** tenant processes days old (`ps -U <tenant> -o pid,etime,command`), leftover `postgres`, "could not create shared memory segment", or a later job hanging.
- **Cause:** GitHub signals only a step's shell; its children re-parent and survive. The job-completed hook reaps every tenant process and frees its SysV IPC, but it does not run if the daemon or machine died mid-job.
- **Fix:** the next job's start hook reaps them. To clear now, the owner runs `sudo pkill -u <tenant>`, and for IPC, `ipcs -a` then `sudo ipcrm` for the tenant's rows. If it recurs with the daemon healthy, the hooks are not wired (above).
- **Who:** owner.

### Closed-PR runs hogging the runner
- **You see:** the runner is busy with a run whose PR is already merged or closed; other jobs queue behind it.
- **Cause:** GitHub does not cancel runs when a PR closes.
- **Fix:** enable `watchdog.reapClosedPrs` (the watchdog cancels them). Now: `gh run cancel <run id>` (agent, with the user's yes; it is a GitHub action, not a machine change). In the optimisation PR, `concurrency` with cancel-in-progress on PRs (finding C1) stops superseded runs too.
- **Who:** agent (after yes) or watchdog.

### Memory pressure, tests killed
- **You see:** tests killed (exit 137, "JavaScript heap out of memory", SIGSEGV in workers), swap growing, the machine sluggish.
- **Cause:** worker counts too high for the RAM, or a co-tenant using it.
- **Fix:** lower `caps.jestMaxWorkers` / `playwrightWorkers` / `nextBuildCpus`, set `cotenant.swapYieldMb`, re-render. Pin the exact runtime patch version (a floating major can pull a release with a different memory profile).
- **Who:** agent (profile + PR).

### Stale build output between jobs
- **You see:** a job serves half-old assets or manifests (`.next`, `.turbo`, `dist`) or installs into a broken `node_modules`.
- **Cause:** the job workspace was not wiped (the job-completed hook did not run).
- **Fix:** check the banner of the previous job for the wipe line; if hooks are not wired, see above. Do not add `clean: false` workarounds.
- **Who:** owner (if hooks), agent (diagnose).

### Runner too old / will not update
- **You see:** GitHub refuses the runner as outdated, or the log shows a failed self-update.
- **Cause:** the runner directory is pinned and partly root-owned, so in-place self-update cannot always complete.
- **Fix:** `upgrade` mode: re-render with the new pinned version and checksum; owner re-runs `provision.sh install`.
- **Who:** agent (render + PR), owner (install).

### Registration fails
- **You see:** the owner's `register` step says the token expired or is invalid, or that a runner with that name exists.
- **Cause:** registration tokens expire one hour after they are created; the name is still registered from an earlier install.
- **Fix:** owner opens Settings → Actions → Runners → New self-hosted runner, copies a fresh token, and runs `bash <kit>/provision.sh register` again, pasting it at the hidden prompt. A stale runner with the same name: remove it on that page first, or let the provisioner replace it.
- **Who:** owner. Never paste the token into chat.

### Maintenance has not run
- **You see:** `doctor` reports the last maintenance run is more than 8 days old.
- **Cause:** GitHub's `schedule:` triggers are best-effort and can be late or skipped; or the job was queued while the machine was off.
- **Fix:** dispatch it once (`gh workflow run homeactions-runner-maintenance.yml`, with a yes). It is idempotent, so late or doubled runs are harmless.
- **Who:** agent (after yes).

### A launchd timer fires hours late
- **You see:** a scheduled task on macOS runs at the wrong hour.
- **Cause:** calendar-based launchd timers (`StartCalendarInterval`) can be delivered late after sleep or a timezone change.
- **Fix:** the kit uses `StartInterval` only, with the time window checked inside the script. If a hand-made plist uses calendar intervals, replace it.
- **Who:** agent (kit) / owner (hand-made plists).
