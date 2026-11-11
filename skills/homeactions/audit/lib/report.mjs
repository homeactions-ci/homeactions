// Report rendering: markdown (default), JSON, and the monthly minutes ledger.
// Money appears only when prices were supplied (or read from the billing report) and always with source and date.
import { midpoint } from "./rule-kit.mjs";

export const SECTIONS = [
  ["code", "Code optimisations"],
  ["budget", "Budget controls"],
  ["infra", "Infrastructure adjustments"],
];

const fmtRange = (m) => (m.low == null ? "not sized" : m.low === m.high ? `${m.low}` : `${m.low}-${m.high}`);

export function money(minutes, prices) {
  if (!prices || minutes == null || minutes.low == null) return null;
  const r = prices.perMinuteLinux;
  const f = (x) => (x * r).toFixed(2);
  const unit = prices.currency ? ` ${prices.currency}` : "";
  return `about ${f(minutes.low)}-${f(minutes.high)}${unit} a month at ${r} per Linux-equivalent minute (${prices.source}, ${prices.date})`;
}

function evidenceText(evs) {
  if (!evs.length) return "none recorded";
  return evs
    .slice(0, 8)
    .map((e) => (e.run != null ? `run ${e.run}` : `${e.file}:${e.line}`))
    .join(", ") + (evs.length > 8 ? `, +${evs.length - 8} more` : "");
}

export function renderMarkdown(r) {
  const out = [];
  out.push(`# GitHub Actions cost audit: ${r.repo}`, "");
  out.push(`Data used: **${r.dataSource.label}**. Read-only: ${r.calls.used} \`gh api\` GET call(s) of a ${r.calls.cap} cap.`, "");
  out.push("Findings are ranked by minutes saved (midpoint) divided by effort (low 1, medium 2, high 4). Minutes are billable minutes per month: raw job minutes x the runner-OS multiplier.");
  if (r.prices) out.push(`Money uses ${r.prices.source} (${r.prices.date}).`);
  else out.push("No prices were given, so no money figures: pass `--prices <file>` or `--price-per-min-linux <n> --price-source <text> --price-date <YYYY-MM-DD>` with current published prices.");
  out.push("");
  for (const [area, heading] of SECTIONS) {
    out.push(`## ${heading}`, "");
    const items = r.findings.filter((f) => f.area === area);
    const unknown = r.unknown.filter((f) => f.area === area);
    if (!items.length && !unknown.length) out.push("Nothing to change here.", "");
    for (const f of items) {
      out.push(`### #${f.rank} ${f.id}: ${f.title}`, "");
      out.push(`${f.summary}`, "");
      out.push(f.minutesPerMonth.low == null ? `- Saves: not sized (${f.minutesPerMonth.method})` : `- Saves: ${fmtRange(f.minutesPerMonth)} billable minutes a month (${f.minutesPerMonth.method})`);
      const m = money(f.minutesPerMonth, r.prices);
      if (m) out.push(`- Money: ${m}`);
      if (f.minutesPerMonth.assumptions?.length) out.push(`- Assumptions: ${f.minutesPerMonth.assumptions.join("; ")}`);
      out.push(`- Evidence: ${evidenceText(f.evidence)}`);
      out.push(`- Risk ${f.risk}, effort ${f.effort}, ${f.reversible ? "reversible" : "not easily reversible"}, applies on ${f.appliesOn}`);
      out.push(`- Fix: ${f.fix}`);
      for (const d of f.details ?? []) out.push(`  - ${d}`);
      out.push("");
    }
    for (const f of unknown) out.push(`- Could not check ${f.id} (${f.title}): ${f.summary}`);
    if (unknown.length) out.push("");
  }
  out.push("## Already doing well", "");
  if (!r.alreadyDone.length) out.push("Nothing detected yet.");
  for (const f of r.alreadyDone) out.push(`- ${f.id} ${f.title}: ${f.summary}`);
  out.push("");
  out.push("## Data used", "");
  for (const l of r.dataSource.lines) out.push(`- ${l}`);
  if (r.notFound.length) out.push(`- Checked, nothing found: ${r.notFound.map((f) => f.id).join(", ")}`);
  out.push("");
  return out.join("\n");
}

export function renderJson(r) {
  return JSON.stringify(r, null, 2) + "\n";
}

/** Monthly minutes ledger: one row per workflow job, from history. */
export function renderLedger(r, stats, history) {
  const out = [`# Actions minutes ledger: ${r.repo}`, "", `Period: last ${Math.round(history.effectiveDays ?? history.days)} days to ${new Date(history.now).toISOString().slice(0, 10)}, scaled to 30 days. Source: ${r.dataSource.label}.`, ""];
  if (!stats || !stats.perJob.size) {
    out.push("No job history was readable, so there is nothing to tally.", "");
    return out.join("\n");
  }
  out.push("| Job | OS | Runs | Raw min / month | Billable min / month | Refused |", "|---|---|---:|---:|---:|---:|");
  const rows = [...stats.perJob.values()].sort((a, b) => b.monthlyBillable - a.monthlyBillable);
  let tot = 0;
  for (const s of rows) {
    tot += s.monthlyBillable;
    out.push(`| ${s.key} | ${[...s.os].join("/")} | ${s.runs.size} | ${Math.round(s.monthlyRaw)} | ${Math.round(s.monthlyBillable)} | ${s.refused} |`);
  }
  out.push(`| **Total** | | | | **${Math.round(tot)}** | |`, "");
  if (history.billing) out.push(`Billing usage report for the same months: ${Math.round(history.billing.totalMinutes)} minutes (${Object.entries(history.billing.minutesBySku).map(([k, v]) => `${k} ${Math.round(v)}`).join(", ")}).`, "");
  if (history.refused) out.push(`Hosted runs refused since ${history.refused.since}: ${history.refused.runs} run(s).`, "");
  return out.join("\n");
}

export { midpoint };
