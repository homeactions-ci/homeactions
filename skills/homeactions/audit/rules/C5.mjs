// C5: the same build runs in several jobs of one workflow instead of once, passed on as an artefact.
import { result, ev, estimate } from "../lib/rule-kit.mjs";
import { BUILD_RE, runText, usesSteps } from "../lib/workflows.mjs";

export const id = "C5";
export const area = "code";
export const title = "The same build runs in several jobs";
const meta = { id, area, title, risk: "medium", effort: "medium", reversible: true, appliesOn: "both",
  fix: "Build once in one job, `actions/upload-artifact` the output (short retention-days), and `actions/download-artifact` it in the jobs that need it." };

export function detect(ctx) {
  const bad = [];
  const good = [];
  for (const wf of ctx.workflows) {
    const builders = wf.jobs.filter((j) => !j.reusable && BUILD_RE.test(runText(j)));
    const downloaders = wf.jobs.filter((j) => usesSteps(j, /download-artifact/).length);
    const uploaders = builders.filter((j) => usesSteps(j, /upload-artifact/).length);
    if (builders.length >= 2) bad.push({ wf, builders });
    else if (builders.length === 1 && uploaders.length && downloaders.length) good.push({ wf, builder: builders[0], downloaders });
  }
  if (bad.length) {
    const extra = bad.flatMap((b) => b.builders.slice(1));
    return result(meta, "found", {
      summary: bad.map((b) => `${b.wf.file}: build runs in ${b.builders.length} jobs (${b.builders.map((j) => j.id).join(", ")})`).join("; "),
      evidence: bad.flatMap((b) => b.builders.map((j) => ev(j.file, j.line))),
      minutes: estimate(ctx, extra, 0.6, 1, ["every build after the first is removed; build time from step timings (else 30% of the job)"], (s) => {
        const build = s.stepMedian(/build/i);
        const share = build != null && s.median ? Math.min(1, build / s.median) : 0.3;
        return s.monthlyDemand == null ? null : s.monthlyDemand * share;
      }),
    });
  }
  if (good.length) return result(meta, "already-done", { summary: good.map((g) => `${g.wf.file}: \`${g.builder.id}\` builds once and ${g.downloaders.map((j) => j.id).join(", ")} download the artefact`).join("; "), evidence: good.map((g) => ev(g.wf.file, g.builder.line)) });
  return result(meta, "not-found", { summary: "No workflow repeats a build across jobs." });
}
export default { id, area, title, detect };
