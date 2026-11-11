// B2: scheduled workflows that fire more often than they have work to do.
import { result, ev, estimate } from "../lib/rule-kit.mjs";
import { lineOf } from "../lib/workflows.mjs";
import { firesPerDay } from "../lib/cron.mjs";

export const id = "B2";
export const area = "budget";
export const title = "Scheduled workflows run more often than they act";
const meta = { id, area, title, risk: "low", effort: "low", reversible: true, appliesOn: "both",
  fix: "Lower the cron frequency (a nightly job once a day), or gate the job on there being something to do (new commits since the last run, a repo variable)." };

export const MAX_PER_DAY = 4;
const GATE = /vars\.|needs\.[\w-]+\.outputs|steps\.[\w-]+\.outputs|github\.event_name\s*!=\s*'schedule'/;

export function detect(ctx) {
  const sched = [];
  for (const wf of ctx.workflows) {
    const s = wf.triggers.schedule;
    if (!Array.isArray(s)) continue;
    const perDay = s.reduce((a, e) => a + (firesPerDay(e && e.cron) ?? 0), 0);
    sched.push({ wf, perDay, line: lineOf(wf.doc.on, "schedule") ?? 1 });
  }
  const frequent = sched.filter((x) => x.perDay > MAX_PER_DAY);
  if (!frequent.length) return result(meta, "not-found", { summary: sched.length ? `Schedules fire at most ${MAX_PER_DAY} times a day.` : "No scheduled workflow." });
  const gated = (x) => x.wf.jobs.length && x.wf.jobs.every((j) => GATE.test(j.if) || j.needs.length);
  const bad = frequent.filter((x) => !gated(x));
  if (!bad.length) return result(meta, "already-done", { summary: frequent.map((x) => `${x.wf.file}: ${x.perDay.toFixed(0)}/day but gated`).join("; "), evidence: frequent.map((x) => ev(x.wf.file, x.line)) });
  return result(meta, "found", {
    summary: bad.map((x) => {
      const w = ctx.stats.perWorkflow.get(x.wf.file);
      const idle = w && w.scheduled ? `, ${w.scheduledIdle}/${w.scheduled} scheduled runs did nothing` : "";
      return `${x.wf.file}: fires ${x.perDay.toFixed(0)} times a day, ungated${idle}`;
    }).join("; "),
    evidence: bad.map((x) => ev(x.wf.file, x.line)),
    minutes: estimate(ctx, bad.flatMap((x) => x.wf.jobs), 0.5, 1, bad.map((x) => `${x.wf.file}: going to once a day removes ${Math.round((1 - 1 / x.perDay) * 100)}% of its scheduled runs`), (s) => {
      const x = bad.find((b) => b.wf.file === s.file);
      return (s.byEvent.schedule ?? 0) * ctx.stats.factor * (1 - 1 / x.perDay);
    }),
  });
}
export default { id, area, title, detect };
