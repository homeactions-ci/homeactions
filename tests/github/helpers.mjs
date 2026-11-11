// Shared helpers for tests/github: fixture paths and a fake `gh` executor replaying recorded responses.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const AUDIT = path.join(ROOT, "skills", "homeactions", "audit");
export const FIXTURES = path.join(AUDIT, "fixtures");
export const KIT = path.join(ROOT, "skills", "homeactions", "kit");
export const FIXTURE_REPOS = ["web-monorepo", "fleet-apps", "pyfmt-lib", "tiny-cli"];

export const fixtureRoot = (name) => path.join(FIXTURES, name, "repo");
export const loadRecording = (name, file = "gh.json") => JSON.parse(readFileSync(path.join(FIXTURES, name, file), "utf8"));
export const loadExpected = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name, "expected.json"), "utf8"));
export const slugOf = (name) => `example-org/${name}`;

/** Normalise an API path the way recordings are keyed: drop the query except `page`. */
export function recordingKey(apiPath) {
  const [p, q] = apiPath.split("?");
  const page = q && /(?:^|&)page=(\d+)/.exec(q);
  return page ? `${p}?page=${page[1]}` : p;
}

/** A fake `gh` executor: replays a recording; unknown paths answer HTTP 404. Records every argv. */
export function fakeExec(recording, { calls = [] } = {}) {
  const fn = (args) => {
    calls.push(args);
    const apiPath = args[args.length - 1];
    const hit = recording.responses[recordingKey(apiPath)];
    if (!hit) return { status: 1, stdout: JSON.stringify({ message: "Not Found" }), stderr: "gh: Not Found (HTTP 404)" };
    if (hit.status === 200) return { status: 0, stdout: JSON.stringify(hit.body), stderr: "" };
    return { status: 1, stdout: JSON.stringify(hit.body), stderr: `gh: ${hit.body?.message ?? "error"} (HTTP ${hit.status})` };
  };
  fn.calls = calls;
  return fn;
}

export const noAuthExec = () => ({ status: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" });
