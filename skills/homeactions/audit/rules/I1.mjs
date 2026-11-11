// I1: heavy GitHub-hosted jobs that suit a self-hosted runner (Linux/macOS, no secrets, no Windows).
import { result, ev, estimate } from "../lib/rule-kit.mjs";
import { E2E_RE, BUILD_RE, runText } from "../lib/workflows.mjs";

export const id = "I1";
export const area = "infra";
export const title = "Heavy hosted jobs that suit a self-hosted runner";
const meta = { id, area, title, risk: "medium", effort: "high", reversible: true, appliesOn: "self-hosted",
  fix: "Put these jobs in the runner plan: they switch to the self-hosted runner through the generated runs-on expression (repo variable + PR labels), with hosted as the fallback." };

export const HEAVY_MONTHLY = 200;
export const HEAVY_MEDIAN = 10;
const SECRET = /secrets\.(?!GITHUB_TOKEN\b)/;

export function suitable(j) {
  return !j.reusable && j.placement.kind !== "none" && !(j.placement.os === "windows") && !SECRET.test(j.text);
}

export function detect(ctx) {
  const selfish = ctx.jobs.filter((j) => j.placement.kind === "switch" || j.placement.kind === "self");
  // once a repo already switches jobs to self-hosted, jobs it pins to a hosted label are deliberate (see I2)
  const hosted = selfish.length ? [] : ctx.jobs.filter((j) => (j.placement.kind === "hosted" || (j.placement.kind === "expr" && j.placement.matrix)) && suitable(j));
  let heavy;
  if (ctx.hasHistory) {
    heavy = hosted.filter((j) => {
      const s = ctx.stats.perJob.get(j.key);
      return s && ((s.monthlyDemand ?? 0) >= HEAVY_MONTHLY || (s.median ?? 0) >= HEAVY_MEDIAN);
    });
  } else heavy = hosted.filter((j) => E2E_RE.test(`${j.id} ${j.name}`) || BUILD_RE.test(runText(j)));
  if (heavy.length) {
    return result(meta, "found", {
      summary: `${heavy.length} hosted job(s) could move: ${heavy.map((j) => j.key).join(", ")}.${selfish.length ? ` (${selfish.length} job(s) already switch to self-hosted.)` : ""}`,
      evidence: heavy.map((j) => ev(j.file, j.lineOf("runs-on") ?? j.line)),
      minutes: estimate(ctx, heavy, 0.6, 1, ["self-hosted minutes are not billed; the low end keeps some runs on hosted (fallback, PR label)", "jobs with services/containers move once the kit replaces them with per-job service scripts"]),
    });
  }
  if (selfish.length) return result(meta, "already-done", { summary: `${selfish.length} job(s) already run on (or switch to) a self-hosted runner.`, evidence: selfish.map((j) => ev(j.file, j.lineOf("runs-on") ?? j.line)) });
  return result(meta, "not-found", { summary: ctx.hasHistory ? `No hosted job uses ${HEAVY_MONTHLY}+ billable minutes a month or runs ${HEAVY_MEDIAN}+ minutes.` : "No heavy hosted job found in the workflow structure." });
}
export default { id, area, title, detect };
