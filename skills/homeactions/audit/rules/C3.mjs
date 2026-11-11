// C3: every job runs on docs-only or unrelated changes; no paths filter, changes job or affected-only build.
import { result, ev, estimate } from "../lib/rule-kit.mjs";
import { hasPrTrigger, pushConfig, triggerLine, runText } from "../lib/workflows.mjs";

export const id = "C3";
export const area = "code";
export const title = "Every job runs on docs-only or unrelated changes";
const meta = { id, area, title, risk: "medium", effort: "medium", reversible: true, appliesOn: "both",
  fix: "Add `paths-ignore` for docs, or a cheap `changes` job (e.g. dorny/paths-filter) whose outputs gate the expensive jobs; in a monorepo build only affected packages (turbo `--filter=...[origin/main]`, `nx affected`)." };

const AFFECTED = /--filter=[^\s]*\[|--affected|nx affected|git diff --name-only|changed-files/;

function hasPathFilter(wf) {
  for (const ev of ["push", "pull_request", "pull_request_target"]) {
    const c = wf.triggers[ev];
    if (c && typeof c === "object" && (c.paths || c["paths-ignore"])) return true;
  }
  return false;
}

function changesJob(wf) {
  return wf.jobs.find((j) => {
    const filterStep = j.steps.some((s) => typeof s.uses === "string" && /paths-filter|changed-files/.test(s.uses));
    const named = /^(changes|detect-changes|changed|affected|filter|paths)$/i.test(j.id) && j.def.outputs;
    if (!filterStep && !named) return false;
    return wf.jobs.some((o) => o !== j && new RegExp(`needs\\.${j.id}\\.outputs`).test(o.text));
  });
}

export function detect(ctx) {
  const cands = ctx.workflows.filter((w) => {
    const p = pushConfig(w);
    const pushBranches = p !== null && !(p && p.tags && !p.branches);
    return hasPrTrigger(w) || pushBranches;
  });
  if (!cands.length) return result(meta, "not-found", { summary: "No workflow runs on branch pushes or pull requests." });
  const good = [];
  const bad = [];
  for (const wf of cands) {
    const cj = changesJob(wf);
    if (hasPathFilter(wf)) good.push({ wf, how: "paths filter", line: triggerLine(wf, hasPrTrigger(wf) ? "pull_request" : "push") });
    else if (cj) good.push({ wf, how: `\`${cj.id}\` job gates the rest`, line: cj.line });
    else if (wf.jobs.some((j) => AFFECTED.test(runText(j)))) good.push({ wf, how: "affected-only build", line: wf.jobs.find((j) => AFFECTED.test(runText(j))).line });
    else bad.push(wf);
  }
  if (!bad.length) return result(meta, "already-done", { summary: good.map((g) => `${g.wf.file}: ${g.how}`).join("; "), evidence: good.map((g) => ev(g.wf.file, g.line)) });
  const mono = ctx.shape.monorepo;
  const [lo, hi] = mono ? [0.1, 0.35] : [0.05, 0.2];
  return result(meta, "found", {
    summary: `${bad.map((w) => w.file).join(", ")}: no paths filter, changes job or affected-only build${mono ? " in a monorepo" : ""}.` + (good.length ? ` Already scoped: ${good.map((g) => `${g.wf.file} (${g.how})`).join("; ")}.` : ""),
    evidence: bad.map((w) => ev(w.file, triggerLine(w, hasPrTrigger(w) ? "pull_request" : "push"))),
    minutes: estimate(ctx, bad.flatMap((w) => w.jobs), lo, hi, [`${Math.round(lo * 100)}-${Math.round(hi * 100)}% of pushes/PRs touch only docs${mono ? " or one app" : ""} (typical; check with git log)`]),
  });
}
export default { id, area, title, detect };
