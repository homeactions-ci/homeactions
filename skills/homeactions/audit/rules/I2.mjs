// I2: jobs that should stay GitHub-hosted (need secrets, Windows, macOS-only tooling, or are tiny), with the reason.
import { result, ev, zero } from "../lib/rule-kit.mjs";
import { INSTALL_RE, runText } from "../lib/workflows.mjs";

export const id = "I2";
export const area = "infra";
export const title = "Jobs that should stay hosted";
const meta = { id, area, title, risk: "low", effort: "low", reversible: true, appliesOn: "hosted",
  fix: "Keep these on GitHub-hosted runners and list them in the profile's workflows.hostedOnlyJobs with the reason, so the placement test allows them." };

const SECRET = /secrets\.(?!GITHUB_TOKEN\b)/;
const MAC_ONLY = /xcodebuild|xcrun|simctl|fastlane|codesign|notarytool|cibuildwheel|delocate/i;

function hardReason(j) {
  if (SECRET.test(j.text)) return "uses repository secrets";
  if (j.def.environment) return "deploys to an environment";
  if (j.placement.os === "windows") return "needs Windows";
  if (j.placement.os === "macos" && MAC_ONLY.test(runText(j))) return "needs macOS tooling the runner host may lack";
  return null;
}

function softReason(j, ctx) {
  const s = ctx.stats.perJob.get(j.key);
  if (s && s.median != null && s.median < 2 && !INSTALL_RE.test(runText(j))) return "tiny (under 2 minutes, nothing to install)";
  return null;
}

export function detect(ctx) {
  const placement = zero("placement advice: keeps these minutes on hosted");
  const placed = ctx.jobs.filter((j) => !j.reusable && j.placement.kind !== "none");
  const hard = placed.map((j) => ({ j, why: hardReason(j) })).filter((x) => x.why);
  const soft = placed.filter((j) => !hardReason(j)).map((j) => ({ j, why: softReason(j, ctx) })).filter((x) => x.why);
  const selfish = ctx.jobs.filter((j) => j.placement.kind === "switch" || j.placement.kind === "self");
  const pinned = ctx.jobs.filter((j) => j.placement.kind === "hosted");
  if (selfish.length && pinned.length && hard.every((x) => x.j.placement.kind === "hosted")) {
    return result(meta, "already-done", { summary: `Self-hosted for ${selfish.length} job(s), while ${pinned.map((j) => j.key).join(", ")} stay pinned to hosted.`, evidence: pinned.map((j) => ev(j.file, j.lineOf("runs-on") ?? j.line)), minutes: placement });
  }
  const stay = selfish.length ? hard.filter((x) => x.j.placement.kind !== "hosted") : [...hard, ...soft];
  if (!stay.length) return result(meta, "not-found", { summary: "No job needs to stay hosted.", minutes: placement });
  return result(meta, "found", {
    summary: stay.map((x) => `${x.j.key}: ${x.why}`).join("; "),
    evidence: stay.map((x) => ev(x.j.file, x.j.line)),
    minutes: placement,
    details: stay.map((x) => `${x.j.file.replace(/^\.github\/workflows\//, "")}#${x.j.id}`),
  });
}
export default { id, area, title, detect };
