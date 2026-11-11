// C6: expensive jobs (e2e, build, tests) start in parallel with cheap checks instead of after them.
import { result, ev, estimate } from "../lib/rule-kit.mjs";
import { CHEAP_RE, E2E_RE, BUILD_RE, runText } from "../lib/workflows.mjs";

export const id = "C6";
export const area = "code";
export const title = "Expensive jobs are not gated on cheap checks";
const meta = { id, area, title, risk: "low", effort: "low", reversible: true, appliesOn: "both",
  fix: "Add `needs: [lint]` (or your cheapest check) to the expensive jobs so a lint or type error fails fast before minutes are spent on builds and e2e." };

const cheap = (j) => CHEAP_RE.test(`${j.id} ${j.name}`) && !E2E_RE.test(`${j.id} ${j.name}`) && !BUILD_RE.test(runText(j));
const expensive = (j, ctx) => !cheap(j) && (E2E_RE.test(`${j.id} ${j.name} ${runText(j)}`) || BUILD_RE.test(runText(j)) || /\btest/i.test(`${j.id} ${j.name}`) || (ctx.stats.perJob.get(j.key)?.median ?? 0) >= 5);

function ancestors(wf, j, seen = new Set()) {
  for (const n of j.needs) {
    if (seen.has(n)) continue;
    seen.add(n);
    const p = wf.jobs.find((x) => x.id === n);
    if (p) ancestors(wf, p, seen);
  }
  return seen;
}

export function detect(ctx) {
  const bad = [];
  const good = [];
  for (const wf of ctx.workflows) {
    const cheaps = wf.jobs.filter((j) => !j.reusable && cheap(j));
    if (!cheaps.length) continue;
    for (const j of wf.jobs.filter((x) => !x.reusable && expensive(x, ctx))) {
      const anc = ancestors(wf, j);
      if (cheaps.some((c) => anc.has(c.id))) good.push(j);
      else bad.push({ j, cheaps });
    }
  }
  if (bad.length) {
    const failRuns = new Set(ctx.history.jobs.filter((x) => x.conclusion === "failure" && !x._refused && bad.some((b) => b.cheaps.some((c) => c.name === x.name || c.id === x.name))).map((x) => x.run_id));
    return result(meta, "found", {
      summary: `${bad.map((b) => b.j.key).join(", ")} start without waiting for ${[...new Set(bad.flatMap((b) => b.cheaps.map((c) => c.id)))].join("/")}.`,
      evidence: [...bad.map((b) => ev(b.j.file, b.j.line)), ...[...failRuns].slice(0, 5).map((r) => ({ run: r }))],
      minutes: estimate(ctx, bad.map((b) => b.j), 0.5, 1, ["minutes of expensive jobs in runs where a cheap check failed are saved; the cost is the cheap job's duration added to the critical path"], (s) => {
        let m = 0;
        for (const r of failRuns) if (s.runs.has(r)) m += s.medianBillablePerExec ?? 0;
        return m * ctx.stats.factor;
      }),
    });
  }
  if (good.length) return result(meta, "already-done", { summary: `${good.map((j) => j.key).join(", ")} wait for the cheap checks (needs:).`, evidence: good.map((j) => ev(j.file, j.lineOf("needs") ?? j.line)) });
  return result(meta, "not-found", { summary: "No workflow pairs a separate cheap check job with expensive jobs." });
}
export default { id, area, title, detect };
