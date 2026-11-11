# Security

homeactions helps you run untrusted-ish code (your repository's CI jobs) on your own machine. Read this before you install a runner.

## Threat model

- **Private (or internal) repositories only.** Never attach a self-hosted runner to a public repository whose workflows run for pull requests from forks: anyone could run code on your machine. homeactions refuses to configure that.
- **Write access means code execution on the host.** Anyone who can push a branch or open a PR in the repository can run arbitrary code as the CI user. Treat repository write access like a login on that machine.
- **Isolation is one-way.** The dedicated CI user cannot read other users' files (deny-read rules), reach your local network or other local services (per-user firewall rules), or become admin (not in any admin group; hooks and runner configuration are root-owned and immutable). You, as admin, can still read and stop everything the CI user does. Isolation is checked before every job; a job fails rather than run with isolation missing.
- **Not isolated:** the kernel (this is not a VM), CPU/memory/disk (capped, not partitioned), the internet (jobs need it), and anything a job is given, including its `GITHUB_TOKEN`. The CI user's caches persist between jobs and could be poisoned by a malicious job.
- **Secrets policy.** The default is no secrets in any job that can run on the self-hosted runner; such jobs stay on GitHub-hosted runners. Allowing a secret is an explicit, documented opt-in per secret.
- **Tokens.** The runner registration token is typed by the owner at a hidden prompt and passed to the runner through the environment of a clean shell, never on a command line or in a file. The agent never asks for a token and refuses one pasted into chat.
- **Privilege.** The coding agent never runs privileged commands. Privileged steps exist only in owner scripts (`provision.sh`, `uninstall.sh`) that support `--dry-run`, are idempotent, verify `SHA256SUMS`, and refuse to act outside the tenant's namespace. In Claude Code a PreToolUse hook also blocks privileged commands; `disableAllHooks` or disabling the plugin turns that off, and it does not inspect script files. It is a seatbelt, not a sandbox.
- **One machine is a single point of failure.** Keep the hosted fallback variable and an off-box watchdog.
- **No telemetry, no autonomous agent on the host.**

The full threat model is in [`skills/homeactions/references/threat-model.md`](skills/homeactions/references/threat-model.md).

## Reporting a vulnerability

Please report security issues **privately** through GitHub's private vulnerability reporting: the repository's **Security** tab → **Report a vulnerability**. Do not open a public issue for a vulnerability.

Include what you found, how to reproduce it (a fictional profile from `fixtures/profiles/` is ideal), and the impact. Never include real tokens, hostnames or addresses. We aim to acknowledge reports within a week. There is no bug bounty.

## Supported versions

Only the latest release receives fixes while homeactions is pre-1.0.
