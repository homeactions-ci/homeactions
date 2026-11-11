# The watchdog

A machine cannot report its own death. If the runner's machine loses power or network, GitHub shows the jobs as **Queued**, silently, for up to a day; an offline runner and a label mismatch look the same. The watchdog is a small, zero-dependency script (rendered from the kit) that runs **somewhere else** on a schedule and tells the owner.

## What it does every tick

1. Lists the repo's queued and in-progress jobs, **filtered to the tenant's labels** (jobs for other runners never count).
2. Times each job by **its own attempt clock** (a re-run starts a new clock; the run's creation time does not move on re-run and would cause false alarms).
3. Distinguishes three states, each with its own message and fix:
   - **offline**: no runner with the tenant labels is online; jobs queued over `thresholdMinutes` → "machine off, asleep, or off the network" (`troubleshooting.md` § Offline after reboot).
   - **wedged**: the runner is online and idle in the API, but jobs stay queued → "listener wedged" (§ Wedged listener).
   - **API/auth**: the watchdog's own token or the API failed → "cannot see the runner" (it never reports "all fine" when it could not look).
4. **Reaps closed-PR runs** (`reapClosedPrs`): cancels unfinished runs whose pull request is closed or merged, because GitHub does not cancel them and they hold the runner.
5. Keeps **exactly one open issue** (`issueTitle`): opens it on the first failure, comments on change, closes it on recovery.

It never restarts anything on the machine. The fix is always the owner's.

## The four placements

| Placement | Runs where | Sees machine death / network loss | Sees wedged listener | Costs | Choose when |
|---|---|---|---|---|---|
| `cloud-routine` | a scheduled cloud agent or routine (off-box) | yes | yes | its scheduler's usage; a token with read on Actions and write on issues | **default**: the user has a scheduled-agent service |
| `hosted-cron` | a GitHub-hosted scheduled workflow in the repo | yes | yes | a minute or two of hosted time per day; **does not run while hosted minutes are blocked**, and GitHub's `schedule:` can be late or skipped | the minutes block is over and the user wants zero extra services |
| `laptop-task` | a launchd / systemd **user** timer on another machine the user owns | yes, while that machine is awake | yes | nothing | the user has a second machine that is usually on |
| `watcher-user` | a second unprivileged user on the **same** machine | **no** (dies with the machine) | yes | nothing | nothing off-box is possible; better than none |
| `none` | — | no | no | — | the user accepts finding out from stuck PRs |

Never place the watchdog on the tenant's own runner: a queued watchdog waits behind the job it should report.

## Token

The watchdog needs read access to Actions and write access to issues (and to cancel runs, if it reaps). The owner creates it, scoped to this one repository, and stores it in the placement's own secret store (the routine's secrets, an Actions secret for `hosted-cron`, the laptop's keychain or a `0600` file). **The agent never sees it.** The watchdog smoke-tests every API call it makes on its first run and reports "API/auth" on any 401/403 instead of failing silently.

## Timers

launchd timers use `StartInterval`, never `StartCalendarInterval` (calendar timers can fire hours late after a timezone or sleep change). A script that should only act in a window checks the time itself.
