// The audit (HMA-022..026): read-only gh wrapper, every detector against its fixtures, ranking, report shape,
// no hard-coded money, and degraded data (no auth, refused runs, unreadable sources).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runAudit, loadRules, parseArgs } from "../../skills/homeactions/audit/audit.mjs";
import { makeGh, RefusedMethodError, CallCapError } from "../../skills/homeactions/audit/lib/gh.mjs";
import { rank, estimate } from "../../skills/homeactions/audit/lib/rule-kit.mjs";
import { renderMarkdown, renderJson, renderLedger, SECTIONS } from "../../skills/homeactions/audit/lib/report.mjs";
import { firesPerDay } from "../../skills/homeactions/audit/lib/cron.mjs";
import { budgetFor } from "../../skills/homeactions/audit/rules/B1.mjs";
import { AUDIT, FIXTURE_REPOS, fixtureRoot, loadRecording, loadExpected, slugOf, fakeExec, noAuthExec } from "./helpers.mjs";

const CATALOGUE = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "B1", "B2", "B3", "B4", "B5", "B6", "I1", "I2", "I3"];

async function audit(name, { file = "gh.json", mutate, ...rest } = {}) {
  const rec = loadRecording(name, file);
  if (mutate) mutate(rec);
  const exec = rest.exec ?? fakeExec(rec);
  return runAudit({ repo: slugOf(name), root: fixtureRoot(name), exec, now: Date.parse(rec.now), ...rest });
}

const results = {};
const ready = (async () => {
  for (const name of FIXTURE_REPOS) results[name] = await audit(name);
})();

// ---------------------------------------------------------------- the read-only door

test("the gh wrapper refuses every method but GET, before executing anything", () => {
  const calls = [];
  const gh = makeGh({ exec: (a) => (calls.push(a), { status: 0, stdout: "{}", stderr: "" }) });
  for (const m of ["POST", "PATCH", "PUT", "DELETE", "post", "", undefined]) assert.throws(() => gh.request(m, "/repos/a/b"), RefusedMethodError);
  assert.throws(() => gh.request("GET", "repos/a/b"), RefusedMethodError, "relative paths refused");
  assert.throws(() => gh.request("GET", "/repos/a/b -X POST"), RefusedMethodError, "no argument smuggling");
  assert.equal(calls.length, 0);
  gh.get("/repos/a/b");
  assert.deepEqual(calls[0].slice(0, 3), ["api", "-X", "GET"]);
});

test("the gh wrapper counts calls against the cap and stops there", () => {
  const gh = makeGh({ exec: () => ({ status: 0, stdout: "{}", stderr: "" }), maxCalls: 3 });
  gh.get("/a");
  gh.get("/b");
  gh.get("/c");
  assert.equal(gh.calls, 3);
  assert.throws(() => gh.get("/d"), CallCapError);
  assert.equal(gh.calls, 3);
});

test("a whole audit only ever sends `gh api -X GET`, within the cap", async () => {
  const rec = loadRecording("web-monorepo");
  const exec = fakeExec(rec);
  const r = await runAudit({ repo: slugOf("web-monorepo"), root: fixtureRoot("web-monorepo"), exec, now: Date.parse(rec.now), maxCalls: 300 });
  assert.ok(exec.calls.length > 10 && exec.calls.length <= 300);
  for (const a of exec.calls) {
    assert.deepEqual(a.slice(0, 3), ["api", "-X", "GET"]);
    assert.ok(!a.some((x) => /^(-f|-F|--field|--raw-field|--input|-X)$/.test(x) && x !== "-X") || a.indexOf("-X") === 1);
  }
  assert.equal(r.calls.used, exec.calls.length);
});

test("a low call cap yields a partial history, labelled, never a crash", async () => {
  const r = await audit("web-monorepo", { maxCalls: 12 });
  assert.equal(r.calls.used, 12);
  assert.ok(r.dataSource.partial);
  assert.ok(r.dataSource.lines.some((l) => /partial/.test(l)));
});

// ---------------------------------------------------------------- detectors x fixtures (HMA-023)

test("every catalogue entry has exactly one detector with id, area, title and detect()", async () => {
  const rules = await loadRules();
  assert.deepEqual(rules.map((r) => r.id), CATALOGUE);
  for (const r of rules) {
    assert.ok(["code", "budget", "infra"].includes(r.area), r.id);
    assert.equal(r.area, { C: "code", B: "budget", I: "infra" }[r.id[0]]);
    assert.equal(typeof r.title, "string");
    assert.equal(typeof r.detect, "function");
  }
  assert.deepEqual(readdirSync(path.join(AUDIT, "rules")).filter((f) => f.endsWith(".mjs")).length, 19);
});

for (const name of FIXTURE_REPOS) {
  test(`fixture ${name}: every detector returns its expected outcome`, async () => {
    await ready;
    const exp = loadExpected(name);
    const got = Object.fromEntries(results[name].results.map((x) => [x.id, x.status]));
    assert.deepEqual(got, exp.outcomes);
    assert.equal(results[name].dataSource.source, exp.dataSource);
  });
}

test("each detector has a found, a not-found and an already-done fixture", () => {
  for (const id of CATALOGUE) {
    const seen = new Set(FIXTURE_REPOS.map((n) => loadExpected(n).outcomes[id]));
    for (const s of ["found", "not-found", "already-done"]) assert.ok(seen.has(s), `${id} lacks a "${s}" fixture`);
  }
});

test("the wasteful monorepo finds every entry; the tuned monorepo reports its practices as already done", async () => {
  await ready;
  assert.equal(results["web-monorepo"].findings.length, 19);
  const tuned = Object.fromEntries(results["fleet-apps"].results.map((x) => [x.id, x.status]));
  for (const id of ["C1", "C3", "C4", "C9", "B1"]) assert.equal(tuned[id], "already-done", `${id}: cancel-in-progress on PRs only, changes job, gated caches, label-gated suite, timeouts`);
  assert.equal(results["fleet-apps"].findings.length, 0);
  const c1 = results["fleet-apps"].alreadyDone.find((f) => f.id === "C1");
  assert.ok(c1.evidence.length >= 2);
});

test("cancel-in-progress that is always true on a workflow that also runs on main is a finding", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ha-c1-"));
  try {
    const wf = path.join(dir, ".github", "workflows");
    spawnSync("mkdir", ["-p", wf]);
    writeFileSync(path.join(wf, "ci.yml"), "on:\n  push:\n    branches: [main]\n  pull_request:\nconcurrency:\n  group: ci-${{ github.ref }}\n  cancel-in-progress: true\njobs:\n  t:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - run: echo hi\n");
    const r = await runAudit({ repo: "example-org/x", root: dir, noHistory: true });
    const c1 = r.results.find((f) => f.id === "C1");
    assert.equal(c1.status, "found");
    assert.match(c1.summary, /main/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- finding shape, ranking, report (HMA-024)

test("every finding carries id, area, evidence, a minutes range with method and assumptions, risk, effort, reversibility, applies-on", async () => {
  await ready;
  for (const name of FIXTURE_REPOS) {
    for (const f of results[name].results) {
      assert.ok(f.id && f.area && f.title, `${name} ${f.id}`);
      assert.ok(Array.isArray(f.evidence));
      for (const e of f.evidence) assert.ok((typeof e.file === "string" && e.line > 0) || e.run != null, `${f.id}: evidence ${JSON.stringify(e)}`);
      const m = f.minutesPerMonth;
      assert.ok(m && "low" in m && "high" in m && typeof m.method === "string" && Array.isArray(m.assumptions ?? []), `${f.id}: minutes`);
      if (m.low != null) assert.ok(m.low <= m.high);
      assert.ok(["low", "medium", "high"].includes(f.risk) && ["low", "medium", "high"].includes(f.effort), f.id);
      assert.equal(typeof f.reversible, "boolean");
      assert.ok(["hosted", "self-hosted", "both"].includes(f.appliesOn), f.id);
      if (f.status === "found") assert.ok(f.evidence.length > 0 || ["B5", "B6"].includes(f.id), `${f.id} found without evidence`);
    }
  }
});

test("findings rank by minutes saved (midpoint) / effort weight; unsized ones go last", () => {
  const f = (id, low, high, effort) => ({ id, effort, minutesPerMonth: { low, high } });
  const ranked = rank([f("A", 100, 100, "high"), f("B", 60, 60, "low"), f("C", null, null, "low"), f("D", 300, 500, "medium"), f("E", 0, 0, "low")]);
  assert.deepEqual(ranked.map((x) => x.id), ["D", "B", "A", "E", "C"]);
  assert.equal(ranked[0].score, 200);
});

test("the wasteful repo's ranking: numbered, monotone in score", async () => {
  await ready;
  const fs = results["web-monorepo"].findings;
  fs.forEach((f, i) => assert.equal(f.rank, i + 1));
  const scores = fs.map((f) => f.score).filter((s) => s != null);
  for (let i = 1; i < scores.length; i++) assert.ok(scores[i - 1] >= scores[i]);
});

test("the markdown report has the three section headings plus 'Already doing well' and 'Data used'", async () => {
  await ready;
  for (const name of FIXTURE_REPOS) {
    const md = renderMarkdown(results[name]);
    for (const h of ["## Code optimisations", "## Budget controls", "## Infrastructure adjustments", "## Already doing well", "## Data used"]) assert.ok(md.includes(h), `${name}: ${h}`);
  }
  assert.deepEqual(SECTIONS.map((s) => s[1]), ["Code optimisations", "Budget controls", "Infrastructure adjustments"]);
  const json = JSON.parse(renderJson(results["web-monorepo"]));
  assert.equal(json.findings.length, 19);
  assert.ok(json.dataSource.label);
});

test("no currency literal anywhere in the audit code (money is never hard-coded)", () => {
  const files = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (f === "fixtures") continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(mjs|js|md|json)$/.test(f)) files.push(p);
    }
  };
  walk(AUDIT);
  assert.ok(files.length >= 25);
  const CURRENCY = /\$\s?\d|\d\s?\$|[€£¥]|\b(USD|AUD|EUR|GBP|CAD|NZD|JPY)\b|US\$|A\$/;
  for (const p of files) {
    readFileSync(p, "utf8").split("\n").forEach((l, i) => assert.ok(!CURRENCY.test(l), `${path.relative(AUDIT, p)}:${i + 1}: currency literal: ${l.trim()}`));
  }
});

test("money appears only with user prices (source + date) or the billing report's own unit price", async () => {
  await ready;
  assert.equal(results["web-monorepo"].prices, null);
  assert.ok(!/Money:/.test(renderMarkdown(results["web-monorepo"])));
  const priced = await audit("web-monorepo", { prices: { perMinuteLinux: 0.5, source: "price list pasted by the user", date: "2026-11-01", currency: "XTS" } });
  const md = renderMarkdown(priced);
  assert.match(md, /- Money: about [\d.]+-[\d.]+ XTS a month at 0\.5 per Linux-equivalent minute \(price list pasted by the user, 2026-11-01\)/);
  await ready;
  assert.match(renderMarkdown(results["fleet-apps"]), /Money uses your billing usage report .*\(2026-11-12\)/);
  assert.throws(() => parseArgs(["--repo", "a/b", "--price-per-min-linux", "0.5"]), /source.*date/);
  assert.throws(() => parseArgs(["--repo", "a/b", "--price-per-min-linux", "0.5", "--price-source", "x", "--price-date", "soon"]), /date/);
  const o = parseArgs(["--repo", "a/b", "--price-per-min-linux", "0.5", "--price-source", "x", "--price-date", "2026-11-01", "--multipliers", "macos=12"]);
  assert.deepEqual(o.prices, { perMinuteLinux: 0.5, source: "x", date: "2026-11-01", currency: "" });
  assert.deepEqual(o.multipliers, { macos: 12 });
});

test("multipliers are GitHub's published defaults and overridable", async () => {
  await ready;
  const base = results["web-monorepo"].findings.find((f) => f.id === "B4").minutesPerMonth;
  const r = await audit("web-monorepo", { multipliers: { macos: 1 } });
  const b4 = r.results.find((f) => f.id === "B4");
  assert.equal(b4.minutesPerMonth.high, 0, "macOS at Linux price: moving saves nothing");
  assert.ok(base.high > 0);
  assert.ok(results["web-monorepo"].dataSource.lines.some((l) => /Linux 1, Windows 2, macOS 10/.test(l)));
});

test("B1 budget rule: 2x longest green, rounded up to 5, minimum 10", () => {
  assert.equal(budgetFor(2), 10);
  assert.equal(budgetFor(6), 15);
  assert.equal(budgetFor(28), 60);
  assert.equal(budgetFor(12.1), 25);
  assert.equal(budgetFor(null), null);
});

test("cron frequency", () => {
  assert.equal(firesPerDay("0 * * * *"), 24);
  assert.equal(firesPerDay("17 */3 * * *"), 8);
  assert.equal(firesPerDay("30 4 * * 1"), 1 / 7);
  assert.equal(firesPerDay("*/15 9-17 * * 1-5"), 4 * 9 * (5 / 7));
  assert.equal(firesPerDay("nonsense"), null);
});

// ---------------------------------------------------------------- degraded data (HMA-026)

test("no gh auth: structure-only audit, labelled, nothing sized, nothing called cheap", async () => {
  const r = await runAudit({ repo: slugOf("web-monorepo"), root: fixtureRoot("web-monorepo"), exec: noAuthExec, now: Date.parse("2026-11-12T00:00:00Z") });
  assert.equal(r.dataSource.source, "structure");
  assert.match(r.dataSource.label, /^workflow structure only \(no gh auth\)/);
  assert.equal(r.calls.used, 1);
  for (const f of r.findings) if (!["B3", "I2"].includes(f.id)) assert.equal(f.minutesPerMonth.low, null, `${f.id} must not be sized without history`);
  assert.equal(r.results.find((f) => f.id === "C7").status, "unknown");
  assert.equal(r.results.find((f) => f.id === "B5").status, "unknown");
  assert.match(renderMarkdown(r), /Could not check C7/);
});

test("billing usage unavailable: estimates from job durations, labelled", async () => {
  await ready;
  assert.match(results["web-monorepo"].dataSource.label, /^job durations x runner-OS multiplier \(billing usage report unreadable: HTTP 403/);
  assert.match(results["fleet-apps"].dataSource.label, /^billing usage report \+ job durations/);
  assert.ok(results["fleet-apps"].dataSource.lines.some((l) => /Billing usage report: 136 Actions minutes/.test(l)), "other repos' items are excluded");
});

test("a billing-refused run (annotation) is detected: 'hosted runs refused since <date>'", async () => {
  await ready;
  const r = results["web-monorepo"];
  assert.equal(r.dataSource.refused.since, "2026-11-10");
  assert.match(r.dataSource.label, /hosted runs refused since 2026-11-10/);
  assert.match(renderMarkdown(r), /hosted runs refused since 2026-11-10/);
});

test("history full of refused runs: refused since <date>, and never 0 minutes reported as cheap", async () => {
  const r = await audit("pyfmt-lib", { file: "gh-refused.json" });
  assert.match(r.dataSource.label, /hosted runs refused since 2026-10-19/);
  for (const f of r.findings) {
    const m = f.minutesPerMonth;
    const placementOrStorage = /storage|placement|guard|visibility/.test(m.method);
    if (!placementOrStorage) assert.equal(m.low, null, `${f.id} must not claim ${m.low}-${m.high} minutes from refused runs`);
  }
  const c1 = r.findings.find((f) => f.id === "C1");
  assert.match(c1.minutesPerMonth.method, /refused/);
  assert.ok(!/Saves: 0 billable/.test(renderMarkdown(r).split("## Budget controls")[0]));
});

test("refusal is not inferred without the annotation text", async () => {
  const r = await audit("web-monorepo", {
    mutate: (rec) => {
      for (const k of Object.keys(rec.responses)) if (k.endsWith("/annotations")) rec.responses[k] = { status: 200, body: [{ message: "Process completed with exit code 1." }] };
    },
  });
  assert.equal(r.dataSource.refused, null);
});

test("an unreadable source says 'unreadable', never 'none'", async () => {
  const r = await audit("web-monorepo", {
    mutate: (rec) => {
      rec.responses["/repos/example-org/web-monorepo/actions/runs?page=1"] = { status: 403, body: { message: "Resource not accessible by integration" } };
    },
  });
  assert.equal(r.dataSource.source, "structure");
  assert.match(r.dataSource.label, /run history unreadable: HTTP 403/);
  assert.ok(r.dataSource.lines.includes("Unreadable: workflow runs (HTTP 403 (forbidden))"));
  const md = renderMarkdown(r);
  assert.ok(!/\bnone\b/i.test(md.split("## Data used")[1].replace(/none recorded/g, "")), "never 'none' for an unreadable source");
  const p = await audit("pyfmt-lib");
  const b5 = p.results.find((f) => f.id === "B5");
  assert.equal(b5.status, "unknown");
  assert.match(b5.summary, /unreadable \(HTTP 403/);
});

test("an unparseable workflow is reported as unreadable, the rest is still audited", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ha-bad-"));
  try {
    const wf = path.join(dir, ".github", "workflows");
    spawnSync("mkdir", ["-p", wf]);
    writeFileSync(path.join(wf, "bad.yml"), "on: push\njobs:\n  a: &x\n    runs-on: ubuntu-latest\n");
    writeFileSync(path.join(wf, "ok.yml"), "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n");
    const r = await runAudit({ repo: "example-org/x", root: dir, noHistory: true });
    assert.ok(r.dataSource.lines.some((l) => /Unreadable: \.github\/workflows\/bad\.yml/.test(l)));
    assert.equal(r.results.find((f) => f.id === "B1").status, "found");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("estimate(): no history -> null; refused-only -> null with a 'refused' method; measured -> range", () => {
  const ctx = (hasHistory, refused, stat) => ({ hasHistory, history: { refused, days: 30, effectiveDays: 30 }, multipliers: { linux: 1, windows: 2, macos: 10 }, stats: { perJob: new Map(stat ? [["k", stat]] : []) } });
  assert.equal(estimate(ctx(false, null), ["k"], 0.1, 0.2).low, null);
  assert.equal(estimate(ctx(true, { since: "2026-11-01" }, { refused: 1, samples: [3], monthlyDemand: 0 }), ["k"], 0.1, 0.2).low, 0, "a measured zero stays zero");
  const r = estimate(ctx(true, { since: "2026-11-01" }, { refused: 3, monthlyDemand: null }), ["k"], 0.1, 0.2);
  assert.equal(r.low, null);
  assert.match(r.method, /refused since 2026-11-01/);
  assert.deepEqual([estimate(ctx(true, null, { refused: 0, monthlyDemand: 100 }), ["k"], 0.1, 0.5).low, estimate(ctx(true, null, { refused: 0, monthlyDemand: 100 }), ["k"], 0.1, 0.5).high], [10, 50]);
});

// ---------------------------------------------------------------- CLI and ledger

test("CLI: --help, usage errors, and a structure-only run without gh writes markdown to stdout", () => {
  const cli = path.join(AUDIT, "audit.mjs");
  const h = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(h.status, 0);
  assert.match(h.stdout, /--repo <owner\/name>/);
  const bad = spawnSync(process.execPath, [cli], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  const ok = spawnSync(process.execPath, [cli, "--repo", "example-org/tiny-cli", "--root", fixtureRoot("tiny-cli"), "--no-history"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /# GitHub Actions cost audit: example-org\/tiny-cli/);
  assert.match(ok.stdout, /history skipped/);
});

test("ledger: one row per job, billable totals, refused runs noted", async () => {
  await ready;
  const r = results["web-monorepo"];
  const md = renderLedger(r, r._ctx.stats, r._ctx.history);
  assert.match(md, /\| \.github\/workflows\/ci\.yml#e2e \| linux \|/);
  assert.match(md, /\*\*Total\*\*/);
  assert.match(md, /refused since 2026-11-10/);
});
