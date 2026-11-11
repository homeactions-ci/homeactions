#!/usr/bin/env node
// homeactions renderer: profile.json -> the kit, deterministically.
//
//   node render.mjs --profile <profile.json> --out <dir> [--check]
//
// Reads kit/manifest.d/*.json (each an array of entries), renders every entry whose `os` and `when`
// match the profile, and writes:
//   <out>/host/**      files copied to the runner machine (provisioner, hooks, units, firewall, services)
//   <out>/repo/**      files for the user's repository (workflows, tests, runbook)
//   <out>/host/SHA256SUMS            checksums the owner verifies before running anything privileged
//   <out>/.homeactions-render.json   what was rendered, from which profile, by which kit version
// Fails (exit 2) on an invalid profile, an unknown template path, or any "{{" left in an output.
// --check renders into a temp dir and compares with <out> byte for byte (exit 1 on drift).
// Zero dependencies; Node >= 18. Never needs network, never needs root.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync, existsSync, rmSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "./lib/schema-lite.mjs";
import { render, leftoverTags, TemplateError } from "./lib/template.mjs";

const KIT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(KIT_DIR, "..", "..", "..");

export function kitVersion() {
  try {
    return JSON.parse(readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")).version;
  } catch {
    return JSON.parse(readFileSync(path.join(KIT_DIR, "VERSION.json"), "utf8")).version;
  }
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Values every template may use, computed from the profile (never typed by the user). */
export function derive(profile) {
  const t = profile.tenant;
  const mac = profile.host.os === "macos";
  const noindex = mac ? ".noindex" : "";
  const archKey = `${mac ? "osx" : "linux"}-${profile.host.arch}`;
  const runnerSha = profile.runner.sha256[archKey];
  const labels = ["self-hosted", mac ? "macOS" : "Linux", profile.host.arch === "arm64" ? "ARM64" : "X64", ...t.runnerLabels];
  const w = profile.workflows;
  const labelsJson = JSON.stringify(labels);
  const runsOnExpression =
    `\${{ ((vars.${w.fallbackVariable} == '${w.selfValue}' || contains(github.event.pull_request.labels.*.name, '${w.selfLabel}'))` +
    ` && !contains(github.event.pull_request.labels.*.name, '${w.hostedLabel}'))` +
    ` && fromJSON('${labelsJson}') || 'ubuntu-latest' }}`;
  const svc = (kind) => profile.services.find((s) => s.kind === kind) ?? null;
  const pg = svc("postgres");
  const redis = svc("redis");
  const optDir = `${t.home}/opt`;
  return {
    kitVersion: kitVersion(),
    banner: `homeactions[${t.name}]`,
    isMacos: mac,
    isLinux: !mac,
    runnerDir: `${t.home}/actions-runner${noindex}`,
    tmpDir: `${t.home}/tmp${noindex}`,
    cacheDir: `${t.home}/cache${noindex}`,
    optDir,
    srcDir: `${optDir}/src${noindex}`,
    stateDir: `${t.home}/.local/state/homeactions`,
    logDir: mac ? `${t.home}/Library/Logs/${t.labelPrefix}.runner` : `${t.home}/logs`,
    hooksDir: `${t.rootDir}/hooks`,
    confFile: `${t.rootDir}/tenant.conf`,
    daemonLabel: `${t.labelPrefix}.runner`,
    firewallLabel: `${t.labelPrefix}.firewall`,
    pfAnchor: `com.apple/900.${t.name}`,
    pfAnchorFile: `/etc/pf.anchors/${t.labelPrefix}`,
    nftTable: `homeactions_${t.name.replace(/-/g, "_")}`,
    runnerArchKey: archKey,
    runnerTarball: `actions-runner-${archKey}-${profile.runner.version}.tar.gz`,
    runnerSha: runnerSha ?? "",
    runnerLabelsCsv: t.runnerLabels.join(","),
    selfLabels: labels,
    selfLabelsJson: labelsJson,
    runsOnExpression,
    portsSpace: profile.ports.join(" "),
    portsComma: profile.ports.join(", "),
    probesSpace: profile.isolation.probeTargets.join(" "),
    forbiddenReadSpace: profile.isolation.forbiddenReadPaths.join(" "),
    otherAdmins: profile.host.otherAdmins ?? [],
    hasPostgres: Boolean(pg),
    hasRedis: Boolean(redis),
    postgres: pg ? { sourceSha256: "", ...pg, major: pg.version.split(".")[0], prefix: `${optDir}/postgresql-${pg.version.split(".")[0]}`, bin: `${optDir}/postgresql-${pg.version.split(".")[0]}/bin` } : null,
    redis: redis ? { sourceSha256: "", ...redis, prefix: `${optDir}/redis`, bin: `${optDir}/redis/bin` } : null,
    serviceBins: [pg ? `${optDir}/postgresql-${pg.version.split(".")[0]}/bin` : null, redis ? `${optDir}/redis/bin` : null].filter(Boolean),
    capsEnv: [
      ["nextBuildCpus", "HOMEACTIONS_NEXT_BUILD_CPUS"],
      ["turboConcurrency", "HOMEACTIONS_TURBO_CONCURRENCY"],
      ["jestMaxWorkers", "HOMEACTIONS_JEST_MAX_WORKERS"],
      ["playwrightWorkers", "HOMEACTIONS_PLAYWRIGHT_WORKERS"],
    ]
      .filter(([k]) => profile.caps[k] != null)
      .map(([k, name]) => ({ name, value: profile.caps[k] })),
    cotenantPidGlob: profile.cotenant.pidGlob ?? "",
    cotenantEpochFile: profile.cotenant.epochFile ?? "",
    cotenantEpochBound: profile.cotenant.epochBoundSeconds ?? 0,
    cotenantMarkerDir: profile.cotenant.mode === "marker-dir",
    cotenantCommand: profile.cotenant.mode === "command",
    swapYieldMb: profile.cotenant.swapYieldMb ?? 0,
    hasWorkerProbe: Boolean(profile.cotenant.workerProbe),
  };
}

/** Semantic checks the schema cannot express. */
export function semanticProblems(p) {
  const out = [];
  const d = derive(p);
  if (!d.runnerSha) out.push(`runner.sha256 has no "${d.runnerArchKey}" entry for this host`);
  if (p.host.access === "ssh" && !p.host.sshAlias) out.push("host.access is ssh but host.sshAlias is missing");
  if (p.repo.visibility === "public" && p.repo.forkPrs) out.push("repo is public and runs fork PRs: a self-hosted runner must not serve it (references/threat-model.md)");
  for (const s of p.services) if (!p.ports.includes(s.port)) out.push(`service ${s.kind} port ${s.port} is not in ports[]`);
  if (new Set(p.ports).size !== p.ports.length) out.push("ports[] has duplicates");
  const kinds = p.services.map((s) => s.kind);
  if (new Set(kinds).size !== kinds.length) out.push("services[] has two of the same kind");
  for (const s of p.services) {
    if (s.install === "package" && p.host.os === "macos") out.push(`service ${s.kind}: install "package" is Linux-only (macOS builds from source into the tenant home)`);
    if (s.install === "source" && !s.sourceSha256) out.push(`service ${s.kind}: install "source" needs sourceSha256`);
  }
  const c = p.cotenant;
  if (c.mode === "marker-dir" && !c.markerDir) out.push("cotenant.mode marker-dir needs markerDir");
  if (c.mode === "marker-dir" && !c.pidGlob && !c.epochFile) out.push("cotenant.mode marker-dir needs pidGlob and/or epochFile");
  if (c.epochFile && !c.epochBoundSeconds) out.push("cotenant.epochFile needs epochBoundSeconds");
  if (c.mode === "command" && !c.command) out.push("cotenant.mode command needs command");
  if (p.tenant.user === "root" || p.tenant.uid === 0) out.push("tenant.user must never be root");
  if (p.isolation.network && p.isolation.privateRanges.length === 0) out.push("isolation.network is on but privateRanges is empty");
  return out;
}

function loadManifest() {
  const dir = path.join(KIT_DIR, "manifest.d");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .flatMap((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")).map((e) => ({ ...e, _from: f })));
}

function whenMatches(entry, ctx) {
  if (entry.os && !entry.os.includes(ctx.host.os)) return false;
  if (!entry.when) return true;
  // "a.b" truthy | "!a.b" falsy | "a.b=value" equality. Several conditions joined by " && ".
  return entry.when.split(/\s*&&\s*/).every((cond) => {
    const neg = cond.startsWith("!");
    const [p, eq] = (neg ? cond.slice(1) : cond).split("=");
    let v = ctx;
    for (const k of p.split(".")) v = v?.[k];
    const ok = eq !== undefined ? String(v) === eq : Array.isArray(v) ? v.length > 0 : Boolean(v) && v !== "none";
    return neg ? !ok : ok;
  });
}

function header(output, version) {
  const line = `rendered by homeactions v${version} from .homeactions/profile.json; do not edit, re-render instead`;
  const ext = path.extname(output);
  if ([".plist", ".xml", ".md"].includes(ext)) return { kind: "xml", text: `<!-- ${line} -->` };
  if ([".mjs", ".js", ".ts"].includes(ext)) return { kind: "line", text: `// ${line}` };
  if (ext === ".json") return null;
  return { kind: "line", text: `# ${line}` };
}

function addHeader(text, output, version, wanted) {
  if (wanted === false) return text;
  const h = header(output, version);
  if (!h) return text;
  if (h.kind === "xml") {
    const nl = text.indexOf("\n");
    return text.startsWith("<?xml") ? `${text.slice(0, nl + 1)}${h.text}\n${text.slice(nl + 1)}` : `${h.text}\n${text}`;
  }
  if (text.startsWith("#!")) {
    const nl = text.indexOf("\n");
    return `${text.slice(0, nl + 1)}${h.text}\n${text.slice(nl + 1)}`;
  }
  return `${h.text}\n${text}`;
}

export function renderKit(profile, outDir) {
  const schema = JSON.parse(readFileSync(path.join(KIT_DIR, "profile.schema.json"), "utf8"));
  const problems = [...validate(schema, profile), ...(validate(schema, profile).length ? [] : semanticProblems(profile))];
  if (problems.length) {
    const e = new Error(`invalid profile:\n  ${problems.join("\n  ")}`);
    e.code = "PROFILE";
    throw e;
  }
  mkdirSync(outDir, { recursive: true });
  const ctx = { ...profile, derived: derive(profile) };
  const version = ctx.derived.kitVersion;
  const entries = loadManifest().filter((e) => whenMatches(e, ctx));
  const seen = new Set();
  const written = [];
  for (const entry of entries) {
    if (seen.has(entry.output)) throw new Error(`two manifest entries write ${entry.output} (${entry._from})`);
    seen.add(entry.output);
    const src = readFileSync(path.join(KIT_DIR, entry.template), "utf8");
    let text;
    try {
      text = render(src, ctx);
    } catch (err) {
      if (err instanceof TemplateError) throw new Error(`${entry.template}: ${err.message}`);
      throw err;
    }
    text = addHeader(text, entry.output, version, entry.header);
    const left = leftoverTags(text);
    if (left) throw new Error(`${entry.template} -> ${entry.output}: ${left} unresolved "{{" left after rendering`);
    const dest = path.join(outDir, entry.output);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, text);
    chmodSync(dest, parseInt(entry.mode ?? "0644", 8));
    written.push({ output: entry.output, sha256: sha256(Buffer.from(text)), mode: entry.mode ?? "0644" });
  }
  written.sort((a, b) => a.output.localeCompare(b.output));
  const hostFiles = written.filter((w) => w.output.startsWith("host/"));
  if (hostFiles.length) {
    const sums = hostFiles.map((w) => `${w.sha256}  ${w.output.slice("host/".length)}`).join("\n") + "\n";
    writeFileSync(path.join(outDir, "host", "SHA256SUMS"), sums);
  }
  const record = {
    kitVersion: version,
    profileSha256: sha256(Buffer.from(JSON.stringify(profile))),
    tenant: profile.tenant.name,
    os: profile.host.os,
    files: written,
  };
  writeFileSync(path.join(outDir, ".homeactions-render.json"), JSON.stringify(record, null, 2) + "\n");
  return record;
}

function listFiles(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? listFiles(p, base) : [path.relative(base, p)];
  });
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const profilePath = arg("--profile");
  const out = arg("--out");
  if (!profilePath || !out) {
    console.error("usage: render.mjs --profile <profile.json> --out <dir> [--check]");
    return 2;
  }
  let profile;
  try {
    profile = JSON.parse(readFileSync(profilePath, "utf8"));
  } catch (e) {
    console.error(`render: cannot read ${profilePath}: ${e.message}`);
    return 2;
  }
  try {
    if (argv.includes("--check")) {
      const tmp = mkdtempSync(path.join(tmpdir(), "homeactions-check-"));
      try {
        renderKit(profile, tmp);
        const a = listFiles(tmp).sort();
        const b = listFiles(out).sort();
        const drift = [...new Set([...a, ...b])].filter((f) => {
          const pa = path.join(tmp, f);
          const pb = path.join(out, f);
          return !existsSync(pa) || !existsSync(pb) || !readFileSync(pa).equals(readFileSync(pb));
        });
        if (drift.length) {
          console.error(`render --check: ${drift.length} file(s) differ from a fresh render:\n  ${drift.join("\n  ")}`);
          return 1;
        }
        console.log(`render --check: ${a.length} files match`);
        return 0;
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    rmSync(out, { recursive: true, force: true });
    const rec = renderKit(profile, out);
    console.log(`rendered ${rec.files.length} files for tenant ${rec.tenant} (${rec.os}) into ${out} with homeactions v${rec.kitVersion}`);
    return 0;
  } catch (e) {
    console.error(`render: ${e.message}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
