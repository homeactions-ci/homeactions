// B6: no visibility into minutes: nobody sees the monthly spend until the bill or the refusal.
import { result, ev, none } from "../lib/rule-kit.mjs";

export const id = "B6";
export const area = "budget";
export const title = "No visibility into minutes used";
const meta = { id, area, title, risk: "low", effort: "low", reversible: true, appliesOn: "hosted",
  fix: "Generate a monthly minutes ledger (`node audit.mjs --repo <owner/name> --ledger > .homeactions/ledger.md`) and review it with the budget." };

const LEDGER_RE = /audit\.mjs[^\n]*--ledger|settings\/billing\/usage/;

export function detect(ctx) {
  const guard = none("visibility, not a saving");
  if (ctx.history.repoMeta?.visibility === "public") return result(meta, "not-found", { summary: "Public repository: standard hosted minutes are free.", minutes: guard });
  const hosted = ctx.jobs.some((j) => ["hosted", "switch", "expr"].includes(j.placement.kind));
  if (!hosted) return result(meta, "not-found", { summary: "No GitHub-hosted job.", minutes: guard });
  const wf = ctx.workflows.find((w) => LEDGER_RE.test(w.text));
  if (ctx.shape.ledger || wf) return result(meta, "already-done", { summary: wf ? `${wf.file} produces a minutes ledger.` : "A minutes ledger is kept in .homeactions/.", evidence: wf ? [ev(wf.file, 1)] : [], minutes: guard });
  return result(meta, "found", { summary: "No minutes ledger or usage report is generated.", minutes: guard });
}
export default { id, area, title, detect };
