// host-common: hooks/lib.sh, driven function by function in bash with fixtures and overrides
// (pid_alive, sleep, date, id, memory_pressure_level, swap_used_mb ...). node --test tests/host-common/
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, chmodSync, existsSync, readdirSync, symlinkSync, readFileSync } from "node:fs";
import path from "node:path";
import { rendered, bash, tmp, IS_ROOT } from "./helpers.mjs";

const R = rendered("two-tenant-mac.json");
const LIB = R.file("host/hooks/lib.sh");
const run = (code, env) => bash(code, { lib: LIB, env });

describe("json_int_field", () => {
  const cases = [
    ["pid first", `{"pid":4242,"kind":"busy","epoch":1700000000}`, "pid", "int", "4242"],
    ["pid last", `{"kind":"busy","epoch":1700000000,"pid":4242}`, "pid", "int", "4242"],
    ["spaces and newlines", `{ "kind": "busy",\n  "pid": 4242 }\n`, "pid", "int", "4242"],
    ["a quoted numeric string", `{"pid":"4242"}`, "pid", "int", "4242"],
    ["a fractional epoch drops the fraction", `{"epoch":1700000000.75}`, "epoch", "epoch", "1700000000"],
    ["a negative epoch", `{"epoch":-5}`, "epoch", "epoch", "-5"],
    ["an escaped \\\"pid\\\": inside another string is not the field", `{"id":"x\\"pid\\":99","pid":12}`, "pid", "int", "12"],
    ["escaped quotes before the real field", `{"pid":12,"id":"a\\"pid\\":99"}`, "pid", "int", "12"],
  ];
  for (const [name, body, key, kind, want] of cases) {
    test(name, () => {
      const d = tmp();
      writeFileSync(path.join(d, "m"), body);
      const r = run(`json_int_field "${d}/m" ${key} ${kind}`);
      assert.equal(r.status, 0, r.out);
      assert.equal(r.stdout, `${want}\n`);
    });
  }
  for (const [name, body] of [
    ["malformed (not an object)", `pid=12`],
    ["truncated", `{"pid":12`],
    ["missing key", `{"kind":"busy"}`],
    ["non-numeric", `{"pid":"abc"}`],
    ["empty", ``],
  ]) {
    test(`${name} -> exit 1, no output`, () => {
      const d = tmp();
      writeFileSync(path.join(d, "m"), body);
      const r = run(`json_int_field "${d}/m" pid int`);
      assert.equal(r.status, 1);
      assert.equal(r.stdout, "");
    });
  }
  test("a missing file -> exit 1", () => {
    assert.equal(run(`json_int_field /nonexistent/marker pid int`).status, 1);
  });
});

describe("cotenant_hold (marker-dir)", () => {
  const NOW = 1700000000;
  const BOUND = 2400;
  const hold = (dir, extra = "") =>
    run(`${extra}\nHA_COTENANT_MODE=marker-dir HA_COTENANT_MARKER_DIR="${dir}" HA_COTENANT_PID_GLOB='device.*.busy' HA_COTENANT_EPOCH_FILE=device.want HA_COTENANT_EPOCH_BOUND=${BOUND}\ncotenant_hold ${NOW}; echo "rc=$?"`);
  const alive = (pids) => `pid_alive() { case " ${pids} " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }`;
  const mk = (files) => {
    const d = tmp();
    for (const [n, b] of Object.entries(files)) writeFileSync(path.join(d, n), b);
    return d;
  };

  test("a busy marker whose pid is alive is a hold", () => {
    const d = mk({ "device.phone1.busy": `{"kind":"device","id":"phone1","epoch":1,"pid":4242}` });
    assert.equal(hold(d, alive("4242")).stdout, "cotenant marker device.phone1.busy (pid 4242)\nrc=0\n");
  });
  test("a busy marker whose pid is dead is not a hold (never judged by age)", () => {
    const d = mk({ "device.phone1.busy": `{"epoch":${NOW},"pid":4242}` });
    assert.equal(hold(d, alive("1")).stdout, "rc=0\n");
  });
  test("pid 0 or a missing pid is not a hold", () => {
    const d = mk({ "device.a.busy": `{"pid":0}`, "device.b.busy": `{"epoch":1}` });
    assert.equal(hold(d, `pid_alive() { return 0; }`).stdout, "rc=0\n");
  });
  test(".tmp- files are ignored", () => {
    const d = mk({ ".tmp-device.a.busy": `{"pid":4242}`, "device.a.busy.tmp-99": `{"pid":4242}` });
    assert.equal(hold(d, alive("4242")).stdout, "rc=0\n");
  });
  test("a malformed marker is not a hold", () => {
    const d = mk({ "device.a.busy": `garbage`, "device.want": `{{{` });
    assert.equal(hold(d, alive("4242")).stdout, "rc=0\n");
  });
  test("the real pid_alive sees this process as alive", () => {
    const d = mk({ "device.self.busy": `{"pid":${process.pid}}` });
    assert.match(hold(d).stdout, /^cotenant marker device\.self\.busy/);
  });
  for (const [age, live] of [[0, true], [BOUND, true], [BOUND + 1, false], [-1, false]]) {
    test(`want marker aged ${age}s -> ${live ? "hold" : "clear"}`, () => {
      const d = mk({ "device.want": `{"kind":"want","epoch":${NOW - age}}` });
      const r = hold(d, alive(""));
      assert.equal(r.stdout, live ? `cotenant intent device.want (${age}s old)\nrc=0\n` : "rc=0\n");
    });
  }
  test("a missing marker directory is not a hold", () => {
    assert.equal(hold(path.join(tmp(), "does-not-exist")).stdout, "rc=0\n");
  });
  test("an UNREADABLE marker directory is 'unreadable' (rc 2), never clear", (t) => {
    if (IS_ROOT) return t.skip("root reads everything");
    const d = mk({ "device.a.busy": `{"pid":4242}` });
    chmodSync(d, 0o000);
    const r = hold(d, alive("4242"));
    chmodSync(d, 0o755);
    assert.equal(r.stdout, `unreadable: ${d}\nrc=2\n`);
  });
  test("a marker directory under an unsearchable parent is 'unreadable', not missing", (t) => {
    if (IS_ROOT) return t.skip("root reads everything");
    const parent = tmp();
    mkdirSync(path.join(parent, "busy"));
    chmodSync(parent, 0o000);
    const r = hold(path.join(parent, "busy"));
    chmodSync(parent, 0o755);
    assert.match(r.stdout, /^unreadable: .*cannot search.*\nrc=2\n$/);
  });
  test("an UNREADABLE marker file is 'unreadable' (rc 2)", (t) => {
    if (IS_ROOT) return t.skip("root reads everything");
    const d = mk({ "device.a.busy": `{"pid":4242}` });
    chmodSync(path.join(d, "device.a.busy"), 0o000);
    const r = hold(d, alive("4242"));
    assert.equal(r.stdout, `unreadable: ${d}/device.a.busy\nrc=2\n`);
  });
  test("an UNREADABLE want file is 'unreadable' (rc 2)", (t) => {
    if (IS_ROOT) return t.skip("root reads everything");
    const d = mk({ "device.want": `{"epoch":${NOW}}` });
    chmodSync(path.join(d, "device.want"), 0o000);
    assert.equal(hold(d).stdout, `unreadable: ${d}/device.want\nrc=2\n`);
  });
});

describe("cotenant_hold (command and none)", () => {
  const cmd = (c) => run(`HA_COTENANT_MODE=command HA_COTENANT_COMMAND='${c}'\ncotenant_hold 1; echo "rc=$?"`);
  const script = (body, mode = 0o755) => {
    const p = path.join(tmp(), "check");
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, mode);
    return p;
  };
  test("exit 0 -> clear", () => assert.equal(cmd(script("exit 0")).stdout, "rc=0\n"));
  test("exit 1 -> busy", () => assert.equal(cmd(script("exit 1")).stdout, "cotenant busy (check exit 1)\nrc=0\n"));
  test("arguments are passed", () => assert.equal(cmd(`${script('[ "$1" = go ] && exit 0; exit 3')} go`).stdout, "rc=0\n"));
  test("a missing command -> unreadable", () => assert.match(cmd("/nonexistent/busy-check").stdout, /^unreadable: \/nonexistent\/busy-check is missing or not executable\nrc=2\n$/));
  test("a non-executable command -> unreadable", () => assert.match(cmd(script("exit 0", 0o644)).stdout, /^unreadable: .* is missing or not executable\nrc=2\n$/));
  test("an empty command -> unreadable", () => assert.match(cmd("").stdout, /^unreadable: no co-tenant command configured\nrc=2\n$/));
  test("a hanging command is bounded and reported unreadable", () => {
    const r = run(`HA_COTENANT_MODE=command HA_COTENANT_COMMAND_TIMEOUT=1 HA_COTENANT_COMMAND='${script("sleep 20")}'\ncotenant_hold 1; echo "rc=$?"`);
    assert.match(r.stdout, /timed out\nrc=2\n$/);
  });
  test("mode none -> clear", () => assert.equal(run(`HA_COTENANT_MODE=none\ncotenant_hold 1; echo "rc=$?"`).stdout, "rc=0\n"));
});

describe("yield_reason order", () => {
  const yr = (pre) => run(`${pre}\nyield_reason 1; echo "rc=$?"`).stdout;
  test("co-tenant hold first, even under critical pressure", () => {
    assert.equal(yr(`cotenant_hold() { echo "cotenant marker x"; }; memory_pressure_level() { echo 4; }`), "cotenant marker x\nrc=0\n");
  });
  test("unreadable co-tenant signal -> rc 2", () => {
    assert.equal(yr(`cotenant_hold() { echo "unreadable: d"; return 2; }`), "unreadable: d\nrc=2\n");
  });
  test("then memory pressure critical", () => {
    assert.equal(yr(`cotenant_hold() { :; }; memory_pressure_level() { echo 4; }; swap_used_mb() { echo 99999; }; HA_SWAP_YIELD_MB=10`), "memory pressure critical\nrc=0\n");
  });
  test("then swap over the threshold", () => {
    assert.equal(yr(`cotenant_hold() { :; }; memory_pressure_level() { echo 2; }; swap_used_mb() { echo 2000; }; HA_SWAP_YIELD_MB=1775`), "swap used 2000 MB over 1775 MB\nrc=0\n");
  });
  test("swap yield off when the threshold is 0, and unknown swap never yields", () => {
    assert.equal(yr(`cotenant_hold() { :; }; memory_pressure_level() { echo 1; }; swap_used_mb() { echo 99999; }; HA_SWAP_YIELD_MB=0`), "rc=0\n");
    assert.equal(yr(`cotenant_hold() { :; }; memory_pressure_level() { echo 1; }; swap_used_mb() { :; }; HA_SWAP_YIELD_MB=10`), "rc=0\n");
  });
});

describe("run_yield", () => {
  const job = (state, runId, extra = "") =>
    run(
      `HA_YIELD_STATE_DIR="${state}" HA_YIELD_BUDGET_SECONDS=60 HA_YIELD_POLL_SECONDS=15 GITHUB_RUN_ID=${runId} GITHUB_RUN_ATTEMPT=1
       sleep() { :; }; date() { echo 1700000000; }
       yield_reason() { echo "cotenant marker device.a.busy"; }
       ${extra}
       run_yield; echo "waited=$YIELD_WAITED first=$YIELD_FIRST_REASON"`,
    );
  test("one budget per run attempt, shared by the run's jobs; a new run gets a fresh one", () => {
    const state = tmp();
    const j1 = job(state, 111);
    assert.match(j1.stdout, /yielding to cotenant marker device\.a\.busy \(up to 60s left/);
    assert.match(j1.stdout, /waited=60 first=cotenant marker device\.a\.busy\n$/);
    assert.equal(readFileSync(path.join(state, "111-1"), "utf8"), "60\n");
    const j2 = job(state, 111);
    assert.match(j2.stdout, /run budget of 60s spent; starting anyway under: cotenant marker device\.a\.busy \(fail-open\)/);
    assert.match(j2.stdout, /waited=0 first=\n$/);
    assert.match(job(state, 222).stdout, /waited=60 /);
  });
  test("a garbage state file counts as 0 used", () => {
    const state = tmp();
    writeFileSync(path.join(state, "333-1"), "not a number\n");
    assert.match(job(state, 333).stdout, /waited=60 /);
  });
  test("a hold that clears stops the wait early; no hold waits 0 and logs nothing", () => {
    const state = tmp();
    const counter = path.join(tmp(), "n");
    const r = job(state, 444, `yield_reason() { n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${counter}"; [ "$n" -le 2 ] && echo "memory pressure critical"; return 0; }`);
    assert.match(r.stdout, /waited=30 first=memory pressure critical\n$/);
    const quiet = job(state, 555, `yield_reason() { :; }`);
    assert.equal(quiet.stdout, "waited=0 first=\n");
  });
  test("a signal that turns unreadable mid-wait warns and starts (fail-open)", () => {
    const r = job(tmp(), 666, `yield_reason() { echo "unreadable: d"; return 2; }`);
    assert.match(r.stdout, /::warning::homeactions\[acme-ci\] co-tenant signal became unreadable: d; starting without waiting/);
    assert.match(r.stdout, /waited=0 /);
  });
});

describe("process selection", () => {
  // pid ppid args, as `ps -U <uid> -o pid=,ppid=,args=` prints them. The hook is 500.
  const PS = [
    "  100     1 /Users/acme-ci/actions-runner.noindex/bin/Runner.Listener run --startuptype service",
    "  101   100 /Users/acme-ci/actions-runner.noindex/bin/Runner.Worker spawnclient 123 456",
    "  102   101 /bin/bash /Library/AcmeCI/hooks/job-started.sh",
    "  500   102 /bin/bash /Library/AcmeCI/hooks/job-started.sh",
    "  501   500 ps -U 510 -o pid=,ppid=,args=",
    "  502   500 awk -v self=500",
    "  103     1 /bin/bash /Users/acme-ci/actions-runner.noindex/runsvc.sh",
    "  104     1 node /Users/acme-ci/actions-runner.noindex/bin/RunnerService.js",
    "  105     1 /usr/libexec/secinitd",
    "  106     1 /System/Library/Frameworks/CoreServices.framework/cfprefsd agent",
    "  107     1 /usr/sbin/distnoted agent",
    "  108     1 /Library/Apple/System/Library/thing",
    "  109     1 /lib/systemd/systemd --user",
    "  110   109 (sd-pam)",
    "  111   109 /usr/bin/dbus-daemon",
    "  200     1 /Users/acme-ci/cache.noindex/ms-playwright/chromium-1140/chrome-mac/Chromium --headless",
    "  201     1 node /Users/acme-ci/actions-runner.noindex/_work/app/app/node_modules/.bin/next dev -p 3100",
    "  202     1 /Users/acme-ci/opt/postgresql-16/bin/postgres -D /Users/acme-ci/actions-runner.noindex/_work/_temp/homeactions-pg-5442 -p 5442",
    "  203   202 postgres: checkpointer",
    "  204     1 /bin/bash -c sleep 1000",
    "  205     1 /Users/acme-ci/opt/redis/bin/redis-server 127.0.0.1:6390",
  ].join("\n");
  test("reap_candidates spares self, ancestors, descendants, the runner and OS agents; reaps the rest", () => {
    const r = run(`reap_candidates 500 <<'EOF'\n${PS}\nEOF`);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.stdout.trim().split("\n"), ["200", "201", "202", "203", "204", "205"]);
  });
  test("postmaster_pids finds only the postmaster (postgres ... -D)", () => {
    assert.equal(run(`postmaster_pids <<'EOF'\n${PS}\nEOF`).stdout, "202\n");
  });
  test("redis_pids finds redis-server", () => {
    assert.equal(run(`redis_pids <<'EOF'\n${PS}\nEOF`).stdout, "205\n");
  });
});

describe("listeners", () => {
  test("listeners_on_ports: macOS netstat -an -p tcp lines", () => {
    const NETSTAT = [
      "Active Internet connections (including servers)",
      "Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)",
      "tcp4       0      0  127.0.0.1.5442         *.*                    LISTEN",
      "tcp46      0      0  *.3100                 *.*                    LISTEN",
      "tcp6       0      0  ::1.3101               *.*                    LISTEN",
      "tcp4       0      0  127.0.0.1.54420        *.*                    LISTEN",
      "tcp4       0      0  127.0.0.1.5442         127.0.0.1.61000        ESTABLISHED",
      "tcp4       0      0  *.22                   *.*                    LISTEN",
    ].join("\n");
    assert.equal(run(`listeners_on_ports "3100 3101 5442 5443" <<'EOF'\n${NETSTAT}\nEOF`).stdout, "127.0.0.1.5442\n*.3100\n::1.3101\n");
  });
  test("listeners_on_ports: Linux ss -ltnH lines (and netstat -ltn)", () => {
    const SS = [
      "LISTEN 0      4096       127.0.0.1:5452      0.0.0.0:*",
      "LISTEN 0      511             [::]:8000         [::]:*",
      "LISTEN 0      128          0.0.0.0:22        0.0.0.0:*",
      "LISTEN 0      128    127.0.0.53%lo:53        0.0.0.0:*",
      "LISTEN 0      128                *:6391            *:*",
      "tcp        0      0 127.0.0.1:5452          0.0.0.0:*               LISTEN",
    ].join("\n");
    assert.equal(run(`listeners_on_ports "8000 5452 6391" <<'EOF'\n${SS}\nEOF`).stdout, "127.0.0.1:5452\n[::]:8000\n*:6391\n127.0.0.1:5452\n");
  });
  test("nonloopback_listeners (lsof -Fn)", () => {
    const LSOF = ["p201", "f23", "n127.0.0.1:3100", "f24", "n[::1]:3101", "f25", "n*:3100", "f26", "n203.0.113.7:8000", "f27", "nlocalhost:5442", "n[::ffff:127.0.0.1]:9"].join("\n");
    assert.equal(run(`nonloopback_listeners <<'EOF'\n${LSOF}\nEOF`).stdout, "*:3100\n203.0.113.7:8000\n");
  });
  test("is_loopback_addr accepts both spellings and rejects wildcards", () => {
    const r = run(`for a in 127.0.0.1.5442 ::1.3101 '[::1]:8000' 127.0.0.1:5452 '*.3100' '[::]:8000' '*:6391' 0.0.0.0:22; do is_loopback_addr "$a" && echo "y $a" || echo "n $a"; done`);
    assert.equal(r.stdout, "y 127.0.0.1.5442\ny ::1.3101\ny [::1]:8000\ny 127.0.0.1:5452\nn *.3100\nn [::]:8000\nn *:6391\nn 0.0.0.0:22\n");
  });
});

describe("host readers", () => {
  test("disk_free_kb is a positive integer for a real directory, empty for a missing one", () => {
    assert.match(run(`disk_free_kb "${tmp()}"`).stdout, /^[1-9][0-9]*\n$/);
    assert.equal(run(`disk_free_kb /nonexistent/x`).stdout, "");
  });
  test("parse_swapusage_mb: macOS sysctl vm.swapusage strings", () => {
    assert.equal(run(`echo 'total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)' | parse_swapusage_mb`).stdout, "1024\n");
    assert.equal(run(`echo 'total = 4096.00M  used = 1.50G  free = 2560.00M  (encrypted)' | parse_swapusage_mb`).stdout, "1536\n");
    assert.equal(run(`echo 'total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)' | parse_swapusage_mb`).stdout, "0\n");
  });
  test("parse_meminfo_swap_mb: a /proc/meminfo sample", () => {
    const MEM = "MemTotal:       32768000 kB\nMemFree:         1000000 kB\nSwapCached:            0 kB\nSwapTotal:       8388604 kB\nSwapFree:        6291452 kB\n";
    assert.equal(run(`parse_meminfo_swap_mb <<'EOF'\n${MEM}EOF`).stdout, "2048\n");
    assert.equal(run(`echo 'MemTotal: 1 kB' | parse_meminfo_swap_mb`).stdout, "");
  });
  test("psi_level maps /proc/pressure/memory some avg10 to 1/2/4", () => {
    const psi = (v) => run(`printf 'some avg10=${v} avg60=0.00 avg300=0.00 total=1\\nfull avg10=99.00 avg60=0.00 avg300=0.00 total=1\\n' | psi_level`).stdout;
    assert.equal(psi("0.00"), "1\n");
    assert.equal(psi("12.50"), "2\n");
    assert.equal(psi("41.00"), "4\n");
  });
  test("memory_pressure_level and load1 read the real host (a level and a number)", () => {
    assert.match(run(`memory_pressure_level`).stdout, /^[0-9]+\n$/);
    assert.match(run(`load1`).stdout, /^[0-9]+([.,][0-9]+)?\n$/);
  });
  test("ipc_ids reads both the macOS and the Linux ipcs formats", () => {
    const MAC = "IPC status from <running system> as of Thu Nov 12 08:00:00 UTC 2026\nT     ID     KEY        MODE       OWNER    GROUP\nShared Memory:\nm  65536 0x0052e2c1 --rw-------  acme-ci  acme-ci\nm  65537 0x00000000 --rw-------  other    other\n";
    const LIN = "\n------ Shared Memory Segments --------\nkey        shmid      owner      perms      bytes      nattch     status\n0x0052e2c1 32769      lab-ci     600        56         6\n0x00000000 32770      other      600        56         6\n";
    assert.equal(run(`ipc_ids m acme-ci <<'EOF'\n${MAC}EOF`).stdout, "65536\n");
    assert.equal(run(`ipc_ids m lab-ci <<'EOF'\n${LIN}EOF`).stdout, "32769\n");
  });
  test("worker_probe_count is 0 when not configured or nothing matches", () => {
    assert.equal(run(`HA_WORKER_PROBE_USER= HA_WORKER_PROBE_PATTERN=; worker_probe_count`).stdout, "0\n");
    assert.equal(run(`HA_WORKER_PROBE_USER=nobody HA_WORKER_PROBE_PATTERN='no-such-process-xyz'; worker_probe_count`).stdout, "0\n");
  });
});

describe("workspace_wipe", () => {
  const setup = () => {
    const work = path.join(tmp(), "_work");
    for (const d of ["app/app/node_modules", "app/app/.next", "_tool/node/24.10.0", "_temp", "_actions/x", "other/other"]) mkdirSync(path.join(work, d), { recursive: true });
    writeFileSync(path.join(work, "app/app/package.json"), "{}");
    writeFileSync(path.join(work, "app/stray"), "x");
    return work;
  };
  test("deletes the contents of _work/<repo> and nothing else", () => {
    const work = setup();
    const r = run(`workspace_wipe "${work}" "${work}/app/app"`);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.stdout, `${work}/app\n`);
    assert.deepEqual(readdirSync(path.join(work, "app")), []);
    for (const keep of ["_tool/node/24.10.0", "_temp", "_actions/x", "other/other"]) assert.ok(existsSync(path.join(work, keep)), keep);
  });
  test("refuses a workspace outside _work, a runner _ directory, a .. path and a symlink", () => {
    const work = setup();
    const outside = tmp();
    writeFileSync(path.join(outside, "keep"), "x");
    symlinkSync(outside, path.join(work, "linked"));
    for (const ws of [`${outside}/x`, `${work}/_tool/node`, `${work}/app/../_tool`, `${work}/linked/linked`]) {
      const r = run(`workspace_wipe "${work}" "${ws}"; echo "rc=$?"`);
      assert.match(r.stdout, /not wiped\n.*rc=1\n$|not wiped\nrc=1\n$/s, `${ws}: ${r.out}`);
    }
    assert.ok(existsSync(path.join(outside, "keep")));
    assert.ok(existsSync(path.join(work, "_tool/node/24.10.0")));
  });
  test("an empty workspace or a missing directory is a no-op", () => {
    const work = setup();
    assert.equal(run(`workspace_wipe "${work}" ""; echo "rc=$?"`).stdout, "rc=0\n");
    assert.equal(run(`workspace_wipe "${work}" "${work}/gone/gone"; echo "rc=$?"`).stdout, "rc=0\n");
  });
});

describe("identity and wiring checks", () => {
  const ID = (un, gn, gs, u = 510) => `id() { case "$1" in -un) echo ${un} ;; -u) echo ${u} ;; -gn) echo ${gn} ;; -Gn) echo "${gs}" ;; esac; }`;
  const conf = `HA_USER=acme-ci HA_UID=510 HA_GROUP=acme-ci HA_FORBIDDEN_GROUPS="admin wheel staff"`;
  test("check_identity passes for the tenant in its own group", () => {
    assert.equal(run(`${conf}; ${ID("acme-ci", "acme-ci", "acme-ci everyone")}; check_identity; echo ok`).stdout, "ok\n");
  });
  for (const [why, args, msg] of [
    ["the wrong user", ["someone", "acme-ci", "acme-ci"], /running as someone, not acme-ci/],
    ["the wrong uid", ["acme-ci", "acme-ci", "acme-ci", 999], /uid is 999, not 510/],
    ["the wrong primary group", ["acme-ci", "staff", "staff"], /primary group is staff, not acme-ci/],
    ["an admin group", ["acme-ci", "acme-ci", "acme-ci admin everyone"], /member of group admin/],
  ]) {
    test(`check_identity fails on ${why}`, () => {
      const r = run(`${conf}; ${ID(...args)}; check_identity; echo unreachable`);
      assert.equal(r.status, 1);
      assert.match(r.stdout, /^::error::homeactions\[acme-ci\] /);
      assert.match(r.stdout, msg);
      assert.doesNotMatch(r.stdout, /unreachable/);
    });
  }
  test("root_immutable_problem: missing, not root-owned (a file of ours), and an overridden root+immutable file", () => {
    const d = tmp();
    writeFileSync(path.join(d, ".env"), "A=1\n");
    assert.equal(run(`root_immutable_problem "${d}/nope"`).stdout, `${d}/nope is missing\n`);
    if (!IS_ROOT) assert.equal(run(`root_immutable_problem "${d}/.env"`).stdout, `${d}/.env is not owned by root\n`);
    assert.equal(run(`file_owner() { echo root; }; file_immutable() { return 0; }; root_immutable_problem "${d}/.env"`).stdout, "");
    assert.match(run(`file_owner() { echo root; }; file_immutable() { return 1; }; root_immutable_problem "${d}/.env"`).stdout, /is not immutable/);
    // Linux without lsattr: owner root and a mode that is not group/other-writable
    assert.equal(run(`file_owner() { echo root; }; file_immutable() { return 3; }; file_mode() { echo 644; }; root_immutable_problem "${d}/.env"`).stdout, "");
    assert.match(run(`file_owner() { echo root; }; file_immutable() { return 3; }; file_mode() { echo 664; }; root_immutable_problem "${d}/.env"`).stdout, /group\/other-writable \(mode 664\)/);
    assert.match(run(`file_owner() { echo root; }; file_immutable() { return 3; }; file_mode() { echo 646; }; root_immutable_problem "${d}/.env"`).stdout, /group\/other-writable/);
  });
  test("network_probe fails when a probe target connects, passes when refused", async () => {
    const net = await import("node:net");
    const server = net.createServer();
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    const port = server.address().port;
    try {
      const open = run(`HA_PROBES="127.0.0.1:${port}" HA_FIREWALL_LABEL=com.example.acme-ci.firewall; id() { echo acme-ci; }; network_probe; echo unreachable`);
      assert.equal(open.status, 1, open.out);
      assert.match(open.stdout, new RegExp(`network isolation is not active: acme-ci reached 127\\.0\\.0\\.1:${port}`));
    } finally {
      await new Promise((res) => server.close(res));
    }
    const closed = run(`HA_PROBES="127.0.0.1:${port}"; network_probe; echo passed`);
    assert.equal(closed.stdout, "passed\n");
  });
});
