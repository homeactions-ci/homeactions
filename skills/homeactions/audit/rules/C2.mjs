// C2: push and pull_request both fire for the same commit (push not narrowed to the default branch).
import { result, ev, estimate } from "../lib/rule-kit.mjs";
import { hasPrTrigger, pushConfig, triggerLine } from "../lib/workflows.mjs";

export const id = "C2";
export const area = "code";
export const title = "push and pull_request both run for the same commit";
const meta = { id, area, title, risk: "low", effort: "low", reversible: true, appliesOn: "both",
  fix: "Narrow `push:` to `branches: [main]` (and tags if you release from them); PR commits are then tested once, by the pull_request run." };

function narrowed(push, defaultBranch) {
  if (!push || typeof push !== "object") return false;
  if (push.tags && !push.branches) return true;
  const br = [].concat(push.branches ?? []);
  if (!br.length) return false;
  return br.every((b) => typeof b === "string" && ([defaultBranch, "main", "master", "trunk", "develop"].includes(b) || /^(release|hotfix)s?\//.test(b)));
}

export function detect(ctx) {
  const both = ctx.workflows.filter((w) => hasPrTrigger(w) && pushConfig(w) !== null);
  if (!both.length) return result(meta, "not-found", { summary: "No workflow has both push and pull_request triggers." });
  const def = ctx.history.repoMeta?.defaultBranch ?? "main";
  const bad = both.filter((w) => !narrowed(w.triggers.push, def));
  if (!bad.length) return result(meta, "already-done", { summary: `push is narrowed to the default branch in ${both.map((w) => w.file).join(", ")}.`, evidence: both.map((w) => ev(w.file, triggerLine(w, "push"))) });
  const files = new Set(bad.map((w) => w.file));
  const runIds = ctx.history.runs.filter((r) => r.event === "push" && r.head_branch !== def && files.has(String(r.path))).map((r) => r.id);
  const dupRuns = new Set(runIds);
  const minutes = estimate(ctx, bad.flatMap((w) => w.jobs), 0.5, 1, ["push runs on non-default branches duplicate their PR run (when a PR is open)"], (s) => {
    let m = 0;
    for (const r of dupRuns) if (s.runs.has(r)) m += (ctx.stats.runBillable.get(r) ?? 0) / Math.max(1, ctx.workflows.find((x) => x.file === s.file).jobs.length);
    return m * ctx.stats.factor;
  });
  return result(meta, "found", {
    summary: `${bad.map((w) => w.file).join(", ")}: push runs on every branch and pull_request runs again for the same commit.`,
    evidence: [...bad.map((w) => ev(w.file, triggerLine(w, "push"))), ...runIds.slice(0, 5).map((r) => ({ run: r }))],
    minutes,
  });
}
export default { id, area, title, detect };
