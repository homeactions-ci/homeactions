// The repo part of the kit (manifest.d/40-repo.json): workflows, the generated placement test, the runbook,
// the watchdog and its four placements. Rendered here entry by entry, so these tests do not depend on the
// host-side templates other parts of the kit own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { render, leftoverTags } from "../../skills/homeactions/kit/lib/template.mjs";
import { derive } from "../../skills/homeactions/kit/render.mjs";
import { parse } from "../../skills/homeactions/audit/lib/yaml-lite.mjs";
import { KIT, ROOT } from "./helpers.mjs";

const PROFILES = ["two-tenant-mac", "dedicated-mac", "linux-beta"];
const PLACEMENTS = ["cloud-routine", "hosted-cron", "laptop-task", "watcher-user", "none"];
const loadProfile = (n) => JSON.parse(readFileSync(path.join(ROOT, "fixtures", "profiles", `${n}.json`), "utf8"));
const manifest = JSON.parse(readFileSync(path.join(KIT, "manifest.d", "40-repo.json"), "utf8"));

// Same matching rule as render.mjs whenMatches().
function when(entry, ctx) {
  if (entry.os && !entry.os.includes(ctx.host.os)) return false;
  if (!entry.when) return true;
  return entry.when.split(/\s*&&\s*/).every((cond) => {
    const neg = cond.startsWith("!");
    const [p, eq] = (neg ? cond.slice(1) : cond).split("=");
    let v = ctx;
    for (const k of p.split(".")) v = v?.[k];
    const ok = eq !== undefined ? String(v) === eq : Array.isArray(v) ? v.length > 0 : Boolean(v) && v !== "none";
    return neg ? !ok : ok;
  });
}

/** Render the repo entries for a profile into dir; returns { output: text }. */
function renderRepo(profile, dir) {
  const ctx = { ...profile, derived: derive(profile) };
  const out = {};
  for (const e of manifest.filter((x) => when(x, ctx))) {
    assert.ok(e.output.startsWith("repo/"), `${e.output} must be under repo/`);
    assert.ok(!(e.output in out), `two entries write ${e.output}`);
    const text = render(readFileSync(path.join(KIT, e.template), "utf8"), ctx);
    assert.equal(leftoverTags(text), 0, `${e.template}: unresolved {{`);
    out[e.output] = text;
    if (dir) {
      const dest = path.join(dir, e.output);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, text);
    }
  }
  return out;
}

const withPlacement = (p, placement) => ({ ...p, watchdog: { ...p.watchdog, placement } });

test("manifest 40-repo.json: every template exists and every output is under repo/", () => {
  for (const e of manifest) {
    assert.doesNotThrow(() => readFileSync(path.join(KIT, e.template)), e.template);
    assert.match(e.output, /^repo\//);
  }
  assert.ok(manifest.some((e) => e.output === "repo/.homeactions/watchdog.mjs"));
  assert.ok(manifest.some((e) => e.output === "repo/.github/workflows/homeactions-watchdog.yml" && e.when === "watchdog.placement=hosted-cron"));
});

for (const name of PROFILES) {
  test(`${name}: renders the repo files with no leftover tags; workflows parse; runs-on values are the profile's`, () => {
    const p = loadProfile(name);
    const d = derive(p);
    const out = renderRepo(p);
    const smoke = parse(out["repo/.github/workflows/homeactions-runner-smoke.yml"]);
    const maint = parse(out["repo/.github/workflows/homeactions-runner-maintenance.yml"]);
    assert.deepEqual(Object.keys(smoke.on), ["workflow_dispatch"], "smoke is dispatch only");
    assert.deepEqual(smoke.on.workflow_dispatch.inputs.runner.options, ["self", "hosted", "offline-drill"]);
    assert.ok("inbound_probe_seconds" in smoke.on.workflow_dispatch.inputs);
    const ro = smoke.jobs.smoke["runs-on"];
    assert.ok(ro.includes("'ubuntu-latest'") && ro.includes(`'${d.selfLabelsJson}'`) && ro.includes(`${p.tenant.name}-offline-drill`), ro);
    assert.ok(smoke.jobs.smoke["timeout-minutes"] > 0);
    assert.ok(smoke.jobs.smoke.steps.some((s) => s.run && s.run.includes(`${p.tenant.rootDir}/smoke/smoke-probes.sh`)));
    assert.equal(maint.on.schedule[0].cron, p.maintenance.cron);
    assert.ok("workflow_dispatch" in maint.on);
    assert.equal(maint.jobs.maintenance.if, `vars.${p.workflows.fallbackVariable} == '${p.workflows.selfValue}' || github.event_name == 'workflow_dispatch'`);
    assert.deepEqual(maint.jobs.maintenance["runs-on"], d.selfLabels);
    assert.match(maint.jobs.maintenance.steps[0].run, new RegExp(`${p.tenant.rootDir}/maintenance\\.sh`));
    const runbook = out["repo/.homeactions/RUNBOOK.md"];
    assert.ok(runbook.includes(d.banner));
    for (const s of ["Hook messages", "Jobs queued with nothing running", "wedged", "Job message not found", "fallback switch", "Reboots", "Maintenance", "Uninstall"]) assert.ok(runbook.toLowerCase().includes(s.toLowerCase()), `runbook: ${s}`);
    assert.ok(runbook.includes(p.host.os === "macos" ? `sudo launchctl kickstart -k system/${d.daemonLabel}` : `sudo systemctl restart ${d.daemonLabel}.service`));
    assert.ok(runbook.includes(p.host.os === "macos" ? "FileVault" : "LUKS"));
  });
}

for (const placement of PLACEMENTS) {
  test(`watchdog placement ${placement}: renders exactly its instructions${placement === "hosted-cron" ? " and the hosted workflow" : ""}`, () => {
    const p = withPlacement(loadProfile("two-tenant-mac"), placement);
    const out = renderRepo(p);
    const wd = out["repo/.homeactions/WATCHDOG.md"];
    if (placement === "none") {
      assert.equal(wd, undefined);
      assert.equal(out["repo/.homeactions/watchdog.mjs"], undefined);
      return;
    }
    assert.ok(wd.startsWith(`# Watchdog placement: ${placement.replace("-", " ")}`), wd.slice(0, 60));
    assert.ok(out["repo/.homeactions/watchdog.mjs"].includes("export function decide("));
    assert.ok(wd.includes("node .homeactions/watchdog.mjs"));
    assert.ok(!/paste (your|the) token|token here/i.test(wd), "never asks for a token in chat");
    const wf = out["repo/.github/workflows/homeactions-watchdog.yml"];
    if (placement !== "hosted-cron") return assert.equal(wf, undefined);
    const doc = parse(wf);
    assert.equal(doc.jobs.watchdog["runs-on"], "ubuntu-latest");
    assert.ok(doc.jobs.watchdog["timeout-minutes"] <= 5);
    assert.ok(Array.isArray(doc.on.schedule) && "workflow_dispatch" in doc.on);
    assert.deepEqual(doc.permissions, { contents: "read", issues: "write", actions: "write" });
    assert.match(doc.jobs.watchdog.steps[1].run, /--apply --reap --threshold/);
  });
}

test("cloud-routine placement is a ready-to-paste routine prompt", () => {
  const wd = renderRepo(withPlacement(loadProfile("two-tenant-mac"), "cloud-routine"))["repo/.homeactions/WATCHDOG.md"];
  assert.match(wd, /## Routine prompt \(paste as is\)\n\n```text\nYou are the off-box watchdog/);
  assert.match(wd, /node \.homeactions\/watchdog\.mjs --apply --reap --threshold 30/);
});

test("laptop-task placement uses StartInterval, never StartCalendarInterval (L19)", () => {
  const wd = renderRepo(withPlacement(loadProfile("dedicated-mac"), "laptop-task"))["repo/.homeactions/WATCHDOG.md"];
  assert.ok(wd.includes("<key>StartInterval</key>"));
  assert.ok(!wd.includes("<key>StartCalendarInterval</key>"));
});

test("hosted-cron without the reaper keeps actions: read and no --reap", () => {
  const p = withPlacement(loadProfile("dedicated-mac"), "hosted-cron");
  p.watchdog.reapClosedPrs = false;
  const doc = parse(renderRepo(p)["repo/.github/workflows/homeactions-watchdog.yml"]);
  assert.equal(doc.permissions.actions, "read");
  assert.ok(!doc.jobs.watchdog.steps[1].run.includes("--reap"));
});

test("the rendered watchdog.mjs is byte-identical to the kit source (no tags; profile read at run time)", () => {
  const src = readFileSync(path.join(KIT, "common", "watchdog", "watchdog.mjs"), "utf8");
  assert.equal(leftoverTags(src), 0);
  assert.equal(renderRepo(loadProfile("two-tenant-mac"))["repo/.homeactions/watchdog.mjs"], src);
});

// ---------------------------------------------------------------- the generated placement test, run for real

function makeRepo(profileName, extraWorkflows) {
  const dir = mkdtempSync(path.join(tmpdir(), "ha-placement-"));
  const p = profileName === "hosted" ? withPlacement(loadProfile("two-tenant-mac"), "hosted-cron") : loadProfile(profileName);
  renderRepo(p, dir);
  const repo = path.join(dir, "repo");
  for (const [f, text] of Object.entries(extraWorkflows)) writeFileSync(path.join(repo, ".github", "workflows", f), text);
  return { dir, repo, p, d: derive(p) };
}

function runPlacement(repo) {
  const env = { ...process.env, HOMEACTIONS_REPO_ROOT: repo };
  delete env.NODE_TEST_CONTEXT; // run as a top-level test process, as the user's CI would
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=spec", path.join(repo, ".homeactions", "tests", "placement.test.mjs")], { encoding: "utf8", env });
  return { status: r.status, out: r.stdout + r.stderr };
}

const ciYaml = (d, { secret = false, cache = "gated", timeout = true, extraJob = "" } = {}) => `name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ${d.runsOnExpression}
${timeout ? "    timeout-minutes: 20\n" : ""}    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
${cache === "gated" ? "        if: runner.environment == 'github-hosted'\n" : ""}        with:
          node-version: 24.10.0
          cache: ${cache === "expr" ? "${{ runner.environment == 'github-hosted' && 'pnpm' || '' }}" : "pnpm"}
      - run: pnpm install --frozen-lockfile && pnpm test
${secret ? "        env:\n          API_KEY: ${{ secrets.API_KEY }}\n" : ""}${extraJob}`;

test("rendered placement test: green on a compliant repo (plus a hosted-only job that uses secrets)", () => {
  const { dir, repo, d } = makeRepo("two-tenant-mac", {
    "ci.yml": ciYaml(derive(loadProfile("two-tenant-mac"))),
    "pre-deploy.yml": "on:\n  push:\n    branches: [main]\njobs:\n  webkit:\n    runs-on: ubuntu-latest\n    timeout-minutes: 30\n    steps:\n      - run: ./deploy.sh\n        env:\n          T: ${{ secrets.DEPLOY }}\n",
    "release.yml": "on:\n  push:\n    tags: ['v*']\njobs:\n  release:\n    uses: example-org/shared/.github/workflows/release.yml@v1\n",
  });
  try {
    assert.ok(d.runsOnExpression.includes("self-hosted"));
    const r = runPlacement(repo);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /ci\.yml\\?#test: safe to run self-hosted/);
    assert.match(r.out, /homeactions-runner-smoke\.yml\\?#smoke: runs-on/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression (first real tenant, 2026-11-12): a cache gated inside its own `cache:` expression is hosted-only too.
test("rendered placement test: green when the cache is gated in the `cache:` expression itself", () => {
  const { dir, repo, d } = makeRepo("two-tenant-mac", { "ci.yml": ciYaml(derive(loadProfile("two-tenant-mac")), { cache: "expr" }) });
  try {
    const r = runPlacement(repo);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /ci\.yml\\?#test: safe to run self-hosted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rendered placement test: green with the hosted-cron watchdog workflow present", () => {
  const { dir, repo, d } = makeRepo("hosted", {});
  try {
    writeFileSync(path.join(repo, ".github", "workflows", "ci.yml"), ciYaml(d));
    assert.ok(readdirSync(path.join(repo, ".github", "workflows")).includes("homeactions-watchdog.yml"));
    const r = runPlacement(repo);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /homeactions-watchdog\.yml\\?#watchdog: runs-on/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [label, opts, re] of [
  ["`secrets.` on a self-hosted job", { secret: true }, /uses `secrets\.` but secretsPolicy is none/],
  ["an ungated setup-node cache", { cache: "ungated" }, /caches without `if: runner\.environment == 'github-hosted'`/],
  ["a job without timeout-minutes", { timeout: false }, /has no timeout-minutes/],
  ["a job not on the switch expression", { extraJob: "  lint:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - run: echo\n" }, /must use the homeactions runs-on expression/],
  ["services: and sudo on a self-hosted job", { extraJob: `  db:\n    runs-on: ${"PLACEHOLDER"}\n    timeout-minutes: 5\n    services:\n      pg:\n        image: postgres\n    steps:\n      - run: sudo apt-get install -y jq\n` }, /has `services:`[\s\S]*runs sudo|runs sudo[\s\S]*has `services:`/],
]) {
  test(`rendered placement test: red on ${label}`, () => {
    const d = derive(loadProfile("two-tenant-mac"));
    const o = { ...opts, extraJob: opts.extraJob ? opts.extraJob.replace("PLACEHOLDER", d.runsOnExpression) : "" };
    const { dir, repo } = makeRepo("two-tenant-mac", { "ci.yml": ciYaml(d, o) });
    try {
      const r = runPlacement(repo);
      assert.notEqual(r.status, 0, r.out);
      assert.match(r.out, re);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("rendered placement test: red when the kit's smoke workflow was edited off its runs-on", () => {
  const d = derive(loadProfile("dedicated-mac"));
  const { dir, repo } = makeRepo("dedicated-mac", { "ci.yml": ciYaml(d) });
  try {
    const f = path.join(repo, ".github", "workflows", "homeactions-runner-smoke.yml");
    writeFileSync(f, readFileSync(f, "utf8").replace(/runs-on: .*/, "runs-on: ubuntu-latest"));
    const r = runPlacement(repo);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /must keep the kit's runs-on/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the rendered placement test needs no dependencies (only node: imports)", () => {
  const out = renderRepo(loadProfile("linux-beta"));
  const t = out["repo/.homeactions/tests/placement.test.mjs"];
  const imports = [...t.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.ok(imports.length >= 4);
  for (const i of imports) assert.match(i, /^node:/);
});

// Regression (first real tenant, 2026-11-12): the smoke workflow picks its runtimes at render time. A runtime
// `fromJSON('{"node":…}').python` lookup is a type error to actionlint (the literal has no such key).
test("smoke workflow: runtime setup steps are chosen at render time, one per runtime in the profile", () => {
  for (const [name, has, hasNot] of [["two-tenant-mac", "node-version: \"24.10.0\"", "setup-python"], ["linux-beta", "python-version: \"3.12\"", "setup-node"]]) {
    const dir = mkdtempSync(path.join(tmpdir(), "ha-smoke-"));
    try {
      const out = renderRepo(loadProfile(name), dir);
      const smoke = out["repo/.github/workflows/homeactions-runner-smoke.yml"];
      assert.ok(smoke, `${name}: smoke rendered`);
      assert.ok(!/fromJSON\('\{/.test(smoke), `${name}: no runtime fromJSON of a literal object`);
      assert.ok(smoke.includes(has), `${name}: ${has}`);
      assert.ok(!smoke.includes(hasNot), `${name}: no ${hasNot}`);
      parse(smoke);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// Regression (first real tenant, 2026-11-12): kit workflows run on the user's machine, so a checkout must not
// leave the job's token in the workspace's .git/config.
test("every rendered workflow's checkout sets persist-credentials: false", () => {
  for (const name of ["two-tenant-mac", "dedicated-mac", "linux-beta"]) {
    const dir = mkdtempSync(path.join(tmpdir(), "ha-checkout-"));
    try {
      const out = renderRepo(loadProfile(name), dir);
      for (const [file, text] of Object.entries(out).filter(([f]) => f.endsWith(".yml"))) {
        const doc = parse(text);
        for (const [job, j] of Object.entries(doc.jobs ?? {})) {
          for (const s of j.steps ?? []) {
            if (typeof s.uses === "string" && s.uses.startsWith("actions/checkout")) assert.equal(s.with?.["persist-credentials"], false, `${name} ${file}#${job}`);
          }
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
