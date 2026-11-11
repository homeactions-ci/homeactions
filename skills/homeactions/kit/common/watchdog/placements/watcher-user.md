# Watchdog placement: watcher user ({{derived.banner}})

The watchdog runs as a **second unprivileged user on the runner's own machine**. It catches a wedged listener and a stopped runner service, but **not** the machine dying or losing its network (it dies with it). Use it only when nothing off-box is possible; it is better than none.

Never run the watchdog as the tenant user `{{tenant.user}}` or on the tenant's runner: a queued watchdog waits behind the job it should report.

## Set it up ({{roles.machineAdmin}}, once, in your own terminal)

1. Create a standard (non-admin) user, e.g. `{{tenant.name}}-watch`, with no access to the tenant's home.
2. As that user: clone {{repo.slug}}, `gh auth login` with an account that has Actions read{{#if watchdog.reapClosedPrs}}/write{{/if}}, Issues write and admin read on the repo, and test `node .homeactions/watchdog.mjs`.
3. Install the timer as that user, exactly as in the laptop placement (`launchctl bootstrap gui/<uid>` with `StartInterval` on macOS, or a `systemctl --user` timer with lingering enabled on Linux: `loginctl enable-linger {{tenant.name}}-watch`).

Command run by the timer, from the checkout:

```sh
git pull --ff-only -q; node .homeactions/watchdog.mjs --apply{{#if watchdog.reapClosedPrs}} --reap{{/if}}
```

What each state means and what to do: `.homeactions/RUNBOOK.md`.
