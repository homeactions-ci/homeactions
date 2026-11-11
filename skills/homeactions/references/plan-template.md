# The plan summary

Shown after the interview (setup) or after the finding selection (audit only), **before anything is rendered or written to the repo**. It ends with one yes/no. Only an explicit yes ("yes", "go", "approved") counts; anything else (a question, "maybe", silence, "skip") means no, and you answer or adjust and ask again. A changed answer means a new summary and a new yes.

Fill every `<…>`. Mark each value `(you said)`, `(measured)` or `(default)`. Keep it to one screen: details live in the PRs.

---

## Part A: optimisation PR (only when code or budget findings were selected)

> **1. Optimisation PR** (`homeactions/optimise`, independent of any runner)
>
> | Finding | Change | Est. minutes saved / month | Risk | Undo |
> |---|---|---|---|---|
> | `<C1>` `<superseded PR runs not cancelled>` | `<concurrency group, cancel-in-progress on PRs only>` in `<ci.yml>` | `<300–900 (job durations × runs, 30 days)>` | `<low>` | revert the PR |
>
> Owner-only budget items (not in the PR, you click these): `<B5: set a spending limit and usage alerts under Billing>`.

For an audit-only user, stop here: "Shall I create branch `homeactions/optimise` with these changes and open the PR? (yes/no)"

## Part B: the runner (setup)

> **2. Your machine** — `<Mac mini, arm64, 10 cores, 16 GB, 180 GB free, FileVault on>` `<(measured)>`, reached `<locally | over ssh as "buildbox">`. `<Linux: this is BETA.>`
>
> **3. What moves** — `<build, unit, e2e>` run on your machine when the switch is on; `<release, deploy-preview>` stay on GitHub-hosted because `<they need secrets>`. Fallback: repository variable `<ACME_CI_RUNNER>` = `<self>`; PR labels `<ci:self>` / `<ci:hosted>` force either side.
>
> **4. What gets created on the machine** (all by the owner's scripts, all inside the CI user's namespace):
>
> | What | Where |
> |---|---|
> | a hidden, non-admin user and group | `<acme-ci>` (uid/gid `<510>`), home `<…/acme-ci>` |
> | the GitHub runner `<2.x.y>` (pinned, checksum-verified) | `<home>/actions-runner<.noindex>` |
> | a system daemon that starts it at boot | `<local.homeactions.acme-ci.runner>` |
> | root-owned job hooks and config | `<rootDir>` |
> | network rules for that user only | `<pf anchor | nftables table>` (`<on | off>`) |
> | per-job databases | `<Postgres 16 on 5442>` built into the CI user's home |
> | file protections | deny-read on `<other admins' homes>` |
>
> **5. What you (the owner) run, in your own terminal** — each with `--dry-run` first; run them as yourself (they ask for your admin password via sudo themselves). I never run these:
> 1. `shasum -a 256 -c SHA256SUMS` in the copied kit (checks nothing was altered), then `bash provision.sh preflight` (read-only)
> 2. `bash provision.sh install` — creates the user, folders, services and hooks (needs admin because it creates a system user)
> 3. `bash provision.sh firewall` — loads the network rules (needs admin: firewall)
> 4. `bash provision.sh register` — you paste a registration token from GitHub at a hidden prompt (needs admin: writes the runner's root-owned config)
> 5. `<repo admin>`: set the repository variable `<ACME_CI_RUNNER>` = `<self>` when the canaries are green
>
> **6. What I do** — open `<the optimisation PR, then>` the runner PR (`homeactions/runner`: workflow changes, kit tests, runbook, owner checklist); copy the kit to `<the machine>` (I'll ask before `scp`); run read-only checks and `provision.sh verify`; run the smoke workflow and `<2>` canary PRs; set up the watchdog (`<cloud routine>`).
>
> **7. Cost and risk**
> - Money: GitHub-hosted minutes for moved jobs drop to `<≈ 0>`; your machine's electricity; `<GitHub has announced, then postponed, a per-minute fee for self-hosted runners: check current pricing>`.
> - Risk: anyone with write access to `<owner/name>` can run code as the CI user on this machine. The CI user cannot read `<your files>`, reach `<your local network>`, or use admin rights. `<Secrets: none on self-hosted.>`
> - Load: CI is capped at `<2>` build CPUs, nice `<10>`, `<waits up to 15 min for your other workload>`.
> - Single machine: if it is off, moved jobs `<wait | fall back once the variable is removed>`. `<FileVault: after a power cut nothing runs until someone types the disk password.>`
>
> **8. How to undo** — remove the variable (instant fallback to hosted); `bash uninstall.sh` (the exact reversal: user, daemon, rules, folders); revert the PRs.
>
> **Shall I go ahead? (yes/no)**

---

## After the yes

1. Write `.homeactions/profile.json` (the validated draft) on the branch.
2. Render, copy `out/repo/**`, open the PR(s) listed in the plan, in the order listed.
3. Anything not in the approved plan (another PR, another file, a different host, a new secret) needs its own yes.
