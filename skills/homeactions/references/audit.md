# The CI cost audit

Read-only. Runs as step 0 of `setup` and on its own as `audit`. It answers: where do the minutes go, and what would save them? A user who never installs a runner still gets the optimisation PR.

## What it may and may not do

- It reads `.github/workflows/*.yml` and the repo's structure.
- It makes **`gh api` GET calls only**, capped (default 300 calls, 30 days of history). The script refuses any other method.
- It never dispatches, re-runs or cancels a run, and never changes a setting.
- It writes nothing anywhere: the report goes to stdout. You keep it in your scratch space or `${CLAUDE_PLUGIN_DATA}`, not in the repo, until the user approves a plan.

## Run it

```bash
gh auth status                       # read-only; no auth → structure-only audit
node "${CLAUDE_SKILL_DIR}/audit/audit.mjs" --repo <owner/name> --root <checkout> --json \
  [--days 30] [--max-calls 300] \
  [--price-per-min-linux <n> --price-source <url> --price-date <YYYY-MM-DD> --currency <code>]
```

- **Prices are never remembered or hard-coded.** Fetch GitHub's published Actions pricing page at audit time (or ask the user for their rate), and pass the per-minute Linux price with its source URL and today's date. Without a price, the report shows minutes only, and that is fine.
- Runner-OS multipliers default to GitHub's published ones for private repos; override with `--multipliers linux=1,windows=2,macos=10` if they changed.
- `--ledger` prints a monthly minutes ledger (finding B6) instead of the report.
- `--no-history` forces a structure-only audit (no API calls).

## Data sources, best first

The report says which one it used, in its first lines. Repeat that sentence to the user, first.

1. **Billing usage report** (needs billing access): actual billed minutes.
2. **Job durations × runner-OS multiplier**: start/end of each job in the window. Labelled "estimated from job durations".
3. **Workflow structure only**: no history (no `gh` auth, or `--no-history`). Labelled "structure-only: no minutes measured".

Degraded data is reported, never hidden:

- no `gh` auth → structure-only, said so;
- billing usage unavailable → job-duration estimates, said so;
- history full of runs refused for billing → "hosted runs refused since `<date>`": **do not** call those 0-minute runs cheap;
- an unreadable source → "unreadable (`<reason>`)", never "none".

## The catalogue

| Area | Id | Detects | Typical fix | Target |
|---|---|---|---|---|
| Code | C1 | superseded PR runs not cancelled | `concurrency` with `cancel-in-progress` on PRs only, never on the default branch | optimise PR |
| Code | C2 | `push` and `pull_request` both firing for the same commit | narrow the triggers | optimise PR |
| Code | C3 | every job runs on docs-only or unrelated changes; no affected-only build in a monorepo | `paths`/`paths-ignore`, a changes job, turbo/nx affected | optimise PR |
| Code | C4 | no dependency/browser cache on hosted; a `cache:` on self-hosted | add the cache on hosted; on self-hosted rely on the persistent store and remove the cache | optimise PR / runner PR |
| Code | C5 | the same build in several jobs | build once, pass an artefact | optimise PR |
| Code | C6 | expensive jobs not gated on cheap checks | `needs:` ordering, fail fast | optimise PR |
| Code | C7 | one long test job; slow tests | sharding, a slowest-tests report | optimise PR |
| Code | C8 | the full OS/version matrix on every PR | full matrix on the default branch and nightly only | optimise PR |
| Code | C9 | expensive suites on every PR, or on drafts | label-gate, skip drafts | optimise PR |
| Code | C10 | full-history checkout; rerun-heavy flaky jobs | shallow checkout; a flaky-test list from rerun history | optimise PR |
| Budget | B1 | jobs without `timeout-minutes` | 2 × the longest green run, rounded up to 5, minimum 10 | optimise PR |
| Budget | B2 | scheduled workflows running more often than they act | lower the frequency, or gate on changes | optimise PR |
| Budget | B3 | long artefact or cache retention | `retention-days`; cache-key hygiene | optimise PR |
| Budget | B4 | macOS/Windows hosted jobs that could run on Linux | move them (they cost a multiple of Linux minutes) | optimise PR |
| Budget | B5 | no spending limit or usage alerts | owner clicks it in Billing (the agent cannot) | owner checklist |
| Budget | B6 | no visibility | a monthly minutes ledger (`--ledger`) | optimise PR |
| Infra | I1 | heavy jobs that suit a self-hosted runner | per-job placement in the runner plan | runner PR |
| Infra | I2 | jobs that should stay hosted (tiny, needs secrets, needs an OS the host lacks) | keep hosted, with the reason | runner PR |
| Infra | I3 | a cheaper hosted runner type would do | suggest it, priced at audit time | optimise PR |

Every detector also recognises "already done" (for example cancel-in-progress already scoped to PRs). Those are **strengths**: list them, briefly, so the user sees what they got right.

## Present it

1. One line on the data source and window ("Estimated from job durations, last 30 days, 284 API calls of 300").
2. One line on the total: minutes in the window (and money only with a dated price).
3. Findings grouped under **Code optimisations**, **Budget controls**, **Infrastructure adjustments**, each group ranked by minutes saved ÷ effort:

| # | Id | Finding | Evidence | Minutes / month saved | Money | Risk | Effort | Reversible | Applies on |
|---|---|---|---|---|---|---|---|---|---|
| 1 | C1 | superseded PR runs keep running | `ci.yml:12`; runs 812, 815 | 300–900 (job durations × superseded runs) | `<n>`–`<m>` `<currency>` at `<price>` (`<source>`, `<date>`) | low | 5 min | yes | both |

4. Strengths ("already done").
5. What could not be read, if anything.
6. The multi-select: "Which of these shall I include?" (`AskUserQuestion` with `multiSelect`, up to 4 options per question, more questions for more findings; or a numbered list). Then: code and budget picks → the optimisation PR plan (`plan-template.md` part A); infrastructure picks → the runner plan.

## Honesty rules

- **Ranges, not points.** Every saving is a range with its method and assumptions ("assumes the same PR volume as the last 30 days").
- **Never round toward the answer the user wants.** A finding saving < 1 % says so.
- **Money only with a source and a date.** No price → minutes only. Never a remembered price, never a currency literal in your own arithmetic without its source.
- **Self-hosted is not free of cost.** Mention the machine, its electricity, and that GitHub has announced (and postponed) a per-minute fee for self-hosted runners: the user should check current pricing.
- **Refused runs are not cheap runs.** Billing-blocked history means "unknown", with the date it started.
- **Unreadable is not none.** Say what could not be read and why.
- **Do not upsell the runner.** If the code and budget findings alone fix the problem, say so.
