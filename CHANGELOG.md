# Changelog

All notable changes to homeactions are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.3] - 2026-11-12

### Fixed
- Kit workflows (smoke, hosted-cron watchdog) check out with `persist-credentials: false`, so the job token never stays in the workspace's `.git/config` on the user's machine.
- The smoke workflow chooses its Node/Python setup steps at render time instead of a runtime `fromJSON(...)` lookup that actionlint reports as a type error. Found on the first real tenant.

## [0.1.2] - 2026-11-12

### Fixed
- The generated placement test treats a cache gated inside its own `cache:` expression (`${{ runner.environment == 'github-hosted' && 'pnpm' || '' }}`) as hosted-only, like the audit's C4 already did. Found on the first real tenant.

### Changed
- Rendered Markdown files (the runbook and the watchdog guide) now carry the "rendered by" header as an HTML comment, so every rendered file whose format allows a comment says where it came from.

## [0.1.1] - 2026-11-12

### Fixed
- Audit C7: when one long unsharded test job is found, the summary also credits the jobs that are already sharded, so the user is not told to shard what they already split. Found on the first real production audit.

## [0.1.0] - 2026-11-12

First public beta. Unproven until the first production install passes.

### Added
- The `homeactions` Agent Skill with modes `audit`, `setup`, `doctor`, `upgrade` and `uninstall`, portable across agents (`npx skills add homeactions-ci/homeactions`) and packaged as a Claude Code plugin and marketplace.
- A read-only GitHub Actions cost audit: catalogue C1–C10 (code), B1–B6 (budget), I1–I3 (infrastructure), `gh api` GET calls only, degraded data labelled, prices fetched or asked at audit time with their date.
- The interview (12 topics, read-only probes for "I don't know"), the plan summary with an explicit yes before anything is written, and the owner checklist.
- The kit: one validated profile rendered deterministically into owner scripts (`provision.sh`, `uninstall.sh`, `--dry-run`, idempotent, checksum-verified), root-owned job hooks, per-user network rules, per-job Postgres/Redis, maintenance, smoke and watchdog workflows. macOS primary, Linux beta.
- The Claude Code PreToolUse guard that denies privileged commands (also inside `ssh`, `sh -c`, `env`, `xargs`, heredocs) and tells the agent to hand them to the owner.
- Claude Code shortcuts `/homeactions:setup`, `/homeactions:doctor`, `/homeactions:audit`, `/homeactions:uninstall`.
- `claude plugin eval` cases for interview-first, never-sudo, measure-don't-assume, read-only doctor, no tokens in chat, the audit-only path and the public-fork refusal.
