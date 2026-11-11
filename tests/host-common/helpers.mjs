// Shared helpers for the host-common tests: render each fixture once per test file, and drive the
// rendered bash with stubs. Zero dependencies.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { renderKit, derive } from "../../skills/homeactions/kit/render.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const KIT = path.join(ROOT, "skills", "homeactions", "kit");
export const FIXTURES = path.join(ROOT, "fixtures", "profiles");
export const fixtureNames = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort();
export const loadFixture = (f) => JSON.parse(readFileSync(path.join(FIXTURES, f), "utf8"));
export const COMMON_MANIFEST = JSON.parse(readFileSync(path.join(KIT, "manifest.d", "10-common.json"), "utf8"));
export const IS_MAC = process.platform === "darwin";
export const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

const temps = [];
export function tmp(prefix = "homeactions-hc-") {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  temps.push(d);
  return d;
}
export function cleanup() {
  for (const d of temps.splice(0)) {
    spawnSync("chmod", ["-R", "u+rwx", d]);
    rmSync(d, { recursive: true, force: true });
  }
}
process.on("exit", cleanup);

const renders = new Map();
/** Render a fixture (cached per process): { out, profile, derived, file(rel), text(rel) }. */
export function rendered(name) {
  if (!renders.has(name)) {
    const profile = loadFixture(name);
    const out = tmp("homeactions-render-");
    const record = renderKit(profile, out);
    renders.set(name, {
      out,
      profile,
      record,
      derived: derive(profile),
      file: (rel) => path.join(out, rel),
      text: (rel) => readFileSync(path.join(out, rel), "utf8"),
    });
  }
  return renders.get(name);
}

/** Run bash code with lib.sh (and optionally tenant.conf) sourced first. */
export function bash(code, { lib, conf, env = {}, cwd } = {}) {
  const pre = ["set -u -o pipefail"];
  if (conf) pre.push(`. "${conf}"`);
  if (lib) pre.push(`. "${lib}"`);
  const res = spawnSync("/bin/bash", ["-c", `${pre.join("\n")}\n${code}`], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/tmp", ...env },
    encoding: "utf8",
    cwd,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, out: res.stdout + res.stderr };
}

export const hasCmd = (c) => spawnSync("/bin/sh", ["-c", `command -v ${c}`]).status === 0;
