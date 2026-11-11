// The specifics scanner must catch private names, addresses, emails and token shapes, and leave look-alikes alone (HMA-010).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanText, scanRepo, loadDenylist } from "../../scripts/scan-specifics.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const hash = (s) => createHash("sha256").update(s).digest("hex");

test("the repository itself is clean", () => {
  assert.deepEqual(scanRepo(ROOT), []);
});

test("the shipped denylist is hashes only, at least a handful", () => {
  const set = loadDenylist(ROOT);
  assert.ok(set.size >= 5);
  for (const h of set) assert.match(h, /^[0-9a-f]{64}$/);
});

test("denylisted tokens are caught in any casing and inside compound words split on punctuation", () => {
  const deny = new Set([hash("acmesecret")]);
  assert.equal(scanText("hello AcmeSecret world", deny).length, 1);
  assert.equal(scanText("path/acmesecret-ci/home", deny).length, 1);
  assert.equal(scanText("acmesecretive", deny).length, 0, "only whole tokens");
});

test("private IPv4 addresses are caught; CIDR ranges, loopback and documentation ranges are not", () => {
  const none = new Set();
  // Samples are assembled at runtime so this file never contains them literally (the repo scan reads it too).
  const ip = (...parts) => parts.join(".");
  for (const bad of [`ssh ${ip(10, 0, 0, 7)}`, `host ${ip(192, 168, 1, 20)}:22`, ip(172, 20, 3, 4), ip(100, 64, 1, 1), ip(169, 254, 10, 10)]) assert.equal(scanText(bad, none).length, 1, bad);
  for (const ok of ["10.0.0.0/8", "192.168.0.0/16", "127.0.0.1:5442", "192.0.2.10", "203.0.113.5", "version 10.0.1"]) assert.equal(scanText(ok, none).length, 0, ok);
});

test("emails are caught except example and noreply addresses", () => {
  const none = new Set();
  assert.equal(scanText(`contact someone${"@"}mailhost.io`, none).length, 1);
  assert.equal(scanText("me@example.com noreply@anthropic.com 123+x@users.noreply.github.com", none).length, 0);
});

test("token shapes are caught without echoing them", () => {
  const none = new Set();
  const fakes = [
    "ghp_" + "a".repeat(36),
    "github_pat_" + "B".repeat(40),
    "sk-ant-" + "x".repeat(30),
    "AKIA" + "ABCDEFGHIJKLMNOP",
    "xoxb-" + "1".repeat(20),
    ["-----BEGIN", "OPENSSH PRIVATE", "KEY-----"].join(" "),
    "ABCDEFGH1JKLMNOP" + "QRSTUVWXYZ234",
  ];
  for (const f of fakes) {
    const r = scanText(`value ${f}`, none);
    assert.equal(r.length, 1, f);
    assert.ok(!r[0].reason.includes(f.slice(4)), "the finding never repeats the secret");
  }
  assert.equal(scanText("RUNNERVERSIONISFINEBUTLOWERcase", none).length, 0);
});
