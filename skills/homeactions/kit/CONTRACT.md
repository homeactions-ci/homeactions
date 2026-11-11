# Kit contract (for contributors)

The kit is a set of templates rendered from one validated profile (`profile.schema.json`) by `render.mjs`. Nothing in the kit is hand-edited after rendering: users re-render.

## Rendering

- **Input:** `.homeactions/profile.json` in the user's repo, validated against `profile.schema.json` plus `semanticProblems()` in `render.mjs`.
- **Context:** templates see the profile at the top level (`{{tenant.user}}`, `{{cotenant.yieldBudgetSeconds}}`) and computed values under `derived` (`{{derived.runnerDir}}`). See `derive()` in `render.mjs` for the full list. Need a value that isn't there? Do not hard-code it: compute it from existing values inside the script at runtime, or ask for a new `derived` key.
- **Syntax** (`lib/template.mjs`):
  - `{{a.b}}` for a value;
  - `{{join a.b " "}}` to join an array;
  - `{{json a.b}}` for JSON;
  - `{{#if a.b}}…{{else}}…{{/if}}` and `{{#unless a.b}}…{{/unless}}` (an empty array or `"none"` is falsy);
  - `{{#each a.b}}…{{this}}…{{this.x}}…{{@index}}…{{/each}}`.

  An unknown path is an error. GitHub expressions `${{ … }}` are left untouched because of the `$` prefix. Any other `{{` left after rendering fails the render.
- **Manifest:** `manifest.d/*.json`, each a JSON array of entries, merged in filename order:
  ```json
  { "template": "common/hooks/lib.sh", "output": "host/hooks/lib.sh", "os": ["macos", "linux"], "when": "derived.hasPostgres", "mode": "0755", "header": true }
  ```
  - `os` (optional) limits the entry to those host OSes.
  - `when` (optional) is `path` (truthy), `!path`, or `path=value`, with several conditions joined by ` && `.
  - `mode` defaults to `0644`.
  - `header: false` suppresses the "rendered by" header. Use it for files whose format forbids comments, such as the runner `.env` and `.path`. JSON outputs never carry one; Markdown carries it as an HTML comment.
  - Two entries may not write the same output.
- **Output layout:**
  - `host/**` is copied to the runner machine. The renderer writes `host/SHA256SUMS`, and the owner verifies it before running anything privileged.
  - `repo/**` goes into the user's repository: workflows, generated tests, runbook.

## Conventions for host scripts

- **Bash 3.2** (stock macOS). No associative arrays, no `mapfile`, no `${var,,}`. `set -u -o pipefail`. Use `set -e` only where every failure should abort (provisioners); hooks handle each failure explicitly.
- **Under `pipefail`, never use `grep -q` downstream of a pipe.** It can exit early, SIGPIPE the writer and invert the result once output passes about 64 KiB. Use `grep -c … >/dev/null` or a here-string.
- **Hooks run as the tenant user**, from root-owned files under `{{tenant.rootDir}}`. They never use sudo.
  - Messages start with `{{derived.banner}}` (`homeactions[<tenant>]`).
  - A failure is printed as `::error::{{derived.banner}} <message>` and exits 1, which fails the job before any step runs.
- **Privileged steps live only in the provisioner/uninstaller,** which the machine owner runs in their own terminal.
  - They support `--dry-run`, which prints every command without running it, and they are idempotent.
  - They refuse to run as the tenant user, refuse a tenant user of root or an existing admin, and refuse targets outside the tenant's namespace.
- **"Unreadable" is not "absent."** A check that cannot read its input reports `unreadable`; it never reports `none`.
- **launchd timers use `StartInterval`, never `StartCalendarInterval`**, which is delivered in the setup timezone and can fire hours late. A script that needs a time window guards it itself.
- **Tokens never appear in argv or files.** Registration reads the token at a hidden prompt (`read -rs`) and passes it as `ACTIONS_RUNNER_INPUT_TOKEN` into `env -i bash --noprofile --norc`.
- **No names of real people, companies, hosts, accounts, IP addresses or projects** anywhere in the kit, its tests or fixtures. Use `example`, `acme` and other fictional names. CI enforces this with `scripts/scan-specifics.mjs`.
