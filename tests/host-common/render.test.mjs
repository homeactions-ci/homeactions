// host-common: every common template renders for every fixture, parses as bash, passes shellcheck,
// and the runner .env/.path and manifest conditions hold. node --test tests/host-common/
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fixtureNames, rendered, COMMON_MANIFEST, hasCmd, bash } from "./helpers.mjs";

const SCRIPT_OUTPUTS = COMMON_MANIFEST.filter((e) => e.output.endsWith(".sh") || e.output.endsWith(".conf"));

test("10-common.json: every entry has a template under common/, a host/ (or repo/.homeactions/services/) output and a mode", () => {
  assert.ok(COMMON_MANIFEST.length >= 14);
  for (const e of COMMON_MANIFEST) {
    assert.match(e.template, /^common\//, e.template);
    assert.match(e.output, /^(host\/|repo\/\.homeactions\/services\/)/, e.output);
    assert.match(e.mode, /^0[0-7]{3}$/, e.output);
    if (e.output.endsWith(".sh")) assert.equal(e.mode, "0755", `${e.output} is a script`);
  }
  const outs = COMMON_MANIFEST.map((e) => e.output);
  assert.equal(new Set(outs).size, outs.length, "no two entries write the same output");
  for (const o of ["host/runner/.env", "host/runner/.path"]) assert.equal(COMMON_MANIFEST.find((e) => e.output === o).header, false, o);
});

for (const f of fixtureNames) {
  const when = (e, d) => {
    if (!e.when) return true;
    return e.when.split(/\s*&&\s*/).every((c) => {
      const neg = c.startsWith("!");
      let v = { derived: d.derived, ...d.profile };
      for (const k of (neg ? c.slice(1) : c).split(".")) v = v?.[k];
      return neg ? !v : Boolean(v);
    });
  };

  test(`${f}: the common outputs exist exactly when their condition holds, with their mode`, () => {
    const r = rendered(f);
    for (const e of COMMON_MANIFEST) {
      const p = r.file(e.output);
      assert.equal(existsSync(p), when(e, r), `${e.output} (when ${e.when ?? "always"})`);
      if (existsSync(p)) assert.equal((statSync(p).mode & 0o777).toString(8), e.mode.slice(1), e.output);
    }
    assert.equal(existsSync(r.file("host/services/postgres.sh")), r.derived.hasPostgres);
    assert.equal(existsSync(r.file("host/services/redis.sh")), r.derived.hasRedis);
  });

  test(`${f}: every rendered common script parses with bash -n`, () => {
    const r = rendered(f);
    for (const e of SCRIPT_OUTPUTS) {
      if (!existsSync(r.file(e.output))) continue;
      const res = spawnSync("/bin/bash", ["-n", r.file(e.output)], { encoding: "utf8" });
      assert.equal(res.status, 0, `${e.output}: ${res.stderr}`);
    }
  });

  test(`${f}: shellcheck -S warning is clean on the common scripts`, (t) => {
    if (!hasCmd("shellcheck")) return t.skip("shellcheck is not installed");
    const r = rendered(f);
    const files = SCRIPT_OUTPUTS.map((e) => r.file(e.output)).filter((p) => existsSync(p));
    const res = spawnSync("shellcheck", ["-S", "warning", "-s", "bash", "-e", "SC1090,SC1091", ...files], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stdout + res.stderr);
  });

  test(`${f}: no "grep -q" downstream of a pipe in any common script (pipefail + SIGPIPE)`, () => {
    const r = rendered(f);
    for (const e of SCRIPT_OUTPUTS) {
      if (!existsSync(r.file(e.output))) continue;
      const bad = r.text(e.output).split("\n").filter((l) => /\|\s*grep\s+(-[A-Za-z]*q|--quiet)/.test(l) && !/^\s*#/.test(l));
      assert.deepEqual(bad, [], e.output);
    }
  });

  test(`${f}: runner .path is the service bins then the system dirs, never /opt/homebrew or /usr/local`, () => {
    const r = rendered(f);
    const p = r.text("host/runner/.path");
    assert.doesNotMatch(p, /\/opt\/homebrew|\/usr\/local/);
    assert.doesNotMatch(p, /\n/, "one line");
    assert.equal(p, [...r.derived.serviceBins, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"));
  });

  test(`${f}: runner .env is KEY=VALUE only and wires the hooks, TZ, TMPDIR and the caches`, () => {
    const r = rendered(f);
    const d = r.derived;
    const lines = r.text("host/runner/.env").trimEnd().split("\n");
    for (const l of lines) assert.match(l, /^[A-Za-z_][A-Za-z0-9_]*=\S/, `bad .env line: ${JSON.stringify(l)}`);
    const env = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    assert.equal(env.TZ, "UTC");
    assert.equal(env.TMPDIR, `${d.tmpDir}/`);
    assert.equal(env.ACTIONS_RUNNER_HOOK_JOB_STARTED, `${d.hooksDir}/job-started.sh`);
    assert.equal(env.ACTIONS_RUNNER_HOOK_JOB_COMPLETED, `${d.hooksDir}/job-completed.sh`);
    for (const k of ["PLAYWRIGHT_BROWSERS_PATH", "XDG_CACHE_HOME", "pnpm_config_store_dir", "npm_config_store_dir", "npm_config_cache"]) {
      assert.ok(env[k].startsWith(`${d.cacheDir}/`), `${k}=${env[k]}`);
    }
    assert.equal(env.HOMEACTIONS_PG_BIN, d.hasPostgres ? d.postgres.bin : undefined);
    assert.equal(env.HOMEACTIONS_REDIS_BIN, d.hasRedis ? d.redis.bin : undefined);
    const capVars = { nextBuildCpus: "HOMEACTIONS_NEXT_BUILD_CPUS", turboConcurrency: "HOMEACTIONS_TURBO_CONCURRENCY", jestMaxWorkers: "HOMEACTIONS_JEST_MAX_WORKERS", playwrightWorkers: "HOMEACTIONS_PLAYWRIGHT_WORKERS" };
    for (const [k, name] of Object.entries(capVars)) assert.equal(env[name], r.profile.caps[k] == null ? undefined : String(r.profile.caps[k]), name);
    assert.doesNotMatch(r.text("host/runner/.env"), /\/opt\/homebrew|\/usr\/local/);
  });

  test(`${f}: tenant.conf sources cleanly and carries the profile's tunables`, () => {
    const r = rendered(f);
    const p = r.profile;
    const res = bash(
      `for v in HA_USER HA_UID HA_GROUP HA_PORTS HA_PROBES HA_FORBIDDEN_READ HA_NETWORK_ISOLATION HA_DISK_FLOOR_GB HA_COTENANT_MODE HA_COTENANT_MARKER_DIR HA_COTENANT_PID_GLOB HA_COTENANT_EPOCH_FILE HA_COTENANT_EPOCH_BOUND HA_COTENANT_COMMAND HA_YIELD_BUDGET_SECONDS HA_YIELD_POLL_SECONDS HA_SWAP_YIELD_MB HA_WORKER_PROBE_USER HA_WORKER_PROBE_PATTERN HA_RUNNER_DIR HA_WORK_DIR HA_YIELD_STATE_DIR HA_PG_BIN HA_REDIS_BIN; do printf '%s=%s\\n' "$v" "\${!v}"; done`,
      { conf: r.file("host/conf/tenant.conf") },
    );
    assert.equal(res.status, 0, res.out);
    const got = Object.fromEntries(res.stdout.trimEnd().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    const c = p.cotenant;
    assert.equal(got.HA_USER, p.tenant.user);
    assert.equal(got.HA_UID, String(p.tenant.uid));
    assert.equal(got.HA_PORTS, p.ports.join(" "));
    assert.equal(got.HA_PROBES, p.isolation.probeTargets.join(" "));
    assert.equal(got.HA_FORBIDDEN_READ, p.isolation.forbiddenReadPaths.join(" "));
    assert.equal(got.HA_NETWORK_ISOLATION, p.isolation.network ? "1" : "0");
    assert.equal(got.HA_DISK_FLOOR_GB, String(p.diskFloorGb));
    assert.equal(got.HA_COTENANT_MODE, c.mode);
    assert.equal(got.HA_COTENANT_MARKER_DIR, c.mode === "marker-dir" ? c.markerDir : "");
    assert.equal(got.HA_COTENANT_PID_GLOB, c.mode === "marker-dir" ? c.pidGlob ?? "" : "");
    assert.equal(got.HA_COTENANT_EPOCH_FILE, c.mode === "marker-dir" ? c.epochFile ?? "" : "");
    assert.equal(got.HA_COTENANT_EPOCH_BOUND, String(c.mode === "marker-dir" ? c.epochBoundSeconds ?? 0 : 0));
    assert.equal(got.HA_COTENANT_COMMAND, c.mode === "command" ? c.command : "");
    assert.equal(got.HA_YIELD_BUDGET_SECONDS, String(c.yieldBudgetSeconds));
    assert.equal(got.HA_YIELD_POLL_SECONDS, String(c.pollSeconds));
    assert.equal(got.HA_SWAP_YIELD_MB, String(c.swapYieldMb ?? 0));
    assert.equal(got.HA_WORKER_PROBE_USER, c.workerProbe?.user ?? "");
    assert.equal(got.HA_WORKER_PROBE_PATTERN, c.workerProbe?.pattern ?? "");
    assert.equal(got.HA_RUNNER_DIR, r.derived.runnerDir);
    assert.equal(got.HA_WORK_DIR, `${r.derived.runnerDir}/_work`);
    assert.equal(got.HA_YIELD_STATE_DIR, `${r.derived.stateDir}/yield`);
    assert.equal(got.HA_PG_BIN, r.derived.hasPostgres ? r.derived.postgres.bin : "");
    assert.equal(got.HA_REDIS_BIN, r.derived.hasRedis ? r.derived.redis.bin : "");
  });

  test(`${f}: every common host script uses the tenant banner, never another prefix`, () => {
    const r = rendered(f);
    for (const o of ["host/hooks/lib.sh", "host/hooks/job-started.sh", "host/hooks/job-completed.sh"]) {
      assert.ok(r.text(o).includes(r.derived.banner), o);
    }
    assert.match(r.text("host/hooks/lib.sh"), new RegExp(`HA_BANNER="${r.derived.banner.replace(/[[\]]/g, "\\$&")}"`));
  });
}

test("a profile string with quotes and $ in the co-tenant command and worker pattern cannot break tenant.conf", async () => {
  const { loadFixture, tmp } = await import("./helpers.mjs");
  const { renderKit } = await import("../../skills/homeactions/kit/render.mjs");
  const p = loadFixture("linux-beta.json");
  p.cotenant.command = `/usr/bin/test -e '/var/run/it is "busy" $HOME'`;
  p.cotenant.workerProbe = { user: "ops", pattern: `Runner.Worker.*'$(touch /tmp/x)'` };
  const out = tmp();
  renderKit(p, out);
  const res = bash(`printf '%s\\n%s\\n' "$HA_COTENANT_COMMAND" "$HA_WORKER_PROBE_PATTERN"`, { conf: `${out}/host/conf/tenant.conf` });
  assert.equal(res.status, 0, res.out);
  assert.equal(res.stdout, `${p.cotenant.command}\n${p.cotenant.workerProbe.pattern}\n`);
});
