// T8 rows 8–10: CLI JSON envelope + exit-class matrix, import gate, and the
// adapter-absent precondition (M3). Self-contained harness (same contract as
// cli.e2e.test.mjs, duplicated on purpose — no cross-file helper coupling).

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "../..");
const BIN = path.join(REPO, "bin/asylumwarden.mjs");
const SPAWN_OPTS = { encoding: "utf8", timeout: 30_000, maxBuffer: 8 << 20, stdio: ["ignore", "pipe", "pipe"] };

function cli(home, args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      ...SPAWN_OPTS, env: { ...process.env, HOME: home }, cwd,
    });
    return { code: 0, json: JSON.parse(stdout) };
  } catch (err) {
    let json = null;
    try { json = JSON.parse(err.stdout ?? ""); } catch { /* non-JSON stdout */ }
    return { code: typeof err.status === "number" ? err.status : 1, json };
  }
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

// Stable envelope fields (CONTRACT §8.1) — present on EVERY CLI output,
// success or failure, regardless of command payload extras.
const ENVELOPE_KEYS = [
  "ok", "code", "message", "wave", "cell", "actor", "epoch",
  "state", "expires_at", "receipt", "violations", "warnings", "degraded",
];

function checkEnvelope(label, res, expectCode, expectRc) {
  assert.ok(res.json !== null, `${label}: stdout is not a JSON envelope (exit ${res.code})`);
  for (const key of ENVELOPE_KEYS) {
    assert.ok(Object.hasOwn(res.json, key), `${label}: envelope missing stable field "${key}"`);
  }
  assert.ok([0, 1, 2].includes(res.code), `${label}: rc ${res.code} outside {0,1,2}`);
  assert.equal(res.code, expectRc, `${label}: exit class (§8.2/§8.3), envelope ${JSON.stringify(res.json)}`);
  assert.equal(res.json.code, expectCode, `${label}: exact error/OK code`);
  assert.equal(res.json.ok, expectRc === 0, `${label}: ok flag mirrors exit class`);
  assert.ok(Array.isArray(res.json.violations) && Array.isArray(res.json.warnings),
    `${label}: violations/warnings must be arrays`);
}

function makeWorld(t, label) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `aw-t8-${label}-`)));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  // Separate temp root for no-config probes: discovery walks UP, so it must
  // not sit under base (which carries asylumwarden.json).
  const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `aw-t8-${label}-empty-`)));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const home = path.join(base, "home");
  const root = path.join(base, "line");
  const work = path.join(root, "work");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(work, { recursive: true });

  const regPath = path.join(home, ".config/asylumwarden/registry.json");
  const boot = cli(home, ["init", "--bootstrap-registry", "--registry", regPath, "--self", "demo", "--root", root], base);
  assert.equal(boot.code, 0, `bootstrap: ${JSON.stringify(boot.json)}`);
  const stateHome = path.join(home, ".local/state/asylumwarden");
  const configPath = path.join(base, "asylumwarden.json");
  fs.writeFileSync(configPath, `${JSON.stringify({
    version: 1, registry: regPath, registry_sha256: boot.json.registry.sha256,
    self: "demo", state_home: stateHome,
    mode: "normal", kinds: {}, anchor: null,
  }, null, 2)}\n`);
  const init = cli(home, ["init", "--config", configPath], base);
  assert.equal(init.code, 0, `init: ${JSON.stringify(init.json)}`);

  const run = (args, cwd = base) => cli(home, args, cwd);
  return { base, home, root, work, empty, regPath, stateHome, configPath, run };
}

function planWave(world, wave, cells) {
  const p = path.join(world.base, `${wave}.json`);
  fs.writeFileSync(p, `${JSON.stringify({ version: 1, wave, cells }, null, 2)}\n`);
  return world.run(["plan", p, "--config", world.configPath]);
}

const cell = (id, deps, world) =>
  ({ id, kind: "gen", line: "demo", cwd: world.work, allowed_roots: [world.work], deps });

function makeReceipt(world, { cell: cellId, actor, epoch, status = "done", cmdExit = 0, badHash = false }) {
  const artifact = path.join(world.work, `env-art-${cellId}-${Math.random().toString(36).slice(2, 8)}`);
  fs.writeFileSync(artifact, `env artifact ${cellId}\n`);
  const doc = {
    version: 1, cell: cellId, actor, epoch, status,
    summary: `t8 envelope receipt ${cellId}`,
    commands: [{ cmd: "node --version", exit: cmdExit }],
    artifacts: [{ path: artifact, sha256: badHash ? "0".repeat(64) : sha256File(artifact) }],
    reads: [],
  };
  const p = path.join(world.base, `env-receipt-${cellId}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`);
  return p;
}

// ---------------------------------------------------------------------------
// Row 8 — every command through the envelope/exit-class matrix: success for
// all 12 commands, --help/unknown-flag/missing-flag shapes, and config/lease/
// receipt rejection probes. Every output: 13 stable fields + exact code +
// exit class (CONTRACT §8.1/§8.2/§8.3).
// ---------------------------------------------------------------------------
test("T8 row 8: CLI JSON envelope on all commands — stable fields present, exit classes match CONTRACT §8.3", (t) => {
  const w = makeWorld(t, "envelope");
  const cfg = w.configPath;
  const C = (id, deps = []) => cell(id, deps, w);

  // -- help / version shapes
  checkEnvelope("--help", w.run(["--help"]), "OK", 0);
  checkEnvelope("bare argv", w.run([]), "OK", 0);
  checkEnvelope("help word", w.run(["help"]), "OK", 0);

  // -- success sweep across the full command table (§8 command list)
  checkEnvelope("init idempotent", w.run(["init", "--config", cfg]), "OK", 0);
  checkEnvelope("plan w8", planWave(w, "w8", [C("c1")]), "OK", 0);
  checkEnvelope("ready w8", w.run(["ready", "w8", "--config", cfg]), "OK", 0);
  checkEnvelope("claim w8/c1", w.run(["claim", "w8", "c1", "--actor", "seat-m", "--config", cfg]), "OK", 0);
  checkEnvelope("renew w8/c1", w.run(["renew", "w8", "c1", "--actor", "seat-m", "--epoch", "1", "--config", cfg]), "OK", 0);
  checkEnvelope("release w8/c1", w.run(["release", "w8", "c1", "--actor", "seat-m", "--epoch", "1", "--config", cfg]), "OK", 0);
  checkEnvelope("re-claim w8/c1", w.run(["claim", "w8", "c1", "--actor", "seat-m", "--config", cfg]), "OK", 0);
  let rec = makeReceipt(w, { cell: "c1", actor: "seat-m", epoch: 2 });
  checkEnvelope("done w8/c1", w.run(["done", "w8", "c1", "--actor", "seat-m", "--epoch", "2", "--receipt", rec, "--config", cfg]), "OK", 0);
  checkEnvelope("plan w8f", planWave(w, "w8f", [C("f1")]), "OK", 0);
  checkEnvelope("claim w8f/f1", w.run(["claim", "w8f", "f1", "--actor", "seat-m", "--config", cfg]), "OK", 0);
  checkEnvelope("fail w8f/f1", w.run(["fail", "w8f", "f1", "--actor", "seat-m", "--epoch", "1", "--reason", "exit-class probe", "--config", cfg]), "OK", 0);
  // §7 amendment (c7b03b8): a successful done/fail CONSUMES the lease — the
  // failed cell must be requeue-able, and a finished cell must carry no lease.
  assert.ok(!fs.existsSync(path.join(w.stateHome, "waves", "w8f", "leases", "f1", "owner.json")),
    "fail must consume the lease (§7 amendment)");
  checkEnvelope("requeue w8f/f1 after fail", w.run(["requeue", "w8f", "f1", "--config", cfg]), "OK", 0);
  checkEnvelope("requeue pending cell refused", w.run(["requeue", "w8f", "f1", "--config", cfg]), "CELL-STATE", 1);
  checkEnvelope("status", w.run(["status", "--config", cfg]), "OK", 0);
  checkEnvelope("verify", w.run(["verify", "--config", cfg]), "OK", 0);
  checkEnvelope("registry check", w.run(["registry", "check", "--config", cfg]), "OK", 0);

  // -- lease probes on a fresh claimed cell (rejections must not mutate state)
  checkEnvelope("plan w8e", planWave(w, "w8e", [C("e1")]), "OK", 0);
  checkEnvelope("claim w8e/e1", w.run(["claim", "w8e", "e1", "--actor", "seat-m", "--config", cfg]), "OK", 0);
  rec = makeReceipt(w, { cell: "e1", actor: "seat-m", epoch: 1 });
  checkEnvelope("done wrong epoch", w.run(["done", "w8e", "e1", "--actor", "seat-m", "--epoch", "99", "--receipt", rec, "--config", cfg]), "EPOCH-MISMATCH", 1);
  checkEnvelope("done wrong actor", w.run(["done", "w8e", "e1", "--actor", "intruder", "--epoch", "1", "--receipt", rec, "--config", cfg]), "ACTOR-MISMATCH", 1);
  const badCmd = makeReceipt(w, { cell: "e1", actor: "seat-m", epoch: 1, cmdExit: 1 });
  checkEnvelope("done cmd exit!=0", w.run(["done", "w8e", "e1", "--actor", "seat-m", "--epoch", "1", "--receipt", badCmd, "--config", cfg]), "RECEIPT-COMMANDS", 1);
  const badHash = makeReceipt(w, { cell: "e1", actor: "seat-m", epoch: 1, badHash: true });
  checkEnvelope("done artifact hash mismatch", w.run(["done", "w8e", "e1", "--actor", "seat-m", "--epoch", "1", "--receipt", badHash, "--config", cfg]), "RECEIPT-HASH", 1);
  checkEnvelope("claim ttl below min", w.run(["claim", "w8e", "e1", "--actor", "seat-m", "--ttl", "10", "--config", cfg]), "USAGE", 1);
  checkEnvelope("renew on claimed cell wrong epoch", w.run(["renew", "w8e", "e1", "--actor", "seat-m", "--epoch", "42", "--config", cfg]), "EPOCH-MISMATCH", 1);
  checkEnvelope("claim live lease held", w.run(["claim", "w8e", "e1", "--actor", "seat-x", "--config", cfg]), "LEASE-HELD", 1);
  checkEnvelope("renew on done cell", w.run(["renew", "w8", "c1", "--actor", "seat-m", "--epoch", "2", "--config", cfg]), "CELL-STATE", 1);
  checkEnvelope("claim after done", w.run(["claim", "w8", "c1", "--actor", "seat-m", "--config", cfg]), "CELL-STATE", 1);
  assert.ok(!fs.existsSync(path.join(w.stateHome, "waves", "w8", "leases", "c1", "owner.json")),
    "done consumed the lease (§7 amendment)");

  // -- usage / argv probes
  checkEnvelope("unknown command", w.run(["frobnicate", "--config", cfg]), "UNKNOWN-COMMAND", 1);
  checkEnvelope("unknown global flag", w.run(["--nope"]), "USAGE", 1);
  checkEnvelope("unknown command flag", w.run(["status", "--nope", "--config", cfg]), "USAGE", 1);
  checkEnvelope("value flag missing value", w.run(["status", "--state-home", "--config", cfg]), "USAGE", 1);
  checkEnvelope("plan missing manifest", w.run(["plan", "--config", cfg]), "USAGE", 1);
  checkEnvelope("ready missing wave", w.run(["ready", "--config", cfg]), "USAGE", 1);
  checkEnvelope("claim missing actor", w.run(["claim", "w8", "c1", "--config", cfg]), "USAGE", 1);
  checkEnvelope("renew missing epoch", w.run(["renew", "w8", "c1", "--actor", "seat-m", "--config", cfg]), "USAGE", 1);
  checkEnvelope("release missing epoch", w.run(["release", "w8", "c1", "--actor", "seat-m", "--config", cfg]), "USAGE", 1);
  checkEnvelope("done missing receipt", w.run(["done", "w8", "c1", "--actor", "seat-m", "--epoch", "1", "--config", cfg]), "USAGE", 1);
  checkEnvelope("fail missing reason", w.run(["fail", "w8", "c1", "--actor", "seat-m", "--epoch", "1", "--config", cfg]), "USAGE", 1);
  checkEnvelope("registry missing subcommand", w.run(["registry", "--config", cfg]), "USAGE", 1);
  checkEnvelope("registry bad subcommand", w.run(["registry", "bogus", "--config", cfg]), "USAGE", 1);
  checkEnvelope("ready ghost wave", w.run(["ready", "ghostwave", "--config", cfg]), "WAVE-MISSING", 1);
  checkEnvelope("claim ghost wave", w.run(["claim", "ghostwave", "c1", "--actor", "seat-m", "--config", cfg]), "WAVE-MISSING", 1);
  checkEnvelope("claim ghost cell", w.run(["claim", "w8", "ghostcell", "--actor", "seat-m", "--config", cfg]), "CELL-MISSING", 1);

  // -- fail-closed config probes from a directory with no config on the up-tree
  checkEnvelope("status no config", cli(w.home, ["status"], w.empty), "CONFIG-MISSING", 2);
  checkEnvelope("registry check no config", cli(w.home, ["registry", "check"], w.empty), "CONFIG-MISSING", 2);

  // Post-matrix state sanity: rejected done attempts left no mutation — and
  // did NOT consume the lease (consumption belongs to success only).
  assert.ok(fs.existsSync(path.join(w.stateHome, "waves", "w8e", "leases", "e1", "owner.json")),
    "rejected done attempts never consume the lease");
  const st = w.run(["status", "w8e", "--config", cfg]);
  assert.equal(st.code, 0);
  assert.equal(st.json.waves[0].cells.find((c) => c.id === "e1").state, "claimed");
});

// ---------------------------------------------------------------------------
// Row 9 — import gate + zero-dep check (package script gate:imports) exit 0.
// Spawned via node directly (same command the npm script runs, PATH-safe).
// ---------------------------------------------------------------------------
test("T8 row 9: import gate exit 0 — core is stdlib-only, zero runtime deps", () => {
  let stdout = "";
  let code = 0;
  try {
    stdout = execFileSync(process.execPath, [path.join(REPO, "tools/import-gate.mjs")],
      { ...SPAWN_OPTS, cwd: REPO });
  } catch (err) {
    code = typeof err.status === "number" ? err.status : 1;
    stdout = err.stdout?.toString() ?? "";
  }
  assert.equal(code, 0, `import gate failed:\n${stdout}`);
  assert.match(stdout, /import gate OK/);

  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  assert.deepEqual(pkg.dependencies ?? {}, {}, "zero-dep product promise");
});

// ---------------------------------------------------------------------------
// Row 10 — CLI works with adapters absent (M3 precondition), proven
// behaviorally: the entire command surface ran in row 8 with zero adapter
// involvement, the core→adapters ban is enforced by the import gate (row 9),
// and the bin answers standalone from an unrelated cwd. Feature detection
// shape: --version prints {name, version, contract: 1} (CONTRACT §11).
// (Deliberately NOT asserting adapters/ directory absence: adapters/ may or
// may not exist in the tree; the promise is that core never depends on it.)
// ---------------------------------------------------------------------------
test("T8 row 10: adapter-independent CLI — standalone bin, --version reports {name, version, contract:1}", () => {
  assert.ok(fs.existsSync(BIN), `bin entrypoint present: ${BIN}`);

  // Run from a cwd with no project context at all: bin + package only.
  const res = cli(os.tmpdir(), ["--version", "--json"], os.tmpdir());
  checkEnvelope("--version", res, "OK", 0);
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  assert.equal(res.json.name, "asylumwarden");
  assert.equal(res.json.version, pkg.version);
  assert.equal(res.json.contract, 1, "CONTRACT §11 adapter feature-detection field");
});
