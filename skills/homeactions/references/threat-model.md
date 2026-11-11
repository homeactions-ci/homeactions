# Threat model

Read this before recommending a self-hosted runner, and summarise it in the plan.

## The one fact that matters

**Anyone who can make a workflow run on your runner can run any code on your machine, as the CI user.** On GitHub that means anyone with write access to the repository (they push a branch or open a PR that changes a workflow or a test). homeactions limits what that code can reach; it cannot make running untrusted code safe.

## Scope

- **Private and internal repositories only.** A public repository whose workflows run for pull requests from forks would let any stranger run code on the machine. homeactions refuses to put those workflows on a self-hosted runner (the profile cannot even validate with `visibility: public` and `forkPrs: true`). Public repos get free GitHub-hosted minutes anyway.
- **People with write access are trusted as much as a person who can log in as the CI user.** If that is not true for every collaborator, do not use a self-hosted runner for that repository.

## What is protected

| Asset | Protection | Residual risk |
|---|---|---|
| Your files and other users' files | dedicated non-admin CI user; deny-read on other admins' homes; checked before every job | a kernel or privilege-escalation bug; files you made world-readable yourself |
| Your local network and local services | per-user network rules: loopback only on the tenant's ports, DNS, internet; private ranges blocked; probed before every job | services reachable over the internet; rules not loaded (the job then fails, it does not run unprotected) |
| Admin rights | the CI user is not admin, has no sudo, no secure token; the hooks and runner env are root-owned and immutable | a local privilege-escalation vulnerability in the OS |
| The next job | workspace wiped, every tenant process reaped, IPC freed at job end | the shared package store and tool cache persist and could be poisoned by a malicious job |
| Your time and CPU | caps, nice, idle I/O, disk floor, co-tenant yielding | contention still happens; caps reduce it |

**Isolation is one-way.** The CI user cannot reach you; you (an admin) can still read, stop and inspect everything the CI user does.

## Secrets policy

- Default `secretsPolicy: none`: no `secrets.` in any job that can run on the self-hosted runner. Jobs that need secrets stay on GitHub-hosted.
- A secret passed to a job is readable by every PR author with write access, exactly as on hosted runners, and on a persistent machine it can also leave traces on disk. `allow-listed` is an explicit, documented opt-in per secret.
- The job's own `GITHUB_TOKEN` is visible to the job. Set workflow `permissions:` to the minimum.
- Tokens never pass through the agent: the registration token is typed by the owner into a hidden prompt and handed to the runner's config through the environment of a clean shell, never on a command line (where `ps` would show it) and never in a file.

## One machine is a single point of failure

If it is off, asleep, rebooting behind disk encryption, or off the network, jobs queue. Mitigations: the repository variable gives an instant fallback to hosted (when minutes allow); the off-box watchdog reports it; the README and plan say so up front.

## What the agent and the guard do and do not defend

- **The agent never runs privileged commands.** Every privileged step lives in an owner script (`provision.sh`, `uninstall.sh`) with `--dry-run`, idempotence, refusal to run as the CI user, refusal to touch anything outside the tenant's namespace, and `SHA256SUMS` verification before use.
- **In Claude Code, a PreToolUse hook enforces it**: it denies `sudo`, `su`, `doas`, `pkexec`, system launchd/systemd changes, firewall commands, user and group changes, file flags and ACLs, writes under `/etc` or `/Library`, and owner scripts run without `--dry-run`, including inside `ssh host '…'`, `sh -c`, `env`, `xargs`, `eval`, `$(…)` and heredocs piped into a shell.
- **The hook is a seatbelt, not a sandbox.** It does not open script files the agent runs (`bash some-file.sh`); it can be turned off by `disableAllHooks` or by disabling the plugin; other agents (Codex, Cursor, Copilot) have no hook and rely on the skill's rules. The real boundary is that the agent never has the owner's password: privileged steps cannot succeed without the owner typing it.
- **The agent does not hold secrets.** It never asks for tokens, and refuses to use one pasted into chat.
- **No autonomous agent runs on the host.** Nothing homeactions installs calls a model or acts on its own beyond the fixed hooks, maintenance and watchdog scripts.
- **No telemetry.** homeactions sends nothing anywhere.

## Reporting a vulnerability

See `SECURITY.md` at the repository root.
