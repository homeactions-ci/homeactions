#!/usr/bin/env node
// Fails (exit 1) when anything private could be leaking into this public repo (HMA-010):
//   - a denylisted token (scripts/denylist.sha256 holds SHA-256 hashes; .denylist.local holds plain terms, gitignored)
//   - a private IPv4 address (RFC 1918, CGNAT, link-local) that is not a CIDR range (10.0.0.0/8 in a rule is fine)
//   - an email address other than @example.* / noreply addresses
//   - token-shaped strings (GitHub, Anthropic, AWS, Slack keys, private keys, Actions runner registration tokens)
// Usage: node scripts/scan-specifics.mjs [root]   (default: the repo root). Zero dependencies.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set([".git", "node_modules", "out", ".render-tmp", "results"]);
const BINARY = /\.(png|jpe?g|gif|ico|pdf|zip|gz|tgz|woff2?)$/i;

const sha = (s) => createHash("sha256").update(s).digest("hex");

export function loadDenylist(root) {
  const hashes = new Set();
  const file = path.join(root, "scripts", "denylist.sha256");
  if (existsSync(file)) for (const l of readFileSync(file, "utf8").split("\n")) if (/^[0-9a-f]{64}$/.test(l.trim())) hashes.add(l.trim());
  const local = path.join(root, ".denylist.local");
  if (existsSync(local)) for (const l of readFileSync(local, "utf8").split("\n")) if (l.trim() && !l.startsWith("#")) hashes.add(sha(l.trim().toLowerCase()));
  return hashes;
}

const PRIVATE_V4 = /(?<![\d.])(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})(?![\d.])(?!\/\d)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const EMAIL_OK = /(@example\.(com|org|net)|noreply@|@users\.noreply\.github\.com$)/i;
const TOKENS = [
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/, "GitHub fine-grained token"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\b(?=[A-Z0-9]{29}\b)(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{29}\b/, "Actions runner registration token shape"],
];

export function scanText(text, denylist) {
  const findings = [];
  text.split("\n").forEach((line, i) => {
    const n = i + 1;
    for (const tok of line.toLowerCase().split(/[^a-z0-9]+/)) {
      if (tok && denylist.has(sha(tok))) findings.push({ line: n, reason: `denylisted term (sha256 ${sha(tok).slice(0, 12)}…)` });
    }
    for (const m of line.matchAll(PRIVATE_V4)) findings.push({ line: n, reason: `private IPv4 address ${m[1]}` });
    for (const m of line.matchAll(EMAIL)) if (!EMAIL_OK.test(m[0])) findings.push({ line: n, reason: "email address" });
    for (const [re, what] of TOKENS) if (re.test(line)) findings.push({ line: n, reason: what });
  });
  return findings;
}

function walk(dir, root, out = []) {
  for (const f of readdirSync(dir)) {
    if (SKIP_DIRS.has(f) || f === ".denylist.local") continue;
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p, root, out);
    else if (!BINARY.test(f)) out.push(path.relative(root, p));
  }
  return out;
}

export function scanRepo(root) {
  const denylist = loadDenylist(root);
  const results = [];
  for (const rel of walk(root, root).sort()) {
    if (rel === path.join("scripts", "denylist.sha256")) continue;
    for (const f of scanText(readFileSync(path.join(root, rel), "utf8"), denylist)) results.push({ file: rel, ...f });
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const results = scanRepo(root);
  for (const r of results) console.log(`${r.file}:${r.line}: ${r.reason}`);
  if (results.length) {
    console.error(`scan-specifics: ${results.length} finding(s). This repo is public: remove private names, hosts, addresses, emails and secrets.`);
    process.exitCode = 1;
  } else console.log("scan-specifics: clean");
}
