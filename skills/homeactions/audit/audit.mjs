#!/usr/bin/env node
// homeactions audit: a read-only GitHub Actions cost audit (PRD D16, HMA-022..026).
//
//   node audit.mjs --repo <owner/name> [--root <checkout>] [--days 30] [--max-calls 300] [--json | --ledger]
//                  [--prices <file> | --price-per-min-linux <n> --price-source <text> --price-date <YYYY-MM-DD> [--currency <code>]]
//                  [--multipliers linux=1,windows=2,macos=10] [--no-history]
//
// Reads <root>/.github/workflows/*.yml and, through `gh api` GET calls only (capped), the run/job history.
// Data sources, best first, each labelled in the report: the billing usage report; job durations x runner-OS
// multiplier; workflow structure only. Writes nothing anywhere: the report goes to stdout.
// --prices file: { "source": "...", "date": "YYYY-MM-DD", "perMinuteLinux": <number>, "currency": "<code>" }.
// Exit: 0 report printed, 2 usage error. Zero dependencies; Node >= 18.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadWorkflows, repoShape } from "./lib/workflows.mjs";
import { makeGh } from "./lib/gh.mjs";
import { collectHistory } from "./lib/history.mjs";
import { buildStats, DEFAULT_MULTIPLIERS } from "./lib/stats.mjs";
import { rank } from "./lib/rule-kit.mjs";
import { renderMarkdown, renderJson, renderLedger } from "./lib/report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Load every detector in rules/ (C1..C10, B1..B6, I1..I3), in catalogue order. */
export async function loadRules(dir = path.join(HERE, "rules")) {
  const files = readdirSync(dir).filter((f) => /^[CBI]\d+\.mjs$/.test(f));
  const order = { C: 0, B: 1, I: 2 };
  files.sort((a, b) => order[a[0]] - order[b[0]] || parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
  const rules = [];
  for (const f of files) rules.push((await import(pathToFileURL(path.join(dir, f)).href)).default);
  return rules;
}

function dataSource(history, gh, multipliers) {
  const why = (src) => history.unreadable.find((u) => u.source === src)?.reason;
  let label;
  if (history.source === "billing+jobs") label = "billing usage report + job durations x runner-OS multiplier";
  else if (history.source === "jobs") label = `job durations x runner-OS multiplier (billing usage report ${why("billing usage report") ? `unreadable: ${why("billing usage report")}` : "not used"})`;
  else if (history.source === "billing") label = "billing usage report only (job history unreadable)";
  else label = `workflow structure only (${history.auth === "none" ? "no gh auth" : why("workflow runs") ? `run history unreadable: ${why("workflow runs")}` : why("repository metadata") ? `repository unreadable: ${why("repository metadata")}` : "no run history"})`;
  if (history.refused) label += `; hosted runs refused since ${history.refused.since}`;
  const lines = [`Source: ${label}`];
  lines.push(`Period: ${history.days} days requested${history.partial ? `, ${Math.round(history.effectiveDays)} days read before the call cap (partial)` : ""}; ${history.runs.length} run(s), ${history.jobs.length} job execution(s) read`);
  lines.push(`Runner-OS multipliers: Linux ${multipliers.linux}, Windows ${multipliers.windows}, macOS ${multipliers.macos} (GitHub's published multipliers for private repositories; override with --multipliers)`);
  if (history.billing) lines.push(`Billing usage report: ${Math.round(history.billing.totalMinutes)} Actions minutes in the months read (${Object.entries(history.billing.minutesBySku).map(([k, v]) => `${k} ${Math.round(v)}`).join(", ") || "no minute items"})`);
  if (history.repoMeta) lines.push(`Repository visibility: ${history.repoMeta.visibility}; default branch ${history.repoMeta.defaultBranch}${history.repoMeta.visibility === "public" ? " (standard GitHub-hosted runners are free for public repositories: the minutes above are compute, not billed minutes)" : ""}`);
  for (const n of history.notes) lines.push(n);
  for (const u of history.unreadable) lines.push(`Unreadable: ${u.source} (${u.reason})`);
  lines.push(`API calls: ${gh.calls} GET of a ${gh.maxCalls} cap; no other method is ever sent`);
  return { label, source: history.source, refused: history.refused, partial: history.partial, unreadable: history.unreadable, lines };
}

/**
 * runAudit(options) -> report. Options: repo, root, days, maxCalls, exec (injectable gh executor), now,
 * multipliers, prices, noHistory, rules.
 */
export async function runAudit(opts) {
  const { repo, root = process.cwd(), days = 30, maxCalls = 300, exec, now = Date.now(), noHistory = false } = opts;
  const multipliers = { ...DEFAULT_MULTIPLIERS, ...(opts.multipliers ?? {}) };
  const { workflows, unreadable: wfUnreadable, dirMissing } = loadWorkflows(root);
  const shape = repoShape(root);
  const gh = makeGh({ exec, maxCalls });
  const history = noHistory
    ? { source: "structure", auth: "skipped", repoMeta: null, runs: [], jobs: [], refused: null, unreadable: [], notes: ["history skipped (--no-history): structure-only audit"], partial: false, days, effectiveDays: days, now, budgets: null, billing: null }
    : collectHistory(gh, { repo, days, now });
  if (dirMissing) history.notes.push("no .github/workflows directory in the checkout");
  for (const u of wfUnreadable) history.unreadable.push({ source: u.file, reason: `unreadable workflow: ${u.error}` });
  const stats = buildStats(history, workflows, multipliers);
  const ctx = {
    repo,
    root,
    workflows,
    jobs: workflows.flatMap((w) => w.jobs),
    shape,
    history,
    stats,
    multipliers,
    hasHistory: history.jobs.length > 0,
  };
  const rules = opts.rules ?? (await loadRules());
  const results = rules.map((r) => {
    try {
      return r.detect(ctx);
    } catch (e) {
      return { id: r.id, area: r.area, title: r.title, status: "unknown", summary: `detector error: ${e.message}`, evidence: [], minutesPerMonth: { low: null, high: null, method: "detector error", assumptions: [] } };
    }
  });
  let prices = opts.prices ?? null;
  if (!prices && history.billing?.linuxPricePerMinute) prices = { perMinuteLinux: history.billing.linuxPricePerMinute, source: "your billing usage report (pricePerUnit of the Linux minute SKU)", date: history.billing.fetchedAt, currency: "" };
  const found = rank(results.filter((f) => f.status === "found")).map((f, i) => ({ ...f, rank: i + 1 }));
  const report = {
    repo,
    generatedAt: new Date(now).toISOString(),
    dataSource: dataSource(history, gh, multipliers),
    calls: { used: gh.calls, cap: gh.maxCalls },
    prices,
    findings: found,
    unknown: results.filter((f) => f.status === "unknown"),
    alreadyDone: results.filter((f) => f.status === "already-done"),
    notFound: results.filter((f) => f.status === "not-found"),
    results,
  };
  Object.defineProperty(report, "_ctx", { value: ctx, enumerable: false });
  return report;
}

export function parseArgs(argv) {
  const o = { days: 30, maxCalls: 300, format: "markdown" };
  const need = (i) => {
    if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`);
    return argv[i + 1];
  };
  const price = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") o.repo = need(i++);
    else if (a === "--root") o.root = need(i++);
    else if (a === "--days") o.days = Number(need(i++));
    else if (a === "--max-calls") o.maxCalls = Number(need(i++));
    else if (a === "--json") o.format = "json";
    else if (a === "--ledger") o.format = "ledger";
    else if (a === "--no-history") o.noHistory = true;
    else if (a === "--prices") o.pricesFile = need(i++);
    else if (a === "--price-per-min-linux") price.perMinuteLinux = Number(need(i++));
    else if (a === "--price-source") price.source = need(i++);
    else if (a === "--price-date") price.date = need(i++);
    else if (a === "--currency") price.currency = need(i++);
    else if (a === "--multipliers") {
      o.multipliers = {};
      for (const kv of need(i++).split(",")) {
        const [k, v] = kv.split("=");
        if (!["linux", "windows", "macos"].includes(k) || !(Number(v) >= 0)) throw new Error(`bad --multipliers entry "${kv}"`);
        o.multipliers[k] = Number(v);
      }
    } else if (a === "-h" || a === "--help") o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.pricesFile) Object.assign(price, JSON.parse(readFileSync(o.pricesFile, "utf8")));
  if (Object.keys(price).length) {
    if (!(price.perMinuteLinux > 0)) throw new Error("prices need a positive perMinuteLinux (--price-per-min-linux)");
    if (!price.source || !/^\d{4}-\d{2}-\d{2}$/.test(String(price.date ?? ""))) throw new Error("prices need a source (--price-source) and a date (--price-date YYYY-MM-DD): money is never shown without them");
    o.prices = { perMinuteLinux: price.perMinuteLinux, source: String(price.source), date: String(price.date), currency: price.currency ? String(price.currency) : "" };
  }
  if (!o.help && !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(o.repo ?? "")) throw new Error("--repo <owner/name> is required");
  if (!(o.days > 0) || !(o.maxCalls > 0)) throw new Error("--days and --max-calls must be positive");
  return o;
}

async function main(argv) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    console.error(`audit: ${e.message}`);
    return 2;
  }
  if (o.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 13).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    return 0;
  }
  const report = await runAudit({ ...o, root: path.resolve(o.root ?? process.cwd()) });
  if (o.format === "json") process.stdout.write(renderJson(report));
  else if (o.format === "ledger") process.stdout.write(renderLedger(report, report._ctx.stats, report._ctx.history));
  else process.stdout.write(renderMarkdown(report));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => (process.exitCode = c));
}
