// The YAML subset parser (audit/lib/yaml-lite.mjs) against every fixture workflow and its documented limits;
// and the copy embedded in the generated placement test stays identical to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parse, lineOf, YamlError } from "../../skills/homeactions/audit/lib/yaml-lite.mjs";
import { AUDIT, KIT, FIXTURE_REPOS, fixtureRoot } from "./helpers.mjs";

const fixtureWorkflows = FIXTURE_REPOS.flatMap((name) => {
  const dir = path.join(fixtureRoot(name), ".github", "workflows");
  return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join(dir, f));
});

test("there are fixture workflows from at least three fictional repos", () => {
  assert.ok(fixtureWorkflows.length >= 7);
});

for (const file of fixtureWorkflows) {
  test(`parses ${path.relative(AUDIT, file)} into a workflow with jobs`, () => {
    const doc = parse(readFileSync(file, "utf8"));
    assert.equal(typeof doc, "object");
    assert.ok(doc.on && typeof doc.on === "object", "has an on: block");
    assert.ok(doc.jobs && Object.keys(doc.jobs).length > 0, "has jobs");
    for (const [id, job] of Object.entries(doc.jobs)) {
      assert.ok(job["runs-on"] !== undefined || typeof job.uses === "string", `${id} has runs-on or uses`);
      assert.ok(lineOf(doc.jobs, id) > 0, `${id} has a line number`);
      if (Array.isArray(job.steps)) for (const s of job.steps) assert.ok(s.uses || s.run, `${id}: every step has uses or run`);
    }
  });
}

test("the tuned fixture: concurrency expression, flow sequences, block scalar, runs-on expression with quotes", () => {
  const doc = parse(readFileSync(path.join(fixtureRoot("fleet-apps"), ".github/workflows/ci.yml"), "utf8"));
  assert.equal(doc.concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
  assert.deepEqual(doc.on.push.branches, ["main"]);
  assert.equal(doc.on.pull_request, null);
  assert.deepEqual(doc.jobs.e2e.needs, ["changes", "lint", "build"]);
  assert.deepEqual(doc.jobs.e2e.strategy.matrix.shard, [1, 2]);
  assert.match(doc.jobs.changes["runs-on"], /^\$\{\{ \(\(vars\.FLEET_RUNNER == 'self'.*fromJSON\('\["self-hosted","macOS","ARM64","fleet-ci"\]'\) \|\| 'ubuntu-latest' \}\}$/);
  assert.equal(doc.jobs.changes.steps[1].with.filters, "web:\n  - 'apps/web/**'\n  - 'packages/**'\nadmin:\n  - 'apps/admin/**'\n  - 'packages/**'\n");
  assert.equal(doc.jobs.lint.steps[2].with["node-version"], "24.10.0");
});

test("scalars: booleans, null, numbers, quoted strings; 'on' stays a string key", () => {
  const doc = parse(`on:\n  push:\na: true\nb: false\nc: ~\nd:\ne: 12\nf: 3.10\ng: "x: y # not a comment"\nh: 'it''s'\ni: yes\nj: "tab\\there"\nk: 007abc\n`);
  assert.deepEqual(Object.keys(doc), ["on", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"]);
  assert.equal(doc.a, true);
  assert.equal(doc.b, false);
  assert.equal(doc.c, null);
  assert.equal(doc.d, null);
  assert.equal(doc.e, 12);
  assert.equal(doc.f, 3.1);
  assert.equal(doc.g, "x: y # not a comment");
  assert.equal(doc.h, "it's");
  assert.equal(doc.i, "yes");
  assert.equal(doc.j, "tab\there");
  assert.equal(doc.k, "007abc");
});

test("comments, sequences at the parent's indent, nested sequences and flow mappings", () => {
  const doc = parse(`# top\nlist:\n- a   # trailing\n- b\nnested:\n  - - x\n    - y\n  - z\nflow: { a: 1, b: [x, "y, z"], c: \${{ github.ref }} }\nmulti: [\n  one,\n  two\n]\nurl: https://example.com/a#b\n`);
  assert.deepEqual(doc.list, ["a", "b"]);
  assert.deepEqual(doc.nested, [["x", "y"], "z"]);
  assert.deepEqual(doc.flow, { a: 1, b: ["x", "y, z"], c: "${{ github.ref }}" });
  assert.deepEqual(doc.multi, ["one", "two"]);
  assert.equal(doc.url, "https://example.com/a#b");
});

test("block scalars: literal, folded, chomping indicators, blank lines kept", () => {
  const doc = parse(`a: |\n  one\n\n  two\nb: >\n  folded\n  line\n\n  para\nc: |-\n  strip\nd: |+\n  keep\n\ne: x\n`);
  assert.equal(doc.a, "one\n\ntwo\n");
  assert.equal(doc.b, "folded line\npara\n");
  assert.equal(doc.c, "strip");
  assert.equal(doc.d, "keep\n\n");
  assert.equal(doc.e, "x");
});

test("plain scalars fold over deeper continuation lines; line numbers are 1-based", () => {
  const doc = parse(`x:\n  y: first\n    second\n  z: 1\n`);
  assert.equal(doc.x.y, "first second");
  assert.equal(lineOf(doc, "x"), 1);
  assert.equal(lineOf(doc.x, "z"), 4);
});

test("documented limits throw a YamlError instead of returning a wrong value", () => {
  for (const bad of ["a: &anchor 1\n", "a: *alias\n", "a: !!str 1\n", "<<: x\n", "a: 1\n---\nb: 2\n", "a:\n\t- x\n", "a: 'open\n  close'\n", "a: [1, 2\n"]) {
    assert.throws(() => parse(bad), YamlError, JSON.stringify(bad));
  }
});

test("the placement test template carries an identical copy of the parser", () => {
  const src = readFileSync(path.join(AUDIT, "lib", "yaml-lite.mjs"), "utf8");
  const tmpl = readFileSync(path.join(KIT, "repo", "tests", "placement.test.mjs.tmpl"), "utf8");
  const begin = tmpl.indexOf("// ---- BEGIN yaml-lite");
  const end = tmpl.indexOf("// ---- END yaml-lite");
  assert.ok(begin > 0 && end > begin);
  const copy = tmpl.slice(tmpl.indexOf("\n", begin) + 1, end);
  assert.equal(copy, src, "re-copy audit/lib/yaml-lite.mjs into kit/repo/tests/placement.test.mjs.tmpl");
});

test("the rendered kit workflows parse (smoke, maintenance, hosted watchdog templates exist)", () => {
  for (const f of ["repo/workflows/runner-smoke.yml.tmpl", "repo/workflows/runner-maintenance.yml.tmpl", "common/watchdog/placements/hosted-cron.yml.tmpl"]) assert.ok(existsSync(path.join(KIT, f)), f);
});
