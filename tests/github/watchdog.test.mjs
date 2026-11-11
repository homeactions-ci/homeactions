// The watchdog (HMA-014): label filter, per-attempt clock, offline vs wedged vs api-error, busy queue,
// one-issue lifecycle against a fake gh, and the closed-PR reaper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  decide,
  latestAttempts,
  planIssue,
  planReap,
  issueBody,
  issueTitle,
  restartCommand,
  daemonLabel,
  banner,
  makeGh,
  runWatchdog,
  main,
} from "../../skills/homeactions/kit/common/watchdog/watchdog.mjs";
import { derive } from "../../skills/homeactions/kit/render.mjs";
import { ROOT } from "./helpers.mjs";

const profile = (name = "two-tenant-mac") => JSON.parse(readFileSync(path.join(ROOT, "fixtures", "profiles", `${name}.json`), "utf8"));
const NOW = Date.parse("2026-11-12T12:00:00Z");
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();
const LABEL = "acme-ci";
const MINE = ["self-hosted", "macOS", "ARM64", "acme-ci"];
const OTHER = ["self-hosted", "macOS", "ARM64", "other-pool"];
let id = 1;
const job = (status, createdMinsAgo, labels = MINE, extra = {}) => ({ id: id++, run_id: extra.run_id ?? id, run_attempt: 1, name: extra.name ?? `job-${id}`, status, labels, created_at: minsAgo(createdMinsAgo), started_at: status === "queued" ? null : minsAgo(createdMinsAgo), ...extra });
const runner = (status, busy, labels = MINE) => ({ id: 1, name: "box-acme-1", status, busy, labels: labels.map((name) => ({ name })) });
const base = { now: NOW, label: LABEL, thresholdMinutes: 30, bannerText: "homeactions[acme-ci]", restart: "sudo launchctl kickstart -k system/com.example.acme-ci.runner", fallback: "FALLBACK" };

test("ok when nothing is queued past the threshold", () => {
  const d = decide({ ...base, jobs: [job("queued", 5), job("in_progress", 10)], runners: [runner("online", true)] });
  assert.equal(d.state, "ok");
  assert.deepEqual(d.stuckJobs, []);
});

test("busy queue: stuck queued jobs behind a running job are ok", () => {
  const d = decide({ ...base, jobs: [job("queued", 90), job("queued", 45), job("in_progress", 20)], runners: [runner("online", true)] });
  assert.equal(d.state, "ok");
  assert.match(d.message, /busy/);
});

test("the label filter ignores other pools' jobs (queued or running)", () => {
  // another pool's stuck job never alerts
  assert.equal(decide({ ...base, jobs: [job("queued", 300, OTHER)], runners: [] }).state, "ok");
  // another pool's running job does not mask our stuck one
  const d = decide({ ...base, jobs: [job("queued", 60), job("in_progress", 5, OTHER)], runners: [runner("online", false)] });
  assert.equal(d.state, "wedged");
  // runners carrying another pool's label do not count as ours
  const d2 = decide({ ...base, jobs: [job("queued", 60)], runners: [runner("online", false, OTHER)] });
  assert.equal(d2.state, "offline");
  assert.match(d2.message, /No registered runner carries the label 'acme-ci'/);
});

test("per-attempt clock: a re-run attempt is timed from its own created_at, not the run's", () => {
  const runId = 777;
  const first = { ...job("completed", 240, MINE, { run_id: runId, name: "e2e" }), run_attempt: 1, conclusion: "failure" };
  const rerun = { ...job("queued", 4, MINE, { run_id: runId, name: "e2e" }), run_attempt: 2 };
  assert.deepEqual(latestAttempts([first, rerun]).map((j) => j.run_attempt), [2]);
  const d = decide({ ...base, jobs: [first, rerun], runners: [runner("online", false)] });
  assert.equal(d.state, "ok", "a fresh attempt (4 min) of an old run (240 min) is not stuck");
  // the same attempt queued long enough does alert, and reports its attempt
  const stale = { ...rerun, created_at: minsAgo(45) };
  const d2 = decide({ ...base, jobs: [first, stale], runners: [runner("online", false)] });
  assert.equal(d2.state, "wedged");
  assert.equal(d2.stuckJobs[0].run_attempt, 2);
  assert.equal(d2.stuckJobs[0].queuedMinutes, 45);
});

test("offline: stuck, nothing running, runner list unavailable", () => {
  const d = decide({ ...base, jobs: [job("queued", 61)], runners: null });
  assert.equal(d.state, "offline");
  assert.match(d.message, /^homeactions\[acme-ci\] watchdog offline: 1 job\(s\) labelled 'acme-ci' queued for up to 61 min/);
  assert.match(d.message, /could not be read/);
  assert.match(d.message, /FALLBACK/);
});

test("offline: stuck, nothing running, zero runners online", () => {
  const d = decide({ ...base, jobs: [job("queued", 61)], runners: [runner("offline", false)] });
  assert.equal(d.state, "offline");
  assert.match(d.message, /box-acme-1 are offline/);
});

test("wedged: stuck, runner online and idle, nothing running; names the signature and the owner's restart", () => {
  const d = decide({ ...base, jobs: [job("queued", 33)], runners: [runner("online", false)] });
  assert.equal(d.state, "wedged");
  assert.match(d.message, /Job message not found/);
  assert.match(d.message, /sudo launchctl kickstart -k system\/com\.example\.acme-ci\.runner/);
  assert.match(d.message, /no Runner\.Worker/);
});

test("api-error on 401, 403 and 5xx, with distinct wording and no runner verdict", () => {
  for (const [status, re] of [[401, /missing, expired or revoked/], [403, /lacks permission/], [502, /recover/]]) {
    const d = decide({ ...base, jobs: [job("queued", 600)], runners: null, error: { status, message: "boom" } });
    assert.equal(d.state, "api-error");
    assert.match(d.message, re);
    assert.match(d.message, /says nothing about the runner/);
  }
});

test("the three alert messages are distinct", () => {
  const msgs = [decide({ ...base, jobs: [job("queued", 60)], runners: [] }), decide({ ...base, jobs: [job("queued", 60)], runners: [runner("online", false)] }), decide({ ...base, error: { status: 403 } })].map((d) => d.message.split(":")[0]);
  assert.equal(new Set(msgs).size, 3);
});

test("restart command and daemon label agree with the renderer's derive()", () => {
  for (const name of ["two-tenant-mac", "dedicated-mac", "linux-beta"]) {
    const p = profile(name);
    assert.equal(daemonLabel(p), derive(p).daemonLabel);
    assert.equal(banner(p), derive(p).banner);
  }
  assert.equal(restartCommand(profile("two-tenant-mac")), "sudo launchctl kickstart -k system/com.example.acme-ci.runner");
  assert.match(restartCommand(profile("linux-beta")), /^sudo systemctl restart .*\.runner\.service$/);
  assert.equal(issueTitle(profile()), "homeactions[acme-ci]: runner jobs queued with nothing running");
  assert.equal(issueTitle({ ...profile(), watchdog: { ...profile().watchdog, issueTitle: "CI box down" } }), "CI box down");
});

// ---------------------------------------------------------------- issue lifecycle

const T = "homeactions[acme-ci]: runner jobs queued with nothing running";
const alert = { state: "offline", message: "m", stuckJobs: [] };

test("planIssue: create when none, update (no comment) when same state, comment on change, close on ok, close duplicates", () => {
  assert.deepEqual(planIssue({ decision: alert, openIssues: [], title: T, body: "B" }), [{ op: "create", title: T, body: "B" }]);
  const open = { number: 7, title: T, state: "open", body: issueBody(alert, { now: NOW }) };
  assert.deepEqual(planIssue({ decision: alert, openIssues: [open], title: T, body: "B2" }), [{ op: "update", number: 7, body: "B2" }]);
  const wedged = { state: "wedged", message: "w", stuckJobs: [] };
  const ch = planIssue({ decision: wedged, openIssues: [open], title: T, body: "B3" });
  assert.equal(ch[0].op, "update");
  assert.match(ch[0].comment, /now \*\*wedged\*\*/);
  assert.deepEqual(planIssue({ decision: { state: "ok", message: "fine", stuckJobs: [] }, openIssues: [open], title: T, body: "" }), [{ op: "close", number: 7, comment: "Resolved: fine" }]);
  const dup = planIssue({ decision: alert, openIssues: [{ ...open, number: 9 }, open, { number: 3, title: "other", state: "open" }, { number: 11, title: T, state: "open", pull_request: {} }], title: T, body: "B" });
  assert.deepEqual(dup.map((o) => [o.op, o.number]), [["update", 7], ["close", 9]]);
  assert.deepEqual(planIssue({ decision: { state: "ok", message: "", stuckJobs: [] }, openIssues: [], title: T }), []);
});

/** A fake GitHub for runWatchdog: queued/in-progress runs, jobs, runners, issues; records writes. */
function fakeGitHub({ jobs = [], runners = [], runnersStatus = 200, runsStatus = 200, issues = [], runs, pulls = {} }) {
  const state = { issues: issues.map((i) => ({ ...i })), next: 100, writes: [], cancelled: [] };
  const allRuns = runs ?? [...new Set(jobs.map((j) => j.run_id))].map((rid) => ({ id: rid, status: jobs.find((j) => j.run_id === rid).status, event: "push" }));
  const ok = (body) => ({ status: 0, stdout: JSON.stringify(body), stderr: "" });
  const fail = (s) => ({ status: 1, stdout: "{}", stderr: `gh: error (HTTP ${s})` });
  const exec = (args, input) => {
    const method = args[args.indexOf("-X") + 1];
    const p = args[args.indexOf("Accept: application/vnd.github+json") + 1];
    const body = input ? JSON.parse(input) : undefined;
    if (method !== "GET") state.writes.push({ method, path: p, body });
    let m;
    if (method === "GET" && (m = /\/actions\/runs\?status=(\w+)/.exec(p))) return runsStatus === 200 ? ok({ workflow_runs: allRuns.filter((r) => r.status === m[1]) }) : fail(runsStatus);
    if (method === "GET" && (m = /\/actions\/runs\/(\d+)\/jobs/.exec(p))) return ok({ jobs: jobs.filter((j) => String(j.run_id) === m[1]) });
    if (method === "GET" && /\/actions\/runners/.test(p)) return runnersStatus === 200 ? ok({ runners }) : fail(runnersStatus);
    if (method === "GET" && /\/issues\?state=open/.test(p)) return ok(state.issues.filter((i) => i.state === "open"));
    if (method === "GET" && (m = /\/pulls\/(\d+)$/.exec(p))) return pulls[m[1]] ? ok(pulls[m[1]]) : fail(404);
    if (method === "POST" && /\/issues$/.test(p)) {
      const n = state.next++;
      state.issues.push({ number: n, title: body.title, body: body.body, state: "open" });
      return ok({ number: n });
    }
    if (method === "PATCH" && (m = /\/issues\/(\d+)$/.exec(p))) {
      const i = state.issues.find((x) => x.number === Number(m[1]));
      Object.assign(i, body);
      return ok(i);
    }
    if (method === "POST" && /\/comments$/.test(p)) return ok({});
    if (method === "POST" && (m = /\/actions\/runs\/(\d+)\/cancel$/.exec(p))) {
      state.cancelled.push(Number(m[1]));
      return ok({});
    }
    return fail(404);
  };
  return { exec, state };
}

test("issue lifecycle end to end: opens once, stays one issue across ticks, closes on recovery", () => {
  const p = profile();
  const stuck = [job("queued", 50, MINE, { run_id: 501 })];
  const gh1 = fakeGitHub({ jobs: stuck, runners: [], runnersStatus: 403 });
  let out = runWatchdog({ gh: makeGh({ exec: gh1.exec, apply: true }), profile: p, now: NOW, apply: true });
  assert.equal(out.decision.state, "offline");
  assert.equal(gh1.state.issues.filter((i) => i.state === "open").length, 1);
  // next tick, same state: still exactly one open issue, updated in place
  out = runWatchdog({ gh: makeGh({ exec: gh1.exec, apply: true }), profile: p, now: NOW + 3600000, apply: true });
  assert.equal(gh1.state.issues.filter((i) => i.state === "open").length, 1);
  assert.deepEqual(out.issueOps.map((o) => o.op), ["update"]);
  // recovery: the job ran
  const gh2 = fakeGitHub({ jobs: [], runners: [], issues: gh1.state.issues });
  out = runWatchdog({ gh: makeGh({ exec: gh2.exec, apply: true }), profile: p, now: NOW + 7200000, apply: true });
  assert.equal(out.decision.state, "ok");
  assert.equal(gh2.state.issues.filter((i) => i.state === "open").length, 0);
  assert.ok(gh2.state.writes.some((w) => w.method === "PATCH" && w.body.state === "closed"));
});

test("without --apply nothing is written; the plan is still computed", () => {
  const gh = fakeGitHub({ jobs: [job("queued", 50, MINE, { run_id: 502 })], runners: [runner("online", false)] });
  const wrapped = makeGh({ exec: gh.exec, apply: false });
  const out = runWatchdog({ gh: wrapped, profile: profile(), now: NOW });
  assert.equal(out.decision.state, "wedged");
  assert.deepEqual(out.issueOps.map((o) => o.op), ["create"]);
  assert.equal(gh.state.writes.length, 0);
  assert.equal(wrapped.writes.length, 1, "the intended write is recorded, not sent");
});

test("the watchdog gh wrapper refuses writes other than issues and run cancel", () => {
  const g = makeGh({ exec: () => ({ status: 0, stdout: "{}", stderr: "" }), apply: true });
  assert.throws(() => g.call("DELETE", "/repos/a/b/actions/runners/1"), /refuses/);
  assert.throws(() => g.call("POST", "/repos/a/b/actions/runs/1/rerun"), /refuses/);
  assert.throws(() => g.call("PUT", "/repos/a/b/actions/variables/X"), /refuses/);
  assert.throws(() => g.call("POST", "/repos/a/b/dispatches"), /refuses/);
  assert.doesNotThrow(() => g.call("POST", "/repos/a/b/actions/runs/1/cancel"));
});

test("api-error when the runs API fails; a 403 on the runner list alone is not an api-error", () => {
  const bad = fakeGitHub({ runsStatus: 403 });
  assert.equal(runWatchdog({ gh: makeGh({ exec: bad.exec }), profile: profile(), now: NOW }).decision.state, "api-error");
  const noRunners = fakeGitHub({ jobs: [job("queued", 50, MINE, { run_id: 503 })], runnersStatus: 403 });
  assert.equal(runWatchdog({ gh: makeGh({ exec: noRunners.exec }), profile: profile(), now: NOW }).decision.state, "offline");
});

// ---------------------------------------------------------------- closed-PR reaper

test("planReap: unfinished runs of closed/merged PRs; cancel only when allowed, else report", () => {
  const runs = [
    { id: 1, status: "queued", event: "pull_request", pull_requests: [{ number: 10 }] },
    { id: 2, status: "in_progress", event: "pull_request", pull_requests: [{ number: 11 }] },
    { id: 3, status: "queued", event: "pull_request", pull_requests: [{ number: 12 }] },
    { id: 4, status: "completed", event: "pull_request", pull_requests: [{ number: 10 }] },
    { id: 5, status: "queued", event: "push", pull_requests: [] },
    { id: 6, status: "queued", event: "pull_request", pull_requests: [], head_branch: "gone", head_sha: "abc" },
  ];
  const pulls = new Map([
    [10, { number: 10, state: "closed", merged_at: "2026-11-11T00:00:00Z" }],
    [11, { number: 11, state: "closed", merged_at: null }],
    [12, { number: 12, state: "open" }],
    [13, { number: 13, state: "closed", head: { ref: "gone", sha: "abc" } }],
  ]);
  const plan = planReap({ runs, pulls, allowCancel: true });
  assert.deepEqual(plan.map((r) => [r.run_id, r.pr, r.prState, r.action]), [[1, 10, "merged", "cancel"], [2, 11, "closed", "cancel"], [6, 13, "closed", "cancel"]]);
  assert.ok(planReap({ runs, pulls, allowCancel: false }).every((r) => r.action === "report"));
});

test("runWatchdog --reap cancels closed-PR runs only with reapClosedPrs and --apply", () => {
  const runs = [{ id: 601, status: "queued", event: "pull_request", pull_requests: [{ number: 42 }] }];
  const pulls = { 42: { number: 42, state: "closed", merged_at: null } };
  const g = fakeGitHub({ runs, pulls, runners: [] });
  runWatchdog({ gh: makeGh({ exec: g.exec, apply: true }), profile: profile(), now: NOW, apply: true, reap: true });
  assert.deepEqual(g.state.cancelled, [601]);
  const off = { ...profile(), watchdog: { ...profile().watchdog, reapClosedPrs: false } };
  const g2 = fakeGitHub({ runs, pulls, runners: [] });
  const out = runWatchdog({ gh: makeGh({ exec: g2.exec, apply: true }), profile: off, now: NOW, apply: true, reap: true });
  assert.deepEqual(g2.state.cancelled, []);
  assert.equal(out.reaped[0].action, "report");
});

test("CLI main(): reads the profile, prints the decision, exit 2 on api-error", () => {
  const prof = path.join(ROOT, "fixtures", "profiles", "two-tenant-mac.json");
  const logs = [];
  const orig = console.log;
  console.log = (s) => logs.push(String(s));
  try {
    const g = fakeGitHub({ jobs: [job("queued", 50, MINE, { run_id: 701 })], runners: [runner("online", false)] });
    assert.equal(main(["--profile", prof], { exec: g.exec, now: NOW }), 0);
    assert.match(logs[0], /watchdog wedged/);
    assert.ok(logs.some((l) => /\[dry run\] issue create/.test(l)));
    const bad = fakeGitHub({ runsStatus: 401 });
    assert.equal(main(["--profile", prof], { exec: bad.exec, now: NOW }), 2);
  } finally {
    console.log = orig;
  }
});
