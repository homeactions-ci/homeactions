// C1: superseded PR runs are not cancelled (no concurrency cancel-in-progress), or cancel-in-progress also hits main.
import { result, ev, estimate } from "../lib/rule-kit.mjs";
import { hasPrTrigger, pushConfig, lineOf, triggerLine } from "../lib/workflows.mjs";

export const id = "C1";
export const area = "code";
export const title = "Superseded PR runs are not cancelled";
const meta = { id, area, title, risk: "low", effort: "low", reversible: true, appliesOn: "both",
  fix: "Add a workflow-level `concurrency:` with `group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}` and `cancel-in-progress: ${{ github.event_name == 'pull_request' }}` so new pushes cancel older PR runs but never a run on main." };

const PR_ONLY_CANCEL = /pull_request|event_name|head_ref/;

export function detect(ctx) {
  const prWfs = ctx.workflows.filter(hasPrTrigger);
  if (!prWfs.length) return result(meta, "not-found", { summary: "No workflow runs on pull_request." });
  const bad = [];
  const good = [];
  for (const wf of prWfs) {
    const c = wf.doc.concurrency;
    const cancel = c && typeof c === "object" ? c["cancel-in-progress"] : undefined;
    const group = c && typeof c === "object" ? String(c.group ?? "") : String(c ?? "");
    const push = pushConfig(wf);
    if (cancel === true && push && !/run_id|run_number/.test(group)) {
      bad.push({ wf, why: "cancel-in-progress is always true, so a newer push to main cancels an in-flight main run", line: lineOf(c, "cancel-in-progress") });
    } else if (cancel === true || (typeof cancel === "string" && PR_ONLY_CANCEL.test(cancel))) good.push(wf);
    else bad.push({ wf, why: c ? "concurrency has no cancel-in-progress" : "no concurrency group", line: c ? lineOf(wf.doc, "concurrency") : triggerLine(wf, "pull_request") });
  }
  if (!bad.length) return result(meta, "already-done", { summary: `Cancel-in-progress on PRs only in ${good.map((w) => w.file).join(", ")}.`, evidence: good.map((w) => ev(w.file, lineOf(w.doc, "concurrency"))) });
  const jobs = bad.flatMap((b) => b.wf.jobs);
  const files = new Set(bad.map((b) => b.wf.file));
  const minutes = estimate(ctx, jobs, 0.3, 0.9, ["superseded runs would be cancelled part-way (30-90% of their minutes saved)"], (s) => {
    const w = ctx.stats.perWorkflow.get(s.file);
    if (!w || !files.has(s.file)) return 0;
    return [...w.superseded].reduce((a, r) => a + (ctx.stats.runBillable.get(r) ?? 0), 0) * ctx.stats.factor / Math.max(1, ctx.workflows.find((x) => x.file === s.file).jobs.length);
  });
  return result(meta, "found", {
    summary: bad.map((b) => `${b.wf.file}: ${b.why}`).join("; "),
    evidence: [...bad.map((b) => ev(b.wf.file, b.line)), ...[...files].flatMap((f) => [...(ctx.stats.perWorkflow.get(f)?.superseded ?? [])].slice(0, 5).map((r) => ({ run: r })))],
    minutes,
  });
}
export default { id, area, title, detect };
