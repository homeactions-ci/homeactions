// Run and job history, best data source first (PRD "Data sources, best first"):
//   1. the account's billing usage report (if the caller can read it);
//   2. job start/end times x the runner-OS minute multiplier;
//   3. workflow structure alone.
// Every source that cannot be read is reported as "unreadable" with its reason; it is never treated as empty.
import { CallCapError } from "./gh.mjs";

export const REFUSED_RE = /recent account payments have failed|spending limit/i;
export const UNFINISHED = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

const DAY = 86400000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);

function describe(res) {
  if (res.kind === "auth") return "gh is not authenticated";
  if (res.kind === "no-gh") return "gh is not installed";
  if (res.status) return `HTTP ${res.status}${res.kind && res.kind !== "other" ? ` (${res.kind})` : ""}`;
  return res.message || "failed";
}

/**
 * collectHistory(gh, { repo, days, now }) -> history
 * Never throws for API failures; a CallCapError ends collection early and marks the history partial.
 */
export function collectHistory(gh, { repo, days = 30, now = Date.now(), annotationCalls = 10 } = {}) {
  const h = {
    source: "structure",
    auth: "unknown",
    repoMeta: null,
    billing: null,
    budgets: null,
    runs: [],
    jobs: [],
    refused: null,
    unreadable: [],
    notes: [],
    partial: false,
    days,
    effectiveDays: days,
    now,
  };
  const [owner] = repo.split("/");
  const since = now - days * DAY;
  try {
    const r = gh.get(`/repos/${repo}`);
    if (!r.ok) {
      if (r.kind === "auth" || r.kind === "no-gh") {
        h.auth = "none";
        h.notes.push(`${describe(r)}: structure-only audit (workflow files only, no run history)`);
      } else {
        h.unreadable.push({ source: "repository metadata", reason: describe(r) });
        h.notes.push(`repository ${repo} unreadable (${describe(r)}): structure-only audit`);
      }
      return h;
    }
    h.auth = "ok";
    const d = r.data ?? {};
    h.repoMeta = {
      visibility: d.visibility ?? (d.private === true ? "private" : d.private === false ? "public" : "unknown"),
      ownerType: d.owner?.type ?? "User",
      owner: d.owner?.login ?? owner,
      defaultBranch: d.default_branch ?? "main",
    };
    const base = h.repoMeta.ownerType === "Organization" ? `/organizations/${h.repoMeta.owner}` : `/users/${h.repoMeta.owner}`;

    // 1. billing usage report (enhanced billing platform), current and previous month
    const months = [...new Set([iso(now).slice(0, 7), iso(since).slice(0, 7)])];
    const items = [];
    let billingErr = null;
    for (const ym of months) {
      const [y, m] = ym.split("-");
      const b = gh.get(`${base}/settings/billing/usage?year=${y}&month=${Number(m)}`);
      if (!b.ok) {
        billingErr = b;
        break;
      }
      for (const it of b.data?.usageItems ?? []) items.push(it);
    }
    if (billingErr) h.unreadable.push({ source: "billing usage report", reason: describe(billingErr) });
    else {
      const name = repo.split("/")[1];
      const seen = new Set();
      const mine = items.filter((it) => {
        const k = JSON.stringify(it);
        if (seen.has(k)) return false;
        seen.add(k);
        const t = Date.parse(it.date);
        const repoOk = !it.repositoryName || it.repositoryName === name || it.repositoryName === repo;
        return /actions/i.test(it.product ?? "") && repoOk && (!Number.isFinite(t) || (t >= since - DAY && t <= now + DAY));
      });
      const bySku = {};
      for (const it of mine) if (/minute/i.test(it.unitType ?? "")) bySku[it.sku ?? "unknown"] = (bySku[it.sku ?? "unknown"] ?? 0) + Number(it.quantity ?? 0);
      const linux = mine.find((it) => /linux/i.test(it.sku ?? "") && Number(it.pricePerUnit) > 0);
      h.billing = {
        minutesBySku: bySku,
        totalMinutes: Object.values(bySku).reduce((a, b) => a + b, 0),
        linuxPricePerMinute: linux ? Number(linux.pricePerUnit) : null,
        fetchedAt: iso(now),
      };
    }
    const bud = gh.get(`${base}/settings/billing/budgets`);
    if (bud.ok) h.budgets = Array.isArray(bud.data?.budgets) ? bud.data.budgets : Array.isArray(bud.data) ? bud.data : [];
    else h.unreadable.push({ source: "budgets / spending limits", reason: describe(bud) });

    // 2. runs in the window, newest first; keep calls for jobs
    const runsReserve = Math.max(20, Math.floor(gh.remaining * 0.6));
    let page = 1;
    let runsOk = true;
    for (;;) {
      const res = gh.get(`/repos/${repo}/actions/runs?per_page=100&created=>=${iso(since)}&page=${page}`);
      if (!res.ok) {
        h.unreadable.push({ source: "workflow runs", reason: describe(res) });
        runsOk = false;
        break;
      }
      const batch = res.data?.workflow_runs ?? [];
      for (const run of batch) if (Date.parse(run.created_at) >= since) h.runs.push(run);
      if (batch.length < 100) break;
      if (gh.remaining <= runsReserve) {
        h.partial = true;
        break;
      }
      page++;
    }
    if (!runsOk) return finish(h);

    // 3. jobs for each run (all attempts), newest first, within the cap
    const annotationReserve = Math.min(annotationCalls, Math.floor(gh.remaining * 0.1));
    for (const run of h.runs) {
      if (gh.remaining <= annotationReserve) {
        h.partial = true;
        break;
      }
      const res = gh.get(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=all&per_page=100`);
      if (!res.ok) {
        run._jobsUnreadable = describe(res);
        continue;
      }
      run._jobsRead = true;
      for (const j of res.data?.jobs ?? []) h.jobs.push({ ...j, _run: run });
    }
    const unreadJobs = h.runs.filter((r) => r._jobsUnreadable).length;
    if (unreadJobs) h.unreadable.push({ source: `jobs of ${unreadJobs} run(s)`, reason: h.runs.find((r) => r._jobsUnreadable)._jobsUnreadable });

    // 4. billing-refused runs: GitHub fails them before any step, with an annotation saying why
    const suspects = h.jobs.filter(looksRefused);
    const checkedRuns = new Map();
    for (const j of suspects) {
      if (checkedRuns.has(j.run_id)) {
        if (checkedRuns.get(j.run_id)) j._refused = true;
        continue;
      }
      if (gh.remaining <= 0) break;
      const a = gh.get(`/repos/${repo}/check-runs/${j.id}/annotations`);
      if (!a.ok) {
        h.unreadable.push({ source: `annotations of job ${j.id}`, reason: describe(a) });
        checkedRuns.set(j.run_id, false);
        continue;
      }
      const hit = (a.data ?? []).some((x) => REFUSED_RE.test(`${x.message ?? ""} ${x.title ?? ""}`));
      checkedRuns.set(j.run_id, hit);
      if (hit) j._refused = true;
    }
    for (const j of suspects) if (!j._refused && checkedRuns.get(j.run_id)) j._refused = true;
  } catch (e) {
    if (!(e instanceof CallCapError)) throw e;
    h.partial = true;
    h.notes.push(`stopped at the call cap (${gh.maxCalls} calls); the history is partial`);
  }
  return finish(h);
}

/** A job that failed without a runner ever picking it up: the shape of a billing refusal. */
export function looksRefused(j) {
  if (j.conclusion !== "failure" && j.conclusion !== "startup_failure") return false;
  const steps = j.steps ?? [];
  const dur = j.started_at && j.completed_at ? Date.parse(j.completed_at) - Date.parse(j.started_at) : 0;
  return (steps.length === 0 || !j.runner_name) && dur <= 15000;
}

function finish(h) {
  const refusedJobs = h.jobs.filter((j) => j._refused);
  if (refusedJobs.length) {
    const runIds = new Set(refusedJobs.map((j) => j.run_id));
    const dates = refusedJobs.map((j) => Date.parse(j._run?.created_at ?? j.created_at ?? j.started_at)).filter(Number.isFinite).sort((a, b) => a - b);
    const later = h.jobs.filter((j) => !j._refused && !(j.labels ?? []).includes("self-hosted") && Date.parse(j.started_at) > dates[dates.length - 1] && j.conclusion === "success");
    h.refused = {
      jobs: refusedJobs.length,
      runs: runIds.size,
      since: iso(dates[0]),
      latest: iso(dates[dates.length - 1]),
      ongoing: later.length === 0,
    };
    h.notes.push(`hosted runs refused since ${h.refused.since} (${h.refused.runs} run(s) refused for billing: "recent account payments have failed" or a spending limit). Minutes measured in this window understate real demand; refused runs are never counted as cheap.`);
  }
  if (h.partial && h.runs.length) {
    const oldest = Math.min(...h.runs.map((r) => Date.parse(r.created_at)));
    h.effectiveDays = Math.max(1, Math.min(h.days, (h.now - oldest) / DAY));
  }
  if (h.jobs.length) h.source = h.billing ? "billing+jobs" : "jobs";
  else if (h.billing) h.source = "billing";
  if (h.auth === "ok" && !h.jobs.length && !h.unreadable.some((u) => u.source === "workflow runs")) h.notes.push(`no workflow runs in the last ${h.days} days`);
  return h;
}
