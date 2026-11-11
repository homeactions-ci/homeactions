#!/usr/bin/env node
// homeactions watchdog: tells the owner when the tenant's self-hosted runner stops taking jobs (HMA-014).
// Zero dependencies, Node >= 18. Rendered into the user's repo as .homeactions/watchdog.mjs; it reads its
// settings from the profile next to it (.homeactions/profile.json) at run time.
//
//   node .homeactions/watchdog.mjs [--profile <profile.json>] [--repo <owner/name>] [--threshold <minutes>]
//                                  [--apply] [--reap] [--json]
//
// Every tick it:
//   1. reads queued and in-progress runs and their latest-attempt jobs, keeping ONLY jobs whose labels include
//      the tenant label (other runner pools never count, L12);
//   2. times each queued job by its own created_at (a re-run attempt gets fresh jobs and a fresh clock; the run's
//      created_at does not move on re-run, L12);
//   3. decides: "ok", "offline" (stuck queued, nothing running, no runner online or the runner list unreadable),
//      "wedged" (stuck queued, a runner online AND idle, nothing running: the "Job message not found" listener,
//      L11), or "api-error" (the watchdog itself could not read GitHub: auth, 403, 5xx; L27);
//   4. keeps exactly one open issue (opens, updates, closes), titled from profile watchdog.issueTitle;
//   5. with --reap, lists unfinished runs whose pull request is closed or merged and cancels them when the
//      profile allows (watchdog.reapClosedPrs) and --apply is given; otherwise reports them (L10).
// Without --apply it writes nothing and prints the plan. Writes are limited to: create/update/close/comment on
// issues, and cancel a workflow run. Exit: 0 decided (any state but api-error), 2 api-error or usage error.

import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const QUEUED = new Set(["queued"]);
export const UNFINISHED = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);
const STATE_MARK = /<!-- homeactions-watchdog state=([a-z-]+) -->/;

// ---------------------------------------------------------------- profile-derived settings

export const banner = (profile) => `homeactions[${profile.tenant.name}]`;
export const tenantLabel = (profile) => profile.tenant.runnerLabels[0];
export const daemonLabel = (profile) => `${profile.tenant.labelPrefix}.runner`; // same rule as derive() in render.mjs
export const defaultTitle = (profile) => `${banner(profile)}: runner jobs queued with nothing running`;
export const issueTitle = (profile) => (profile.watchdog && profile.watchdog.issueTitle) || defaultTitle(profile);

/** The owner's one-line listener restart, for the host OS. */
export function restartCommand(profile) {
  return profile.host.os === "macos" ? `sudo launchctl kickstart -k system/${daemonLabel(profile)}` : `sudo systemctl restart ${daemonLabel(profile)}.service`;
}

export function fallbackHint(profile) {
  const w = profile.workflows;
  return `To fall back to GitHub-hosted runners now, set the repository variable ${w.fallbackVariable} to anything other than '${w.selfValue}' (e.g. \`gh variable set ${w.fallbackVariable} --body hosted\`), or add the PR label '${w.hostedLabel}' to one PR.`;
}

// ---------------------------------------------------------------- the decision function

const labelsOf = (x) => (x.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));

/** Keep only the latest attempt of each job (same run, same name). */
export function latestAttempts(jobs) {
  const best = new Map();
  for (const j of jobs) {
    const k = `${j.run_id}\u0000${j.name}`;
    const prev = best.get(k);
    if (!prev || (j.run_attempt ?? 1) > (prev.run_attempt ?? 1)) best.set(k, j);
  }
  return [...best.values()];
}

/**
 * decide({ jobs, runners, now, label, thresholdMinutes, error, bannerText, restart, fallback })
 *   jobs:    GitHub job objects (any pool, any attempt); only those labelled `label` count.
 *   runners: GitHub runner objects, or null/undefined when the runner list could not be read.
 *   error:   { status, message } when the jobs/runs API itself failed.
 * Returns { state: "ok"|"offline"|"wedged"|"api-error", message, stuckJobs }.
 */
export function decide({ jobs = [], runners, now = Date.now(), label, thresholdMinutes = 30, error, bannerText = "homeactions", restart = "", fallback = "" }) {
  const t = typeof now === "number" ? now : Date.parse(now);
  if (error) {
    const st = error.status ? `HTTP ${error.status}` : "no response";
    const why = error.status === 401 ? "the token is missing, expired or revoked" : error.status === 403 ? "the token lacks permission (it needs Actions read and Issues write on this repository) or a rate limit hit" : error.status >= 500 ? "GitHub's API is failing; it may recover on the next tick" : "the API call failed";
    return { state: "api-error", message: `${bannerText} watchdog api-error: could not read GitHub (${st}: ${error.message ?? "error"}); ${why}. This says nothing about the runner: the watchdog cannot see it until the token or API works again.`, stuckJobs: [] };
  }
  const mine = latestAttempts(jobs.filter((j) => labelsOf(j).includes(label)));
  const age = (j) => (t - Date.parse(j.created_at ?? j.started_at)) / 60000;
  const queued = mine.filter((j) => QUEUED.has(j.status));
  const running = mine.filter((j) => j.status === "in_progress");
  const stuck = queued.filter((j) => age(j) >= thresholdMinutes).map((j) => ({ id: j.id, run_id: j.run_id, run_attempt: j.run_attempt ?? 1, name: j.name, queuedMinutes: Math.floor(age(j)), url: j.html_url }));
  const oldest = stuck.reduce((m, j) => Math.max(m, j.queuedMinutes), 0);
  if (!stuck.length) {
    return { state: "ok", message: `${bannerText} watchdog ok: ${queued.length} queued (none for ${thresholdMinutes}+ min), ${running.length} running for label '${label}'.`, stuckJobs: [] };
  }
  if (running.length) {
    return { state: "ok", message: `${bannerText} watchdog ok: busy. ${stuck.length} job(s) queued up to ${oldest} min behind ${running.length} running job(s) for label '${label}'.`, stuckJobs: [] };
  }
  const head = `${stuck.length} job(s) labelled '${label}' queued for up to ${oldest} min (threshold ${thresholdMinutes}) and none is running.`;
  if (runners == null) {
    return { state: "offline", stuckJobs: stuck, message: `${bannerText} watchdog offline: ${head} The runner list could not be read with this token, so the runner is offline (machine off, asleep, or off the network), deregistered, or its labels no longer match; a wedged listener looks the same from here. ${fallback}`.trim() };
  }
  const pool = runners.filter((r) => labelsOf(r).includes(label));
  const online = pool.filter((r) => r.status === "online");
  if (!pool.length) {
    return { state: "offline", stuckJobs: stuck, message: `${bannerText} watchdog offline: ${head} No registered runner carries the label '${label}' (deregistered, or a label mismatch between the workflow and the runner). ${fallback}`.trim() };
  }
  if (!online.length) {
    return { state: "offline", stuckJobs: stuck, message: `${bannerText} watchdog offline: ${head} Runner(s) ${pool.map((r) => r.name).join(", ")} are offline: the machine is off, asleep, locked after a FileVault reboot, or off the network, or the runner service stopped. ${fallback}`.trim() };
  }
  const idle = online.filter((r) => !r.busy);
  if (idle.length) {
    return { state: "wedged", stuckJobs: stuck, message: `${bannerText} watchdog wedged: ${head} Runner ${idle.map((r) => r.name).join(", ")} is online and idle, so its listener is not picking up work. Signature: the runner's _diag/Runner_*.log repeats "Job message not found". Owner remedy, only when no Runner.Worker process exists: ${restart}. ${fallback}`.trim() };
  }
  return { state: "ok", message: `${bannerText} watchdog ok: runner ${online.map((r) => r.name).join(", ")} reports busy; ${stuck.length} job(s) queued up to ${oldest} min.`, stuckJobs: [] };
}

// ---------------------------------------------------------------- one issue, kept in step with the state

export function issueBody(decision, { now = Date.now(), runbook = ".homeactions/RUNBOOK.md" } = {}) {
  const lines = [`<!-- homeactions-watchdog state=${decision.state} -->`, `**State: ${decision.state}** (checked ${new Date(now).toISOString()})`, "", decision.message, ""];
  if (decision.stuckJobs.length) {
    lines.push("Stuck jobs (latest attempt, timed by the job's own clock):");
    for (const j of decision.stuckJobs) lines.push(`- ${j.name} (run ${j.run_id}, attempt ${j.run_attempt}): queued ${j.queuedMinutes} min${j.url ? ` ${j.url}` : ""}`);
    lines.push("");
  }
  lines.push(`What each state means and what to do: ${runbook}. This issue is opened, updated and closed by the watchdog; closing it by hand is fine.`);
  return lines.join("\n");
}

/**
 * planIssue({ decision, openIssues, title, body }) -> ops
 * Exactly one open issue with `title` while the state is not ok; none when ok. Duplicates are closed.
 * ops: { op: "create", title, body } | { op: "update", number, body, comment? } | { op: "close", number, comment }
 */
export function planIssue({ decision, openIssues = [], title, body }) {
  const mine = openIssues.filter((i) => i.title === title && !i.pull_request && (i.state ?? "open") === "open").sort((a, b) => a.number - b.number);
  const ops = [];
  if (decision.state === "ok") {
    for (const i of mine) ops.push({ op: "close", number: i.number, comment: `Resolved: ${decision.message}` });
    return ops;
  }
  if (!mine.length) return [{ op: "create", title, body }];
  const [keep, ...dups] = mine;
  const prev = STATE_MARK.exec(keep.body ?? "");
  const changed = !prev || prev[1] !== decision.state;
  ops.push({ op: "update", number: keep.number, body, ...(changed ? { comment: `State is now **${decision.state}**: ${decision.message}` } : {}) });
  for (const d of dups) ops.push({ op: "close", number: d.number, comment: `Duplicate of #${keep.number}.` });
  return ops;
}

// ---------------------------------------------------------------- closed-PR reaper

/**
 * planReap({ runs, pulls, allowCancel }) -> [{ run_id, pr, prState, action: "cancel"|"report" }]
 * runs: unfinished workflow runs; pulls: Map<number, pull object>. A run is reaped when its pull request is
 * closed or merged; GitHub does not cancel those runs and they hold the runner (L10).
 */
export function planReap({ runs = [], pulls = new Map(), allowCancel = false }) {
  const out = [];
  for (const r of runs) {
    if (!UNFINISHED.has(r.status)) continue;
    if (r.event !== "pull_request" && r.event !== "pull_request_target") continue;
    const num = prNumber(r, pulls);
    if (num == null) continue;
    const pr = pulls.get(num);
    if (!pr || pr.state !== "closed") continue;
    out.push({ run_id: r.id, pr: num, prState: pr.merged_at ? "merged" : "closed", action: allowCancel ? "cancel" : "report", name: r.name, url: r.html_url });
  }
  return out;
}

function prNumber(run, pulls) {
  const n = run.pull_requests && run.pull_requests[0] && run.pull_requests[0].number;
  if (n != null) return n;
  for (const [num, pr] of pulls) if (pr.head && pr.head.ref === run.head_branch && (!run.head_sha || pr.head.sha === run.head_sha)) return num;
  return null;
}

// ---------------------------------------------------------------- the gh wrapper (GET, plus four named writes)

const WRITES = [
  ["POST", /^\/repos\/[^/]+\/[^/]+\/issues$/],
  ["PATCH", /^\/repos\/[^/]+\/[^/]+\/issues\/\d+$/],
  ["POST", /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/],
  ["POST", /^\/repos\/[^/]+\/[^/]+\/actions\/runs\/\d+\/cancel$/],
];

export function defaultExec(args, input) {
  const r = spawnSync("gh", args, { encoding: "utf8", input, maxBuffer: 32 * 1024 * 1024 });
  if (r.error) return { status: 127, stdout: "", stderr: String(r.error.message) };
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** makeGh({ exec, apply }): GET always; the four writes above only with apply; anything else refused. */
export function makeGh({ exec = defaultExec, apply = false } = {}) {
  const writes = [];
  function call(method, apiPath, body) {
    const m = String(method).toUpperCase();
    if (m !== "GET") {
      if (!WRITES.some(([wm, re]) => wm === m && re.test(apiPath.split("?")[0]))) throw new Error(`watchdog refuses ${m} ${apiPath}: not one of its allowed writes`);
      writes.push({ method: m, path: apiPath, body });
      if (!apply) return { ok: true, status: 0, dryRun: true, data: null };
    }
    const args = ["api", "-X", m, "-H", "Accept: application/vnd.github+json", apiPath];
    if (body !== undefined) args.push("--input", "-");
    const res = exec(args, body !== undefined ? JSON.stringify(body) : undefined);
    if (res.status === 0) {
      try {
        return { ok: true, status: 200, data: res.stdout.trim() ? JSON.parse(res.stdout) : null };
      } catch (e) {
        return { ok: false, status: 0, message: `response was not JSON: ${e.message}` };
      }
    }
    const mm = /HTTP (\d{3})/.exec(res.stderr ?? "");
    const status = mm ? Number(mm[1]) : /gh auth login|not logged/i.test(res.stderr ?? "") ? 401 : 0;
    return { ok: false, status, message: (res.stderr ?? "").trim().split("\n")[0] || `gh exited ${res.status}` };
  }
  return { call, get: (p) => call("GET", p), writes };
}

// ---------------------------------------------------------------- one tick

/** runWatchdog({ gh, profile, repo, thresholdMinutes, now, apply, reap }) -> { decision, issueOps, reaped, applied } */
export function runWatchdog({ gh, profile, repo = profile.repo.slug, thresholdMinutes = profile.watchdog.thresholdMinutes, now = Date.now(), apply = false, reap = false }) {
  const label = tenantLabel(profile);
  const common = { now, label, thresholdMinutes, bannerText: banner(profile), restart: restartCommand(profile), fallback: fallbackHint(profile) };
  const runs = [];
  let error = null;
  for (const status of ["queued", "in_progress"]) {
    const r = gh.get(`/repos/${repo}/actions/runs?status=${status}&per_page=100`);
    if (!r.ok) {
      error = r;
      break;
    }
    runs.push(...(r.data?.workflow_runs ?? []));
  }
  const jobs = [];
  if (!error) {
    for (const run of runs.slice(0, 60)) {
      const r = gh.get(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
      if (!r.ok) {
        error = r;
        break;
      }
      jobs.push(...(r.data?.jobs ?? []));
    }
  }
  let runners = null;
  if (!error) {
    const r = gh.get(`/repos/${repo}/actions/runners?per_page=100`);
    if (r.ok) runners = r.data?.runners ?? [];
    else if (r.status === 401) error = r; // a 403/404 here only means this token cannot list runners
  }
  const decision = decide({ ...common, jobs, runners, error });

  const title = issueTitle(profile);
  const issues = gh.get(`/repos/${repo}/issues?state=open&per_page=100`);
  const issueOps = issues.ok ? planIssue({ decision, openIssues: issues.data ?? [], title, body: issueBody(decision, { now }) }) : [];
  const issueReadError = issues.ok ? null : issues;

  let reaped = [];
  if (reap && !error) {
    const pulls = new Map();
    for (const run of runs) {
      if (run.event !== "pull_request" && run.event !== "pull_request_target") continue;
      const n = run.pull_requests && run.pull_requests[0] && run.pull_requests[0].number;
      if (n != null) {
        if (!pulls.has(n)) {
          const p = gh.get(`/repos/${repo}/pulls/${n}`);
          if (p.ok) pulls.set(n, p.data);
        }
      } else if (run.head_branch && run.head_repository && run.head_repository.owner) {
        const p = gh.get(`/repos/${repo}/pulls?state=all&head=${run.head_repository.owner.login}:${run.head_branch}&per_page=5`);
        if (p.ok) for (const pr of p.data ?? []) if (!pulls.has(pr.number)) pulls.set(pr.number, pr);
      }
    }
    reaped = planReap({ runs, pulls, allowCancel: Boolean(profile.watchdog.reapClosedPrs) });
  }

  const applied = [];
  for (const op of issueOps) {
    if (op.op === "create") applied.push(gh.call("POST", `/repos/${repo}/issues`, { title: op.title, body: op.body }));
    if (op.op === "update") {
      applied.push(gh.call("PATCH", `/repos/${repo}/issues/${op.number}`, { body: op.body }));
      if (op.comment) applied.push(gh.call("POST", `/repos/${repo}/issues/${op.number}/comments`, { body: op.comment }));
    }
    if (op.op === "close") {
      applied.push(gh.call("POST", `/repos/${repo}/issues/${op.number}/comments`, { body: op.comment }));
      applied.push(gh.call("PATCH", `/repos/${repo}/issues/${op.number}`, { state: "closed", state_reason: "completed" }));
    }
  }
  for (const r of reaped) if (r.action === "cancel") applied.push(gh.call("POST", `/repos/${repo}/actions/runs/${r.run_id}/cancel`));
  return { decision, issueOps, issueReadError, reaped, applied, apply };
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const o = { apply: false, reap: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--profile") o.profile = val();
    else if (a === "--repo") o.repo = val();
    else if (a === "--threshold") o.threshold = Number(val());
    else if (a === "--apply") o.apply = true;
    else if (a === "--reap") o.reap = true;
    else if (a === "--json") o.json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.threshold !== undefined && !(o.threshold > 0)) throw new Error("--threshold must be a positive number of minutes");
  return o;
}

export function main(argv, { exec, now } = {}) {
  let o;
  let profile;
  try {
    o = parseArgs(argv);
    profile = JSON.parse(readFileSync(o.profile ?? path.join(HERE, "profile.json"), "utf8"));
  } catch (e) {
    console.error(`watchdog: ${e.message}`);
    return 2;
  }
  const gh = makeGh({ exec, apply: o.apply });
  const out = runWatchdog({ gh, profile, repo: o.repo ?? profile.repo.slug, thresholdMinutes: o.threshold ?? profile.watchdog.thresholdMinutes, now: now ?? Date.now(), apply: o.apply, reap: o.reap });
  if (o.json) console.log(JSON.stringify({ ...out, writes: gh.writes }, null, 2));
  else {
    console.log(out.decision.message);
    if (out.issueReadError) console.log(`could not read issues (HTTP ${out.issueReadError.status}): issue not updated`);
    for (const op of out.issueOps) console.log(`${o.apply ? "" : "[dry run] "}issue ${op.op}${op.number ? ` #${op.number}` : ""}: ${op.title ?? op.comment ?? "body refreshed"}`.split("\n")[0]);
    for (const r of out.reaped) console.log(`${r.action === "cancel" && o.apply ? "" : "[report] "}run ${r.run_id} of ${r.prState} PR #${r.pr}: ${r.action === "cancel" ? (o.apply ? "cancelled" : "would cancel (pass --apply)") : "not cancelled (watchdog.reapClosedPrs is false)"}`);
  }
  return out.decision.state === "api-error" ? 2 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
