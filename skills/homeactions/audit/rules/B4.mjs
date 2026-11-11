// B4: macOS or Windows hosted jobs doing OS-neutral work (they bill at a multiple of Linux).
import { result, ev, estimate } from "../lib/rule-kit.mjs";
import { runText } from "../lib/workflows.mjs";

export const id = "B4";
export const area = "budget";
export const title = "macOS or Windows jobs that could run on Linux";
const meta = { id, area, title, risk: "medium", effort: "low", reversible: true, appliesOn: "hosted",
  fix: "Move OS-neutral jobs (lint, unit tests, builds of web code) to ubuntu-latest; keep macOS/Windows for work that needs them (Xcode, signing, native wheels, Windows-only tooling)." };

const OS_SPECIFIC = /xcodebuild|xcrun|simctl|xcode-select|swift (build|test)|pod install|fastlane|codesign|notarytool|cibuildwheel|delocate|productbuild|hdiutil|msbuild|choco |signtool|winget|\.exe\b|vcvars|electron-builder|tauri|maui|wix\b|brew install/i;

export function detect(ctx) {
  const cands = ctx.jobs.filter((j) => j.placement.kind === "hosted" && (j.placement.os === "macos" || j.placement.os === "windows"));
  if (!cands.length) return result(meta, "not-found", { summary: "No single-OS macOS or Windows hosted job (OS matrices are covered by C8)." });
  const text = (j) => `${runText(j)}\n${j.steps.map((s) => s.uses ?? "").join("\n")}`;
  const movable = cands.filter((j) => !OS_SPECIFIC.test(text(j)));
  if (!movable.length) return result(meta, "already-done", { summary: `macOS/Windows used only for OS-specific work: ${cands.map((j) => j.key).join(", ")}.`, evidence: cands.map((j) => ev(j.file, j.lineOf("runs-on"))) });
  return result(meta, "found", {
    summary: movable.map((j) => `${j.key} runs on ${j.placement.label} with no OS-specific step`).join("; "),
    evidence: movable.map((j) => ev(j.file, j.lineOf("runs-on"))),
    minutes: estimate(ctx, movable, 0.8, 1, ["the job's minutes then bill at the Linux multiplier; a Linux runner may be a little slower or faster"], (s) => {
      const os = [...s.os][0];
      const m = ctx.multipliers[os] ?? 1;
      return s.monthlyDemand == null ? null : s.monthlyDemand * (1 - 1 / m);
    }),
  });
}
export default { id, area, title, detect };
