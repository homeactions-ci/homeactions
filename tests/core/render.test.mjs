// Core renderer + schema + template engine tests (HMA-007, HMA-021). Zero dependencies: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { renderKit, derive, semanticProblems } from "../../skills/homeactions/kit/render.mjs";
import { render, leftoverTags, TemplateError } from "../../skills/homeactions/kit/lib/template.mjs";
import { validate } from "../../skills/homeactions/kit/lib/schema-lite.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const KIT = path.join(ROOT, "skills", "homeactions", "kit");
const SCHEMA = JSON.parse(readFileSync(path.join(KIT, "profile.schema.json"), "utf8"));
const FIXTURES = path.join(ROOT, "fixtures", "profiles");
const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort();
const load = (f) => JSON.parse(readFileSync(path.join(FIXTURES, f), "utf8"));
const tmp = () => mkdtempSync(path.join(tmpdir(), "homeactions-test-"));

function walk(dir, base = dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p, base) : [path.relative(base, p)];
  });
}

test("there are at least three fixture profiles, covering macOS two-tenant, macOS dedicated and Linux", () => {
  assert.ok(fixtures.length >= 3);
  const oses = fixtures.map((f) => load(f).host.os);
  assert.ok(oses.includes("macos") && oses.includes("linux"));
});

for (const f of fixtures) {
  test(`fixture ${f}: valid against the schema and the semantic rules`, () => {
    const p = load(f);
    assert.deepEqual(validate(SCHEMA, p), []);
    assert.deepEqual(semanticProblems(p), []);
  });

  test(`fixture ${f}: renders, leaves no {{, is byte-identical across two renders, and SHA256SUMS matches`, () => {
    const a = tmp();
    const b = tmp();
    try {
      const ra = renderKit(load(f), a);
      renderKit(load(f), b);
      const files = walk(a).sort();
      assert.deepEqual(files, walk(b).sort());
      for (const rel of files) {
        const ta = readFileSync(path.join(a, rel));
        assert.ok(ta.equals(readFileSync(path.join(b, rel))), `${rel} differs between renders`);
        assert.equal(leftoverTags(ta.toString("utf8")), 0, `${rel} has unresolved {{`);
      }
      const sumsPath = path.join(a, "host", "SHA256SUMS");
      if (ra.files.some((x) => x.output.startsWith("host/"))) {
        const res = spawnSync("shasum", ["-a", "256", "-c", "SHA256SUMS"], { cwd: path.join(a, "host"), encoding: "utf8" });
        if (res.error) {
          const r2 = spawnSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: path.join(a, "host"), encoding: "utf8" });
          assert.equal(r2.status, 0, r2.stdout + r2.stderr);
        } else assert.equal(res.status, 0, res.stdout + res.stderr);
        assert.ok(readFileSync(sumsPath, "utf8").length > 0);
      }
      const rec = JSON.parse(readFileSync(path.join(a, ".homeactions-render.json"), "utf8"));
      assert.equal(rec.tenant, load(f).tenant.name);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  test(`fixture ${f}: every rendered file (except .json and header:false files, which cannot hold a comment) carries the "rendered by" header`, () => {
    const out = tmp();
    try {
      const rec = renderKit(load(f), out);
      const manifest = readdirSync(path.join(KIT, "manifest.d")).filter((x) => x.endsWith(".json")).flatMap((x) => JSON.parse(readFileSync(path.join(KIT, "manifest.d", x), "utf8")));
      const noHeader = new Set(manifest.filter((e) => e.header === false).map((e) => e.output));
      for (const { output } of rec.files) {
        if (noHeader.has(output) || /\.json$/.test(output)) continue;
        assert.match(readFileSync(path.join(out, output), "utf8").split("\n").slice(0, 3).join("\n"), /rendered by homeactions v\d+\.\d+\.\d+/, output);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
}

test("render.mjs --check passes on a fresh render and fails after a hand edit", () => {
  const out = tmp();
  const prof = path.join(FIXTURES, fixtures[0]);
  try {
    const r1 = spawnSync(process.execPath, [path.join(KIT, "render.mjs"), "--profile", prof, "--out", out], { encoding: "utf8" });
    assert.equal(r1.status, 0, r1.stderr);
    const ok = spawnSync(process.execPath, [path.join(KIT, "render.mjs"), "--profile", prof, "--out", out, "--check"], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    const first = walk(out).find((x) => !x.startsWith("."));
    if (first) {
      writeFileSync(path.join(out, first), readFileSync(path.join(out, first), "utf8") + "\n# hand edit\n");
      const bad = spawnSync(process.execPath, [path.join(KIT, "render.mjs"), "--profile", prof, "--out", out, "--check"], { encoding: "utf8" });
      assert.equal(bad.status, 1);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("an invalid profile is refused with every problem listed, and nothing is written", () => {
  const out = tmp();
  try {
    const p = load(fixtures[0]);
    p.tenant.user = "root";
    p.ports = [22];
    delete p.watchdog;
    assert.throws(() => renderKit(p, out), (e) => e.code === "PROFILE" && /watchdog/.test(e.message) && /ports\[0\]/.test(e.message));
    assert.deepEqual(readdirSync(out), []);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("semantic rules: public + fork PRs refused; ssh needs an alias; service port must be a tenant port; source builds need a checksum; package installs are Linux-only", () => {
  const base = load(fixtures.find((f) => load(f).host.os === "macos" && load(f).services.length));
  const cases = [
    [(p) => Object.assign(p.repo, { visibility: "public", forkPrs: true }), /fork PRs/],
    [(p) => Object.assign(p.host, { access: "ssh", sshAlias: undefined }) && delete p.host.sshAlias, /sshAlias/],
    [(p) => (p.services[0].port = 40000), /not in ports/],
    [(p) => delete p.services[0].sourceSha256, /sourceSha256/],
    [(p) => (p.services[0].install = "package"), /Linux-only/],
    [(p) => (p.runner.sha256 = {}), /runner\.sha256/],
  ];
  for (const [mutate, re] of cases) {
    const p = structuredClone(base);
    mutate(p);
    assert.match(semanticProblems(p).join("\n"), re);
  }
});

test("derive: the runs-on expression honours the fallback variable and both labels, and the self labels match the host", () => {
  const p = load(fixtures[0]);
  const d = derive(p);
  assert.ok(d.runsOnExpression.startsWith("${{ "));
  assert.ok(d.runsOnExpression.includes(`vars.${p.workflows.fallbackVariable} == '${p.workflows.selfValue}'`));
  assert.ok(d.runsOnExpression.includes(`'${p.workflows.selfLabel}'`));
  assert.ok(d.runsOnExpression.includes(`!contains(github.event.pull_request.labels.*.name, '${p.workflows.hostedLabel}')`));
  assert.deepEqual(d.selfLabels.slice(0, 1), ["self-hosted"]);
  for (const l of p.tenant.runnerLabels) assert.ok(d.selfLabels.includes(l));
  assert.equal(d.banner, `homeactions[${p.tenant.name}]`);
});

test("template engine: values, join, json, if/else, unless, each, nesting; unknown paths throw; GitHub ${{ }} is untouched", () => {
  const ctx = { a: { b: "x", list: ["p", "q"], empty: [], none: "none", obj: { k: 1 } }, items: [{ n: 1 }, { n: 2 }] };
  assert.equal(render("{{a.b}}-{{join a.list \"+\"}}-{{json a.obj}}", ctx), 'x-p+q-{"k":1}');
  assert.equal(render("{{#if a.list}}Y{{else}}N{{/if}}{{#if a.empty}}Y{{else}}N{{/if}}{{#if a.none}}Y{{else}}N{{/if}}", ctx), "YNN");
  assert.equal(render("{{#unless a.empty}}U{{/unless}}", ctx), "U");
  assert.equal(render("{{#each items}}[{{@index}}:{{this.n}}{{#if a.b}}!{{/if}}]{{/each}}", ctx), "[0:1!][1:2!]");
  assert.equal(render("runs-on: ${{ matrix.os }}", ctx), "runs-on: ${{ matrix.os }}");
  assert.throws(() => render("{{a.missing}}", ctx), TemplateError);
  assert.throws(() => render("{{#if a.b}}open", ctx), TemplateError);
  assert.throws(() => render("{{a.obj}}", ctx), TemplateError);
  assert.equal(leftoverTags("ok ${{ x }} {{ bad"), 1);
});

test("schema-lite: types, enum, pattern, required, additionalProperties, items, bounds", () => {
  const s = { type: "object", additionalProperties: false, required: ["n"], properties: { n: { type: "integer", minimum: 1, maximum: 3 }, e: { enum: ["a"] }, s: { type: "string", pattern: "^x" }, l: { type: "array", minItems: 1, items: { type: "number" } } } };
  assert.deepEqual(validate(s, { n: 2, e: "a", s: "xy", l: [1.5] }), []);
  const errs = validate(s, { n: 9, e: "b", s: "y", l: ["no"], extra: 1 }).join("\n");
  for (const re of [/<= 3/, /one of/, /does not match/, /expected number/, /unknown property "extra"/]) assert.match(errs, re);
  assert.match(validate(s, {}).join(""), /missing required "n"/);
});
