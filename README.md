# homeactions

**Out of Actions minutes? Run CI on your own machine, free.**

> **BETA.** homeactions is unproven until the first production install passes. Read the plan it shows you, run the `--dry-run` of every owner step first, and keep the hosted fallback switch until you trust it. macOS is the primary target; Linux is beta on top of beta.

You open your inbox and there it is: *"You've used 100% of included GitHub Actions minutes."* Or worse, a failed payment, and every workflow sits at *"The job was not started because your account is locked due to a billing issue."* PRs pile up unchecked. Meanwhile there is a perfectly good Mac mini (or Linux box) under your desk doing nothing.

homeactions is an [Agent Skill](https://agentskills.io) for your coding agent. It does two things, in this order:

1. **A free CI cost audit**: where your minutes actually go, and what to change.
   - **Code optimisations**: cancel superseded PR runs, skip docs-only changes, build once, shard slow tests, run the full matrix only on main…
   - **Budget controls**: timeouts on every job, saner schedules, shorter artefact retention, spending limits and alerts.
   - **Infrastructure adjustments**: which jobs suit your own machine, which should stay hosted, cheaper hosted runner types.

   Every finding comes with evidence (`file:line`, run ids), an estimated range of minutes saved and how it was estimated. Pick what you want and you get an optimisation PR. **Many teams stop here.**
2. **A safe, isolated self-hosted runner** on your own machine, if you want one: a dedicated non-admin CI user that can't read your files or reach your network, a hosted fallback you can flip with one variable, a watchdog that tells you when the machine goes quiet, and a `doctor` that explains what's wrong in plain words.

The agent interviews you first, shows you a plan, and does nothing until you say yes. **The agent never runs sudo.** Every privileged step is a script you run yourself, in your own terminal, after reading it.

## Install

### Claude Code (plugin, recommended)

```text
/plugin marketplace add homeactions-ci/homeactions
/plugin install homeactions@homeactions
/homeactions:audit            # or /homeactions:setup, /homeactions:doctor, /homeactions:uninstall
```

The plugin adds the skill, four shortcuts, and a hook that blocks privileged commands (below).

### Codex, Cursor, Copilot and other agents (skill)

```bash
npx skills add homeactions-ci/homeactions --skill homeactions
```

Then ask your agent: *"audit my CI costs"* or *"set up a self-hosted runner for this repo"*.

### Plain git

```bash
git clone https://github.com/homeactions-ci/homeactions.git /tmp/homeactions
cp -R /tmp/homeactions/skills/homeactions .claude/skills/homeactions     # or your agent's skills directory
```

Everything the skill needs (kit, audit, references) lives inside `skills/homeactions/`. Rendering needs Node.js 18+ on the machine running your agent; nothing is installed from the network at render time.

## How a setup goes

1. **Audit** (read-only, `gh api` GET calls only). You pick findings.
2. **Interview**: 12 short topics (machine, local or ssh, repo visibility, which jobs move, stack, databases, browsers, other workloads, isolation, who is admin, budget, secrets). Say "I don't know" and the agent measures it, read-only.
3. **Plan**: what gets created where, what you run and why, cost, risk, how to undo. Nothing happens until you say yes.
4. **PRs**: the optimisation PR (if you picked fixes), then the runner PR (workflow changes, kit tests, runbook, owner checklist).
5. **You run the owner steps** in your own terminal: verify checksums, `provision.sh install`, `provision.sh firewall`, `provision.sh register` (you paste the registration token at a hidden prompt; it never touches the chat). Each has `--dry-run`.
6. **Verify, smoke, canary**: the agent checks everything read-only, runs a smoke workflow and a couple of canary PRs.
7. **Flip the switch**: you set one repository variable. Delete it and you're back on hosted runners instantly.

## What it changes on your machine

All of it is created by the owner scripts you run, and removed by `uninstall.sh` (its exact reversal).

| What | macOS | Linux (beta) |
|---|---|---|
| A dedicated CI user and group | hidden, non-admin, no ssh, no FileVault token | system user (`useradd -r`), no login shell |
| The GitHub Actions runner | pinned version, checksum-verified, in the CI user's home (`.noindex` so Spotlight skips it) | same |
| A system service that starts it at boot | LaunchDaemon generated from the runner's own template | hardened systemd unit (`NoNewPrivileges`, `ProtectSystem=strict`, …) |
| Root-owned job hooks and config | under a root-owned directory; the runner's `.env`/`.path` made immutable | same |
| Network rules for the CI user only | a pf anchor where every rule matches the CI user | nftables rules matching the CI user's uid |
| File protection | deny-read rules on other admins' home folders | home folder permissions |
| Per-job databases (if you use them) | Postgres/Redis built from source into the CI user's home, one instance per job on loopback | distro packages or source |
| Workflows in your repo | a `runs-on` switch (repository variable + PR labels), smoke, maintenance and watchdog workflows | same |

Nothing outside the CI user's namespace, no Docker, no shared Homebrew, no background agent, no telemetry.

## The agent never runs sudo

- Every privileged step lives in `provision.sh` / `uninstall.sh`, which you run as yourself; they ask for your password via `sudo` in your terminal, support `--dry-run`, are idempotent, refuse to run as root or as the CI user, and refuse to touch anything outside the CI user's namespace.
- In Claude Code, the plugin's **PreToolUse hook** denies `sudo`, `su`, `doas`, `pkexec`, system `launchctl`/`systemctl` changes, `pfctl`/`nft`/`iptables`, user and group changes, `chflags`/`chattr`/ACL edits and writes under `/etc` or `/Library`, also when wrapped in `ssh host '…'`, `sh -c`, `env`, `xargs`, `eval` or a heredoc piped into a shell. It tells the agent to hand the step to you instead.
- The hook is a seatbelt, not a sandbox. **`disableAllHooks: true` (or disabling the plugin) turns it off**, and other agents have no hook: there the rule lives in the skill's instructions. The real protection is that the agent never has your admin password.
- While the plugin is enabled the hook applies in every Claude Code session, not just homeactions ones. It only blocks privileged commands, which an agent should not run anyway.
- The agent never asks for tokens in chat. If you paste one, it will refuse to use it and tell you to rotate it.

## Supported

| | Status |
|---|---|
| macOS (Apple silicon and Intel), bash 3.2 | **Primary target** (beta until the first production install passes) |
| Linux with systemd + nftables | **Beta**: rendered and statically checked in CI, no live proof yet |
| Windows | Not supported |
| GitHub Actions | Supported. Other CI providers: the audit is GitHub-only too |
| Private and internal repositories | Supported |
| Public repositories | Audit and optimisation PR only for workflows that run fork PRs (see below) |

## Threat model, in short

- **Anyone with write access to the repository can run code on your machine as the CI user.** Only use a self-hosted runner where you trust every collaborator that much.
- **Private repos only.** A public repo that runs workflows for fork PRs would let strangers run code on your machine; homeactions refuses to set that up.
- **Isolation is one-way.** The CI user can't read your files, reach your local network or services, or become admin. You can still see and stop everything it does.
- **What is not isolated:** the kernel, CPU/RAM/disk (capped, not partitioned), the internet, and anything you pass to a job. By default no secrets go to self-hosted jobs.
- **One machine is a single point of failure.** The hosted fallback variable and the off-box watchdog are how you live with that.

Full version: [`skills/homeactions/references/threat-model.md`](skills/homeactions/references/threat-model.md). Reporting a vulnerability: [`SECURITY.md`](SECURITY.md).

## FAQ

**Is it free?** homeactions is MIT-licensed and free. Running CI on your own machine costs you electricity and some of the machine's time. The audit and the optimisation PR are useful even if you never install a runner.

**Does GitHub charge for self-hosted runners?** Historically, no: self-hosted minutes were not billed. GitHub has announced, and then postponed, a per-minute platform fee for self-hosted runners. **Check GitHub's current pricing** before you decide; the audit asks for, or fetches, prices at the time you run it and shows the date.

**Can I use it on a public repository?** Not for workflows that run on pull requests from forks: anyone could run code on your machine. Public repositories get free GitHub-hosted minutes, so keep those workflows hosted. The audit still helps.

**Docker?** Not used. Databases run per job as plain processes owned by the CI user, on loopback. That keeps the CI user unprivileged (Docker access is effectively root) and works on a stock Mac.

**Windows?** Not supported, and not planned for now.

**My machine is also my work machine. Will CI slow me down?** CI runs at low priority with capped CPU and test workers, waits (up to a limit) while another workload you name is busy, and stops when disk gets low. You will still feel heavy jobs; a dedicated machine is better.

**What happens when the machine is off?** Jobs queue. Delete the repository variable and new jobs go to GitHub-hosted runners (if you have minutes). The watchdog opens an issue so you know.

**FileVault?** Keep it on. After a power cut, a FileVault Mac waits for the disk password before anything (including the runner) starts; the interview asks and the plan says so.

**Telemetry?** None. homeactions sends nothing anywhere.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). The kit contract is [`skills/homeactions/kit/CONTRACT.md`](skills/homeactions/kit/CONTRACT.md).

## License

MIT. See [`LICENSE`](LICENSE).
