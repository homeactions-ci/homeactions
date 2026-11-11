// Workflow model: reads .github/workflows/*.yml|yaml from a checkout and normalises what the rules need.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse, lineOf } from "./yaml-lite.mjs";

export { lineOf };

/** Load and parse every workflow. Parse failures are kept as { file, error } ("unreadable", never "absent"). */
export function loadWorkflows(root) {
  const dir = path.join(root, ".github", "workflows");
  if (!existsSync(dir)) return { workflows: [], unreadable: [], dirMissing: true };
  const workflows = [];
  const unreadable = [];
  for (const f of readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(f)) continue;
    const file = `.github/workflows/${f}`;
    let text;
    try {
      text = readFileSync(path.join(dir, f), "utf8");
    } catch (e) {
      unreadable.push({ file, error: e.message });
      continue;
    }
    try {
      const doc = parse(text) ?? {};
      workflows.push(modelWorkflow(file, text, doc));
    } catch (e) {
      unreadable.push({ file, error: e.message });
    }
  }
  return { workflows, unreadable, dirMissing: false };
}

/** Top-level files and directories of the checkout (for stack detection). */
export function repoShape(root) {
  const has = (p) => existsSync(path.join(root, p));
  let top = [];
  try {
    top = readdirSync(root);
  } catch {
    top = [];
  }
  const pkg = has("package.json") ? safeJson(path.join(root, "package.json")) : null;
  return {
    top,
    monorepo: has("pnpm-workspace.yaml") || has("turbo.json") || has("nx.json") || has("lerna.json") || Boolean(pkg && pkg.workspaces),
    turbo: has("turbo.json"),
    nx: has("nx.json"),
    hasDocs: has("docs") || top.some((f) => /\.md$/i.test(f)),
    packageJson: pkg,
    python: has("pyproject.toml") || has("requirements.txt") || has("setup.py"),
    ledger: has(".homeactions/ledger.md") || (has(".homeactions") && safeList(path.join(root, ".homeactions")).some((f) => /^ledger/.test(f))),
  };
}

function safeJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
function safeList(p) {
  try {
    return statSync(p).isDirectory() ? readdirSync(p) : [];
  } catch {
    return [];
  }
}

/** Normalise the `on:` block into { event: config|null }. */
export function triggers(doc) {
  const on = doc.on ?? doc.true; // a YAML 1.1 parser would turn `on` into true; ours keeps "on"
  if (!on) return {};
  if (typeof on === "string") return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.map((e) => [e, null]));
  return on;
}

export function modelWorkflow(file, text, doc) {
  const trig = triggers(doc);
  const jobsNode = doc.jobs && typeof doc.jobs === "object" ? doc.jobs : {};
  const lines = text.split("\n");
  const jobs = Object.entries(jobsNode).map(([id, def]) => modelJob(file, id, def ?? {}, lineOf(jobsNode, id), lines));
  return { file, text, doc, triggers: trig, jobs, name: doc.name ?? path.basename(file) };
}

function modelJob(file, id, def, line, lines) {
  const steps = Array.isArray(def.steps) ? def.steps.map((s, i) => ({ ...(s ?? {}), _line: lineOf(def.steps, i), _index: i })) : [];
  const runsOn = def["runs-on"];
  return {
    key: `${file}#${id}`,
    file,
    id,
    line,
    def,
    name: typeof def.name === "string" ? def.name : id,
    steps,
    runsOn,
    placement: classifyRunsOn(runsOn),
    reusable: typeof def.uses === "string",
    needs: [].concat(def.needs ?? []),
    if: def.if == null ? "" : String(def.if),
    matrix: def.strategy && def.strategy.matrix,
    timeout: def["timeout-minutes"],
    text: jobText(lines, line),
    lineOf: (k) => lineOf(def, k),
  };
}

// The raw text of one job: from its key line to the next line at the same or lower indentation.
function jobText(lines, line) {
  if (!line) return "";
  const start = line - 1;
  const ind = /^( *)/.exec(lines[start])[1].length;
  let end = start + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (l.trim() !== "" && !/^\s*#/.test(l) && /^( *)/.exec(l)[1].length <= ind) break;
    end++;
  }
  return lines.slice(start, end).join("\n");
}

/**
 * Where a job can run, from its runs-on:
 *   { kind: "hosted", os: "linux"|"macos"|"windows", labels, larger }  a GitHub-hosted label
 *   { kind: "self", labels }                                            self-hosted labels only
 *   { kind: "switch", hostedOs, labels }                                an expression that picks self-hosted or hosted
 *   { kind: "expr", text }                                              an expression we cannot resolve (e.g. matrix)
 *   { kind: "none" }                                                    reusable-workflow caller (no runs-on)
 */
export function classifyRunsOn(runsOn) {
  if (runsOn == null) return { kind: "none" };
  if (typeof runsOn === "object" && !Array.isArray(runsOn)) {
    const labels = [].concat(runsOn.labels ?? []);
    if (runsOn.group) return { kind: "self", labels, group: runsOn.group };
    return classifyRunsOn(labels);
  }
  const arr = Array.isArray(runsOn) ? runsOn.map(String) : [String(runsOn)];
  const joined = arr.join(" ");
  if (/\$\{\{/.test(joined)) {
    const selfish = /self-hosted/.test(joined);
    const hosted = /(ubuntu|macos|windows)-[\w.-]+/.exec(joined);
    if (selfish && hosted) return { kind: "switch", hostedOs: osOfLabel(hosted[0]), text: joined };
    if (/matrix\./.test(joined)) return { kind: "expr", text: joined, matrix: true };
    return { kind: "expr", text: joined };
  }
  if (arr.some((l) => l === "self-hosted")) return { kind: "self", labels: arr };
  const hostedLabel = arr.find((l) => /^(ubuntu|macos|windows)-/.test(l)) ?? arr[0];
  const os = osOfLabel(hostedLabel);
  if (!os) return { kind: "self", labels: arr }; // custom labels without a hosted image: treat as a runner pool
  return { kind: "hosted", os, labels: arr, label: hostedLabel, larger: isLargerRunner(hostedLabel), arm: /-arm\b|arm64/.test(hostedLabel) };
}

export function osOfLabel(label) {
  if (/^ubuntu|^linux/i.test(label)) return "linux";
  if (/^macos/i.test(label)) return "macos";
  if (/^windows/i.test(label)) return "windows";
  return null;
}

export function isLargerRunner(label) {
  return /(\d+[-_]?cores?|xlarge|\blarge\b|-large$|-xl$|gpu)/i.test(label);
}

/** The OS a job runs on when it runs hosted (for minute multipliers), from its matrix too. */
export function hostedOses(job) {
  const p = job.placement;
  if (p.kind === "hosted") return [p.os];
  if (p.kind === "switch") return [p.hostedOs ?? "linux"];
  if (p.kind === "expr" && p.matrix && job.matrix) {
    const out = new Set();
    for (const v of Object.values(job.matrix)) {
      for (const x of [].concat(v ?? [])) {
        if (typeof x === "string" && osOfLabel(x)) out.add(osOfLabel(x));
        if (x && typeof x === "object") for (const y of Object.values(x)) if (typeof y === "string" && osOfLabel(y)) out.add(osOfLabel(y));
      }
    }
    return [...out];
  }
  return [];
}

export const INSTALL_RE = /\b(pnpm (install|i)\b|npm (ci|install)\b|yarn( install)?\s*($|--|\n)|bun install|pip install|poetry install|uv sync|bundle install|go mod download|cargo fetch)/m;
export const BUILD_RE = /\b(pnpm( -r| --recursive)?( run)? build|npm run build|yarn( run)? build|turbo( run)? build|next build|nx( run-many)? (build|-t build)|python -m build|vite build|tsc -b)\b/;
export const E2E_RE = /\b(playwright|cypress|e2e|webkit|integration|detox|selenium)\b/i;
export const CHEAP_RE = /\b(lint|typecheck|type-check|tsc --noEmit|format|prettier|eslint|ruff|flake8|mypy|black --check|biome)\b/i;

export function runText(job) {
  return job.steps.map((s) => (typeof s.run === "string" ? s.run : "")).join("\n");
}

export function usesSteps(job, re) {
  return job.steps.filter((s) => typeof s.uses === "string" && re.test(s.uses));
}

export function stepIf(s) {
  return s.if == null ? "" : String(s.if);
}

/** A job that only runs where the runner is GitHub-hosted, by step or job gate. */
export const HOSTED_GATE_RE = /runner\.environment\s*==\s*'github-hosted'/;

export function hasPrTrigger(wf) {
  return "pull_request" in wf.triggers || "pull_request_target" in wf.triggers;
}

export function pushConfig(wf) {
  return "push" in wf.triggers ? wf.triggers.push ?? {} : null;
}

export function triggerLine(wf, event) {
  const on = wf.doc.on;
  return (on && typeof on === "object" && !Array.isArray(on) && lineOf(on, event)) || lineOf(wf.doc, "on") || 1;
}

export function matrixSize(matrix) {
  if (!matrix || typeof matrix !== "object") return 0;
  let n = 1;
  let dims = 0;
  for (const [k, v] of Object.entries(matrix)) {
    if (k === "include" || k === "exclude") continue;
    if (Array.isArray(v)) {
      n *= v.length;
      dims++;
    }
  }
  if (!dims) return Array.isArray(matrix.include) ? matrix.include.length : 0;
  if (Array.isArray(matrix.exclude)) n -= matrix.exclude.length;
  return n;
}

export const SHARD_KEY_RE = /^(shard|shards|shardIndex|shard-index|shardTotal|split|group|chunk|partition|ci_node_index|index)$/i;
