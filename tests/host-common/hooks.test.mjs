// host-common: job-started.sh / job-completed.sh. The step order is pinned statically, then each hook
// runs end to end in a sandbox: the rendered hook with its conf/lib paths pointed at sandbox copies,
// the conf's paths overridden, and the lib's host I/O (id, ps, netstat, df, sysctl, file flags) stubbed.
// Process reaping, IPC and /tmp cleanup are stubbed out so the tests can never touch real processes.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, chmodSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fixtureNames, rendered, tmp, IS_ROOT } from "./helpers.mjs";

describe("job-started.sh step order", () => {
  for (const f of fixtureNames) {
    test(`${f}: identity, wiring, isolation, co-tenant readability, leftovers, ports, disk, yield, banner`, () => {
      const text = rendered(f).text("host/hooks/job-started.sh");
      const code = text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
      const steps = [
        /^check_identity$/m,
        /^check_root_immutable "\$HA_RUNNER_DIR\/\.env" "\$HA_RUNNER_DIR\/\.path"$/m,
        /for d in "\$HA_HOOKS_DIR" "\$HA_ROOT_DIR" "\$HA_CONF_FILE"/,
        /for p in \$HA_FORBIDDEN_READ/,
        /-w "\$HA_COTENANT_MARKER_DIR"/,
        /network_probe/,
        /cotenant_hold "\$\(date \+%s\)"/,
        /co-tenant markers UNREADABLE/,
        /^reap_strays job-started$/m,
        /^ipc_cleanup$/m,
        /^tmp_cleanup 1$/m,
        /tcp_listen_table \| listeners_on_ports "\$HA_PORTS"/,
        /disk_free_kb "\$HA_HOME"/,
        /^run_yield$/m,
        /^hook_log "\$banner"$/m,
        /^exit 0$/m,
      ];
      let at = -1;
      for (const re of steps) {
        const m = re.exec(code);
        assert.ok(m, `missing step ${re}`);
        assert.ok(m.index > at, `step ${re} is out of order`);
        at = m.index;
      }
      const numbered = [...text.matchAll(/^# (\d)\. /gm)].map((m) => Number(m[1]));
      assert.deepEqual(numbered, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });
  }
  test("job-completed.sh records exposure before reaping and fails on it only after the banner", () => {
    const code = rendered("two-tenant-mac.json").text("host/hooks/job-completed.sh").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    const order = [/own_tcp_listeners/, /^reap_strays job-completed$/m, /^ipc_cleanup$/m, /workspace_wipe/, /^tmp_cleanup$/m, /hook_log "job-completed/, /bound off loopback/];
    let at = -1;
    for (const re of order) {
      const m = re.exec(code);
      assert.ok(m && m.index > at, `${re} missing or out of order`);
      at = m.index;
    }
  });
});

/** A sandboxed, runnable copy of a rendered hook. */
function sandbox(fixture, o = {}) {
  const r = rendered(fixture);
  const d = r.derived;
  const t = r.profile.tenant;
  const sb = tmp("homeactions-hook-");
  const dirs = { runner: "runner", work: "runner/_work", hooks: "hooks", root: "root", conf: "confdir", forbidden: "forbidden", markers: "markers", state: "state" };
  for (const v of Object.values(dirs)) mkdirSync(path.join(sb, v), { recursive: true });
  const P = (k) => path.join(sb, dirs[k]);
  writeFileSync(path.join(P("runner"), ".env"), "TZ=UTC\n");
  writeFileSync(path.join(P("runner"), ".path"), "/usr/bin:/bin\n");
  writeFileSync(path.join(sb, "listen"), o.listen ?? "");
  for (const [n, b] of Object.entries(o.markers ?? {})) writeFileSync(path.join(P("markers"), n), b);
  const check = path.join(sb, "busy-check");
  writeFileSync(check, `#!/bin/sh\nexit ${o.checkExit ?? 0}\n`);
  chmodSync(check, 0o755);
  const conf = path.join(P("conf"), "tenant.conf");
  const lib = path.join(P("hooks"), "lib.sh");
  writeFileSync(
    conf,
    r.text("host/conf/tenant.conf") +
      `\n# test overrides\nHA_RUNNER_DIR="${P("runner")}"; HA_WORK_DIR="${P("work")}"; HA_HOOKS_DIR="${P("hooks")}"; HA_ROOT_DIR="${P("root")}"; HA_CONF_FILE="${conf}"\n` +
      `HA_FORBIDDEN_READ="${P("forbidden")}"; HA_YIELD_STATE_DIR="${P("state")}"; HA_HOME="${sb}"; HA_PROBES="${o.probes ?? "127.0.0.1:1"}"\n` +
      (r.profile.cotenant.mode === "marker-dir" ? `HA_COTENANT_MARKER_DIR="${P("markers")}"\n` : "") +
      (r.profile.cotenant.mode === "command" ? `HA_COTENANT_COMMAND="${o.command ?? check}"\n` : "") +
      (o.conf ?? ""),
  );
  const user = o.user ?? t.user;
  writeFileSync(
    lib,
    r.text("host/hooks/lib.sh") +
      `\n# test stubs\nid() { case "$1" in -un) echo ${user} ;; -u) echo ${t.uid} ;; -gn) echo ${t.group} ;; -Gn) echo "${o.groups ?? `${t.group} everyone`}" ;; *) command id "$@" ;; esac; }\n` +
      `own_processes() { :; }; tmp_cleanup() { :; }; ipc_cleanup() { :; }\n` +
      `file_owner() { echo root; }; file_immutable() { return ${o.immutableRc ?? 0}; }\n` +
      `tcp_listen_table() { cat "${sb}/listen"; }; disk_free_kb() { echo ${o.freeKb ?? 100 * 1048576}; }\n` +
      `memory_pressure_level() { echo ${o.pressure ?? 1}; }; swap_used_mb() { echo ${o.swap ?? 0}; }; load1() { echo 0.50; }; sleep() { :; }\n` +
      `own_tcp_listeners() { printf '%s\\n' ${(o.ownListeners ?? []).map((x) => `'${x}'`).join(" ")}; }\n` +
      (o.lib ?? ""),
  );
  const hook = (kind) => {
    const out = path.join(sb, `${kind}.sh`);
    writeFileSync(out, r.text(`host/hooks/${kind}.sh`).replaceAll(d.confFile, conf).replaceAll(`${d.hooksDir}/lib.sh`, lib));
    return out;
  };
  const started = hook("job-started");
  const completed = hook("job-completed");
  const lock = () => {
    chmodSync(conf, 0o444);
    if (!o.hooksWritable) chmodSync(P("hooks"), 0o555);
    chmodSync(P("root"), 0o555);
    if (!o.forbiddenReadable) chmodSync(P("forbidden"), 0o000);
    chmodSync(P("markers"), o.markersMode ?? 0o555);
  };
  const run = (script, env = {}) => {
    lock();
    const res = spawnSync("/bin/bash", [script], {
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/tmp", GITHUB_RUN_ID: "1001", GITHUB_RUN_ATTEMPT: "1", ...env },
      encoding: "utf8",
    });
    return { status: res.status, out: res.stdout + res.stderr };
  };
  return { sb, P, banner: d.banner, started: (env) => run(started, env), completed: (env) => run(completed, env) };
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("job-started.sh end to end (sandboxed)", { skip: IS_ROOT && "permission checks need a non-root user" }, () => {
  for (const f of fixtureNames) {
    test(`${f}: a clean host passes with the full banner`, () => {
      const s = sandbox(f);
      const r = s.started();
      assert.equal(r.status, 0, r.out);
      const workers = rendered(f).profile.cotenant.workerProbe ? ", cotenant-workers \\d+" : "";
      assert.match(r.out, new RegExp(`^${esc(s.banner)} job-started v1 OK: reaped 0, yielded 0s, free 100 GB, swap 0 MB, pressure 1, load 0\\.50${workers}\\n$`));
    });
  }
  test("a live co-tenant marker is yielded to, out of the run's budget, then fail-open", () => {
    const s = sandbox("two-tenant-mac.json", { markers: { "device.phone1.busy": `{"kind":"device","pid":${process.pid}}` } });
    const r = s.started();
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /yielding to cotenant marker device\.phone1\.busy/);
    assert.match(r.out, /run budget of 900s spent; starting anyway/);
    assert.match(r.out, new RegExp(`job-started v1 OK: reaped 0, yielded 900s to cotenant marker device\\.phone1\\.busy \\(pid ${process.pid}\\), `));
  });
  test("swap over the threshold is yielded to (two-tenant profile: 1775 MB)", () => {
    const r = sandbox("two-tenant-mac.json", { swap: 2000 }).started();
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /yielded 900s to swap used 2000 MB over 1775 MB, free 100 GB, swap 2000 MB/);
  });
  test("UNREADABLE co-tenant markers fail the job with a clear message", () => {
    const r = sandbox("two-tenant-mac.json", { markersMode: 0o000 }).started();
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /^::error::homeactions\[acme-ci\] co-tenant markers UNREADABLE: .*markers/m);
    assert.doesNotMatch(r.out, /job-started v1 OK/);
  });
  test("a missing co-tenant command is UNREADABLE and fails the job; a busy one is yielded to", () => {
    const missing = sandbox("linux-beta.json", { command: "/nonexistent/busy-check" }).started();
    assert.equal(missing.status, 1, missing.out);
    assert.match(missing.out, /co-tenant markers UNREADABLE: \/nonexistent\/busy-check is missing/);
    const busy = sandbox("linux-beta.json", { checkExit: 1 }).started();
    assert.equal(busy.status, 0, busy.out);
    assert.match(busy.out, /yielded 600s to cotenant busy \(busy-check exit 1\)/);
  });
  const failures = [
    ["the wrong user", { user: "someone" }, /running as someone, not acme-ci/],
    ["an admin group", { groups: "acme-ci admin" }, /member of group admin/],
    ["a mutable runner .env", { immutableRc: 1 }, /\.env is not immutable/],
    ["a writable hooks directory", { hooksWritable: true }, /hooks is writable by acme-ci/],
    ["a readable forbidden path", { forbiddenReadable: true }, /forbidden is readable by acme-ci/],
    ["a writable co-tenant marker directory", { markersMode: 0o755 }, /markers is writable by acme-ci/],
    ["a tenant port held by anyone", { listen: "tcp46  0  0  *.3100  *.*  LISTEN\n" }, /a tenant port is held by another process: \*\.3100/],
    ["disk under the floor", { freeKb: 3 * 1048576 }, /free disk 3 GB is under the 25 GB floor/],
  ];
  for (const [why, opts, msg] of failures) {
    test(`fails on ${why}`, () => {
      const r = sandbox("two-tenant-mac.json", opts).started();
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /^::error::homeactions\[acme-ci\] /m);
      assert.match(r.out, msg);
      assert.doesNotMatch(r.out, /job-started v1 OK/);
    });
  }
  test("a reachable probe target fails the job only when isolation.network is on", async () => {
    const net = await import("node:net");
    const server = net.createServer();
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    const probes = `127.0.0.1:${server.address().port}`;
    try {
      const on = sandbox("two-tenant-mac.json", { probes }).started();
      assert.equal(on.status, 1, on.out);
      assert.match(on.out, /network isolation is not active: acme-ci reached 127\.0\.0\.1:\d+ \(owner: re-apply the com\.example\.acme-ci\.firewall rules\)/);
      const off = sandbox("dedicated-mac.json", { probes }).started();
      assert.equal(off.status, 0, off.out);
    } finally {
      await new Promise((res) => server.close(res));
    }
  });
});

describe("job-completed.sh end to end (sandboxed)", { skip: IS_ROOT && "permission checks need a non-root user" }, () => {
  const work = (s) => {
    for (const d of ["app/app/node_modules", "_tool/node/24.10.0", "_temp"]) mkdirSync(path.join(s.P("work"), d), { recursive: true });
    writeFileSync(path.join(s.P("work"), "app/app/package.json"), "{}");
  };
  test("wipes the job's workspace (keeping _tool) and passes when listeners stayed on loopback", () => {
    const s = sandbox("two-tenant-mac.json", { ownListeners: ["p1", "n127.0.0.1:3100", "n[::1]:3101"] });
    work(s);
    const r = s.completed({ GITHUB_WORKSPACE: path.join(s.P("work"), "app/app") });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, new RegExp(`job-completed v1: reaped 0, wiped ${esc(path.join(s.P("work"), "app"))}, pressure 1, swap 0 MB\\n$`));
    assert.deepEqual(readdirSync(path.join(s.P("work"), "app")), []);
    assert.ok(existsSync(path.join(s.P("work"), "_tool/node/24.10.0")));
  });
  test("falls back to GITHUB_REPOSITORY when GITHUB_WORKSPACE is unset", () => {
    const s = sandbox("two-tenant-mac.json");
    work(s);
    const r = s.completed({ GITHUB_REPOSITORY: "example-org/app" });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(readdirSync(path.join(s.P("work"), "app")), []);
  });
  test("fails, after reaping, wiping and the banner, when a listener was bound off loopback", () => {
    const s = sandbox("linux-beta.json", { ownListeners: ["n127.0.0.1:5452", "n*:8000"] });
    work(s);
    const r = s.completed({ GITHUB_WORKSPACE: path.join(s.P("work"), "app/app") });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /homeactions\[lab-ci\] job-completed v1: reaped 0, wiped /);
    assert.match(r.out, /::error::homeactions\[lab-ci\] a listener of this job was bound off loopback: \*:8000/);
    assert.deepEqual(readdirSync(path.join(s.P("work"), "app")), []);
  });
  test("refuses to run as anyone but the tenant", () => {
    const r = sandbox("two-tenant-mac.json", { user: "someone" }).completed();
    assert.equal(r.status, 1);
    assert.match(r.out, /running as someone, not acme-ci/);
  });
});
