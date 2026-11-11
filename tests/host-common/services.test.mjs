// host-common: per-job services (postgres.sh, redis.sh) against stub binaries, the build scripts'
// refusals, maintenance.sh's refusal, and the timed/sampler wrappers. node --test tests/host-common/
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, chmodSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { rendered, tmp, fixtureNames } from "./helpers.mjs";

const LINUX = rendered("linux-beta.json"); // postgres 16 (package) on 5452, redis 7 on 6391, ports 8000 5452 6391
const ACME = rendered("two-tenant-mac.json"); // postgres 16 (source) on 5442, ports 3100 3101 5442 5443

const PG_STUBS = {
  postgres: `#!/bin/bash\nif [ "\${1:-}" = "--version" ]; then echo "postgres (PostgreSQL) \${MOCK_PG_VERSION:-16.6}"; exit 0; fi\nexit 1\n`,
  initdb: `#!/bin/bash\nprintf '%s\\n' "$@" > "$STUB_LOG/initdb.args"\n`,
  pg_ctl: `#!/bin/bash\nmode=""; data=""; prev=""\nfor a in "$@"; do case "$a" in start|stop) mode="$a" ;; esac; [ "$prev" = -D ] && data="$a"; prev="$a"; done\nprintf '%s\\n' "$@" > "$STUB_LOG/pg_ctl_$mode.args"\nif [ "$mode" = start ]; then touch "$data/postmaster.pid"; else rm -f "$data/postmaster.pid"; fi\n`,
  createdb: `#!/bin/bash\nprintf '%s\\n' "$@" > "$STUB_LOG/createdb.args"\necho "PGPASSWORD=$PGPASSWORD" >> "$STUB_LOG/createdb.args"\n`,
};
const SUDO_STUB = `#!/bin/bash\nprintf '%s\\n' "$*" >> "$STUB_LOG/sudo.calls"\nexit 0\n`;

function fixture(stubs = PG_STUBS) {
  const root = tmp("homeactions-svc-");
  const f = { root, temp: path.join(root, "runner-temp"), bin: path.join(root, "bin"), log: path.join(root, "log"), sbin: path.join(root, "sbin"), ghpath: path.join(root, "github-path") };
  for (const d of [f.temp, f.bin, f.log, f.sbin]) mkdirSync(d, { recursive: true });
  writeFileSync(f.ghpath, "");
  for (const [n, s] of Object.entries(stubs)) {
    writeFileSync(path.join(f.bin, n), s);
    chmodSync(path.join(f.bin, n), 0o755);
  }
  writeFileSync(path.join(f.sbin, "sudo"), SUDO_STUB);
  chmodSync(path.join(f.sbin, "sudo"), 0o755);
  return f;
}
function sh(script, args, env) {
  const merged = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/tmp", ...env };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  const res = spawnSync("/bin/bash", [script, ...args], { env: merged, encoding: "utf8" });
  return { status: res.status, out: res.stdout + res.stderr, stdout: res.stdout, stderr: res.stderr };
}
const portFree = (port) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });

describe("services/postgres.sh", () => {
  const PG = LINUX.file("host/services/postgres.sh");
  const base = (f, extra = {}) => ({ RUNNER_TEMP: f.temp, HOMEACTIONS_PG_BIN: f.bin, HOMEACTIONS_PG_DB: "app_test", STUB_LOG: f.log, ...extra });

  test("usage: no argument or an unknown subcommand exits 2", () => {
    const f = fixture();
    for (const a of [[], ["restart"]]) {
      const r = sh(PG, a, base(f));
      assert.equal(r.status, 2);
      assert.match(r.stderr, /usage: postgres\.sh start\|stop/);
    }
  });
  for (const [why, env, msg] of [
    ["a port outside the tenant's rendered set (5432)", { HOMEACTIONS_PG_PORT: "5432" }, /must be one of the tenant's ports: 8000 5452 6391 \(got '5432'\)/],
    ["another tenant's port (5442)", { HOMEACTIONS_PG_PORT: "5442" }, /must be one of the tenant's ports/],
    ["a non-numeric port", { HOMEACTIONS_PG_PORT: "54x2" }, /must be one of the tenant's ports/],
    ["a missing RUNNER_TEMP", { RUNNER_TEMP: undefined }, /RUNNER_TEMP is not a directory/],
    ["a bad database name", { HOMEACTIONS_PG_DB: "app-db; drop" }, /HOMEACTIONS_PG_DB must look like/],
    ["a postgres of another major", { MOCK_PG_VERSION: "17.2" }, /is not PostgreSQL 16/],
  ]) {
    test(`refuses ${why}`, () => {
      const f = fixture();
      const r = sh(PG, ["start"], base(f, env));
      assert.equal(r.status, 2, r.out);
      assert.match(r.stderr, msg);
      assert.ok(!existsSync(path.join(f.log, "initdb.args")), "no binary was touched");
    });
  }
  test("refuses a missing RUNNER_TEMP even for stop", () => {
    const f = fixture();
    const r = sh(PG, ["stop"], { ...base(f), RUNNER_TEMP: path.join(f.root, "nope") });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /RUNNER_TEMP is not a directory/);
  });
  test("self-hosted without HOMEACTIONS_PG_BIN refuses and never calls sudo", () => {
    const f = fixture();
    const env = { ...base(f), HOMEACTIONS_PG_BIN: undefined, RUNNER_ENVIRONMENT: "self-hosted", PATH: `${f.sbin}:/usr/bin:/bin` };
    const r = sh(PG, ["start"], env);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /HOMEACTIONS_PG_BIN is not set/);
    assert.ok(!existsSync(path.join(f.log, "sudo.calls")));
  });
  test("github-hosted without the binaries installs them with sudo apt-get (the only sudo)", (t) => {
    if (existsSync("/usr/lib/postgresql/16/bin/postgres")) return t.skip("a real postgres 16 is installed here");
    const f = fixture();
    const env = { RUNNER_TEMP: f.temp, HOMEACTIONS_PG_DB: "app_test", STUB_LOG: f.log, RUNNER_ENVIRONMENT: "github-hosted", PATH: `${f.sbin}:/usr/bin:/bin` };
    const r = sh(PG, ["start"], env);
    assert.equal(r.status, 2, r.out);
    assert.match(r.stderr, /no postgres binary in \/usr\/lib\/postgresql\/16\/bin/);
    assert.equal(readFileSync(path.join(f.log, "sudo.calls"), "utf8"), "apt-get update -qq\napt-get install -y -qq postgresql-16\n");
  });
  for (const fx of fixtureNames) {
    const r = rendered(fx);
    if (!r.derived.hasPostgres) continue;
    test(`${fx}: sudo appears only inside the github-hosted branch`, () => {
      const lines = r.text("host/services/postgres.sh").split("\n");
      const begin = lines.findIndex((l) => l.includes(">>> github-hosted only"));
      const end = lines.findIndex((l) => l.includes("<<< github-hosted only"));
      assert.ok(begin > 0 && end > begin);
      assert.match(lines.slice(0, begin).reverse().find((l) => /^\s*(if|elif) /.test(l)), /RUNNER_ENVIRONMENT:-\}" = github-hosted/);
      lines.forEach((l, i) => {
        if (/\bsudo\b/.test(l.replace(/#.*$/, ""))) assert.ok(i > begin && i < end, `sudo outside the hosted branch at line ${i + 1}: ${l}`);
      });
    });
  }
  test("start/stop against stub binaries: loopback only, no unix socket, scram, fsync off, GITHUB_PATH", async (t) => {
    if (!(await portFree(5452))) return t.skip("127.0.0.1:5452 is in use here");
    const f = fixture();
    const env = { ...base(f), GITHUB_PATH: f.ghpath };
    const r = sh(PG, ["start"], env);
    assert.equal(r.status, 0, r.out);
    const data = path.join(f.temp, "homeactions-pg-5452");
    const initdb = readFileSync(path.join(f.log, "initdb.args"), "utf8").split("\n");
    assert.deepEqual(initdb.slice(0, 2), ["-D", data]);
    assert.ok(initdb.includes("scram-sha-256") && initdb.includes("homeactions"));
    const start = readFileSync(path.join(f.log, "pg_ctl_start.args"), "utf8");
    assert.match(start, /-p 5452 -c listen_addresses=127\.0\.0\.1 -c unix_socket_directories='' -c fsync=off/);
    const createdb = readFileSync(path.join(f.log, "createdb.args"), "utf8");
    assert.match(createdb, /^-h\n127\.0\.0\.1\n-p\n5452\n-U\nhomeactions\napp_test\nPGPASSWORD=homeactions\n$/);
    assert.equal(readFileSync(f.ghpath, "utf8"), `${f.bin}\n`);
    assert.ok(!existsSync(path.join(f.temp, "homeactions-pg-5452.pw")), "the password file is removed");
    assert.match(r.stdout, /homeactions\[lab-ci\] postgres: postgres \(PostgreSQL\) 16\.6 on 127\.0\.0\.1:5452, database app_test/);
    const s = sh(PG, ["stop"], env);
    assert.equal(s.status, 0, s.out);
    assert.match(readFileSync(path.join(f.log, "pg_ctl_stop.args"), "utf8"), /-m\nfast/);
  });
  test("refuses to start when the port is already in use", async (t) => {
    const ACME_PG = ACME.file("host/services/postgres.sh");
    const server = net.createServer();
    const ok = await new Promise((res) => {
      server.once("error", () => res(false));
      server.listen(5443, "127.0.0.1", () => res(true));
    });
    if (!ok) return t.skip("127.0.0.1:5443 is in use here");
    try {
      const f = fixture();
      const r = sh(ACME_PG, ["start"], { ...base(f), HOMEACTIONS_PG_PORT: "5443" });
      assert.equal(r.status, 2, r.out);
      assert.match(r.stderr, /127\.0\.0\.1:5443 is already in use/);
    } finally {
      await new Promise((res) => server.close(res));
    }
  });
});

describe("services/redis.sh", () => {
  const RS = LINUX.file("host/services/redis.sh");
  const REDIS_STUB = { "redis-server": `#!/bin/bash\nif [ "\${1:-}" = "--version" ]; then echo "Redis server v=\${MOCK_REDIS_VERSION:-7.4.12} sha=00000000:0 malloc=libc bits=64 build=0"; exit 0; fi\nprintf '%s\\n' "$@" > "$STUB_LOG/redis.args"\n` };
  for (const [why, env, msg] of [
    ["a port outside the tenant's rendered set", { HOMEACTIONS_REDIS_PORT: "6379" }, /must be one of the tenant's ports: 8000 5452 6391 \(got '6379'\)/],
    ["a missing RUNNER_TEMP", { RUNNER_TEMP: "" }, /RUNNER_TEMP is not a directory/],
    ["a redis of another major", { MOCK_REDIS_VERSION: "6.2.1" }, /is not Redis 7/],
  ]) {
    test(`refuses ${why}`, () => {
      const f = fixture(REDIS_STUB);
      const r = sh(RS, ["start"], { RUNNER_TEMP: f.temp, HOMEACTIONS_REDIS_BIN: f.bin, STUB_LOG: f.log, ...env });
      assert.equal(r.status, 2, r.out);
      assert.match(r.stderr, msg);
      assert.ok(!existsSync(path.join(f.log, "redis.args")));
    });
  }
  test("usage exits 2", () => {
    assert.equal(sh(RS, ["bounce"], {}).status, 2);
  });
  test("self-hosted without HOMEACTIONS_REDIS_BIN refuses and never calls sudo", () => {
    const f = fixture(REDIS_STUB);
    const r = sh(RS, ["start"], { RUNNER_TEMP: f.temp, STUB_LOG: f.log, RUNNER_ENVIRONMENT: "self-hosted", PATH: `${f.sbin}:/usr/bin:/bin` });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /HOMEACTIONS_REDIS_BIN is not set/);
    assert.ok(!existsSync(path.join(f.log, "sudo.calls")));
  });
  test("start passes loopback, protected mode, no unix socket, no persistence and a RUNNER_TEMP pidfile", async (t) => {
    if (!(await portFree(6391))) return t.skip("127.0.0.1:6391 is in use here");
    // The stub records its arguments and opens the port with a short-lived node listener.
    const f = fixture({
      "redis-server": REDIS_STUB["redis-server"].replace(
        `printf '%s\\n' "$@" > "$STUB_LOG/redis.args"\n`,
        `printf '%s\\n' "$@" > "$STUB_LOG/redis.args"\n"${process.execPath}" -e 'const s=require("net").createServer().listen(6391,"127.0.0.1");setTimeout(()=>s.close(),3000)' &\necho $! > "$RUNNER_TEMP/homeactions-redis-6391.pid"\n`,
      ),
    });
    const r = sh(RS, ["start"], { RUNNER_TEMP: f.temp, HOMEACTIONS_REDIS_BIN: f.bin, STUB_LOG: f.log });
    assert.equal(r.status, 0, r.out);
    const args = readFileSync(path.join(f.log, "redis.args"), "utf8");
    for (const want of ["--port\n6391\n", "--bind\n127.0.0.1\n", "--protected-mode\nyes\n", "--unixsocket\n\n", "--save\n\n", "--appendonly\nno\n", "--daemonize\nyes\n", `--pidfile\n${f.temp}/homeactions-redis-6391.pid\n`]) {
      assert.ok(args.includes(want), `missing ${JSON.stringify(want)} in ${args}`);
    }
    const s = sh(RS, ["stop"], { RUNNER_TEMP: f.temp, HOMEACTIONS_REDIS_BIN: f.bin, STUB_LOG: f.log });
    assert.equal(s.status, 0, s.out);
    assert.ok(!existsSync(path.join(f.temp, "homeactions-redis-6391.pid")));
  });
  for (const fx of fixtureNames) {
    const r = rendered(fx);
    if (!r.derived.hasRedis) continue;
    test(`${fx}: sudo appears only inside the github-hosted branch`, () => {
      const lines = r.text("host/services/redis.sh").split("\n");
      const begin = lines.findIndex((l) => l.includes(">>> github-hosted only"));
      const end = lines.findIndex((l) => l.includes("<<< github-hosted only"));
      assert.ok(begin > 0 && end > begin);
      assert.match(lines.slice(0, begin).reverse().find((l) => /^\s*(if|elif) /.test(l)), /RUNNER_ENVIRONMENT:-\}" = github-hosted/);
      lines.forEach((l, i) => {
        if (/\bsudo\b/.test(l.replace(/#.*$/, ""))) assert.ok(i > begin && i < end, `sudo outside the hosted branch at line ${i + 1}`);
      });
    });
  }
});

describe("build scripts and maintenance refuse to run as anyone but the tenant; no sudo anywhere", () => {
  for (const fx of fixtureNames) {
    const r = rendered(fx);
    const outs = ["host/maintenance.sh", ...(r.derived.hasPostgres ? ["host/services/build-postgres.sh"] : []), ...(r.derived.hasRedis ? ["host/services/build-redis.sh"] : [])];
    for (const o of outs) {
      test(`${fx}: ${o}`, () => {
        const res = sh(r.file(o), [], {});
        assert.notEqual(res.status, 0);
        assert.match(res.out, new RegExp(`run (this )?as ${r.profile.tenant.user}`));
        assert.doesNotMatch(r.text(o).replace(/#.*$/gm, ""), /\bsudo\b/);
      });
    }
    test(`${fx}: build scripts build from pinned, checksum-verified source at nice 10 on half the cores`, () => {
      for (const kind of ["postgres", "redis"]) {
        if (!r.derived[kind === "postgres" ? "hasPostgres" : "hasRedis"]) continue;
        const text = r.text(`host/services/build-${kind}.sh`);
        const svc = r.derived[kind];
        assert.ok(text.includes(`V="${svc.version}"`), kind);
        assert.ok(text.includes(`PREFIX="${svc.prefix}"`), kind);
        assert.match(text, /\$SHACMD -c -/);
        assert.match(text, /nice -n 10 make -j"\$JOBS"/);
        assert.match(text, /JOBS=\$\(\( CORES \/ 2 \)\)/);
        assert.ok(text.includes(`CORES=${r.profile.host.cores}`));
        assert.match(text, /if \[ "\$waited" -ge 1800 \]/, "bounded 30-minute co-tenant wait");
        assert.match(text, /rm -rf "(postgresql|redis)-\$V" "\$TARBALL"\nlog /, "sources deleted after the build");
      }
    });
  }
});

describe("smoke wrappers", () => {
  test("timed.sh streams the command, keeps its exit status and appends a TSV row", () => {
    const d = tmp();
    const out = path.join(d, "t.tsv");
    const r = sh(ACME.file("host/smoke/timed.sh"), ["unit tests", out, "--", "/bin/sh", "-c", "echo hello; echo oops >&2; exit 3"], { TMPDIR: d });
    assert.equal(r.status, 3, r.out);
    assert.match(r.stdout, /hello/);
    assert.match(r.stderr, /oops/);
    const row = readFileSync(out, "utf8").trimEnd().split("\t");
    assert.equal(row[0], "unit tests");
    assert.equal(row[1], "3");
    assert.match(row[2], /^\d+$/);
    assert.match(row[3], /^(\d+|unknown)$/);
    if (process.platform === "darwin") assert.match(row[3], /^\d+$/, "macOS /usr/bin/time -l reports max RSS");
  });
  test("timed.sh needs <label> <out> -- <command>", () => {
    assert.equal(sh(ACME.file("host/smoke/timed.sh"), ["x", "y", "true"], {}).status, 2);
  });
  test("sample-pressure.sh writes epoch, pressure, load1, swap rows", () => {
    const d = tmp();
    const out = path.join(d, "p.tsv");
    const r = sh(ACME.file("host/smoke/sample-pressure.sh"), [out, "0", "2"], {});
    assert.equal(r.status, 0, r.out);
    const rows = readFileSync(out, "utf8").trimEnd().split("\n");
    assert.equal(rows.length, 2);
    for (const row of rows) assert.match(row, /^\d{10}\t\d+\t[0-9.,]+\t(\d+|unknown)$/);
  });
  test("smoke-probes.sh checks every item the runbook names", () => {
    const text = ACME.text("host/smoke/smoke-probes.sh");
    for (const want of ["identity", "forbidden-read", "/opt/homebrew", "network-probe", "api.github.com/zen", "root_immutable_problem", "ulimit -n", "nice", "TMPDIR", "PLAYWRIGHT_BROWSERS_PATH", "XDG_CACHE_HOME", "mdfind -onlyin \"$HOME\" -count 'kMDItemFSName == \"package.json\"'", "unavailable", "svc_loopback postgres"]) {
      assert.ok(text.includes(want), want);
    }
  });
});
