#!/usr/bin/env node
// Regenerates the recorded `gh api` responses (<fixture>/gh.json) for the fictional fixture repos.
// Deterministic: fixed clock, fixed ids, no randomness. Run: node make-recordings.mjs
// Each gh.json is { now, responses: { "<api path, query removed except page>": { status, body } } };
// a path missing from responses answers HTTP 404. See tests/github/helpers.mjs for the fake executor.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const NOW = Date.parse("2026-11-12T00:00:00Z");
const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const t = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

let nextRun = 9100000;
let nextJob = 51000000;

function steps(names, start, totalMin) {
  const per = totalMin / names.length;
  return names.map((name, i) => ({
    name,
    status: "completed",
    conclusion: "success",
    number: i + 1,
    started_at: t(start + i * per * MIN),
    completed_at: t(start + (i + 1) * per * MIN),
  }));
}

function job(run, name, labels, minutes, { conclusion = "success", attempt = 1, stepNames, startOffset = 0.2, refused = false, runner = "GitHub Actions 7" } = {}) {
  const start = Date.parse(run.created_at) + startOffset * MIN;
  const end = start + minutes * MIN;
  return {
    id: nextJob++,
    run_id: run.id,
    run_attempt: attempt,
    name,
    status: "completed",
    conclusion: refused ? "failure" : conclusion,
    created_at: t(Date.parse(run.created_at)),
    started_at: t(start),
    completed_at: t(refused ? start : end),
    labels,
    runner_name: refused ? null : runner,
    steps: refused ? [] : steps(stepNames ?? ["Set up job", "Run actions/checkout@v4", "Install", "Run", "Complete job"], start, minutes),
  };
}

function run(repo, file, event, branch, createdAt, { conclusion = "success", attempt = 1, durMin = 30 } = {}) {
  return {
    id: nextRun++,
    name: file,
    path: `.github/workflows/${file}`,
    event,
    head_branch: branch,
    status: "completed",
    conclusion,
    run_attempt: attempt,
    created_at: t(createdAt),
    updated_at: t(createdAt + durMin * MIN),
    pull_requests: [],
    repository: { full_name: repo },
  };
}

const REFUSAL = "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings.";

function pack(repo, runs, jobsByRun, extra) {
  const responses = { ...extra };
  const sorted = [...runs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  for (let p = 0; p * 100 <= sorted.length; p++) {
    const page = sorted.slice(p * 100, p * 100 + 100);
    responses[`/repos/${repo}/actions/runs?page=${p + 1}`] = { status: 200, body: { total_count: sorted.length, workflow_runs: page } };
    if (page.length < 100) break;
  }
  for (const r of runs) responses[`/repos/${repo}/actions/runs/${r.id}/jobs`] = { status: 200, body: { total_count: (jobsByRun.get(r.id) ?? []).length, jobs: jobsByRun.get(r.id) ?? [] } };
  return { now: t(NOW), responses };
}

function addJobs(map, r, js) {
  map.set(r.id, [...(map.get(r.id) ?? []), ...js]);
}

// ---------------------------------------------------------------- (a) web-monorepo: wasteful
function webMonorepo() {
  const repo = "example-org/web-monorepo";
  const runs = [];
  const jobs = new Map();
  const U = ["ubuntu-latest"];
  const L8 = ["ubuntu-latest-8-cores"];
  const M = ["macos-latest"];
  const ciJobs = (r, { pr, lintFails = false, e2eMin = 28, e2eHung = false, rerun = false, refused = false }) => {
    const js = [];
    js.push(job(r, "lint", L8, 2, { conclusion: lintFails ? "failure" : "success", refused }));
    js.push(job(r, "Lint (macOS)", M, 3, { refused }));
    for (const os of ["ubuntu-latest", "macos-latest", "windows-latest"]) for (const node of [18, 20, 22]) js.push(job(r, `Unit tests (${os}, ${node})`, [os], 6, { stepNames: ["Set up job", "Install", "Build", "Test", "Complete job"], refused }));
    js.push(job(r, "e2e", U, e2eHung ? 360 : e2eMin, { conclusion: e2eHung ? "cancelled" : rerun ? "failure" : "success", stepNames: ["Set up job", "Install", "Build", "Browsers", "Playwright", "Complete job"], refused }));
    if (rerun) js.push(job(r, "e2e", U, e2eMin, { attempt: 2, startOffset: e2eMin + 2, stepNames: ["Set up job", "Install", "Build", "Browsers", "Playwright", "Complete job"] }));
    if (pr) js.push(job(r, "deploy-preview", U, 4, { startOffset: e2eMin + 1, refused }));
    return js;
  };
  // 12 PR pushes on 6 branches (each with a duplicate push-event run), 4 pushes to main
  for (let i = 0; i < 12; i++) {
    const branch = `feature-${Math.floor(i / 2) + 1}`;
    const at = NOW - (28 - i * 2) * DAY + 10 * HOUR;
    // the second push to a branch lands 10 minutes after the first, while the first is still running
    const created = i % 2 === 1 ? NOW - (28 - (i - 1) * 2) * DAY + 10 * HOUR + 10 * MIN : at;
    const prRun = run(repo, "ci.yml", "pull_request", branch, created, { durMin: 35, attempt: i % 3 === 0 ? 2 : 1 });
    const pushRun = run(repo, "ci.yml", "push", branch, created + 5000, { durMin: 35 });
    runs.push(prRun, pushRun);
    addJobs(jobs, prRun, ciJobs(prRun, { pr: true, lintFails: i === 4 || i === 8, e2eHung: i === 6, rerun: i % 3 === 0 }));
    addJobs(jobs, pushRun, ciJobs(pushRun, { pr: false }));
  }
  for (let i = 0; i < 4; i++) {
    const r = run(repo, "ci.yml", "push", "main", NOW - (26 - i * 7) * DAY + 15 * HOUR);
    runs.push(r);
    addJobs(jobs, r, ciJobs(r, { pr: false }));
  }
  // the latest PR run was refused for billing
  const refusedRun = run(repo, "ci.yml", "pull_request", "feature-7", NOW - 2 * DAY + 9 * HOUR, { conclusion: "failure", durMin: 0 });
  runs.push(refusedRun);
  const rj = ciJobs(refusedRun, { pr: true, refused: true });
  addJobs(jobs, refusedRun, rj);
  // "nightly" fires every hour; recorded for the last 2 days
  for (let h = 1; h <= 48; h++) {
    const r = run(repo, "nightly.yml", "schedule", "main", NOW - h * HOUR + 2 * MIN, { durMin: 4 });
    runs.push(r);
    addJobs(jobs, r, [job(r, "smoke", U, 3)]);
  }
  const extra = {
    [`/repos/${repo}`]: { status: 200, body: { full_name: repo, private: true, visibility: "private", default_branch: "main", owner: { login: "example-org", type: "Organization" } } },
    "/organizations/example-org/settings/billing/usage": { status: 403, body: { message: "Must have admin rights to the billing account", status: "403" } },
    "/organizations/example-org/settings/billing/budgets": { status: 200, body: { budgets: [] } },
  };
  for (const j of rj) extra[`/repos/${repo}/check-runs/${j.id}/annotations`] = { status: 200, body: [{ path: ".github", annotation_level: "failure", title: "", message: REFUSAL, start_line: 1, end_line: 1 }] };
  return pack(repo, runs, jobs, extra);
}

// ---------------------------------------------------------------- (b) fleet-apps: well tuned
function fleetApps() {
  const repo = "example-org/fleet-apps";
  const runs = [];
  const jobs = new Map();
  const SELF = ["self-hosted", "macOS", "ARM64", "fleet-ci"];
  const U = ["ubuntu-latest"];
  for (let i = 0; i < 10; i++) {
    const ev = i % 3 === 0 ? "push" : "pull_request";
    const r = run(repo, "ci.yml", ev, ev === "push" ? "main" : `feat-${i}`, NOW - (25 - i * 2) * DAY + 11 * HOUR, { durMin: 25 });
    runs.push(r);
    addJobs(jobs, r, [
      job(r, "changes", SELF, 0.4, { runner: "fleet-box-1" }),
      job(r, "lint", SELF, 3, { runner: "fleet-box-1", startOffset: 1 }),
      job(r, "build", SELF, 6, { runner: "fleet-box-1", startOffset: 4, stepNames: ["Set up job", "Install", "Build", "Complete job"] }),
      job(r, "e2e (1)", SELF, 11, { runner: "fleet-box-1", startOffset: 11 }),
      job(r, "e2e (2)", SELF, 10, { runner: "fleet-box-1", startOffset: 22 }),
    ]);
  }
  for (let i = 0; i < 4; i++) {
    const r = run(repo, "pre-deploy.yml", i < 2 ? "push" : "pull_request", i < 2 ? "main" : "feat-webkit", NOW - (20 - i * 5) * DAY + 13 * HOUR, { durMin: 22 });
    runs.push(r);
    addJobs(jobs, r, [job(r, "webkit", U, 12, { stepNames: ["Set up job", "Install", "Browsers", "Playwright (webkit)", "Complete job"] })]);
  }
  for (let k = 1; k <= 24; k++) {
    const r = run(repo, "runner-watchdog.yml", "schedule", "main", NOW - k * 3 * HOUR + 17 * MIN, { durMin: 1 });
    runs.push(r);
    addJobs(jobs, r, [job(r, "watchdog", U, 0.5)]);
  }
  const extra = {
    [`/repos/${repo}`]: { status: 200, body: { full_name: repo, private: true, visibility: "private", default_branch: "main", owner: { login: "example-org", type: "Organization" } } },
    "/organizations/example-org/settings/billing/usage": {
      status: 200,
      body: {
        usageItems: [
          { date: "2026-11-03T00:00:00Z", product: "actions", sku: "Actions Linux", quantity: 96, unitType: "Minutes", pricePerUnit: 0.006, grossAmount: 0.576, discountAmount: 0, netAmount: 0.576, organizationName: "example-org", repositoryName: "fleet-apps" },
          { date: "2026-10-20T00:00:00Z", product: "actions", sku: "Actions Linux", quantity: 40, unitType: "Minutes", pricePerUnit: 0.006, grossAmount: 0.24, discountAmount: 0, netAmount: 0.24, organizationName: "example-org", repositoryName: "fleet-apps" },
          { date: "2026-10-20T00:00:00Z", product: "actions", sku: "Actions Linux", quantity: 500, unitType: "Minutes", pricePerUnit: 0.006, grossAmount: 3, discountAmount: 0, netAmount: 3, organizationName: "example-org", repositoryName: "other-repo" },
        ],
      },
    },
    "/organizations/example-org/settings/billing/budgets": { status: 200, body: { budgets: [{ id: "budget-1", budget_type: "ProductPricing", budget_product_sku: "actions", budget_scope: "organization", budget_amount: 50, prevent_further_usage: true, budget_alerting: { will_alert: true, alert_recipients: [] } }] } },
  };
  return pack(repo, runs, jobs, extra);
}

// ---------------------------------------------------------------- (c) pyfmt-lib: Python/pytest
function pyfmtLib({ allRefused = false } = {}) {
  const repo = "example-org/pyfmt-lib";
  const runs = [];
  const jobs = new Map();
  const U = ["ubuntu-latest"];
  const extra = {
    [`/repos/${repo}`]: { status: 200, body: { full_name: repo, private: true, visibility: "private", default_branch: "main", owner: { login: "example-dev", type: "User" } } },
    "/users/example-dev/settings/billing/usage": { status: 404, body: { message: "Not Found", status: "404" } },
    "/users/example-dev/settings/billing/budgets": { status: 403, body: { message: "Resource not accessible by personal access token", status: "403" } },
  };
  for (let i = 0; i < 8; i++) {
    const ev = i % 2 ? "pull_request" : "push";
    const r = run(repo, "test.yml", ev, ev === "push" ? "main" : `fix-${i}`, NOW - (24 - i * 3) * DAY + 8 * HOUR, { durMin: 6, conclusion: allRefused ? "failure" : "success" });
    runs.push(r);
    const versions = ev === "pull_request" ? ["3.12"] : ["3.10", "3.11", "3.12", "3.13"];
    const js = versions.map((v) => job(r, `test (${v})`, U, 4, { refused: allRefused }));
    addJobs(jobs, r, js);
    if (allRefused) for (const j of js) extra[`/repos/${repo}/check-runs/${j.id}/annotations`] = { status: 200, body: [{ annotation_level: "failure", title: "", message: REFUSAL }] };
  }
  if (!allRefused) {
    const r = run(repo, "wheels.yml", "push", "v0.4.0", NOW - 10 * DAY + 9 * HOUR, { durMin: 12 });
    runs.push(r);
    addJobs(jobs, r, [job(r, "sdist", ["ubuntu-24.04-arm"], 1), job(r, "macos-wheels", ["macos-14"], 8), job(r, "publish", U, 1, { startOffset: 9 })]);
  }
  return pack(repo, runs, jobs, extra);
}

// ---------------------------------------------------------------- (d) tiny-cli: public, reusable-workflow caller
function tinyCli() {
  const repo = "example-org/tiny-cli";
  const runs = [];
  const jobs = new Map();
  for (let i = 0; i < 2; i++) {
    const r = run(repo, "release.yml", "push", `v1.${i}.0`, NOW - (20 - i * 10) * DAY, { durMin: 5 });
    runs.push(r);
    addJobs(jobs, r, [job(r, "release / build", ["ubuntu-latest"], 4)]);
  }
  const extra = {
    [`/repos/${repo}`]: { status: 200, body: { full_name: repo, private: false, visibility: "public", default_branch: "main", owner: { login: "example-org", type: "Organization" } } },
    "/organizations/example-org/settings/billing/usage": { status: 404, body: { message: "Not Found" } },
    "/organizations/example-org/settings/billing/budgets": { status: 404, body: { message: "Not Found" } },
  };
  return pack(repo, runs, jobs, extra);
}

const out = (name, data) => writeFileSync(path.join(HERE, name), JSON.stringify(data, null, 1) + "\n");
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  out("web-monorepo/gh.json", webMonorepo());
  out("fleet-apps/gh.json", fleetApps());
  out("pyfmt-lib/gh.json", pyfmtLib());
  out("pyfmt-lib/gh-refused.json", pyfmtLib({ allRefused: true }));
  out("tiny-cli/gh.json", tinyCli());
  console.log("recordings written");
}
