// Static checks of the rendered provisioner kit (HMA provisioner area): syntax, lint, manifest gating,
// pf anchor, nftables, systemd hardening and the token rules. Zero dependencies: node --test tests/provision/
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { fixtureNames, renderedFixture, has, stubs, tmp, cleanupAll } from "./helpers.mjs";

after(cleanupAll);

const MY_SCRIPTS = ["provision.sh", "uninstall.sh", "pf/pf-load.sh", "nftables/nft-load.sh"];
const existing = (r) => MY_SCRIPTS.map((s) => path.join(r.host, s)).filter((p) => existsSync(p));
const read = (p) => readFileSync(p, "utf8");

for (const f of fixtureNames) {
  test(`${f}: every provisioner script passes bash -n (bash 3.2 on macOS) and is executable`, () => {
    const r = renderedFixture(f);
    const scripts = existing(r);
    assert.ok(scripts.length >= 2, "provision.sh and uninstall.sh are rendered");
    for (const s of scripts) {
      const res = spawnSync("/bin/bash", ["-n", s], { encoding: "utf8" });
      assert.equal(res.status, 0, `${s}: ${res.stderr}`);
      assert.ok(statSync(s).mode & 0o100, `${s} is executable`);
    }
  });

  test(`${f}: shellcheck -S warning is clean on the provisioner scripts`, { skip: !has("shellcheck") && "shellcheck not installed" }, () => {
    const r = renderedFixture(f);
    const res = spawnSync("shellcheck", ["-S", "warning", "-s", "bash", ...existing(r)], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stdout + res.stderr);
  });

  test(`${f}: no grep -q downstream of a pipe, no StartCalendarInterval`, () => {
    const r = renderedFixture(f);
    for (const s of existing(r)) {
      for (const [i, line] of read(s).split("\n").entries()) {
        if (/^\s*#/.test(line)) continue;
        assert.ok(!/\|\s*grep\b[^|]*\s-[a-zA-Z]*q/.test(line), `${s}:${i + 1} pipes into grep -q`);
      }
    }
    for (const p of ["launchd/firewall.plist"].map((x) => path.join(r.host, x)).filter(existsSync)) {
      assert.ok(!read(p).includes("StartCalendarInterval"), `${p} uses StartCalendarInterval`);
    }
  });

  test(`${f}: the token never reaches argv: no --token anywhere, env input only via read -rs + pipe + env -i`, () => {
    const r = renderedFixture(f);
    for (const name of ["provision.sh", "uninstall.sh"]) {
      const text = read(path.join(r.host, name));
      assert.ok(!text.includes("--token"), `${name} mentions --token`);
      assert.ok(!/ACTIONS_RUNNER_INPUT_TOKEN=/.test(text), `${name} assigns ACTIONS_RUNNER_INPUT_TOKEN on a command line`);
      assert.match(text, /IFS= read -rs token/, `${name} reads the token at a hidden prompt`);
      assert.match(text, /printf '%s\\n' "\$token" \| tenant_q \/bin\/bash --noprofile --norc -c '/, `${name} pipes the token into bash`);
      assert.match(text, /sudo -H -u "\$T_USER" env -i /, `${name} crosses into the tenant through env -i`);
      for (const [i, line] of text.split("\n").entries()) {
        if (!line.includes("ACTIONS_RUNNER_INPUT_TOKEN")) continue;
        const ok =
          /^\s*#/.test(line) ||
          /^\s*IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN$/.test(line) ||
          /^\s*export ACTIONS_RUNNER_INPUT_TOKEN$/.test(line) ||
          /IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN; export ACTIONS_RUNNER_INPUT_TOKEN; cd/.test(line);
        assert.ok(ok, `${name}:${i + 1} uses ACTIONS_RUNNER_INPUT_TOKEN some other way: ${line.trim()}`);
      }
      // The variable holding the pasted token is only ever read by `read -rs`, piped by printf (a
      // builtin), and cleared.
      for (const [i, line] of text.split("\n").entries()) {
        if (!/\$token\b|\btoken=/.test(line) || /^\s*#/.test(line)) continue;
        const ok = /IFS= read -rs token/.test(line) || /printf '%s\\n' "\$token" \|/.test(line) || /\[ -n "\$token" \]|\[ -z "\$token" \]|case "\$token" in|token=""$|^\s*\+ printf/.test(line) || /"\+ printf '%s\\\\n' \\"\\\$token\\"/.test(line);
        assert.ok(ok, `${name}:${i + 1} touches $token unexpectedly: ${line.trim()}`);
      }
    }
  });
}

test("manifest: pf, firewall plist, nftables and firewall unit render only when isolation.network", () => {
  const off = renderedFixture("dedicated-mac.json");
  const on = renderedFixture("two-tenant-mac.json");
  const lin = renderedFixture("linux-beta.json");
  assert.equal(off.profile.isolation.network, false);
  for (const p of ["pf/anchor.pf", "pf/pf-load.sh", "launchd/firewall.plist"]) {
    assert.ok(!existsSync(path.join(off.host, p)), `${p} rendered with network off`);
    assert.ok(existsSync(path.join(on.host, p)), `${p} missing with network on`);
  }
  for (const p of ["provision.sh", "uninstall.sh"]) {
    assert.ok(existsSync(path.join(off.host, p)) && existsSync(path.join(on.host, p)) && existsSync(path.join(lin.host, p)));
  }
  for (const p of ["systemd/runner.service", "systemd/firewall.service", "nftables/tenant.nft", "nftables/nft-load.sh"]) {
    assert.ok(existsSync(path.join(lin.host, p)), `${p} missing on linux`);
    assert.ok(!existsSync(path.join(on.host, p)), `${p} rendered on macOS`);
  }
  assert.ok(!existsSync(path.join(lin.host, "pf")), "pf rendered on linux");
  assert.match(read(path.join(on.host, "provision.sh")), /^#!\/bin\/bash\n# rendered by homeactions/);
  assert.match(read(path.join(lin.host, "provision.sh")), /Linux provisioner \(BETA\)/);
});

test("macOS firewall plist: plutil -lint, label, loader path, StartInterval 300, RunAtLoad", { skip: process.platform !== "darwin" && "plutil is macOS-only" }, () => {
  const r = renderedFixture("two-tenant-mac.json");
  const p = path.join(r.host, "launchd/firewall.plist");
  const res = spawnSync("plutil", ["-lint", p], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const json = JSON.parse(spawnSync("plutil", ["-convert", "json", "-o", "-", p], { encoding: "utf8" }).stdout);
  assert.equal(json.Label, r.d.firewallLabel);
  assert.deepEqual(json.ProgramArguments, ["/bin/bash", `${r.profile.tenant.rootDir}/pf-load.sh`]);
  assert.equal(json.StartInterval, 300);
  assert.equal(json.RunAtLoad, true);
  assert.equal(json.StartCalendarInterval, undefined);
});

test("pf anchor: every rule carries `user <tenant>`, nothing machine-wide, the ports macro and private table match the profile", () => {
  const r = renderedFixture("two-tenant-mac.json");
  const text = read(path.join(r.host, "pf/anchor.pf"));
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const rules = lines.filter((l) => /^(pass|block)\b/.test(l));
  assert.equal(rules.length, 7, "seven rules, as verify tells the owner to expect");
  for (const l of rules) assert.ok(l.includes(` user ${r.profile.tenant.user}`), `rule without user: ${l}`);
  for (const l of lines) {
    assert.ok(!/^(set|scrub|nat|rdr|binat|antispoof|anchor|load|nat-anchor|rdr-anchor)\b/.test(l), `machine-wide line: ${l}`);
    assert.ok(/^(pass|block)\b/.test(l) || /^tenant_ports = /.test(l) || /^table <tenant_private> const /.test(l), `unexpected line: ${l}`);
  }
  const macro = /^tenant_ports = "\{ (.*) \}"$/m.exec(text);
  assert.ok(macro, "ports macro present");
  assert.deepEqual(macro[1].split(/,\s*/).map(Number), r.profile.ports);
  const table = /^table <tenant_private> const \{ (.*) \}$/m.exec(text);
  assert.ok(table);
  assert.deepEqual(table[1].split(/,\s*/), r.profile.isolation.privateRanges);
  assert.ok(rules.some((l) => /^pass out quick on lo0 proto tcp from any to any port \$tenant_ports /.test(l)), "loopback pass to own ports");
  assert.ok(rules.some((l) => /^pass out quick on lo0 proto tcp from any port \$tenant_ports to any /.test(l)), "loopback pass from own ports");
  // Regression (first real install, 2026-11-12): the reply pass must be stateless. A stateful pass only matches
  // the opening SYN (flags S/SA), so the listener's SYN-ACK hit the block and the tenant's own Postgres timed out.
  assert.ok(rules.some((l) => /^pass out quick on lo0 proto tcp from any port \$tenant_ports to any user \S+ no state$/.test(l)), "the reply pass from own ports is stateless");
  assert.ok(rules.some((l) => /^pass out quick on lo0 proto tcp from any to any port \$tenant_ports user \S+ keep state$/.test(l)), "the connect pass to own ports keeps state");
  assert.ok(rules.some((l) => /^block return out quick on lo0 /.test(l)), "other loopback blocked");
  assert.ok(rules.some((l) => /to <tenant_private> port 53 /.test(l) && l.startsWith("pass")), "DNS to private allowed");
  assert.ok(rules.some((l) => /^block return out quick proto \{ tcp, udp \} from any to <tenant_private> /.test(l)), "private blocked");
  assert.ok(rules.some((l) => /^pass out quick proto \{ tcp, udp \} from any to any user /.test(l)), "internet passed");
  assert.ok(rules.some((l) => /^block drop in quick on ! lo0 /.test(l)), "inbound off lo0 blocked");
  const idx = (re) => rules.findIndex((l) => re.test(l));
  assert.ok(idx(/port 53/) < idx(/^block return out quick proto/), "DNS pass precedes the private block");
});

test("pf loader: same anchor, rules file and token file as the provisioner; refuses non-root and a missing tenant", () => {
  const r = renderedFixture("two-tenant-mac.json");
  const text = read(path.join(r.host, "pf/pf-load.sh"));
  assert.match(text, new RegExp(`^ANCHOR='${r.d.pfAnchor.replace(/\//g, "\\/")}'$`, "m"));
  assert.match(text, new RegExp(`^RULES='${r.d.pfAnchorFile}'$`, "m"));
  assert.match(text, new RegExp(`^TOKEN_FILE='/var/run/${r.profile.tenant.labelPrefix}\\.pf\\.token'$`, "m"));
  assert.match(text, /pfctl -q -n -a "\$ANCHOR" -f "\$RULES"/);
  assert.match(text, /pfctl -E/);
  // non-root refuses before touching pf (pfctl is a recording stub here, and must not be called)
  const res = spawnSync("/bin/bash", [path.join(r.host, "pf/pf-load.sh")], { encoding: "utf8", env: { PATH: `${stubs()}:/usr/bin:/bin`, STUB_UID: "501" } });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /must run as root/);
});

test("Linux runner unit: hardening keys, tenant identity, firewall dependency", () => {
  const r = renderedFixture("linux-beta.json");
  const unit = read(path.join(r.host, "systemd/runner.service"));
  const t = r.profile.tenant;
  const want = [
    `User=${t.user}`,
    `Group=${t.group}`,
    `WorkingDirectory=${r.d.runnerDir}`,
    `ExecStart=${r.d.runnerDir}/runsvc.sh`,
    "Restart=always",
    `Nice=${r.profile.caps.nice}`,
    "IOSchedulingClass=idle",
    `LimitNOFILE=${r.profile.caps.openFiles}`,
    "NoNewPrivileges=yes",
    "ProtectSystem=strict",
    "ProtectHome=no",
    `ReadWritePaths=${t.home} /tmp`,
    "PrivateTmp=yes",
    "KillMode=control-group",
    "WantedBy=multi-user.target",
    `Requires=${r.d.firewallLabel}.service`,
  ];
  const lines = unit.split("\n");
  for (const k of want) assert.ok(lines.includes(k), `runner.service lacks ${k}`);
  assert.ok(!/^User=root$/m.test(unit));
  const fw = read(path.join(r.host, "systemd/firewall.service"));
  assert.match(fw, /^Type=oneshot$/m);
  assert.match(fw, /^RemainAfterExit=yes$/m);
  assert.match(fw, new RegExp(`^ExecStart=/bin/bash ${t.rootDir}/nft-load.sh load$`, "m"));
  assert.match(fw, new RegExp(`^Before=.*${r.d.daemonLabel.replace(/\./g, "\\.")}\\.service`, "m"));
  for (const f of ["systemd/runner.service", "systemd/firewall.service"]) {
    if (!has("systemd-analyze")) continue;
    // Unit syntax only; a real verify also checks the paths exist, which they do not here.
    const res = spawnSync("systemd-analyze", ["verify", path.join(r.host, f)], { encoding: "utf8" });
    assert.ok(!/Unknown (key|section)|Failed to parse/i.test(res.stderr), res.stderr);
  }
});

test("nftables: every rule is scoped to the tenant uid, own ports on lo, private sets filled by family", () => {
  const r = renderedFixture("linux-beta.json");
  const uid = r.profile.tenant.uid;
  const nft = read(path.join(r.host, "nftables/tenant.nft"));
  assert.match(nft, new RegExp(`^table inet ${r.d.nftTable} \\{$`, "m"));
  const rules = nft.split("\n").map((l) => l.trim()).filter((l) => /(accept|reject|reset|drop)$/.test(l) && !l.startsWith("type ") && !l.startsWith("#"));
  assert.ok(rules.length >= 10);
  for (const l of rules) assert.ok(l.includes(`meta skuid ${uid} `), `rule not scoped to uid ${uid}: ${l}`);
  assert.ok(!/flush ruleset|^\s*table (ip|ip6|inet) (?!homeactions_)/m.test(nft), "touches more than its own table");
  const ports = r.profile.ports.join(", ");
  assert.ok(nft.includes(`tcp dport { ${ports} } accept`));
  assert.ok(nft.includes(`tcp sport { ${ports} } accept`));
  assert.match(nft, /policy accept;/);

  // The loader's own ruleset composition, with its root check and file path pointed at test copies.
  const dir = tmp("homeactions-nft-");
  const rules2 = path.join(dir, "tenant.nft");
  writeFileSync(rules2, nft);
  const loader = read(path.join(r.host, "nftables/nft-load.sh"))
    .replace(/^RULES='.*'$/m, `RULES='${rules2}'`)
    .replace(/^NFT=.*$/m, `NFT='${path.join(dir, "nft")}'`);
  writeFileSync(path.join(dir, "nft-load.sh"), loader);
  writeFileSync(path.join(dir, "nft"), `#!/bin/bash\ncat > "${path.join(dir, "captured")}"\n`, { mode: 0o755 });
  const res = spawnSync("/bin/bash", [path.join(dir, "nft-load.sh"), "check"], { encoding: "utf8", env: { PATH: `${stubs()}:/usr/bin:/bin`, STUB_UID: "0" } });
  assert.equal(res.status, 0, res.stderr);
  const composed = read(path.join(dir, "captured"));
  assert.match(composed, new RegExp(`^add table inet ${r.d.nftTable}\\ndelete table inet ${r.d.nftTable}\\n`));
  const v4 = r.profile.isolation.privateRanges.filter((x) => !x.includes(":")).join(", ");
  const v6 = r.profile.isolation.privateRanges.filter((x) => x.includes(":")).join(", ");
  assert.ok(composed.includes(`add element inet ${r.d.nftTable} private4 { ${v4} }`), composed);
  assert.ok(composed.includes(`add element inet ${r.d.nftTable} private6 { ${v6} }`), composed);
  if (has("nft")) {
    const chk = spawnSync("nft", ["-c", "-f", path.join(dir, "captured")], { encoding: "utf8" });
    if (!/Operation not permitted|permission denied/i.test(chk.stderr)) assert.equal(chk.status, 0, chk.stderr);
  }
});

test("nft -c -f parses the rendered table", { skip: !has("nft") && "nft not installed" }, () => {
  const r = renderedFixture("linux-beta.json");
  const res = spawnSync("nft", ["-c", "-f", path.join(r.host, "nftables/tenant.nft")], { encoding: "utf8" });
  if (/Operation not permitted|permission denied/i.test(res.stderr)) return; // nft -c needs CAP_NET_ADMIN on some kernels
  assert.equal(res.status, 0, res.stderr);
});

// Regressions from the first real install (2026-11-12).
test("macOS provisioner: dscl_value reads native attributes (dsAttrTypeNative:IsHidden) as well as standard ones", () => {
  const r = renderedFixture("two-tenant-mac.json");
  const fn = read(path.join(r.host, "provision.sh")).split("\n").find((l) => l.startsWith("dscl_value() "));
  assert.ok(fn, "dscl_value is defined on one line");
  const script = `dscl() { case "$4" in IsHidden) echo "dsAttrTypeNative:IsHidden: 1" ;; UniqueID) echo "UniqueID: 510" ;; esac; }\n${fn}\nprintf '%s|%s|%s\\n' "$(dscl_value /Users/x IsHidden)" "$(dscl_value /Users/x UniqueID)" "$(dscl_value /Users/x Missing)"`;
  const res = spawnSync("/bin/bash", ["-c", script], { encoding: "utf8" });
  assert.equal(res.stdout.trim(), "1|510|", res.stderr);
});

test("macOS provisioner and uninstaller: tenant commands start from / (the owner's kit folder is closed to the tenant)", () => {
  const r = renderedFixture("two-tenant-mac.json");
  for (const s of ["provision.sh", "uninstall.sh"]) {
    const text = read(path.join(r.host, s));
    const bodies = [...text.matchAll(/^(as_tenant|tenant_q)\(\) \{\n([\s\S]*?)\n\}/gm)];
    assert.ok(bodies.length >= 1, `${s}: tenant helpers found`);
    for (const [, name, body] of bodies) assert.match(body, /\(cd \/ && "\$\{argv\[@\]\}" "\$@"\)/, `${s}: ${name} runs from /`);
  }
});
