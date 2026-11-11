// C4: no dependency/browser cache on hosted jobs; or a cache on a self-hosted-capable job that is not gated (L9).
import { result, ev, estimate } from "../lib/rule-kit.mjs";
import { INSTALL_RE, HOSTED_GATE_RE, runText, stepIf } from "../lib/workflows.mjs";

export const id = "C4";
export const area = "code";
export const title = "Dependency caches: missing on hosted, ungated on self-hosted";
const meta = { id, area, title, risk: "low", effort: "low", reversible: true, appliesOn: "both",
  fix: "On hosted jobs add `cache:` to setup-node/setup-python (or actions/cache keyed on the lockfile). On jobs that can run self-hosted, gate every cache step with `if: runner.environment == 'github-hosted'`: the runner keeps a persistent store and cache saves race (L9)." };

const isCacheStep = (s) => typeof s.uses === "string" && (/^actions\/cache(\/|@)/.test(s.uses) || (/setup-(node|python|go|java|dotnet|ruby)|pnpm\/action-setup/.test(s.uses) && s.with && s.with.cache != null && s.with.cache !== false && s.with.cache !== ""));

export function detect(ctx) {
  const installJobs = ctx.jobs.filter((j) => !j.reusable && INSTALL_RE.test(runText(j)));
  if (!installJobs.length) return result(meta, "not-found", { summary: "No job installs dependencies." });
  const uncached = [];
  const ungated = [];
  const good = [];
  for (const j of installJobs) {
    const k = j.placement.kind;
    const caches = j.steps.filter(isCacheStep);
    const canHosted = k === "hosted" || k === "switch" || k === "expr";
    const canSelf = k === "self" || k === "switch";
    const jobGated = HOSTED_GATE_RE.test(j.if);
    if (canHosted && !caches.length) uncached.push(j);
    for (const s of caches) if (canSelf && !HOSTED_GATE_RE.test(stepIf(s)) && !jobGated) ungated.push({ j, s });
    if ((caches.length || !canHosted) && !ungated.some((u) => u.j === j)) good.push(j);
  }
  if (!uncached.length && !ungated.length) {
    const gated = installJobs.some((j) => j.steps.some((s) => isCacheStep(s) && HOSTED_GATE_RE.test(stepIf(s))));
    return result(meta, "already-done", { summary: gated ? "Caches are on for hosted runs and gated off on self-hosted (runner.environment)." : "Every hosted install job uses a cache.", evidence: good.map((j) => ev(j.file, j.line)) });
  }
  const parts = [];
  if (uncached.length) parts.push(`${uncached.length} hosted job(s) install without a cache: ${uncached.map((j) => j.key).join(", ")}`);
  if (ungated.length) parts.push(`${ungated.length} cache step(s) would also run self-hosted: ${ungated.map((u) => u.j.key).join(", ")}`);
  const minutes = estimate(ctx, uncached, 0.3, 0.7, ["a warm cache removes 30-70% of the install step", "install time measured from the job's step timings, else assumed 1.5 minutes"], (s) => {
    const inst = s.stepMedian(/install|dependenc|setup (node|python)|pnpm|npm|pip|yarn/i) ?? 1.5;
    const mult = s.samples.length ? s.billable / Math.max(1, s.samples.reduce((a, d) => a + Math.ceil(d), 0)) : 1;
    return inst * mult * s.monthlyRuns;
  });
  return result(meta, "found", {
    summary: parts.join("; "),
    evidence: [...uncached.map((j) => ev(j.file, j.line)), ...ungated.map((u) => ev(u.j.file, u.s._line))],
    minutes,
    risk: ungated.length ? "medium" : "low",
  });
}
export default { id, area, title, detect };
