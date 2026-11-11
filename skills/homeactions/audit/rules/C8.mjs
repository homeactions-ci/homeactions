// C8: the full OS / version matrix runs on every PR instead of on main and nightly only.
import { result, ev, estimate } from "../lib/rule-kit.mjs";
import { hasPrTrigger, matrixSize, SHARD_KEY_RE } from "../lib/workflows.mjs";

export const id = "C8";
export const area = "code";
export const title = "The full OS or version matrix runs on every PR";
const meta = { id, area, title, risk: "medium", effort: "low", reversible: true, appliesOn: "both",
  fix: "On PRs run one representative combination; run the full matrix on main and nightly, e.g. `os: ${{ fromJSON(github.event_name == 'pull_request' && '[\"ubuntu-latest\"]' || '[\"ubuntu-latest\",\"macos-latest\",\"windows-latest\"]') }}`." };

const EVENT_AWARE = /event_name|pull_request|github\.ref/;

export function detect(ctx) {
  const bad = [];
  const good = [];
  for (const wf of ctx.workflows.filter(hasPrTrigger)) {
    for (const j of wf.jobs) {
      const m = j.matrix;
      if (!m) continue;
      if (typeof m === "string") {
        if (EVENT_AWARE.test(m)) good.push(j);
        continue;
      }
      const dims = Object.keys(m).filter((k) => k !== "include" && k !== "exclude");
      if (dims.length && dims.every((k) => SHARD_KEY_RE.test(k))) continue; // shards are not a version matrix
      const reduced = dims.some((k) => typeof m[k] === "string" && EVENT_AWARE.test(m[k])) || /github\.event_name\s*!=\s*'pull_request'/.test(j.if);
      if (reduced) {
        good.push(j);
        continue;
      }
      const n = matrixSize(m);
      if (n >= 4) bad.push({ j, n });
    }
  }
  if (bad.length) {
    return result(meta, "found", {
      summary: bad.map((b) => `${b.j.key}: ${b.n} combinations on every PR`).join("; "),
      evidence: bad.map((b) => ev(b.j.file, b.j.lineOf("strategy") ?? b.j.line)),
      minutes: estimate(ctx, bad.map((b) => b.j), 0.5, 0.85, ["PR runs keep 1-2 representative combinations; main and nightly keep the full matrix"], (s) => (s.byEvent.pull_request ?? 0) * ctx.stats.factor),
    });
  }
  if (good.length) return result(meta, "already-done", { summary: `The matrix is reduced on PRs: ${good.map((j) => j.key).join(", ")}.`, evidence: good.map((j) => ev(j.file, j.lineOf("strategy") ?? j.line)) });
  return result(meta, "not-found", { summary: "No PR workflow runs a matrix of 4 or more combinations." });
}
export default { id, area, title, detect };
