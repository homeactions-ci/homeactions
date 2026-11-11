// The audit's only door to GitHub: `gh api` GET calls, counted against a cap.
// Any other method is refused before anything runs (HMA-022). The executor is injectable for tests.
import { spawnSync } from "node:child_process";

export class RefusedMethodError extends Error {}
export class CallCapError extends Error {}

/** Default executor: runs the real `gh` binary. Returns { status, stdout, stderr, missing }. */
export function defaultExec(args) {
  const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { status: 127, stdout: "", stderr: String(r.error.message), missing: r.error.code === "ENOENT" };
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Classify a failed `gh api` call from its exit status and stderr. */
export function classifyFailure(res) {
  const err = `${res.stderr ?? ""}`;
  const m = /HTTP (\d{3})/.exec(err) || /"status":\s*"?(\d{3})/.exec(res.stdout ?? "");
  const status = m ? Number(m[1]) : 0;
  let kind = "other";
  if (res.missing) kind = "no-gh";
  else if (status === 401 || /gh auth login|not logged in|authentication required|Bad credentials/i.test(err)) kind = "auth";
  else if (status === 403) kind = "forbidden";
  else if (status === 404) kind = "not-found";
  else if (status === 410) kind = "gone";
  else if (status >= 500) kind = "server";
  return { ok: false, status, kind, message: err.trim().split("\n")[0] || `gh exited ${res.status}` };
}

/**
 * makeGh({ exec, maxCalls }) -> { request(method, path), get(path), calls, log }
 * request() throws RefusedMethodError for anything but GET and CallCapError past the cap.
 * It returns { ok: true, status: 200, data } or { ok: false, status, kind, message }.
 */
export function makeGh({ exec = defaultExec, maxCalls = 300 } = {}) {
  let calls = 0;
  const log = [];
  function request(method, apiPath) {
    const m = String(method ?? "").toUpperCase();
    if (m !== "GET") throw new RefusedMethodError(`audit refuses ${m || "an empty"} method: the audit is read-only and only makes GET calls`);
    if (typeof apiPath !== "string" || !apiPath.startsWith("/") || /\s/.test(apiPath)) throw new RefusedMethodError(`audit refuses a malformed API path: ${apiPath}`);
    if (calls >= maxCalls) throw new CallCapError(`call cap of ${maxCalls} reached`);
    calls++;
    const res = exec(["api", "-X", "GET", "-H", "Accept: application/vnd.github+json", apiPath]);
    let out;
    if (res.status === 0) {
      try {
        out = { ok: true, status: 200, data: res.stdout.trim() ? JSON.parse(res.stdout) : null };
      } catch (e) {
        out = { ok: false, status: 0, kind: "unparseable", message: `response was not JSON: ${e.message}` };
      }
    } else out = classifyFailure(res);
    log.push({ path: apiPath, ok: out.ok, status: out.status, kind: out.kind });
    return out;
  }
  return {
    request,
    get: (p) => request("GET", p),
    get calls() {
      return calls;
    },
    get remaining() {
      return maxCalls - calls;
    },
    maxCalls,
    log,
  };
}
