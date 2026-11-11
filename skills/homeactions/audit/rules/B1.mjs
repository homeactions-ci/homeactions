// B1: jobs without timeout-minutes (GitHub's default is 360 minutes; a hung step bills all of it).
import { result, ev, estimate, stepJobs, none } from "../lib/rule-kit.mjs";

export const id = "B1";
export const area = "budget";
export const title = "Jobs without timeout-minutes";
const meta = { id, area, title, risk: "low", effort: "low", reversible: true, appliesOn: "both",
  fix: "Give every job `timeout-minutes`: 2x its longest green run, rounded up to 5, minimum 10 (L18). Keep the budgets in one file and pin them with a test." };

/** The L18 budget rule. */
export function budgetFor(maxGreenMinutes) {
  if (maxGreenMinutes == null) return null;
  return Math.max(10, Math.ceil((2 * maxGreenMinutes) / 5) * 5);
}

export function detect(ctx) {
  const jobs = stepJobs(ctx);
  if (!jobs.length) return result(meta, "not-found", { summary: "No job with steps (reusable-workflow callers cannot set timeout-minutes)." });
  const missing = jobs.filter((j) => j.timeout == null);
  if (!missing.length) return result(meta, "already-done", { summary: `All ${jobs.length} jobs set timeout-minutes.`, evidence: jobs.slice(0, 5).map((j) => ev(j.file, j.lineOf("timeout-minutes"))) });
  const details = missing.map((j) => {
    const s = ctx.stats.perJob.get(j.key);
    const b = budgetFor(s?.maxGreen ?? null);
    return b == null ? `${j.key}: measure first (no green run in the window), then apply the rule` : `${j.key}: timeout-minutes: ${b} (longest green ${Math.round(s.maxGreen)} min)`;
  });
  let minutes;
  if (!ctx.hasHistory) minutes = estimate(ctx, missing, 0, 0);
  else {
    let waste = 0;
    const hungRuns = [];
    for (const j of missing) {
      const s = ctx.stats.perJob.get(j.key);
      if (!s) continue;
      const b = budgetFor(s.maxGreen) ?? 60;
      for (const h of s.hung) {
        waste += Math.max(0, Math.ceil(h.minutes) - b) * (ctx.multipliers[h.os] ?? 1);
        hungRuns.push(h.run_id);
      }
    }
    const measured = missing.some((j) => (ctx.stats.perJob.get(j.key)?.samples.length ?? 0) > 0);
    if (!measured && ctx.history.refused) minutes = none(`hosted runs refused since ${ctx.history.refused.since}; no measurable durations, so not sized (0 here would not mean cheap)`);
    else minutes = { low: Math.round(waste * 0.8 * ctx.stats.factor), high: Math.round(waste * ctx.stats.factor), method: `hung jobs in the history: minutes past the proposed budget (${ctx.history.effectiveDays ?? ctx.history.days} days, scaled to 30)`, assumptions: [hungRuns.length ? `${hungRuns.length} hung job(s) in the window` : "no hung job in the window: this is insurance (a hung job can bill up to 360 minutes)"] };
    details.push(...hungRuns.map((r) => `hung in run ${r}`));
  }
  return result(meta, "found", {
    summary: `${missing.length} of ${jobs.length} jobs have no timeout-minutes.`,
    evidence: [...missing.map((j) => ev(j.file, j.line)), ...missing.flatMap((j) => (ctx.stats.perJob.get(j.key)?.hung ?? []).map((h) => ({ run: h.run_id })))],
    minutes,
    details,
  });
}
export default { id, area, title, detect };
