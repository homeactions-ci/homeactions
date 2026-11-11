// C7: one long, unsharded test job (needs history to measure; sharding cuts wall time, not billed minutes).
import { result, ev, estimate, none } from "../lib/rule-kit.mjs";
import { E2E_RE, SHARD_KEY_RE, runText } from "../lib/workflows.mjs";

export const id = "C7";
export const area = "code";
export const title = "One long test job; slow tests";
const meta = { id, area, title, risk: "low", effort: "medium", reversible: true, appliesOn: "both",
  fix: "Shard the suite (Playwright/Jest `--shard=i/n`, pytest-split) over a matrix, and publish a slowest-tests report from the job's timings so the slowest tests get fixed first." };

export const LONG_MINUTES = 15;
const isTest = (j) => E2E_RE.test(`${j.id} ${j.name}`) || /\b(test|tests|jest|vitest|pytest|spec)\b/i.test(`${j.id} ${j.name} ${runText(j)}`);
const sharded = (j) => (j.matrix && typeof j.matrix === "object" && Object.keys(j.matrix).some((k) => SHARD_KEY_RE.test(k))) || /--shard|pytest-split|--splits|--split-by/.test(runText(j));

export function detect(ctx) {
  const tests = ctx.jobs.filter((j) => !j.reusable && isTest(j));
  if (!tests.length) return result(meta, "not-found", { summary: "No test job found." });
  const shardedJobs = tests.filter(sharded);
  const unsharded = tests.filter((j) => !sharded(j));
  if (!ctx.hasHistory) {
    if (shardedJobs.length && !unsharded.some((j) => E2E_RE.test(`${j.id} ${j.name}`))) return result(meta, "already-done", { summary: `Sharded: ${shardedJobs.map((j) => j.key).join(", ")}.`, evidence: shardedJobs.map((j) => ev(j.file, j.line)) });
    return result(meta, "unknown", { summary: "Needs run history to tell whether any test job is long.", minutes: none("structure-only: no run history") });
  }
  const long = unsharded.filter((j) => (ctx.stats.perJob.get(j.key)?.median ?? 0) >= LONG_MINUTES);
  if (long.length) {
    return result(meta, "found", {
      summary: long.map((j) => `${j.key} takes ${Math.round(ctx.stats.perJob.get(j.key).median)} min (median), unsharded`).join("; "),
      evidence: long.map((j) => ev(j.file, j.line)),
      minutes: estimate(ctx, long, 0, 0.15, ["sharding cuts wall-clock time, not billed minutes (each shard repeats setup)", "fixing the slowest tests found by the report trims up to 15%"]),
    });
  }
  if (shardedJobs.length) return result(meta, "already-done", { summary: `Sharded: ${shardedJobs.map((j) => j.key).join(", ")}.`, evidence: shardedJobs.map((j) => ev(j.file, j.line)) });
  return result(meta, "not-found", { summary: `No test job has a median of ${LONG_MINUTES} minutes or more.` });
}
export default { id, area, title, detect };
