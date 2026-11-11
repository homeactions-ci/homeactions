// Shared helpers for the detectors in ../rules/. A detector returns:
//   { status: "found"|"not-found"|"already-done"|"unknown", evidence: [{file,line}|{run}], minutesPerMonth:
//     { low, high, method, assumptions }, risk, effort, reversible, appliesOn, fix, summary }
// Minutes are billable minutes per month (raw minutes x runner-OS multiplier). Money is never computed here.

export const EFFORT_WEIGHT = Object.freeze({ low: 1, medium: 2, high: 4 });

export function ev(file, line) {
  return { file, line: line ?? 1 };
}

export function result(meta, status, extra = {}) {
  return {
    id: meta.id,
    area: meta.area,
    title: meta.title,
    status,
    evidence: extra.evidence ?? [],
    minutesPerMonth: extra.minutes ?? none("not applicable"),
    risk: extra.risk ?? meta.risk,
    effort: extra.effort ?? meta.effort,
    reversible: extra.reversible ?? meta.reversible,
    appliesOn: extra.appliesOn ?? meta.appliesOn,
    fix: extra.fix ?? meta.fix,
    summary: extra.summary ?? "",
    details: extra.details ?? [],
  };
}

export function none(method, assumptions = []) {
  return { low: null, high: null, method, assumptions };
}

export function zero(method, assumptions = []) {
  return { low: 0, high: 0, method, assumptions };
}

export function methodLabel(ctx) {
  const h = ctx.history;
  const days = Math.round(h.effectiveDays ?? h.days);
  const m = ctx.multipliers;
  return `job durations x runner-OS multiplier (Linux ${m.linux}, Windows ${m.windows}, macOS ${m.macos}) over the last ${days} days, scaled to 30 days`;
}

/**
 * Size a saving from per-job history: sum pick(stat) over jobs, then apply [lowFrac, highFrac].
 * pick defaults to the job's monthly billable demand (measured minutes plus refused runs priced at the job's median).
 * Returns null bounds (never 0) when the only evidence is refused runs or there is no history at all.
 */
export function estimate(ctx, jobs, lowFrac, highFrac, assumptions = [], pick) {
  const a = [...assumptions];
  if (!ctx.hasHistory) return none("structure-only: no run history, so not sized", a);
  let base = 0;
  let unknown = false;
  let refused = false;
  let measured = false;
  for (const j of jobs) {
    const s = ctx.stats.perJob.get(typeof j === "string" ? j : j.key);
    if (!s) continue;
    if (s.refused) refused = true;
    if (s.samples && s.samples.length) measured = true;
    const v = pick ? pick(s) : s.monthlyDemand;
    if (v == null) unknown = true;
    else base += v;
  }
  if (refused || ctx.history.refused) a.push(`hosted runs refused since ${ctx.history.refused?.since ?? "unknown"}: measured minutes understate demand`);
  if (base === 0 && (unknown || (!measured && (refused || ctx.history.refused)))) return none(`hosted runs refused since ${ctx.history.refused?.since ?? "unknown"}; no measurable durations, so not sized (0 here would not mean cheap)`, a);
  return { low: Math.round(base * lowFrac), high: Math.round(base * highFrac), method: methodLabel(ctx), assumptions: a };
}

export function midpoint(m) {
  if (!m || m.low == null || m.high == null) return null;
  return (m.low + m.high) / 2;
}

/** Rank found findings: minutes saved (midpoint) / effort weight, unsized ones last (by effort). */
export function rank(findings) {
  const score = (f) => {
    const mid = midpoint(f.minutesPerMonth);
    return mid == null ? null : mid / (EFFORT_WEIGHT[f.effort] ?? 2);
  };
  return [...findings]
    .map((f) => ({ ...f, score: score(f) }))
    .sort((a, b) => {
      if (a.score == null && b.score == null) return (EFFORT_WEIGHT[a.effort] ?? 2) - (EFFORT_WEIGHT[b.effort] ?? 2) || a.id.localeCompare(b.id, "en", { numeric: true });
      if (a.score == null) return 1;
      if (b.score == null) return -1;
      return b.score - a.score || a.id.localeCompare(b.id, "en", { numeric: true });
    });
}

export function stepJobs(ctx) {
  return ctx.jobs.filter((j) => !j.reusable);
}
