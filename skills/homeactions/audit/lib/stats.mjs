// Turn raw run/job history into per-job and per-workflow numbers the rules use.
// Billable minutes follow GitHub's published rules for private repositories: each job is rounded up to the
// whole minute and multiplied by its runner OS (Linux 1, Windows 2, macOS 10). Self-hosted jobs bill 0.
// The multipliers are overridable (--multipliers) because GitHub may change them.

export const DEFAULT_MULTIPLIERS = Object.freeze({ linux: 1, windows: 2, macos: 10 });

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function osOfJob(j) {
  const labels = (j.labels ?? []).map(String);
  if (labels.includes("self-hosted")) return "self";
  const l = labels.join(" ").toLowerCase();
  if (/macos/.test(l)) return "macos";
  if (/windows/.test(l)) return "windows";
  return "linux";
}

const durMin = (a, b) => (a && b ? Math.max(0, (Date.parse(b) - Date.parse(a)) / 60000) : null);

/** Match a history job (by its display name) to a workflow job definition. */
export function matchJob(wf, name) {
  if (!wf) return null;
  const n = String(name ?? "");
  for (const j of wf.jobs) {
    const disp = j.name.replace(/\s*\$\{\{[^}]*\}\}\s*/g, " ").trim();
    if (n === j.name || n === j.id) return j;
    if (disp && (n === disp || n.startsWith(`${disp} (`) || n.startsWith(`${j.id} (`) || (j.name.includes("${{") && n.startsWith(disp.split(" ")[0])))) return j;
    if (j.reusable && n.startsWith(`${j.name} / `)) return j;
  }
  return null;
}

/**
 * buildStats(history, workflows, multipliers) ->
 *   { factor, perJob: Map<key, stat>, perWorkflow: Map<file, wstat>, runBillable: Map<runId, minutes> }
 */
export function buildStats(history, workflows, multipliers = DEFAULT_MULTIPLIERS) {
  const factor = 30 / (history.effectiveDays || history.days || 30);
  const byFile = new Map(workflows.map((w) => [w.file, w]));
  const perJob = new Map();
  const perWorkflow = new Map();
  const runBillable = new Map();
  const mult = (os) => (os === "self" ? 0 : multipliers[os] ?? 1);

  const wstat = (file) => {
    if (!perWorkflow.has(file)) perWorkflow.set(file, { file, runs: 0, byEvent: {}, scheduled: 0, scheduledIdle: 0, superseded: new Set(), billable: 0 });
    return perWorkflow.get(file);
  };
  for (const run of history.runs) {
    const file = String(run.path ?? "").replace(/@.*$/, "");
    const w = wstat(file);
    w.runs++;
    w.byEvent[run.event] = (w.byEvent[run.event] ?? 0) + 1;
  }

  for (const j of history.jobs) {
    const run = j._run ?? {};
    const file = String(run.path ?? "").replace(/@.*$/, "");
    const def = matchJob(byFile.get(file), j.name);
    const key = def ? def.key : `${file}#?${j.name}`;
    if (!perJob.has(key)) {
      perJob.set(key, { key, file, matched: Boolean(def), executions: 0, samples: [], greens: [], refused: 0, reruns: 0, rerunRuns: new Set(), runs: new Set(), billable: 0, raw: 0, byEvent: {}, os: new Set(), hung: [], steps: {} });
    }
    const s = perJob.get(key);
    const os = osOfJob(j);
    s.os.add(os);
    s.executions++;
    s.runs.add(j.run_id);
    if ((j.run_attempt ?? 1) > 1) {
      s.reruns++;
      s.rerunRuns.add(j.run_id);
    }
    if (j._refused) {
      s.refused++;
      continue;
    }
    if (j.status !== "completed" || j.conclusion === "skipped") continue;
    const d = durMin(j.started_at, j.completed_at);
    if (d === null) continue;
    s.samples.push(d);
    if (j.conclusion === "success") s.greens.push(d);
    const bill = os === "self" ? 0 : Math.ceil(d) * mult(os);
    s.billable += bill;
    s.raw += d;
    s.byEvent[run.event] = (s.byEvent[run.event] ?? 0) + bill;
    if ((j.run_attempt ?? 1) > 1) s.rerunBillable = (s.rerunBillable ?? 0) + bill;
    runBillable.set(j.run_id, (runBillable.get(j.run_id) ?? 0) + bill);
    wstat(file).billable += bill;
    for (const st of j.steps ?? []) {
      const sd = durMin(st.started_at, st.completed_at);
      if (sd === null) continue;
      (s.steps[st.name] ??= []).push(sd);
    }
    s._last = { d, conclusion: j.conclusion, os, bill };
    if (d >= 355 || (j.conclusion !== "success" && s.greens.length && d > 3 * Math.max(...s.greens) && d >= 30)) s.hung.push({ id: j.id, run_id: j.run_id, minutes: d, os });
  }

  // derived numbers per job
  for (const s of perJob.values()) {
    s.median = median(s.samples);
    s.medianBillablePerExec = s.samples.length ? s.billable / s.samples.length : null;
    s.maxGreen = s.greens.length ? Math.max(...s.greens) : null;
    s.monthlyBillable = s.billable * factor;
    s.monthlyRaw = s.raw * factor;
    // refused executions still represent demand: price them at this job's own median, or leave unknown
    s.refusedDemand = s.refused ? (s.medianBillablePerExec != null ? s.refused * s.medianBillablePerExec * factor : null) : 0;
    s.monthlyDemand = s.refusedDemand == null ? null : s.monthlyBillable + s.refusedDemand;
    s.monthlyRuns = s.runs.size * factor;
    s.rerunRate = s.runs.size ? s.rerunRuns.size / s.runs.size : 0;
    s.stepMedian = (re) => {
      const xs = Object.entries(s.steps).filter(([n]) => re.test(n)).map(([, v]) => median(v) ?? 0);
      return xs.length ? xs.reduce((a, b) => a + b, 0) : null;
    };
  }

  // superseded PR runs (a newer run on the same branch started before this one finished) and idle schedules
  const runsByWf = new Map();
  for (const run of history.runs) {
    const file = String(run.path ?? "").replace(/@.*$/, "");
    if (!runsByWf.has(file)) runsByWf.set(file, []);
    runsByWf.get(file).push(run);
  }
  for (const [file, runs] of runsByWf) {
    const w = wstat(file);
    const byBranch = new Map();
    for (const r of runs) {
      if (r.event !== "pull_request" && r.event !== "push") continue;
      const k = `${r.event}:${r.head_branch}`;
      if (!byBranch.has(k)) byBranch.set(k, []);
      byBranch.get(k).push(r);
    }
    for (const list of byBranch.values()) {
      list.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      for (let i = 0; i + 1 < list.length; i++) {
        const done = Date.parse(list[i].updated_at ?? list[i].created_at);
        if (Date.parse(list[i + 1].created_at) < done && list[i].conclusion !== "cancelled") w.superseded.add(list[i].id);
      }
    }
    for (const r of runs) {
      if (r.event !== "schedule") continue;
      w.scheduled++;
      const js = history.jobs.filter((j) => j.run_id === r.id);
      if (js.length && js.every((j) => j.conclusion === "skipped" || durMin(j.started_at, j.completed_at) < 1)) w.scheduledIdle++;
    }
  }
  return { factor, perJob, perWorkflow, runBillable };
}
