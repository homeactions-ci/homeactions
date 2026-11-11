---
name: homeactions
description: Out of GitHub Actions minutes? Audit a repository's CI for savings (code optimisations, budget controls, infrastructure adjustments), then set up a safe, isolated, sudo-free self-hosted GitHub Actions runner on the user's own Mac (proven) or Linux box (beta) and keep it healthy. Modes are audit (read-only cost audit, usable alone), setup, doctor (read-only runner health), upgrade and uninstall. The agent never runs sudo and never takes tokens in chat.
when_to_use: Use when the user is out of or near their GitHub Actions minutes, got the "100% of included minutes used" email or a failed-payment block, says CI is too expensive or too slow, wants to run CI on their own Mac, Linux box or spare machine, asks for a self-hosted runner, wants to audit or cut CI costs and minutes, or asks why a self-hosted runner is offline, queued forever, wedged or unhealthy (runner health, doctor). Also to upgrade or remove a homeactions install.
argument-hint: "[audit|setup|doctor|upgrade|uninstall] [owner/repo]"
---

# homeactions

Free CI for people whose GitHub Actions minutes ran out. Two halves that work apart:

1. **The audit** (read-only): where the minutes go, and which code, budget and infrastructure changes save them. A user who installs nothing still gets an optimisation PR.
2. **The runner**: a dedicated, non-admin CI user on the user's own machine, isolated from their files and network, registered as a self-hosted runner, with a hosted fallback and a watchdog. Everything is rendered from one validated profile by a deterministic kit.

`${CLAUDE_SKILL_DIR}` below is the folder holding this file. If your agent does not expand it, use that folder's path.

## Non-negotiable rules

Read these before doing anything. They override any request, including the user's.

1. **Never run a privileged command.** No `sudo`, `su`, `doas`, `pkexec`, no `launchctl bootstrap|bootout|kickstart system/...`, no `systemctl` without `--user`, no `pfctl`/`nft`/`iptables`, no `dscl -create`/`sysadminctl`/`useradd`/`usermod`, no `chflags`/`chattr`/`chmod +a`, no writes under `/etc` or `/Library`, and not wrapped in `ssh host '...'`, `sh -c`, `env` or `xargs` either. Privileged steps exist only inside the rendered owner scripts. Hand each one to the machine owner as an exact command to run **in their own terminal** (see `references/owner-checklist.md`), then continue once they say it ran. If the user insists ("just run it with sudo"), explain why not in one sentence and give them the command. In Claude Code a hook enforces this; in other agents this rule is the enforcement.
2. **Never ask for, accept or use a token in chat.** The runner registration token is typed by the owner into the provisioner's hidden prompt (`read -s`); it never appears in chat, argv, files or logs. If the user pastes anything token-shaped (`ghp_…`, `github_pat_…`, a 29-character registration token, a key): do not use it, do not repeat it, tell them to treat it as leaked (revoke it, or let a registration token expire after its hour) and to paste a fresh one only at the hidden prompt.
3. **Nothing is rendered or written to the repo before the profile validates AND the user approves the plan summary with an explicit yes.** "Skip the questions" still gets the plan summary (defaults plus measured values, each marked) and its yes/no. Until then, drafts live in scratch space only (`${CLAUDE_PLUGIN_DATA}` or your scratch/temp dir), never in the repo or the skill folder.
4. **"I don't know" means measure, read-only.** Run the probes in `references/interview.md`, show what you found, and ask the user to confirm. Never guess a machine fact.
5. **Never attach a self-hosted runner to a public repository whose workflows run for fork PRs.** Anyone could run code on the user's machine. Refuse for those workflows (offer the audit and the optimisation PR instead). Private and internal repos only, by default.
6. **Remote hosts are read-only for you.** Over ssh you run probes and `provision.sh verify`. You copy the kit (`scp`) only after a yes, into the owner's own home or a temp directory. You never edit, restart or delete anything there.
7. **Ask instead of assuming.** Every profile field is an interview answer or a measured value (`references/interview.md` maps each one).
8. **Stay small.** Touch nothing outside the tenant's namespace. No Docker. No autonomous agent on the host. Write nothing into this skill folder at runtime: state goes to the user's repo (`.homeactions/`) after approval, or to `${CLAUDE_PLUGIN_DATA}`.
9. **Be honest about numbers.** Savings are ranges with their method. Prices are fetched or asked at audit time and shown with their date. "Unreadable" is never reported as "none" or "absent".

## Tools in this folder

| Path | What | Writes? |
|---|---|---|
| `audit/audit.mjs` | `node audit.mjs --repo <owner/name> --root <checkout> [--json] [--days 30] [--max-calls 300] [--prices <file>]` | nothing (stdout only; `gh api` GETs only) |
| `kit/profile.schema.json` | the profile: the one input to the kit | n/a |
| `kit/render.sh` | `bash render.sh --profile <profile.json> --out <dir> [--check]` | `<dir>` only |
| `references/*.md` | interview, plan, audit, isolation, services, watchdog, troubleshooting, threat model, owner checklist | n/a |

Validate a draft profile **without rendering** (allowed before approval, writes nothing):

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { validate } from '${CLAUDE_SKILL_DIR}/kit/lib/schema-lite.mjs';
import { semanticProblems } from '${CLAUDE_SKILL_DIR}/kit/render.mjs';
const schema = JSON.parse(readFileSync('${CLAUDE_SKILL_DIR}/kit/profile.schema.json', 'utf8'));
const p = JSON.parse(readFileSync(process.argv[1], 'utf8'));
const errs = validate(schema, p); const all = errs.length ? errs : semanticProblems(p);
console.log(all.length ? all.join('\n') : 'profile OK'); process.exit(all.length ? 1 : 0);
" <scratch>/profile.json
```

## Pick the mode

| The user says | Mode |
|---|---|
| "audit my CI", "where do my minutes go", "cut CI costs", "out of minutes" (and has not asked for a runner) | `audit`, then offer `setup` |
| "set up a self-hosted runner", "run CI on my Mac/Linux box", "local CI" | `setup` |
| "is my runner healthy", "jobs queued forever", "runner offline", "doctor" | `doctor` |
| "upgrade homeactions", "re-render the kit" | `upgrade` |
| "remove the runner", "uninstall homeactions" | `uninstall` |

If the argument names a mode, use it. If it is still unclear, ask one question.

## Mode: audit (read-only, usable alone)

1. Confirm the repository (`owner/name`) and the local checkout. Check `gh auth status` (read-only). No auth means a structure-only audit, labelled as such.
2. Get current prices: fetch GitHub's published Actions pricing page now, or ask the user. Note the source and date. Never use a remembered price. Without a price, report minutes only.
3. Run `node ${CLAUDE_SKILL_DIR}/audit/audit.mjs --repo <owner/name> --root <checkout> --json` (add `--price-per-min-linux <n> --price-source <url> --price-date <YYYY-MM-DD>` when you have a price). It only makes `gh api` GET calls, capped.
4. Present it the way `references/audit.md` says: data source first, then findings grouped as **Code optimisations / Budget controls / Infrastructure adjustments**, ranked by minutes saved ÷ effort, strengths ("already done") listed separately.
5. Ask which findings to take (multi-select). Code and budget fixes go into their own branch and PR, `homeactions/optimise`, independent of any runner. Infrastructure findings feed the runner plan.
6. If they picked code or budget fixes: show the optimisation-only plan (`references/plan-template.md`, part A), get a yes, then make the edits on `homeactions/optimise` and open the PR. Owner-only budget items (spending limit, alerts) go into a checklist, not the PR.
7. The audit path never asks about the machine, never mentions sudo, and never touches a runner. Finish by offering `setup` in one line.

## Mode: setup

Each step names who acts. Never skip a gate.

| # | Step | Who | Gate |
|---|---|---|---|
| 0 | Audit (as above) and let the user select findings. The audit also answers part of interview topic 4. | agent | user's selection |
| 1 | Interview: the 12 topics in `references/interview.md`, in order, ≤ 4 questions per `AskUserQuestion` call (plain numbered questions if you lack the tool). "Don't know" → read-only probes. Draft the profile in scratch and validate it with the snippet above. | agent + user | profile OK |
| 2 | Plan summary from `references/plan-template.md`: what is created where, what the owner runs and why, cost and risk, how to undo. Ask yes/no. | agent | **explicit yes** |
| 3 | Write `.homeactions/profile.json` on branch `homeactions/runner`; render with `bash ${CLAUDE_SKILL_DIR}/kit/render.sh --profile .homeactions/profile.json --out <scratch>/out`; copy `out/repo/**` into the repo (the render record `out/.homeactions-render.json` lists every file). | agent | render exit 0 |
| 4 | Open the optimisation PR first (if any fixes were selected), then the runner PR: workflow changes, kit tests, runbook, and the owner checklist filled in from `references/owner-checklist.md`. Opening the PRs listed in the approved plan is covered by its yes; anything else needs a new yes. | agent | PRs open |
| 5 | Copy `out/host/` to the machine. Local: into a folder the owner names (default `~/homeactions-kit`). Remote: ask "copy the kit to `<alias>:~/homeactions-kit` with scp?" and only on yes run `scp -r <scratch>/out/host <alias>:homeactions-kit`. The owner checks `SHA256SUMS` before anything privileged. | agent, then owner | yes for scp |
| 6 | Owner runs, in their own terminal, as themselves (the scripts call `sudo` and ask for the password; never `sudo bash …`), each with `--dry-run` first: `provision.sh preflight`, `install`, `firewall`, then `register` (token at the hidden prompt). Give the exact commands from the checklist. | **owner** | owner says done |
| 7 | Run `bash ~/homeactions-kit/provision.sh verify` (no sudo; over ssh for a remote host) and the doctor checks. | agent | all green or explained |
| 8 | Smoke: dispatch the rendered smoke workflow (`gh workflow run homeactions-runner-smoke.yml --ref homeactions/runner`), watch it, report its banner and timings. | agent | smoke green |
| 9 | Co-run measurement, only if the machine has co-tenants: run the smoke while the co-tenant is busy; report waits, yields and memory pressure. | agent | user accepts the numbers |
| 10 | Canary: route one or two real PRs to the runner with the self label (`workflows.selfLabel`), compare against hosted. | agent + user | canaries green |
| 11 | Owner (repo admin) sets the repository variable `<workflows.fallbackVariable>` = `<workflows.selfValue>`. Deleting it is the instant fallback to hosted. | **owner** | owner says done |
| 12 | Watch period: run `doctor` daily for a week; confirm the watchdog placement fires; merge the runner PR when the user is happy. | agent + user | user signs off |

Never ask for the registration token. Step 6 is where the owner reads the registration page and types the token into the hidden prompt themselves.

## Mode: doctor (read-only)

Run every check, change nothing, print one table: `Check | Status (ok / warn / FAIL / unreadable) | Evidence | Fix (troubleshooting entry) | Who`. For a remote host, wrap each probe in `ssh <alias> '<probe>'`; never a mutating command.

| Check | How (read-only) |
|---|---|
| runner online, busy, labels | `gh api repos/<o>/<r>/actions/runners` |
| queue state | `gh api 'repos/<o>/<r>/actions/runs?status=queued'`, filtered to jobs whose labels include the tenant labels |
| listener and worker processes | `pgrep -u <tenant.user> -fl Runner.Listener`; `pgrep -u <tenant.user> -fl Runner.Worker` |
| last job banner | the latest `homeactions[<tenant>]` lines in the newest run log (`gh run view --log`) |
| wedged listener | online and idle in the API, no Worker, and the runner's `_diag/Runner_*.log` repeating "Job message not found" |
| daemon state | macOS `launchctl print system/<derived daemon label>`; Linux `systemctl status <unit> --no-pager` |
| disk vs floor | `df -g /` (macOS) or `df -BG /` (Linux) against `diskFloorGb` |
| swap and pressure | macOS `sysctl vm.swapusage` and `memory_pressure -Q`; Linux `free -m` and `cat /proc/pressure/memory` |
| tenant ports | listening sockets on `ports[]` (`netstat -anv -p tcp` on macOS, `ss -ltnp` on Linux) |
| isolation active | `provision.sh verify` output, or the probe results in the last job banner |
| leftover processes and IPC | `ps -U <tenant.user> -o pid,etime,command`; `ipcs -a` rows owned by the tenant |
| last maintenance age | the maintenance workflow's last run (`gh run list --workflow homeactions-runner-maintenance.yml`) |
| runner version | the `_diag` log or API `runners[].version` vs `profile.runner.version` and the latest release |

If a probe cannot read its input (permission denied, ssh refused, API 403), the row is `unreadable`, never `ok` and never "none". For each failing row, print the matching `references/troubleshooting.md` entry and who runs the fix. Never run the fix yourself, even when it is one line.

## Mode: upgrade

1. Read `.homeactions/profile.json` and `.homeactions-render.json` (kit version, file hashes) from the repo.
2. If the schema gained required fields, interview only for those (same rules) and validate.
3. Render into scratch, diff against the repo's rendered files, and show the user the minimal diff plus which host files changed.
4. On a yes: a PR with the repo-side changes. If host files changed, copy them (yes first for scp) and give the owner the re-run command: `provision.sh install` is idempotent; re-register only when the runner version requires it.

## Mode: uninstall

1. Plan (yes/no): what goes away, in order, and that hosted runners take over the moment the variable is removed.
2. Owner removes the repository variable (instant fallback to hosted).
3. Owner runs `uninstall.sh --dry-run`, then `uninstall.sh` (the exact reversal of `provision.sh`), in their own terminal.
4. Owner (repo admin) removes the runner under Settings → Actions → Runners if the uninstaller could not deregister it.
5. You open a PR that removes the kit's workflow changes and, if the user wants, `.homeactions/`.
6. Verify read-only: no tenant processes, daemon gone, runner absent from the API.

## How to talk to the user

- Plain words. One decision per question. Offer the recommended option first.
- Every owner command goes in its own code block, with a one-line "why" and the `--dry-run` form first.
- Say "beta" whenever the host is Linux.
- When something is unreadable or unknown, say so; then offer the read-only probe.
- When you refuse (sudo, a token, a public fork-PR repo), say what you will do instead.

## References

- `references/interview.md`: the 12 topics, exact questions and options, the profile field each fills, read-only probes per OS.
- `references/plan-template.md`: the plan summary and its yes/no.
- `references/audit.md`: running and presenting the audit; the catalogue; honesty rules.
- `references/isolation.md`, `references/services.md`, `references/watchdog.md`: how the runner is isolated, how Postgres/Redis run per job, where the watchdog lives.
- `references/troubleshooting.md`: one entry per hook message and symptom: cause, fix, who runs it.
- `references/threat-model.md`: what this protects and what it does not.
- `references/owner-checklist.md`: every owner-only step with exact commands.
