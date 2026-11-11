// Shared helpers for the provisioner tests: render fixtures into temp dirs, build a stub PATH whose
// privileged commands only record their calls, and run a rendered script under it. Zero dependencies.
// Nothing here ever runs a real privileged command: every script runs with --dry-run under a PATH
// whose first entry shadows sudo and friends with recorders.
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, chmodSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { renderKit, derive } from "../../skills/homeactions/kit/render.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FIXTURES = path.join(ROOT, "fixtures", "profiles");
export const fixtureNames = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort();
export const loadFixture = (f) => JSON.parse(readFileSync(path.join(FIXTURES, f), "utf8"));
export const tmp = (p = "homeactions-prov-") => mkdtempSync(path.join(tmpdir(), p));

const cache = new Map();
/** Render a profile once per process; returns { dir, host, profile, d }. */
export function rendered(profile, key = JSON.stringify(profile)) {
  if (cache.has(key)) return cache.get(key);
  const dir = tmp();
  renderKit(profile, dir);
  const r = { dir, host: path.join(dir, "host"), profile, d: derive(profile) };
  cache.set(key, r);
  return r;
}
export const renderedFixture = (f) => rendered(loadFixture(f), f);

// Every command a provisioner might use to change the machine. Each stub appends its argv to $STUB_LOG.
export const RECORDED = [
  "sudo", "dscl", "dseditgroup", "sysadminctl", "createhomedir", "launchctl", "pfctl", "chflags", "chmod", "chown",
  "install", "curl", "tar", "shasum", "sha256sum", "pkill", "pgrep", "kill", "killall", "plutil", "PlistBuddy",
  "rm", "cp", "mv", "mkdir", "ln", "tee", "touch", "useradd", "groupadd", "userdel", "groupdel", "usermod",
  "setfacl", "getfacl", "chattr", "systemctl", "systemd-analyze", "nft", "apt-get", "dnf", "getent", "ss",
  "netstat", "fdesetup", "runuser", "nc", "ps", "csrutil", "mktemp", "env",
];

let stubDir;
/** A directory of recording stubs plus an `id` stub driven by STUB_* variables. */
export function stubs() {
  if (stubDir) return stubDir;
  stubDir = tmp("homeactions-stubs-");
  for (const c of RECORDED) {
    const p = path.join(stubDir, c);
    writeFileSync(p, `#!/bin/bash\nprintf '%s\\n' "${c} $*" >> "\${STUB_LOG:-/dev/null}"\nexit 0\n`);
    chmodSync(p, 0o755);
  }
  const id = path.join(stubDir, "id");
  writeFileSync(
    id,
    `#!/bin/bash
# id stub: the caller is STUB_USER/STUB_UID (default: a non-root admin owner); the tenant exists only
# when STUB_TENANT_GROUPS is set (its groups).
case "$#:$1" in
  "1:-u") echo "\${STUB_UID:-501}" ;;
  "1:-un") echo "\${STUB_USER:-owner}" ;;
  "1:-Gn") echo "staff admin" ;;
  "2:-Gn") if [ -n "\${STUB_TENANT_GROUPS:-}" ]; then echo "$STUB_TENANT_GROUPS"; else echo "id: $2: no such user" >&2; exit 1; fi ;;
  "2:-u") if [ -n "\${STUB_TENANT_GROUPS:-}" ]; then echo 4242; else exit 1; fi ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(id, 0o755);
  return stubDir;
}

/** Run a rendered host script with bash under the stub PATH. Returns { status, out, err, calls }. */
export function runScript(script, args, env = {}) {
  const log = path.join(tmp("homeactions-log-"), "calls.log");
  const home = tmp("homeactions-owner-home-");
  const res = spawnSync("/bin/bash", [script, ...args], {
    encoding: "utf8",
    input: "",
    timeout: 30000,
    env: { PATH: `${stubs()}:/usr/bin:/bin`, HOME: home, STUB_LOG: log, LANG: "C", ...env },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  rmSync(path.dirname(log), { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  return { status: res.status, out: res.stdout ?? "", err: res.stderr ?? "", calls };
}

/** The printed command lines ("+ …") of a dry-run transcript. */
export const commandLines = (out) => out.split("\n").filter((l) => l.startsWith("+ "));

/** Split a printed command line back into words (handles the single quoting the scripts emit). */
export function words(line) {
  const s = line.replace(/^\+ /, "");
  const out = [];
  let cur = "";
  let inq = false;
  let any = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inq) {
      if (c === "'") inq = false;
      else cur += c;
    } else if (c === "'") {
      inq = true;
      any = true;
    } else if (c === "\\" && s[i + 1] === "'") {
      cur += "'";
      i++;
    } else if (c === " ") {
      if (cur || any) out.push(cur);
      cur = "";
      any = false;
    } else cur += c;
  }
  if (cur || any) out.push(cur);
  return out;
}

export function has(cmd) {
  return spawnSync("/bin/sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
}

export function cleanupAll() {
  for (const r of cache.values()) rmSync(r.dir, { recursive: true, force: true });
  cache.clear();
  if (stubDir) rmSync(stubDir, { recursive: true, force: true });
  stubDir = undefined;
}

export { mkdirSync, writeFileSync, readFileSync, existsSync, path };
