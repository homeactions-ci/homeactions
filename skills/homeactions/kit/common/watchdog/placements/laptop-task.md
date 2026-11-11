# Watchdog placement: laptop task ({{derived.banner}})

The watchdog runs as a **user** timer on another machine you own that is usually on (not the runner's machine). It sees the runner's machine dying, while the laptop is awake.

## Set it up (owner, on the laptop)

1. Keep a checkout of {{repo.slug}} on the laptop and log the GitHub CLI in with an account that has Actions read{{#if watchdog.reapClosedPrs}}/write{{/if}}, Issues write and (for the runner list) admin read on the repo: `gh auth login`. The token stays in the laptop's keychain.
2. Test by hand from the checkout: `node .homeactions/watchdog.mjs` (dry run: prints the state and the issue plan).
3. Install the timer.

**macOS** (`~/Library/LaunchAgents/{{tenant.labelPrefix}}.watchdog.plist`; a user agent, no sudo). launchd timers use `StartInterval`, never `StartCalendarInterval`, which can fire hours late:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{{tenant.labelPrefix}}.watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string><string>-c</string>
    <string>cd "$HOME/path/to/your/checkout" &amp;&amp; git pull --ff-only -q; node .homeactions/watchdog.mjs --apply{{#if watchdog.reapClosedPrs}} --reap{{/if}}</string>
  </array>
  <key>StartInterval</key><integer>1800</integer>
  <key>StandardOutPath</key><string>/tmp/{{tenant.name}}-watchdog.log</string>
  <key>StandardErrorPath</key><string>/tmp/{{tenant.name}}-watchdog.log</string>
</dict>
</plist>
```

Load it: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/{{tenant.labelPrefix}}.watchdog.plist`. launchd's PATH is minimal: if `node` or `gh` is not in `/usr/bin:/bin`, put absolute paths in the command.

**Linux** (`~/.config/systemd/user/{{tenant.name}}-watchdog.service` and `.timer`):

```ini
[Unit]
Description=homeactions watchdog for {{tenant.name}}

[Service]
Type=oneshot
WorkingDirectory=%h/path/to/your/checkout
ExecStart=/bin/sh -c 'git pull --ff-only -q; node .homeactions/watchdog.mjs --apply{{#if watchdog.reapClosedPrs}} --reap{{/if}}'
```

```ini
[Timer]
OnBootSec=5min
OnUnitActiveSec=30min

[Install]
WantedBy=timers.target
```

Enable: `systemctl --user daemon-reload && systemctl --user enable --now {{tenant.name}}-watchdog.timer`.

What each state means and what to do: `.homeactions/RUNBOOK.md`.
