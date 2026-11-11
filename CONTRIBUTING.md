# Contributing

Thanks for helping. homeactions runs other people's CI on other people's machines, so the bar is: deterministic, reviewable, unprivileged by default, and free of anyone's private details.

## Layout

| Path | What |
|---|---|
| `skills/homeactions/SKILL.md` | the portable entry point (any agent); keep it under 500 lines, detail goes in `references/` |
| `skills/homeactions/references/` | interview, plan template, audit, isolation, services, watchdog, troubleshooting, threat model, owner checklist |
| `skills/homeactions/kit/` | the templates and renderer. **Read [`kit/CONTRACT.md`](skills/homeactions/kit/CONTRACT.md) first**: profile → render → `host/**` + `repo/**`, template syntax, host-script conventions |
| `skills/homeactions/audit/` | the read-only cost audit: `audit.mjs` plus one detector per catalogue entry in `rules/` |
| `skills/{setup,doctor,audit,uninstall}/` | Claude Code shortcuts that load the main skill in a mode |
| `hooks/` | the Claude Code PreToolUse guard (`guard-privileged.sh` + `guard-privileged.awk`) |
| `tests/` | `node:test` suites (zero dependencies) |
| `evals/` | `claude plugin eval` cases (see `evals/README.md`) |
| `fixtures/profiles/` | fictional profiles every render test uses |

## Before you open a PR

```bash
node --test 'tests/**/*.test.mjs'          # unit, render, kit, audit, guard tests
for p in fixtures/profiles/*.json; do       # every fixture renders, deterministically
  out="out/$(basename "$p" .json)"
  node skills/homeactions/kit/render.mjs --profile "$p" --out "$out"
  node skills/homeactions/kit/render.mjs --profile "$p" --out "$out" --check
done
find out skills hooks scripts -name '*.sh' -print0 | xargs -0 shellcheck -S warning
node scripts/scan-specifics.mjs             # must print "scan-specifics: clean"
claude plugin validate --strict .           # if you have Claude Code
```

CI runs the same on GitHub-hosted `ubuntu-latest` and `macos-latest` only. This repository is public: **no workflow here may ever run on a self-hosted runner** (a test enforces it).

## Rules

- **No specifics.** No names of real people, companies, projects, hosts, accounts, repositories, labels or IP addresses anywhere: code, tests, fixtures, docs, commit messages. Use `example`, `acme`, `example-org`, `buildbox`. `scripts/scan-specifics.mjs` fails CI on denylisted terms (stored as hashes), private IPv4 addresses, non-example emails and token-shaped strings. Keep your own extra terms in `.denylist.local` (git-ignored).
- **The agent never runs privileged commands.** Anything that needs root goes into `provision.sh` / `uninstall.sh` with `--dry-run`, idempotence, and the refusals in the contract. If you add a privileged command, add it to the guard (`hooks/guard-privileged.awk`) and a deny fixture plus an allow look-alike to `tests/agent/guard.test.mjs`.
- **No tokens in chat, argv or files.** Hidden prompts only.
- **Unreadable is not absent.** Every check reports `unreadable` distinctly.
- **Bash 3.2** for host scripts (stock macOS); no `grep -q` downstream of a pipe under `pipefail`.
- **Every profile field traces to an interview question or a read-only probe.** A new field needs a row in `references/interview.md`.
- **No hard-coded prices** in the audit; money always carries its source and date.
- **Zero runtime dependencies.** Node built-ins and POSIX tools only.

## Changelog

Add a line under `## [Unreleased]` in `CHANGELOG.md` for anything user-visible.
