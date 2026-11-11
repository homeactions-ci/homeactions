# Owner checklist (template)

Every step only the owner can do: machine-admin steps (they need the admin password) and GitHub admin steps (they need repository admin). The agent fills the `<…>` from the profile, puts the result in the runner PR as `OWNER-CHECKLIST.md` (or in chat), and **never runs these steps itself**. The owner runs each command in their own terminal, `--dry-run` first, and tells the agent when it is done.

Roles come from the profile: machine admin = `<roles.machineAdmin>`, repository admin = `<roles.repoAdmin>`.

Placeholders: `<kit>` = where the kit was copied (default `~/homeactions-kit`), `<o>/<r>` = `repo.slug`, `<label>` = `<tenant.labelPrefix>.runner`, `<unit>` = the runner's systemd unit (Linux).

**How the owner scripts ask for admin rights:** run them as yourself, **not** with `sudo` in front. They refuse to run as root or as the CI user, print what they will do, and call `sudo` themselves for each privileged command, so your password prompt appears in your own terminal. `--dry-run` prints every privileged command and runs none.

---

## Before you start

- [ ] **Read the plan** in the runner PR description. Nothing below changes anything outside the CI user's namespace.
- [ ] **Remote machine:** log in there (`ssh <host.sshAlias>`) and run every machine step in that session.

## 1. Check the kit was not altered (machine)

```bash
cd <kit>
shasum -a 256 -c SHA256SUMS        # macOS
sha256sum -c SHA256SUMS            # Linux
```
Every line must say `OK`. If any says `FAILED`, stop and tell the agent.

## 2. Preflight (machine, read-only, no password)

```bash
bash <kit>/provision.sh preflight
```
It checks the OS, that you are an admin, free disk, free ports, and that the tenant names are unused. Send the agent the output if anything says `FAIL`.

## 3. Create the CI user, folders, services and hooks (machine admin)

Why admin: it creates a system user and group, deny-read rules on other admins' homes, and root-owned hooks that jobs cannot change.

```bash
bash <kit>/provision.sh install --dry-run     # prints every command, changes nothing
bash <kit>/provision.sh install               # asks for your password (sudo) itself
```

## 4. Load the network rules (machine admin; skip if isolation.network is false)

Why admin: firewall rules are system-wide (they only match the CI user). macOS: a pf anchor and a small loader daemon. Linux (beta): an nftables table.

```bash
bash <kit>/provision.sh firewall --dry-run
bash <kit>/provision.sh firewall
```

## 5. Get a registration token (repository admin, in the browser)

1. Open `https://github.com/<o>/<r>/settings/actions/runners/new`.
2. Copy the token shown in the `config` command (it expires one hour after it is shown).
3. **Do not paste it into the chat with the agent.** You paste it at a hidden prompt in the next step.

## 6. Register the runner and start its daemon (machine admin)

Why admin: it writes the runner's root-owned, immutable configuration and installs the system daemon.

```bash
bash <kit>/provision.sh register --dry-run
bash <kit>/provision.sh register
# paste the token at the hidden prompt (nothing is echoed); it never appears in a command line or a file
```

Then tell the agent "registered". It runs `bash <kit>/provision.sh verify` (read-only, no password) and the smoke workflow.

## 7. Optional machine settings (machine admin)

Only if you chose them in the plan:

```bash
sudo pmset autorestart 1           # macOS: power back on after a power cut
sudo fdesetup authrestart          # macOS + FileVault: one planned restart without the unlock screen
```

## 8. Usage limits (repository or organisation admin, in the browser)

From the audit (finding B5), if selected: Settings → Billing and plans → set a spending limit for Actions and turn on usage alerts.

## 9. Switch jobs to your machine (repository admin)

After the smoke and canary PRs are green:

```bash
gh variable set <workflows.fallbackVariable> --repo <o>/<r> --body <workflows.selfValue>
```
or Settings → Secrets and variables → Actions → Variables → New repository variable: name `<workflows.fallbackVariable>`, value `<workflows.selfValue>`.

**Instant fallback to GitHub-hosted:** delete the variable (`gh variable delete <workflows.fallbackVariable> --repo <o>/<r>`).

## 10. Watchdog token (whoever owns the watchdog placement)

Create a fine-grained token for `<o>/<r>` only, with Actions read/write (to cancel closed-PR runs) and Issues read/write. Store it in the placement's own secret store (`watchdog.md`). Never in chat, never in the repo.

---

## Recurring fixes the agent may ask you to run

| When | macOS | Linux (beta) |
|---|---|---|
| wedged listener, and `pgrep -u <tenant.user> -fl Runner.Worker` prints nothing | `sudo launchctl kickstart -k system/<label>` | `sudo systemctl restart <unit>` |
| network rules not loaded | `bash <kit>/provision.sh firewall` | same |
| hooks, `.env`/`.path` or daemon damaged | `bash <kit>/provision.sh install`, then `register` if the runner config is gone | same |
| leftover CI processes | `sudo pkill -u <tenant.user>` | same |
| upgrade (after the new kit is copied and its `SHA256SUMS` checked) | `bash <kit>/provision.sh install` | same |

## Uninstall

```bash
gh variable delete <workflows.fallbackVariable> --repo <o>/<r>     # jobs go back to hosted first
bash <kit>/uninstall.sh --dry-run
bash <kit>/uninstall.sh            # the exact reversal of provision.sh; asks sudo itself; a hidden prompt for a removal token
```
If the runner still shows under Settings → Actions → Runners, remove it there (repository admin).
