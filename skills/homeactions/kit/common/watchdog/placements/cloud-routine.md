# Watchdog placement: cloud routine ({{derived.banner}})

The watchdog runs off-box as a scheduled cloud routine (for example a Claude Code routine), so it still reports when the runner's machine is off, asleep or off the network. It never touches the machine: every fix stays with {{roles.machineAdmin}}.

## Set it up (owner)

1. Create a fine-grained token scoped to **{{repo.slug}} only**: Actions read{{#if watchdog.reapClosedPrs}}/write (to cancel runs of closed PRs){{/if}}, Issues read/write, Administration read (to see the runner list; without it, "offline" and "wedged" share one message). Store it in the routine's own secret store as `GH_TOKEN`. Never paste it into a chat.
2. Create a routine on an hourly schedule (every 1-3 hours) with access to a checkout of {{repo.slug}} and the GitHub CLI, and paste the prompt below.
3. Run it once by hand: it must print a line starting with `{{derived.banner}} watchdog`. An `api-error` line means the token is wrong; fix that first.

## Routine prompt (paste as is)

```text
You are the off-box watchdog for the self-hosted runner {{derived.banner}} of the repository {{repo.slug}}.
Run exactly this, from the root of a fresh checkout of {{repo.slug}}, with GH_TOKEN from the routine's secrets:

    node .homeactions/watchdog.mjs --apply{{#if watchdog.reapClosedPrs}} --reap{{/if}} --threshold {{watchdog.thresholdMinutes}}

Rules:
- Do nothing else on GitHub: no re-runs, no dispatches, no settings, no commits, no other issues or comments.
- Never try to reach, restart or log in to the runner's machine. The fix is always the owner's.
- If the command cannot run (no node, no checkout, gh missing), open or update ONE issue titled exactly as in
  .homeactions/WATCHDOG.md "Issue title" saying the watchdog itself could not run, and stop.
- Report the single line the command printed, plus any "issue" and "run" lines, as the routine's result.
```

## What you will see

- One issue, titled `{{derived.banner}}: runner jobs queued with nothing running` unless the profile sets `watchdog.issueTitle`. It opens when jobs labelled `{{tenant.runnerLabels.0}}` stay queued for {{watchdog.thresholdMinutes}}+ minutes with nothing running, gets a comment when the state changes (offline, wedged, api-error), and closes on recovery.
- What each state means and what to do: `.homeactions/RUNBOOK.md`.

## Issue title

`{{derived.banner}}: runner jobs queued with nothing running` (or `watchdog.issueTitle` from `.homeactions/profile.json`).
