// I3: a cheaper hosted runner type would do (larger runners on short jobs). Priced only with the user's prices.
import { result, ev, estimate } from "../lib/rule-kit.mjs";
import { CHEAP_RE } from "../lib/workflows.mjs";

export const id = "I3";
export const area = "infra";
export const title = "A cheaper hosted runner type would do";
const meta = { id, area, title, risk: "low", effort: "low", reversible: true, appliesOn: "hosted",
  fix: "Use the standard runner (or a Linux arm64 runner, cheaper per minute for most workloads) for short jobs; keep larger runners for jobs that actually use the cores. Price the difference with the current price list (--prices)." };

export const SHORT_MINUTES = 5;

export function detect(ctx) {
  const larger = ctx.jobs.filter((j) => j.placement.kind === "hosted" && j.placement.larger);
  const short = larger.filter((j) => {
    const s = ctx.stats.perJob.get(j.key);
    return s && s.median != null ? s.median < SHORT_MINUTES : CHEAP_RE.test(`${j.id} ${j.name}`);
  });
  if (short.length) {
    return result(meta, "found", {
      summary: short.map((j) => `${j.key} runs on ${j.placement.label}${ctx.stats.perJob.get(j.key)?.median != null ? ` for ${ctx.stats.perJob.get(j.key).median.toFixed(1)} min` : ""}`).join("; "),
      evidence: short.map((j) => ev(j.file, j.lineOf("runs-on"))),
      minutes: estimate(ctx, short, 0, 0.5, ["these minutes keep running but bill at a lower per-minute rate; up to half is an upper bound, check the price list"]),
    });
  }
  const arm = ctx.jobs.filter((j) => j.placement.kind === "hosted" && j.placement.os === "linux" && j.placement.arm);
  if (arm.length) return result(meta, "already-done", { summary: `Already on the cheaper Linux arm64 runner: ${arm.map((j) => j.key).join(", ")}.`, evidence: arm.map((j) => ev(j.file, j.lineOf("runs-on"))) });
  return result(meta, "not-found", { summary: larger.length ? "Larger runners are used only by long jobs." : "Only standard hosted runners are used." });
}
export default { id, area, title, detect };
