// B5: no spending limit / budget alert on Actions. The agent cannot set it: this is an owner checklist item.
import { result, none } from "../lib/rule-kit.mjs";

export const id = "B5";
export const area = "budget";
export const title = "No spending limit or budget alert";
const meta = { id, area, title, risk: "low", effort: "low", reversible: true, appliesOn: "hosted",
  fix: "Owner checklist: in the account's Billing settings, add an Actions budget with alerts at 75/90/100% and decide whether it stops usage at 100%. The agent cannot set this." };

export function detect(ctx) {
  const guard = none("a guard, not a saving");
  const vis = ctx.history.repoMeta?.visibility;
  if (vis === "public") return result(meta, "not-found", { summary: "Public repository: standard GitHub-hosted runners are free for it.", minutes: guard });
  const b = ctx.history.budgets;
  if (b == null) {
    const why = ctx.history.unreadable.find((u) => /budget/.test(u.source));
    return result(meta, "unknown", { summary: `Budgets unreadable${why ? ` (${why.reason})` : " (no gh auth)"}: check Billing settings by hand.`, minutes: guard });
  }
  const actions = b.filter((x) => /actions/i.test(JSON.stringify(x)));
  if (actions.length) return result(meta, "already-done", { summary: `${actions.length} budget(s) cover Actions.`, minutes: guard });
  return result(meta, "found", { summary: "No budget or spending alert covers Actions.", minutes: guard });
}
export default { id, area, title, detect };
