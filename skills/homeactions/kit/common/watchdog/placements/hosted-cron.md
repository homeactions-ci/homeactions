# Watchdog placement: hosted cron ({{derived.banner}})

The watchdog runs as `.github/workflows/homeactions-watchdog.yml` on a GitHub-hosted runner every 3 hours (and on demand): `node .homeactions/watchdog.mjs --apply{{#if watchdog.reapClosedPrs}} --reap{{/if}}`. It sees machine death and network loss, because it runs off-box.

Trade-offs, read before choosing this:
- It costs about 8 hosted minutes a day (around 240 a month).
- **It does not run while hosted minutes are blocked** (a failed payment or a spending limit): exactly when you may most need it. Prefer `cloud-routine` while that is the case.
- GitHub's `schedule:` can be late or skipped under load.
- It runs only while jobs are switched to the runner (`{{workflows.fallbackVariable}} == '{{workflows.selfValue}}'`), or when dispatched.

## Set it up (owner)

1. Optional but recommended: create a fine-grained token scoped to **{{repo.slug}} only** (Actions read{{#if watchdog.reapClosedPrs}}/write{{/if}}, Issues read/write, Administration read) and save it as the Actions secret `HOMEACTIONS_WATCHDOG_TOKEN` in the repository settings. Without it the workflow uses its own token, which cannot list runners, so "offline" and "wedged" share one message.
2. Merge the runner PR so the workflow is on the default branch (dispatch needs that).
3. Drill: `gh workflow run homeactions-runner-smoke.yml -f runner=offline-drill`, wait 2 minutes, then `gh workflow run homeactions-watchdog.yml -f threshold_minutes=1`: the issue opens. `gh run cancel <drill run id>`, dispatch the watchdog again: the issue closes.

{{#if watchdog.reapClosedPrs}}The workflow also cancels unfinished runs of closed or merged PRs (`--reap`), which GitHub leaves holding the runner.{{else}}Closed-PR runs are reported, not cancelled (`watchdog.reapClosedPrs` is false).{{/if}}

What each state means and what to do: `.homeactions/RUNBOOK.md`.
