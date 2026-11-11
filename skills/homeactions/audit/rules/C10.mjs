// C10: full-history checkouts that do not need history, and rerun-heavy (flaky) jobs.
import { result, ev, estimate } from "../lib/rule-kit.mjs";
import { runText } from "../lib/workflows.mjs";

export const id = "C10";
export const area = "code";
export const title = "Full-history checkouts; rerun-heavy flaky jobs";
const meta = { id, area, title, risk: "low", effort: "low", reversible: true, appliesOn: "both",
  fix: "Drop `fetch-depth: 0` where nothing reads history (keep it for changesets/release/affected jobs); list the flaky tests from rerun history and quarantine or fix them." };

const NEEDS_HISTORY = /git (describe|log|rev-list|merge-base|diff)|changeset|semantic-release|release-please|nx affected|--filter=[^\s]*\[|setuptools[_-]scm|gitversion|lerna (version|publish)|commitlint/i;
export const RERUN_RATE = 0.1;

export function detect(ctx) {
  const deep = [];
  const shallow = [];
  for (const j of ctx.jobs) {
    for (const s of j.steps) {
      if (typeof s.uses !== "string" || !/^actions\/checkout@/.test(s.uses)) continue;
      const w = s.with ?? {};
      if (w["fetch-depth"] === 0 && !NEEDS_HISTORY.test(runText(j))) deep.push({ j, s });
      if (w["fetch-depth"] === 1 || w.filter || w["sparse-checkout"]) shallow.push({ j, s });
    }
  }
  const flaky = [];
  if (ctx.hasHistory) {
    for (const j of ctx.jobs) {
      const st = ctx.stats.perJob.get(j.key);
      if (st && st.rerunRuns.size >= 2 && st.rerunRate >= RERUN_RATE) flaky.push({ j, st });
    }
  }
  if (deep.length || flaky.length) {
    const parts = [];
    if (deep.length) parts.push(`fetch-depth: 0 without a history need in ${deep.map((d) => d.j.key).join(", ")}`);
    if (flaky.length) parts.push(flaky.map((f) => `${f.j.key} re-run in ${Math.round(f.st.rerunRate * 100)}% of runs`).join(", "));
    return result(meta, "found", {
      summary: parts.join("; "),
      evidence: [...deep.map((d) => ev(d.j.file, d.s._line)), ...flaky.flatMap((f) => [ev(f.j.file, f.j.line), ...[...f.st.rerunRuns].slice(0, 3).map((r) => ({ run: r }))])],
      minutes: estimate(ctx, [...new Set([...deep.map((d) => d.j), ...flaky.map((f) => f.j)])], 0.5, 1, ["rerun attempts' minutes are saved once flaky tests are fixed", "a full-history clone costs about 0.1-0.5 minutes per checkout"], (s) => {
        const reruns = (s.rerunBillable ?? 0) * ctx.stats.factor;
        const depth = deep.some((d) => d.j.key === s.key) ? 0.3 * s.monthlyRuns : 0;
        return reruns + depth;
      }),
    });
  }
  if (shallow.length) return result(meta, "already-done", { summary: `Explicitly shallow or filtered checkouts in ${[...new Set(shallow.map((x) => x.j.key))].join(", ")}; no rerun-heavy job.`, evidence: shallow.map((x) => ev(x.j.file, x.s._line)) });
  return result(meta, "not-found", { summary: ctx.hasHistory ? "Checkouts use the default (shallow) depth and no job is rerun-heavy." : "Checkouts use the default (shallow) depth (rerun history not read)." });
}
export default { id, area, title, detect };
