// C9: expensive suites (e2e, browsers, integration) run on every PR and on drafts, with no label gate or draft skip.
import { result, ev, estimate } from "../lib/rule-kit.mjs";
import { hasPrTrigger, E2E_RE, runText, triggerLine } from "../lib/workflows.mjs";

export const id = "C9";
export const area = "code";
export const title = "Expensive suites run on every PR, including drafts";
const meta = { id, area, title, risk: "medium", effort: "low", reversible: true, appliesOn: "both",
  fix: "Gate the expensive suite on a PR label (`if: contains(github.event.pull_request.labels.*.name, 'e2e:full')`) and/or skip drafts (`if: github.event.pull_request.draft == false`); keep it on main/pre-deploy." };

const GATE = /labels\.\*\.name|github\.event\.label|pull_request\.draft|\.draft\s*==\s*false|!github\.event\.pull_request\.draft/;

export function detect(ctx) {
  const prWfs = ctx.workflows.filter(hasPrTrigger);
  const heavy = [];
  for (const wf of prWfs) {
    const wfGate = GATE.test(String(wf.doc.if ?? "")) || (wf.triggers.pull_request && Array.isArray(wf.triggers.pull_request.types) && wf.triggers.pull_request.types.every((t) => t === "labeled"));
    for (const j of wf.jobs) {
      const isHeavy = E2E_RE.test(`${j.id} ${j.name} ${runText(j)}`) || (ctx.stats.perJob.get(j.key)?.median ?? 0) >= 10;
      if (isHeavy) heavy.push({ j, gated: wfGate || GATE.test(j.if), wf });
    }
  }
  if (!heavy.length) return result(meta, "not-found", { summary: "No expensive suite runs on pull requests." });
  const gated = heavy.filter((h) => h.gated);
  if (gated.length) return result(meta, "already-done", { summary: `Label- or draft-gated on PRs: ${gated.map((h) => h.j.key).join(", ")}.`, evidence: gated.map((h) => ev(h.j.file, h.j.lineOf("if") ?? h.j.line)) });
  return result(meta, "found", {
    summary: `${heavy.map((h) => h.j.key).join(", ")} run on every PR event, drafts included.`,
    evidence: heavy.map((h) => ev(h.j.file, h.j.line)).concat(heavy.slice(0, 1).map((h) => ev(h.wf.file, triggerLine(h.wf, "pull_request")))),
    minutes: estimate(ctx, heavy.map((h) => h.j), 0.1, 0.4, ["10-40% of PR runs are drafts or early pushes that do not need the full suite"], (s) => (s.byEvent.pull_request ?? 0) * ctx.stats.factor),
  });
}
export default { id, area, title, detect };
