// Dry-run behaviour of the rendered provisioner and uninstaller: the plan names the fixture's own
// user, paths and labels; nothing is executed (every privileged command is a recording stub and the
// record must stay empty); install and uninstall are exact reverses; unsafe invocations are refused.
// Zero dependencies: node --test tests/provision/
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fixtureNames, loadFixture, rendered, renderedFixture, runScript, commandLines, words, cleanupAll, readFileSync, existsSync } from "./helpers.mjs";

after(cleanupAll);

const SUBS = ["install", "firewall", "register", "firewall-unload"];

function plan(r) {
  const prov = path.join(r.host, "provision.sh");
  const out = {};
  for (const s of SUBS) out[s] = runScript(prov, [s, "--dry-run"]);
  out.uninstall = runScript(path.join(r.host, "uninstall.sh"), ["--dry-run"]);
  return out;
}
const plans = new Map();
const planFor = (f) => plans.get(f) ?? plans.set(f, plan(renderedFixture(f))).get(f);
const isMac = (r) => r.profile.host.os === "macos";

for (const f of fixtureNames) {
  test(`${f}: every --dry-run executes nothing (the stub record stays empty)`, () => {
    const p = planFor(f);
    const r = renderedFixture(f);
    for (const [sub, res] of Object.entries(p)) {
      assert.deepEqual(res.calls, [], `${sub} --dry-run ran: ${res.calls.join(" | ")}`);
      if (sub === "firewall" && !r.profile.isolation.network) {
        assert.notEqual(res.status, 0, "firewall refuses when isolation.network is off");
        assert.match(res.err, /isolation\.network is off/);
      } else {
        assert.equal(res.status, 0, `${sub} --dry-run exit ${res.status}: ${res.err}`);
        assert.match(res.out, /\+ sudo -v/, `${sub} prints its sudo commands`);
      }
    }
  });

  test(`${f}: install --dry-run prints the key commands with the fixture's names`, () => {
    const r = renderedFixture(f);
    const t = r.profile.tenant;
    const out = planFor(f).install.out;
    const want = isMac(r)
      ? [
          `+ sudo dseditgroup -o create -i ${t.gid} -r 'homeactions CI runner ${t.name}' ${t.group}`,
          `+ sudo sysadminctl -addUser ${t.user} -fullName 'homeactions CI runner ${t.name}' -UID ${t.uid} -GID ${t.gid} -shell /usr/bin/false -home ${t.home} -password -`,
          `+ sudo dscl . -create /Users/${t.user} IsHidden 1`,
          `+ sudo chmod 700 ${t.home}`,
          `+ sudo install -d -o root -g wheel -m 0755 ${t.rootDir} ${r.d.hooksDir}`,
          `${r.d.hooksDir}/`,
          `${r.d.confFile}`,
          `+ sudo -H -u ${t.user} env -i HOME=${t.home} `,
          `/usr/bin/curl -fsSL --retry 3 -o ${r.d.cacheDir}/${r.d.runnerTarball} https://github.com/actions/runner/releases/download/v${r.profile.runner.version}/${r.d.runnerTarball}`,
          `shasum -a 256 -c -' sha256 ${r.d.runnerSha} `,
          `/usr/bin/tar -xzf ${r.d.cacheDir}/${r.d.runnerTarball} -C ${r.d.runnerDir}`,
          `/bin/mkdir -p ${r.d.runnerDir} ${r.d.tmpDir} ${r.d.cacheDir} ${r.d.optDir} ${r.d.srcDir} ${r.d.stateDir} ${r.d.logDir}`,
          "? assert: " + t.user + " has no secure token",
          "? assert: " + t.user + " is not in admin",
          "? assert: " + t.user + " has no ~/.ssh",
        ]
      : [
          `+ sudo useradd --system --create-home --home-dir ${t.home} --shell /usr/sbin/nologin --uid ${t.uid} --user-group`,
          `+ sudo chmod 700 ${t.home}`,
          `+ sudo install -d -o root -g root -m 0755 ${t.rootDir} ${r.d.hooksDir}`,
          `sha256sum -c -' sha256 ${r.d.runnerSha} `,
          `tar -xzf ${r.d.cacheDir}/${r.d.runnerTarball} -C ${r.d.runnerDir}`,
          "+ sudo apt-get install -y --no-install-recommends postgresql-16",
          "sudo dnf install -y postgresql16-server",
          "? assert: " + t.user + " has no ~/.ssh",
        ];
    for (const w of want) assert.ok(out.includes(w), `install plan lacks: ${w}\n---\n${out}`);
    for (const a of r.d.otherAdmins) {
      const home = isMac(r) ? `/Users/${a}` : `/home/${a}`;
      const line = isMac(r)
        ? `+ sudo chmod +a 'user:${t.user} deny list,search,readattr,readextattr,readsecurity' ${home}`
        : `+ sudo setfacl -m u:${t.user}:--- ${home}`;
      assert.ok(out.includes(line), `install plan lacks the deny for ${a}`);
    }
    for (const s of r.profile.services) {
      if (s.install === "source") assert.ok(out.includes(`/bin/bash --noprofile --norc ${t.rootDir}/services/build-${s.kind}.sh`), `no build of ${s.kind}`);
    }
  });

  test(`${f}: register --dry-run: env-only token, config.sh flags, root-owned immutable .env/.path, daemon`, () => {
    const r = renderedFixture(f);
    const t = r.profile.tenant;
    const out = planFor(f).register.out;
    assert.ok(out.includes("+ IFS= read -rs token"));
    assert.ok(out.includes(`+ sudo pkill -KILL -u ${t.uid}`), "tenant processes are killed first");
    assert.ok(out.indexOf(`pkill -KILL -u ${t.uid}`) < out.indexOf("read -rs token"), "kill precedes the token");
    const reg = out.split("\n").find((l) => l.startsWith("+ printf '%s\\n' \"$token\" | sudo -H -u "));
    assert.ok(reg, "the token is piped into sudo");
    assert.ok(reg.includes(" env -i "), "env -i");
    assert.ok(reg.includes("/bin/bash --noprofile --norc -c 'IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN; export ACTIONS_RUNNER_INPUT_TOKEN;"));
    assert.ok(reg.includes(`exec ./config.sh --unattended --replace --url "$2" --name "$3" --labels "$4" --work _work' homeactions-register ${r.d.runnerDir} https://github.com/${r.profile.repo.slug} ${t.runnerName} ${r.d.runnerLabelsCsv}`), reg);
    assert.ok(!out.includes("--token"));
    if (isMac(r)) {
      assert.ok(out.includes(`+ sudo chflags uchg ${r.d.runnerDir}/.env ${r.d.runnerDir}/.path`));
      assert.ok(out.includes(`+ sudo install -o root -g wheel -m 0644 ${r.host}/runner/.env ${r.d.runnerDir}/.env`));
      assert.ok(out.includes(`/bin/cp ${r.d.runnerDir}/bin/runsvc.sh ${r.d.runnerDir}/runsvc.sh`));
      assert.ok(out.includes(`/bin/cat ${r.d.runnerDir}/bin/actions.runner.plist.template`));
      assert.ok(out.includes("? assert: no double-brace placeholder is left in"));
      for (const k of [
        `Add :UserName string ${t.user}`,
        `Add :GroupName string ${t.group}`,
        `Add :WorkingDirectory string ${r.d.runnerDir}`,
        "Add :KeepAlive bool true",
        "Add :RunAtLoad bool true",
        "Add :SessionCreate bool true",
        "Add :ProcessType string Standard",
        `Add :Nice integer ${r.profile.caps.nice}`,
        "Add :LowPriorityIO bool true",
        `Add :SoftResourceLimits:NumberOfFiles integer ${r.profile.caps.openFiles}`,
        `Add :HardResourceLimits:NumberOfFiles integer ${r.profile.caps.openFiles}`,
        `Add :StandardOutPath string ${r.d.logDir}/stdout.log`,
        `Add :StandardErrorPath string ${r.d.logDir}/stderr.log`,
      ]) assert.ok(out.includes(`PlistBuddy -c '${k}'`), `register plan lacks PlistBuddy ${k}`);
      assert.ok(out.includes("/usr/bin/plutil -lint"));
      assert.ok(out.includes(`+ sudo launchctl bootstrap system /Library/LaunchDaemons/${r.d.daemonLabel}.plist`));
      assert.ok(out.includes(`? assert: Runner.Listener runs as uid ${t.uid} at nice ${r.profile.caps.nice}`));
    } else {
      assert.ok(out.includes(`+ sudo chattr +i ${r.d.runnerDir}/.env`));
      assert.ok(out.includes(`+ sudo install -o root -g root -m 0644 ${r.host}/systemd/runner.service /etc/systemd/system/${r.d.daemonLabel}.service`));
      assert.ok(out.includes(`+ sudo systemctl enable ${r.d.daemonLabel}.service`));
    }
    if (r.profile.isolation.network) {
      assert.ok(out.includes("? assert: the firewall is active"), "register refuses unless the firewall is active");
      assert.ok(out.indexOf("the firewall is active") < out.indexOf("read -rs token"));
    }
  });

  test(`${f}: install/register/firewall and uninstall are exact reverses`, () => {
    const r = renderedFixture(f);
    const t = r.profile.tenant;
    const p = planFor(f);
    const made = [p.install, p.register, ...(r.profile.isolation.network ? [p.firewall] : [])].flatMap((x) => commandLines(x.out));
    const unmade = commandLines(p.uninstall.out);
    const fwUnload = commandLines(p["firewall-unload"].out);

    // every ACE / ACL entry added is removed with the identical string
    const added = made.filter((l) => / chmod \+a /.test(l)).map((l) => words(l).slice(-2).join(" @ "));
    const removed = unmade.filter((l) => / chmod -a /.test(l)).map((l) => words(l).slice(-2).join(" @ "));
    assert.deepEqual(removed.sort(), added.sort(), "chmod +a / chmod -a strings differ");
    const facl = made.filter((l) => / setfacl -m /.test(l)).map((l) => words(l).slice(-2));
    const unfacl = unmade.filter((l) => / setfacl -x /.test(l)).map((l) => words(l).slice(-2));
    assert.deepEqual(unfacl.map(([e, h]) => `${e}:--- ${h}`).sort(), facl.map(([e, h]) => `${e} ${h}`).sort(), "setfacl -m / -x differ");
    assert.equal(added.length + facl.length, r.d.otherAdmins.length);

    // every daemon / unit started is stopped
    if (isMac(r)) {
      const boot = made.filter((l) => / launchctl bootstrap system /.test(l)).map((l) => path.basename(words(l).at(-1), ".plist"));
      const out = unmade.filter((l) => / launchctl bootout system\//.test(l)).map((l) => words(l).at(-1).replace("system/", ""));
      for (const b of boot) assert.ok(out.includes(b), `bootstrap of ${b} has no bootout`);
      assert.ok(boot.includes(r.d.daemonLabel));
      if (r.profile.isolation.network) assert.ok(boot.includes(r.d.firewallLabel));
    } else {
      const en = made.filter((l) => / systemctl enable /.test(l)).map((l) => words(l).at(-1));
      const dis = unmade.filter((l) => / systemctl disable --now /.test(l)).map((l) => words(l).at(-1));
      for (const u of en) assert.ok(dis.includes(u), `enable of ${u} has no disable`);
    }

    // every path created is removed (directly, or under a removed directory, or with the user's home)
    const created = new Set();
    for (const l of made) {
      const w = words(l);
      if (w[0] !== "sudo") continue;
      if (w[1] === "install") {
        if (w.includes("-d")) w.slice(w.indexOf("-m") + 2).forEach((x) => created.add(x));
        else created.add(w.at(-1).replace(/\/$/, ""));
      }
      if (w[1] === "sysadminctl" || w[1] === "useradd") created.add(t.home);
    }
    if (isMac(r) && r.profile.isolation.network) created.add(`/var/run/${t.labelPrefix}.pf.token`);
    const gone = unmade.filter((l) => / rm -r?f /.test(l) || / rm -f /.test(l)).flatMap((l) => words(l).slice(3));
    assert.ok(unmade.some((l) => l.includes(isMac(r) ? `sysadminctl -deleteUser ${t.user}` : `userdel --remove ${t.user}`)));
    assert.ok(unmade.some((l) => l.includes(isMac(r) ? `dseditgroup -o delete ${t.group}` : `groupdel ${t.group}`)));
    const covered = (p0) => gone.some((g) => p0 === g || p0.startsWith(g + "/"));
    for (const c of created) assert.ok(covered(c), `${c} is created but never removed`);

    // the immutable flags are cleared before the user is deleted
    const flagOff = unmade.findIndex((l) => (isMac(r) ? / chflags -R nouchg / : / chattr -i /).test(l));
    const del = unmade.findIndex((l) => / (sysadminctl -deleteUser|userdel) /.test(l));
    assert.ok(flagOff >= 0 && flagOff < del, "immutable flags cleared before deleting the user");
    // ACEs are removed while the user's name still resolves
    const ace = unmade.findIndex((l) => / (chmod -a|setfacl -x) /.test(l));
    if (ace >= 0) assert.ok(ace < del, "ACEs removed before the user is deleted");
    assert.match(p.uninstall.out, /\? assert gone: user /);

    // the firewall: one anchor / table name everywhere
    if (isMac(r)) {
      const anchorOf = (lines) => lines.filter((l) => / pfctl .*-a /.test(l)).map((l) => words(l)[words(l).indexOf("-a") + 1]);
      const names = new Set([...anchorOf(made), ...anchorOf(unmade), ...anchorOf(fwUnload)]);
      if (r.profile.isolation.network) {
        assert.deepEqual([...names], [r.d.pfAnchor]);
        const loader = readFileSync(path.join(r.host, "pf/pf-load.sh"), "utf8");
        assert.ok(loader.includes(`ANCHOR='${r.d.pfAnchor}'`));
        assert.ok(made.some((l) => l.endsWith(` ${r.d.pfAnchorFile}`)), "anchor file installed");
      } else {
        assert.deepEqual([...names].filter((n) => n !== r.d.pfAnchor), []);
      }
      assert.ok(fwUnload.some((l) => l.includes(`launchctl bootout system/${r.d.firewallLabel}`)));
    } else if (r.profile.isolation.network) {
      const fwInstall = commandLines(p.firewall.out);
      assert.ok(fwInstall.some((l) => l.includes(`nft list table inet ${r.d.nftTable}`)));
      assert.ok(unmade.some((l) => l.includes(`nft delete table inet ${r.d.nftTable}`)));
      const loader = readFileSync(path.join(r.host, "nftables/nft-load.sh"), "utf8");
      assert.ok(loader.includes(`TABLE='${r.d.nftTable}'`));
      assert.ok(fwUnload.some((l) => l.includes(`systemctl disable --now ${r.d.firewallLabel}.service`)));
    }
    const conf = path.join(r.host, "conf/tenant.conf");
    if (existsSync(conf)) {
      const text = readFileSync(conf, "utf8");
      if (/HA_FIREWALL_LABEL=/.test(text)) assert.match(text, new RegExp(`HA_FIREWALL_LABEL="${r.d.firewallLabel.replace(/\./g, "\\.")}"`));
      for (const m of text.matchAll(/com\.apple\/900\.[A-Za-z0-9._-]+/g)) assert.equal(m[0], r.d.pfAnchor, "hooks conf names another anchor");
      for (const m of text.matchAll(/homeactions_[a-z0-9_]+/g)) assert.equal(m[0], r.d.nftTable, "hooks conf names another nft table");
    }
  });

  test(`${f}: refuses to run as root, as the tenant, or for an existing admin; nothing runs`, () => {
    const r = renderedFixture(f);
    const t = r.profile.tenant;
    const prov = path.join(r.host, "provision.sh");
    const un = path.join(r.host, "uninstall.sh");
    const cases = [
      [{ STUB_UID: "0" }, /do not run this as root/],
      [{ STUB_USER: t.user }, /do not run this as the tenant user/],
      [{ STUB_TENANT_GROUPS: isMac(r) ? "staff admin everyone" : `${t.user} sudo` }, /(administrator|privileged)/],
    ];
    for (const [env, re] of cases) {
      for (const [script, args] of [[prov, ["install", "--dry-run"]], [prov, ["register", "--dry-run"]], [prov, ["verify"]], [un, ["--dry-run"]]]) {
        const res = runScript(script, args, env);
        assert.notEqual(res.status, 0, `${path.basename(script)} ${args.join(" ")} with ${JSON.stringify(env)} did not refuse`);
        assert.match(res.err, re);
        assert.deepEqual(res.calls, []);
        assert.ok(!res.out.includes("+ sudo"), "nothing printed as planned before refusing");
      }
    }
  });
}

test("refuses a tenant that is one of host.otherAdmins, and a system rootDir", () => {
  const base = loadFixture("two-tenant-mac.json");
  const asAdmin = structuredClone(base);
  asAdmin.tenant.user = "builder";
  asAdmin.tenant.home = "/Users/builder";
  const r1 = rendered(asAdmin);
  for (const [script, args] of [["provision.sh", ["install", "--dry-run"]], ["uninstall.sh", ["--dry-run"]]]) {
    const res = runScript(path.join(r1.host, script), args);
    assert.notEqual(res.status, 0);
    assert.match(res.err, /listed in host\.otherAdmins/);
    assert.deepEqual(res.calls, []);
  }
  for (const root of ["/Library/LaunchDaemons", "/opt/homebrew", "/etc/ssh"]) {
    const p = structuredClone(base);
    p.tenant.rootDir = root;
    const res = runScript(path.join(rendered(p).host, "provision.sh"), ["install", "--dry-run"]);
    assert.notEqual(res.status, 0, `rootDir ${root} accepted`);
    assert.match(res.err, /system or shared directory|homebrew/);
    assert.deepEqual(res.calls, []);
  }
  const lin = structuredClone(loadFixture("linux-beta.json"));
  lin.tenant.rootDir = "/etc/systemd";
  const res = runScript(path.join(rendered(lin).host, "provision.sh"), ["install", "--dry-run"]);
  assert.notEqual(res.status, 0);
  assert.deepEqual(res.calls, []);
});

test("unknown subcommands and options are refused without running anything", () => {
  const r = renderedFixture("two-tenant-mac.json");
  for (const args of [["frobnicate"], ["install", "--yes"], []]) {
    const res = runScript(path.join(r.host, "provision.sh"), args);
    assert.notEqual(res.status, 0);
    assert.deepEqual(res.calls, []);
  }
});

// Regression from the first real install (2026-11-12): macOS computes every local account into `staff`, so
// (a) the job hook must not forbid that group, and (b) a forbidden read path that is not an admin's home (for
// example another CI user's 750 home owned by group staff) needs the deny-ACE too, added and removed symmetrically.
test("macOS: every forbidden read path under /Users gets the deny-ACE on install and loses it on uninstall", () => {
  const base = loadFixture("two-tenant-mac.json");
  const profile = { ...base, isolation: { ...base.isolation, forbiddenReadPaths: [...base.isolation.forbiddenReadPaths, "/Users/otherci", "/opt/elsewhere"] } };
  const r = rendered(profile);
  const ace = `'user:${profile.tenant.user} deny list,search,readattr,readextattr,readsecurity'`;
  const install = runScript(path.join(r.host, "provision.sh"), ["install", "--dry-run"]);
  assert.equal(install.status, 0, install.err);
  assert.ok(install.out.includes(`+ sudo chmod +a ${ace} /Users/otherci`), install.out);
  assert.ok(install.out.includes(`? assert: ${profile.tenant.user} cannot list /Users/otherci`));
  assert.ok(!install.out.includes("/opt/elsewhere"), "no ACE outside /Users");
  for (const a of profile.host.otherAdmins) assert.equal(install.out.split(`+ sudo chmod +a ${ace} /Users/${a}\n`).length, 2, `${a}: exactly one ACE line`);
  const un = runScript(path.join(r.host, "uninstall.sh"), ["--dry-run"]);
  assert.equal(un.status, 0, un.err);
  assert.ok(un.out.includes(`+ sudo chmod -a ${ace} /Users/otherci`), un.out);
  assert.equal(install.calls.length + un.calls.length, 0, "dry runs execute nothing");
});

test("macOS: the hook's forbidden groups do not include staff (every local account is in it)", () => {
  const r = renderedFixture("two-tenant-mac.json");
  const conf = readFileSync(path.join(r.host, "conf", "tenant.conf"), "utf8");
  const line = conf.split("\n").find((l) => l.startsWith("HA_FORBIDDEN_GROUPS="));
  assert.ok(line && /\badmin\b/.test(line) && /\bwheel\b/.test(line), line);
  assert.ok(!/\bstaff\b/.test(line), line);
});
