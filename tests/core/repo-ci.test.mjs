// homeactions' own CI is hosted-only (HMA-019) and keeps the hygiene gates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WF = path.join(ROOT, ".github", "workflows");
const files = readdirSync(WF).filter((f) => /\.ya?ml$/.test(f));

test("no workflow of this public repo can run on a self-hosted runner", () => {
  assert.ok(files.length > 0);
  for (const f of files) {
    const text = readFileSync(path.join(WF, f), "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    assert.doesNotMatch(text, /self-hosted/i, `${f} mentions self-hosted outside a comment`);
    for (const m of text.matchAll(/runs-on:\s*(.+)/g)) assert.match(m[1], /ubuntu-latest|macos-latest|windows-latest|\$\{\{\s*matrix\.os\s*\}\}/, `${f}: runs-on ${m[1]}`);
  }
});

test("CI runs the tests, the specifics scanner, gitleaks and plugin validation", () => {
  const ci = readFileSync(path.join(WF, "ci.yml"), "utf8");
  for (const needle of ["node --test tests/", "node scripts/scan-specifics.mjs", "gitleaks git", "plugin validate --strict", "--check"]) assert.ok(ci.includes(needle), needle);
});

test("the plugin and marketplace manifests agree on the name and are MIT", () => {
  const plugin = JSON.parse(readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  const market = JSON.parse(readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.equal(plugin.name, "homeactions");
  assert.equal(market.plugins[0].name, plugin.name);
  assert.equal(market.plugins[0].source, "./");
  assert.equal(plugin.license, "MIT");
  assert.doesNotMatch(plugin.name, /^(claude|anthropic|cc-plugin)/);
  assert.match(readFileSync(path.join(ROOT, "LICENSE"), "utf8"), /^MIT License/);
});
