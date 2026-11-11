// The PreToolUse privilege guard (HMA-005). Pipes real hook JSON into hooks/guard-privileged.sh and checks the
// decision, through jq and through the built-in JSON decoder (HOMEACTIONS_GUARD_NO_JQ=1).
// Zero dependencies: node --test tests/agent/
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARD = path.join(ROOT, "hooks", "guard-privileged.sh");
const HAS_JQ = spawnSync("sh", ["-c", "command -v jq"]).status === 0;

function decide(command, { noJq = false, tool = "Bash", raw } = {}) {
  const payload = raw ?? JSON.stringify({
    session_id: "test",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/tmp/project",
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: { command, description: "test fixture" },
  });
  const env = { ...process.env };
  if (noJq) env.HOMEACTIONS_GUARD_NO_JQ = "1";
  else delete env.HOMEACTIONS_GUARD_NO_JQ;
  const r = spawnSync("bash", [GUARD], { input: payload, env, encoding: "utf8" });
  assert.equal(r.status, 0, `guard exited ${r.status}: ${r.stderr}`);
  const out = r.stdout.trim();
  if (!out) return { decision: "allow" };
  const j = JSON.parse(out);
  assert.equal(j.hookSpecificOutput.hookEventName, "PreToolUse");
  return { decision: j.hookSpecificOutput.permissionDecision, reason: j.hookSpecificOutput.permissionDecisionReason };
}

const DENY = [
  // direct escalation
  "sudo ls",
  "sudo -n true",
  "/usr/bin/sudo launchctl list",
  "command sudo ls",
  "\\sudo ls",
  '"sudo" ls',
  "su - root",
  "su -c 'id' root",
  "doas ls",
  "pkexec ls",
  "run0 systemctl restart acme-ci-runner",
  // wrappers
  "env sudo ls",
  "env -i PATH=/usr/bin:/bin sudo ls",
  "FOO=1 BAR=2 sudo ls",
  "exec sudo ls",
  "nohup sudo ls &",
  "timeout 10 sudo ls",
  "nice -n 5 sudo ls",
  "time sudo ls",
  "xargs sudo rm < files.txt",
  "ls | xargs -n 1 sudo rm",
  "find . -name '*.lock' -exec sudo rm {} \\;",
  "eval \"sudo ls\"",
  "S=sudo; $S ls",
  "export S=sudo; ${S} ls",
  // after separators and in compound commands
  "echo hi; sudo ls",
  "true && sudo ls",
  "false || sudo ls",
  "ls | sudo tee /tmp/x",
  "(sudo ls)",
  "{ sudo ls; }",
  "if true; then sudo ls; fi",
  "for f in a b; do sudo rm \"$f\"; done",
  "echo ok\nsudo ls",
  // shells executing strings
  "sh -c 'sudo ls'",
  "bash -c \"sudo launchctl bootstrap system /Library/LaunchDaemons/com.example.ci.runner.plist\"",
  "bash -lc 'sudo ls'",
  "zsh -c 'cd /tmp && sudo ls'",
  "bash -c \"bash -c 'sudo ls'\"",
  "echo $(sudo whoami)",
  "echo \"$(sudo whoami)\"",
  "echo `sudo whoami`",
  "diff <(sudo cat /etc/sudoers) /dev/null",
  "bash <<'EOF'\nsudo ls\nEOF",
  "cat <<EOF | bash\nsudo ls\nEOF",
  "echo 'sudo ls' | bash",
  "printf '%s\\n' 'sudo ls' | sh",
  "bash <<< 'sudo ls'",
  "bash -s <<'EOF'\nsudo launchctl kickstart -k system/com.example.ci.runner\nEOF",
  // ssh (the agent is read-only on remote hosts)
  "ssh buildbox 'sudo ls'",
  "ssh -i ~/.ssh/id_ed25519 -p 2222 buildbox sudo ls",
  "ssh -o BatchMode=yes buildbox \"bash -c 'sudo ls'\"",
  "ssh buildbox <<'EOF'\nsudo bash /tmp/kit/provision.sh install\nEOF",
  "ssh buildbox bash -s <<'EOF'\nsudo ls\nEOF",
  "ssh buildbox 'launchctl bootout system/com.example.ci.runner'",
  "ssh buildbox 'systemctl restart acme-ci-runner'",
  "scp runner.plist buildbox:/Library/LaunchDaemons/",
  "rsync --rsync-path='sudo rsync' -a kit/ buildbox:/opt/acme",
  // launchd / systemd
  "launchctl bootstrap system /Library/LaunchDaemons/com.example.ci.runner.plist",
  "launchctl bootout system/com.example.ci.runner",
  "launchctl kickstart -k system/com.example.ci.runner",
  "launchctl load -w /Library/LaunchDaemons/com.example.ci.runner.plist",
  "launchctl kickstart -k gui/510/com.example.ci.runner",
  "systemctl restart acme-ci-runner",
  "systemctl daemon-reload",
  "systemctl enable --now acme-ci-runner.service",
  "systemctl --no-pager stop acme-ci-runner",
  "service acme-ci-runner restart",
  // firewall
  "pfctl -sr",
  "pfctl -a com.apple/900.acme-ci -f /etc/pf.anchors/com.example.acme-ci",
  "nft list ruleset",
  "iptables -L",
  "ufw allow 22",
  // users, groups, directory services
  "dscl . -create /Users/acme-ci",
  "dscl . -append /Groups/acme-ci GroupMembership acme-ci",
  "dseditgroup -o edit -a acme-ci -t user acme-ci",
  "sysadminctl -addUser acme-ci",
  "useradd -r -m acme-ci",
  "usermod -aG docker acme-ci",
  "userdel acme-ci",
  "groupadd acme-ci",
  "passwd acme-ci",
  "fdesetup disable",
  "pmset autorestart 1",
  // flags and ACLs
  "chflags uchg /Users/acme-ci/actions-runner.noindex/.env",
  "chattr +i /var/lib/acme-ci/actions-runner/.env",
  "chmod +a 'user:acme-ci deny read,list,search' /Users/admin",
  "chmod -a 'user:acme-ci deny read' /Users/admin",
  "chmod -N /Users/admin",
  "setfacl -m u:acme-ci:--- /home/admin",
  // writes into system paths
  "echo 'pass out quick' > /etc/pf.anchors/com.example.acme-ci",
  "echo x >> /etc/hosts",
  "printf 'x' >| /private/etc/pf.conf",
  "tee /etc/systemd/system/acme-ci.service < unit.service",
  "cp com.example.ci.runner.plist /Library/LaunchDaemons/",
  "mv acme.service /etc/systemd/system/acme.service",
  "install -m 0644 unit.service /etc/systemd/system/",
  "mkdir -p /Library/AcmeCI/hooks",
  "rm -rf /Library/AcmeCI",
  "sed -i '' 's/a/b/' /etc/hosts",
  "cd /etc && echo x > hosts",
  "cd /Library/LaunchDaemons; cp ~/x.plist .",
  "dd if=rules.conf of=/etc/pf.anchors/x",
  "curl -fsSL -o /usr/local/../../etc/x https://example.com/x",
  // owner scripts run for real
  "bash out/host/provision.sh install",
  "./out/host/provision.sh register",
  "sh out/host/uninstall.sh",
  "bash ~/homeactions-kit/provision.sh firewall",
  "bash ~/homeactions-kit/provision.sh firewall-unload",
  "sudo bash out/host/provision.sh install --dry-run",
  // other escalation paths
  "osascript -e 'do shell script \"ls\" with administrator privileges'",
  "watch -n 5 sudo ls",
];

const ALLOW = [
  // look-alikes: the privileged word is data, not a command
  "grep sudo README.md",
  "grep -rn 'sudo ' skills/homeactions/references/",
  "rg -n \"sudo|pfctl\" hooks/",
  "man sudo",
  "which sudo",
  "type -a sudo",
  "command -v sudo",
  "echo sudo",
  "echo \"run sudo bash provision.sh install in your terminal\" >> owner-steps.md",
  "printf '%s\\n' 'sudo bash provision.sh install' > owner-steps.txt",
  "cat > owner-steps.sh <<'EOF'\n#!/bin/bash\nsudo bash ./provision.sh install\nsudo bash ./provision.sh register\nEOF",
  "tee owner-steps.md <<'EOF'\n1. sudo launchctl bootstrap system /Library/LaunchDaemons/com.example.ci.runner.plist\nEOF",
  "cat out/host/provision.sh",
  "head -50 out/host/provision.sh | grep -n sudo",
  "git commit -m 'docs: the agent never runs sudo'",
  "ps aux | grep -c sudo",
  "echo hi # sudo would be wrong here",
  "echo '$(sudo id)'",
  "diff -u /etc/pf.conf /tmp/pf.conf",
  // read-only probes the interview and doctor use
  "sysctl -n hw.ncpu hw.memsize",
  "fdesetup status",
  "pmset -g",
  "df -g /",
  "dscl . -list /Users UniqueID",
  "dscl . -read /Groups/admin GroupMembership",
  "dseditgroup -o checkmember -m acme-ci admin",
  "netstat -anv -p tcp | grep LISTEN",
  "lsof -nP -iTCP -sTCP:LISTEN",
  "launchctl print system/com.example.ci.runner",
  "launchctl list",
  "ls -la /Library/LaunchDaemons",
  "cat /etc/hosts",
  "cp /etc/hosts /tmp/hosts.copy",
  "systemctl status acme-ci-runner",
  "systemctl is-active acme-ci-runner",
  "systemctl --user restart homeactions-watchdog.timer",
  "journalctl -u acme-ci-runner --since -1h --no-pager",
  "mdutil -s /",
  "ssh buildbox 'df -h / && launchctl print system/com.example.ci.runner | head -20'",
  "ssh -o BatchMode=yes buildbox true",
  "ssh buildbox 'pgrep -u acme-ci -fl Runner.Worker'",
  "scp -r out/host buildbox:/tmp/homeactions-kit",
  // owner scripts, but only the agent-safe forms
  "bash out/host/provision.sh install --dry-run",
  "bash out/host/provision.sh verify",
  "bash ~/homeactions-kit/provision.sh preflight",
  "bash out/host/provision.sh firewall --dry-run",
  "bash out/host/uninstall.sh --dry-run",
  "./out/host/provision.sh --help",
  // ordinary work
  "node skills/homeactions/kit/render.mjs --profile .homeactions/profile.json --out out --check",
  "bash skills/homeactions/kit/render.sh --profile .homeactions/profile.json --out out",
  "node skills/homeactions/audit/audit.mjs --repo example-org/acme-app --root . --json",
  "gh api repos/example-org/acme-app/actions/runners",
  "git status && git diff --stat",
  "shasum -a 256 -c SHA256SUMS",
  "ln -s /etc/hosts ~/hosts-link",
  "bash -c 'echo hello && ls -la'",
  "sh -c 'grep -n sudo README.md'",
  "systemctl --user daemon-reload",
];

const modes = HAS_JQ ? [false, true] : [true];

for (const noJq of modes) {
  const label = noJq ? "built-in JSON decoder" : "jq";
  test(`denies every privileged fixture (${DENY.length}, ${label})`, () => {
    const missed = DENY.filter((c) => decide(c, { noJq }).decision !== "deny");
    assert.deepEqual(missed, [], "these privileged commands were allowed");
  });
  test(`allows every look-alike and read-only fixture (${ALLOW.length}, ${label})`, () => {
    const blocked = ALLOW.filter((c) => decide(c, { noJq }).decision !== "allow");
    assert.deepEqual(blocked, [], "these harmless commands were denied");
  });
}

test("the deny reason tells the agent to hand the step to the owner", () => {
  const { decision, reason } = decide("ssh buildbox 'sudo launchctl kickstart -k system/com.example.ci.runner'");
  assert.equal(decision, "deny");
  assert.match(reason, /machine owner/);
  assert.match(reason, /own terminal/);
  assert.match(reason, /owner-checklist\.md/);
});

test("the deny output is valid JSON even when the command contains quotes and backslashes", () => {
  const { decision, reason } = decide("sudo echo \"a\\\"b\" 'c\\d'");
  assert.equal(decision, "deny");
  assert.equal(typeof reason, "string");
});

test("non-Bash tools pass through untouched", () => {
  assert.equal(decide("sudo ls", { tool: "Read" }).decision, "allow");
});

test("JSON escapes in the command are decoded before analysis (no-jq path)", () => {
  const raw = '{"tool_name":"Bash","tool_input":{"command":"echo ok\\nsu\\u0064o ls"}}';
  assert.equal(decide(null, { raw, noJq: true }).decision, "deny");
  const raw2 = '{"tool_name":"Bash","tool_input":{"command":"grep \\"sudo\\" README.md"}}';
  assert.equal(decide(null, { raw: raw2, noJq: true }).decision, "allow");
});

test("empty or unparsable input is allowed (nothing to run)", () => {
  assert.equal(decide(null, { raw: "" }).decision, "allow");
  assert.equal(decide(null, { raw: "{}" }).decision, "allow");
});

test("there are at least 40 fixtures, both deny and allow", () => {
  assert.ok(DENY.length + ALLOW.length >= 40);
  assert.ok(DENY.length >= 20 && ALLOW.length >= 20);
});

test("hooks.json wires the guard as a PreToolUse command hook on Bash", () => {
  const hooks = JSON.parse(readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8"));
  const pre = hooks.hooks.PreToolUse;
  assert.ok(Array.isArray(pre) && pre.length === 1);
  assert.equal(pre[0].matcher, "Bash");
  assert.equal(pre[0].hooks[0].type, "command");
  assert.match(pre[0].hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/guard-privileged\.sh/);
});

test("the guard script is bash 3.2-clean (bash -n)", () => {
  const r = spawnSync("bash", ["-n", GUARD], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
