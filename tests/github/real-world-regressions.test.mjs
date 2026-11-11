// Regressions found by auditing a real, well-tuned monorepo (2026-11-12): patterns that are correct must not be flagged.
//  - C4: a setup-node cache gated by an EXPRESSION in `with.cache` (runner.environment) is gated, not "ungated".
//  - C10: fetch-depth 0 is needed when the job compares against a base commit (git cat-file, a paths-filter action,
//         turbo --filter from a variable range).
//  - C1/C3: a finding in one workflow still credits the workflow that already does it right.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const AUDIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "homeactions", "audit", "audit.mjs");

const CI = `name: CI
on:
  push:
    branches: [main]
  pull_request:
concurrency:
  group: ci-\${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}
jobs:
  changes:
    runs-on: \${{ vars.X_RUNNER == 'self' && fromJSON('["self-hosted","acme"]') || 'ubuntu-latest' }}
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - name: base
        run: git cat-file -e "\${BASE}^{commit}"
      - uses: dorny/paths-filter@v3
        with:
          filters: |
            web: ['apps/web/**']
  static:
    needs: changes
    runs-on: \${{ vars.X_RUNNER == 'self' && fromJSON('["self-hosted","acme"]') || 'ubuntu-latest' }}
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v5
        with:
          node-version-file: .nvmrc
          cache: \${{ runner.environment == 'github-hosted' && 'pnpm' || '' }}
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec turbo run typecheck "--filter=$TURBO_RANGE"
`;

const PRE = `name: Pre-deploy
on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened, labeled]
concurrency:
  group: pre-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  webkit:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v5
      - run: echo e2e webkit
`;

function audit(files) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-audit-"));
  try {
    mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(root, ".github", "workflows", name), text);
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x", private: true, workspaces: ["apps/*"] }));
    const r = spawnSync(process.execPath, [AUDIT, "--repo", "example-org/x", "--root", root, "--no-history", "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const byId = (report) => Object.fromEntries((report.results ?? []).map((f) => [f.id, f]));

test("C4: a cache gated by an expression in with.cache is already done, not ungated", () => {
  assert.equal(byId(audit({ "ci.yml": CI })).C4.status, "already-done");
});

test("C10: full-history checkouts that compare against a base commit are not flagged", () => {
  assert.notEqual(byId(audit({ "ci.yml": CI })).C10.status, "found");
});

test("C1: the finding on one workflow credits the workflow that cancels on PRs only", () => {
  const c1 = byId(audit({ "ci.yml": CI, "pre-deploy.yml": PRE })).C1;
  assert.equal(c1.status, "found");
  assert.match(c1.summary, /already right in \.github\/workflows\/ci\.yml/);
});
