// T8 adversarial integration — CLI-level, real subprocesses (TEST-PLAN §T8).
//
// Self-contained harness (no test/helpers.mjs imports): every test spawns
// bin/asylumwarden.mjs as a real CLI with HOME pinned to a per-test mkdtemp,
// parses the JSON envelope from stdout, and asserts EXACT contract codes
// (docs/CONTRACT.md §8.3). Fail-closed probes assert the exact code + exit
// class; "any error" is never accepted.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "../..");
const BIN = path.join(REPO, "bin/asylumwarden.mjs");
const SPAWN_OPTS = { encoding: "utf8", timeout: 30_000, maxBuffer: 8 << 20, stdio: ["ignore", "pipe", "pipe"] };

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

// Synchronous CLI call → { code, json }. json is null when stdout was not JSON.
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

// Async CLI call — used where real process-level concurrency is the probe.
function cliAsync(home, args, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { ...SPAWN_OPTS, env: { ...process.env, HOME: home }, cwd },
      (err, stdout) => {
        let json = null;
        try { json = JSON.parse(stdout ?? ""); } catch { /* ignore */ }
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, json });
      });
  });
}

// Standard normal-mode world, bootstrapped exactly per the CLI contract:
// init --bootstrap-registry → asylumwarden.json pinned to its sha256 → init.
function makeWorld(t, label) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `aw-t8-${label}-`)));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, "home");
  const root = path.join(base, "line");
  const work = path.join(root, "work");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(work, { recursive: true });

  const regPath = path.join(home, ".config/asylumwarden/registry.json");
  const boot = cli(home, ["init", "--bootstrap-registry", "--registry", regPath, "--self", "demo", "--root", root], base);
  assert.equal(boot.code, 0, `bootstrap failed: ${JSON.stringify(boot.json)}`);
  const registrySha256 = boot.json.registry.sha256;
  assert.match(registrySha256, /^[0-9a-f]{64}$/);

  const stateHome = path.join(home, ".local/state/asylumwarden");
  const configPath = path.join(base, "asylumwarden.json");
  fs.writeFileSync(configPath, `${JSON.stringify({
    version: 1, registry: regPath, registry_sha256: registrySha256,
    self: "demo", state_home: stateHome, mode: "normal", kinds: {}, anchor: null,
  }, null, 2)}\n`);

  const init = cli(home, ["init", "--config", configPath], base);
  assert.equal(init.code, 0, `init failed: ${JSON.stringify(init.json)}`);

  const run = (args, cwd = base) => cli(home, args, cwd);
  return { base, home, root, work, regPath, stateHome, configPath, run };
}

function demoCell(id, deps, world, over = {}) {
  return { id, kind: "gen", line: "demo", cwd: world.work, allowed_roots: [world.work], deps, ...over };
}

// Plan a wave from cell rows; asserts plan rc=0. Manifest lands in base/.
function plan(t, world, wave, cells) {
  const manifestPath = path.join(world.base, `${wave}.json`);
  fs.writeFileSync(manifestPath, `${JSON.stringify({ version: 1, wave, cells }, null, 2)}\n`);
  const res = world.run(["plan", manifestPath, "--config", world.configPath]);
  assert.equal(res.code, 0, `plan ${wave} failed: ${JSON.stringify(res.json)}`);
  return res;
}

// Done-ready receipt with one artifact written under `dir`; returns the
// receipt file path. Unique filenames via an internal counter.
let receiptSeq = 0;
function receipt(world, { cell, actor, epoch, dir, name = "art.txt", status = "done", extra = {} }) {
  fs.mkdirSync(dir, { recursive: true });
  receiptSeq += 1;
  const artifact = path.join(dir, `${name}-${cell}-${receiptSeq}`);
  fs.writeFileSync(artifact, `artifact ${cell} ${name} ${receiptSeq}\n`);
  const doc = {
    version: 1, cell, actor, epoch, status,
    summary: `t8 receipt ${cell}`,
    commands: status === "done" ? [{ cmd: "node --version", exit: 0 }] : [{ cmd: "false", exit: 1 }],
    artifacts: [{ path: artifact, sha256: sha256File(artifact) }],
    reads: [],
    ...extra,
  };
  const receiptPath = path.join(world.base, `receipt-${receiptSeq}-cell-${cell}.json`);
  fs.writeFileSync(receiptPath, `${JSON.stringify(doc, null, 2)}\n`);
  return receiptPath;
}

function cellState(world, wave, cell) {
  return JSON.parse(fs.readFileSync(path.join(world.stateHome, "waves", wave, "cells", `${cell}.json`), "utf8"));
}

function ledgerEntries(stateHome) {
  const file = path.join(stateHome, "ledger.jsonl");
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
}

function readyRow(json, cellId) {
  return json.ready.find((r) => r.id === cellId);
}

// ---------------------------------------------------------------------------
// Row 1 — two processes claim same cell (real CLI, 20 races).
//
// T8 row 1 (FIXED, was a KNOWN-DEFECT found by this suite's probe):
// concurrent claim was not atomic — check-to-write TOCTOU let two claimants
// both win, and the loser tripped the kernel atomic-write read-back guard
// (INTERNAL, exit 2). Fix: every lease mutation runs inside a per-cell
// exclusive lock (CONTRACT §6, kernel/lock.mjs). This test now gates: any
// regression of the multi-winner or loser-crash class fails the suite.
// ---------------------------------------------------------------------------
test("T8 row 1: 20 simultaneous CLI claims — exactly one winner, losers LEASE-HELD, epoch 1", async (t) => {
    const w = makeWorld(t, "race");
    for (let round = 0; round < 3; round += 1) {
      const wave = `race${round}`;
      plan(t, w, wave, [demoCell("hot", [], w)]);
      const runs = await Promise.all(Array.from({ length: 20 }, (_, i) =>
        cliAsync(w.home, ["claim", wave, "hot", "--actor", `racer-${i}`, "--config", w.configPath], w.base)));

      const winners = runs.filter((r) => r.code === 0);
      assert.ok(winners.length >= 1, `round ${round}: no claimant could take the cell`);
      assert.equal(winners.length, 1,
        `round ${round}: exactly one winner expected, got ${winners.length} ` +
        `(actors: ${winners.map((x) => x.json.actor).join(", ")})`);
      for (const r of runs.filter((x) => x.code !== 0)) {
        assert.equal(r.code, 1, `round ${round}: loser exit class (code ${r.code}, envelope ${JSON.stringify(r.json)})`);
        assert.equal(r.json.code, "LEASE-HELD", `round ${round}: loser code ${JSON.stringify(r.json)}`);
      }

      const cell = cellState(w, wave, "hot");
      assert.equal(cell.state, "claimed");
      assert.equal(cell.epoch, 1, "exactly one claim ever landed ⇒ epoch stays 1");
      const claims = ledgerEntries(w.stateHome).filter((e) => e.type === "claim" && e.wave === wave);
      assert.equal(claims.length, 1, "one CLAIMED ledger event per epoch");
    }
  });

// Sequential control for row 1: the non-racing double-claim path must be
// green today (deterministic, not todo) — the defect is the concurrent window.
test("T8 row 1 (sequential control): double claim same cell — second is LEASE-HELD exit 1, epoch unchanged", (t) => {
  const w = makeWorld(t, "held");
  plan(t, w, "held", [demoCell("c1", [], w)]);
  const first = w.run(["claim", "held", "c1", "--actor", "seat-a", "--config", w.configPath]);
  assert.equal(first.code, 0, JSON.stringify(first.json));
  assert.equal(first.json.epoch, 1);
  assert.equal(first.json.state, "claimed");

  const second = w.run(["claim", "held", "c1", "--actor", "seat-b", "--config", w.configPath]);
  assert.equal(second.code, 1);
  assert.equal(second.json.code, "LEASE-HELD");
  assert.equal(cellState(w, "held", "c1").epoch, 1);
});

// ---------------------------------------------------------------------------
// Row 2 — kill -9 mid-hold, peer reclaims after expiry (takeover + evidence).
// The CLI claimant exits immediately after claim, so a crashed holder is
// indistinguishable from a clean one; occupancy is time-gated only (§6).
// No wall-clock travel exists in the CLI, so the test rewrites expires_at in
// the future into the past via a direct node-fs edit — a legitimate same-uid
// simulation of the clock passing (documented; same-uid reality per §6).
// ---------------------------------------------------------------------------
test("T8 row 2: expired-lease takeover — reclaim succeeds at epoch+1 with reclaim:expired ledger evidence", (t) => {
  const w = makeWorld(t, "expiry");
  plan(t, w, "t2", [demoCell("c1", [], w)]);

  // ttl floor check first: 29 s is below the contract minimum 30.
  const tooShort = w.run(["claim", "t2", "c1", "--actor", "seat-a", "--ttl", "29", "--config", w.configPath]);
  assert.equal(tooShort.code, 1);
  assert.equal(tooShort.json.code, "USAGE");

  const first = w.run(["claim", "t2", "c1", "--actor", "seat-a", "--ttl", "30", "--config", w.configPath]);
  assert.equal(first.code, 0, JSON.stringify(first.json));
  assert.equal(first.json.epoch, 1);

  // Simulate wall-clock expiry: push expires_at into the past, keys untouched.
  const ownerPath = path.join(w.stateHome, "waves", "t2", "leases", "c1", "owner.json");
  const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
  owner.expires_at = "2020-01-01T00:00:00.000Z";
  fs.writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`);

  const peer = w.run(["claim", "t2", "c1", "--actor", "seat-b", "--config", w.configPath]);
  assert.equal(peer.code, 0, JSON.stringify(peer.json));
  assert.equal(peer.json.actor, "seat-b");
  assert.equal(peer.json.epoch, 2, "reclaim of expired lease increments epoch");

  assert.equal(cellState(w, "t2", "c1").epoch, 2);
  const claims = ledgerEntries(w.stateHome).filter((e) => e.type === "claim");
  assert.equal(claims.length, 2);
  assert.equal(claims[1].payload.reclaim, "expired", "ledger carries takeover evidence");
  assert.equal(claims[1].actor, "seat-b");
});

// ---------------------------------------------------------------------------
// Row 3 — full happy wave with the real CLI on a temp HOME: every ready/
// blocked transition plus final verify (chain_ok, audit_closure "none",
// receipt spot-check ok).
// ---------------------------------------------------------------------------
test("T8 row 3: full happy wave plan→ready→claim→done ×2 → verify chain_ok, closure none, spot-check ok", (t) => {
  const w = makeWorld(t, "happy");
  plan(t, w, "w3", [demoCell("c1", [], w), demoCell("c2", ["c1"], w)]);

  let r = w.run(["ready", "w3", "--config", w.configPath]);
  assert.equal(r.code, 0);
  assert.equal(readyRow(r.json, "c1").ready, true);
  assert.deepEqual(readyRow(r.json, "c2").blocked_by, ["c1"]);

  let claim = w.run(["claim", "w3", "c1", "--actor", "seat-a", "--config", w.configPath]);
  assert.equal(claim.code, 0, JSON.stringify(claim.json));
  let rec = receipt(w, { cell: "c1", actor: "seat-a", epoch: claim.json.epoch, dir: w.work });
  let done = w.run(["done", "w3", "c1", "--actor", "seat-a", "--epoch", String(claim.json.epoch), "--receipt", rec, "--config", w.configPath]);
  assert.equal(done.code, 0, JSON.stringify(done.json));
  assert.equal(done.json.state, "done");

  r = w.run(["ready", "w3", "--config", w.configPath]);
  assert.equal(readyRow(r.json, "c2").ready, true, "c2 unblocks once c1 is done");

  claim = w.run(["claim", "w3", "c2", "--actor", "seat-b", "--config", w.configPath]);
  assert.equal(claim.code, 0, JSON.stringify(claim.json));
  rec = receipt(w, { cell: "c2", actor: "seat-b", epoch: claim.json.epoch, dir: w.work });
  done = w.run(["done", "w3", "c2", "--actor", "seat-b", "--epoch", String(claim.json.epoch), "--receipt", rec, "--config", w.configPath]);
  assert.equal(done.code, 0, JSON.stringify(done.json));

  const st = w.run(["status", "w3", "--config", w.configPath]);
  assert.equal(st.code, 0);
  for (const id of ["c1", "c2"]) {
    const row = st.json.waves[0].cells.find((c) => c.id === id);
    assert.equal(row.state, "done");
    assert.match(row.receipt_sha256, /^[0-9a-f]{64}$/);
  }

  const v = w.run(["verify", "--config", w.configPath]);
  assert.equal(v.code, 0, JSON.stringify(v.json));
  assert.equal(v.json.chain_ok, true);
  assert.ok(v.json.entries >= 6, `genesis+plan+claim+done+claim+done ≥ 6, got ${v.json.entries}`);
  assert.equal(v.json.audit_closure, "none", "anchor null never closes audit (§2.3)");
  assert.equal(v.json.spot_check.checked, 2);
  assert.deepEqual(v.json.spot_check.mismatches, []);
});

// ---------------------------------------------------------------------------
// Row 4 — done/claim on a cell whose dep failed: rejected with CELL-STATE.
// ---------------------------------------------------------------------------
test("T8 row 4: claim cell whose dep failed — CELL-STATE exit 1 listing the blocker", (t) => {
  const w = makeWorld(t, "depfail");
  plan(t, w, "w4", [demoCell("c1", [], w), demoCell("c2", ["c1"], w)]);

  const claim = w.run(["claim", "w4", "c1", "--actor", "seat-a", "--config", w.configPath]);
  assert.equal(claim.code, 0, JSON.stringify(claim.json));
  const fail = w.run(["fail", "w4", "c1", "--actor", "seat-a", "--epoch", String(claim.json.epoch),
    "--reason", "probe blew up", "--config", w.configPath]);
  assert.equal(fail.code, 0, JSON.stringify(fail.json));
  assert.equal(fail.json.state, "failed");

  const r = w.run(["ready", "w4", "--config", w.configPath]);
  assert.equal(readyRow(r.json, "c2").ready, false);
  assert.deepEqual(readyRow(r.json, "c2").blocked_by, ["c1"]);

  const blocked = w.run(["claim", "w4", "c2", "--actor", "seat-b", "--config", w.configPath]);
  assert.equal(blocked.code, 1);
  assert.equal(blocked.json.code, "CELL-STATE");
  assert.match(JSON.stringify(blocked.json.violations), /deps\.c1/);
  assert.match(blocked.json.message, /c1\(failed\)/);
  assert.equal(cellState(w, "w4", "c2").state, "pending", "rejection left zero mutation");
});

// ---------------------------------------------------------------------------
// Row 5 — shadow isolation (CONTRACT §10). Shadow config must keep its state
// entirely inside shadow_home, force shadow- wave ids, require shadow receipt
// keys, and reject artifacts outside shadow_home.
// ---------------------------------------------------------------------------
test("T8 row 5: shadow isolation — state_home mismatch, non-shadow wave id, receipt without shadow keys, artifact outside shadow_home all rejected", (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aw-t8-shadow-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, "home");
  const shadowHome = path.join(home, ".local/state/asylumwarden-shadow-pcb");
  const ws = path.join(shadowHome, "workspace");
  const elsewhere = path.join(base, "elsewhere"); // outside shadow_home, not forbidden-matched
  for (const d of [home, ws, elsewhere]) fs.mkdirSync(d, { recursive: true });

  const shadowRegPath = path.join(shadowHome, "shadow-registry.json");
  fs.writeFileSync(shadowRegPath, `${JSON.stringify({
    version: 1,
    lines: {
      pcbshadow: {
        roots: [ws, elsewhere],
        forbidden_surfaces: [],
        forbidden_absolute: ["/**/outside/**"],
        read_roots: [],
      },
    },
  }, null, 2)}\n`);
  const shadowRegSha = sha256File(shadowRegPath);

  const configPath = path.join(base, "asylumwarden.json");
  const writeConfig = (over) => fs.writeFileSync(configPath, `${JSON.stringify({
    version: 1, registry: shadowRegPath, registry_sha256: shadowRegSha,
    self: "pcbshadow", state_home: shadowHome, mode: "shadow",
    shadow_of: shadowRegSha, shadow_home: shadowHome, kinds: {}, anchor: null,
    ...over,
  }, null, 2)}\n`);

  const run = (args, cwd = base) => cli(home, args, cwd);

  // Probe 0 — shadow config aimed at a non-shadow_home state home: rejected.
  writeConfig({ state_home: path.join(home, ".local/state/asylumwarden") });
  const mis = run(["status", "--config", configPath]);
  assert.equal(mis.code, 2);
  assert.equal(mis.json.code, "CONFIG-INVALID", "§validateRegistrySemantics: shadow state_home must equal shadow_home");

  writeConfig({});
  const init = run(["init", "--config", configPath]);
  assert.equal(init.code, 0, JSON.stringify(init.json));

  // Probe A — wave id without the shadow- prefix: fail-closed at plan.
  const badManifest = path.join(base, "noshadow.json");
  fs.writeFileSync(badManifest, `${JSON.stringify({
    version: 1, wave: "noshadow-x",
    cells: [{ id: "c1", kind: "gen", line: "pcbshadow", cwd: ws, allowed_roots: [ws], deps: [] }],
  }, null, 2)}\n`);
  const badPlan = run(["plan", badManifest, "--config", configPath]);
  assert.equal(badPlan.code, 2);
  assert.equal(badPlan.json.code, "SCHEMA-VIOLATION");

  // Probe B — receipt lacking mode/shadow_of in shadow mode: rejected.
  const okManifest = path.join(base, "shadow-pilot.json");
  fs.writeFileSync(okManifest, `${JSON.stringify({
    version: 1, wave: "shadow-pilot",
    cells: [
      { id: "c1", kind: "gen", line: "pcbshadow", cwd: ws, allowed_roots: [ws], deps: [] },
      { id: "wide", kind: "gen", line: "pcbshadow", cwd: elsewhere, allowed_roots: [elsewhere], deps: [] },
    ],
  }, null, 2)}\n`);
  const okPlan = run(["plan", okManifest, "--config", configPath]);
  assert.equal(okPlan.code, 0, JSON.stringify(okPlan.json));
  const claim = run(["claim", "shadow-pilot", "c1", "--actor", "pcb-shadow-seat", "--config", configPath]);
  assert.equal(claim.code, 0, JSON.stringify(claim.json));

  const plain = receipt({ base, work: ws }, { cell: "c1", actor: "pcb-shadow-seat", epoch: claim.json.epoch, dir: ws });
  const plainDone = run(["done", "shadow-pilot", "c1", "--actor", "pcb-shadow-seat", "--epoch", String(claim.json.epoch),
    "--receipt", plain, "--config", configPath]);
  assert.equal(plainDone.code, 2);
  assert.equal(plainDone.json.code, "SCHEMA-VIOLATION", "shadow receipt must carry mode+shadow_of (§10)");

  // Probe C — artifact outside shadow_home (allowed_root is a line root but
  // lives outside shadow_home): containment rejects, exit 2.
  const claimWide = run(["claim", "shadow-pilot", "wide", "--actor", "pcb-shadow-seat", "--config", configPath]);
  assert.equal(claimWide.code, 0, JSON.stringify(claimWide.json));
  const outside = receipt({ base, work: elsewhere }, {
    cell: "wide", actor: "pcb-shadow-seat", epoch: claimWide.json.epoch, dir: elsewhere,
    extra: { mode: "shadow", shadow_of: shadowRegSha },
  });
  const wideDone = run(["done", "shadow-pilot", "wide", "--actor", "pcb-shadow-seat", "--epoch", String(claimWide.json.epoch),
    "--receipt", outside, "--config", configPath]);
  assert.equal(wideDone.code, 2);
  assert.equal(wideDone.json.code, "PATH-ESCAPE", "shadow artifact outside shadow_home never lands (§10)");

  // Shadow ledger lives in shadow_home; the real line state home was never touched.
  assert.ok(fs.existsSync(path.join(shadowHome, "ledger.jsonl")), "shadow ledger under shadow_home");
  assert.ok(!fs.existsSync(path.join(home, ".local/state/asylumwarden/ledger.jsonl")),
    "real state home never appended by a shadow run");
});

// ---------------------------------------------------------------------------
// Row 6 — registry replaced after plan (sha drift) → CONFIG-DRIFT exit 2 on
// the very next command, every command.
// ---------------------------------------------------------------------------
test("T8 row 6: registry bytes swapped after plan — next command fails CONFIG-DRIFT exit 2", (t) => {
  const w = makeWorld(t, "drift");
  plan(t, w, "w6", [demoCell("c1", [], w)]);

  // Re-serialize with different formatting: same semantics, different bytes.
  const reg = JSON.parse(fs.readFileSync(w.regPath, "utf8"));
  fs.writeFileSync(w.regPath, `${JSON.stringify(reg, null, 3)}\n`);

  for (const args of [["status", "--config", w.configPath], ["registry", "check", "--config", w.configPath]]) {
    const res = w.run(args);
    assert.equal(res.code, 2, `${args[0]}: ${JSON.stringify(res.json)}`);
    assert.equal(res.json.code, "CONFIG-DRIFT");
  }
});

// ---------------------------------------------------------------------------
// Row 7 — same-uid ledger shortening (T8 row 7 + CONTRACT §5.4 / SECURITY.md
// statement 4). A whole-prefix rewrite is self-consistent; the chain proves
// internal order only. Without an external anchor there is NOTHING to detect
// it against — `verify` stays green and appends continue from the forged head.
// This test DOCUMENTS the tamper-evident-not-tamper-proof limit instead of
// pretending detection exists.
// ---------------------------------------------------------------------------
test("T8 row 7: same-uid chain shortening is undetectable without external anchor (tamper-evident NOT tamper-proof; CONTRACT §5.4 / SECURITY.md statement 4)", (t) => {
  const w = makeWorld(t, "shorten");
  plan(t, w, "w7", [demoCell("c1", [], w)]);
  const claim = w.run(["claim", "w7", "c1", "--actor", "seat-a", "--config", w.configPath]);
  assert.equal(claim.code, 0, JSON.stringify(claim.json));
  const rec = receipt(w, { cell: "c1", actor: "seat-a", epoch: claim.json.epoch, dir: w.work });
  const done = w.run(["done", "w7", "c1", "--actor", "seat-a", "--epoch", String(claim.json.epoch),
    "--receipt", rec, "--config", w.configPath]);
  assert.equal(done.code, 0, JSON.stringify(done.json));

  const ledgerPath = path.join(w.stateHome, "ledger.jsonl");
  const full = fs.readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l !== "");
  assert.equal(full.length, 4); // genesis, plan, claim, done

  // Same-uid rewrite: drop the last (done) line. The remaining prefix is a
  // valid chain by construction — nothing inside the file marks the cut.
  fs.writeFileSync(ledgerPath, `${full.slice(0, 3).join("\n")}\n`);

  const v1 = w.run(["verify", "--config", w.configPath]);
  assert.equal(v1.code, 0, `shortened chain must still verify: ${JSON.stringify(v1.json)}`);
  assert.equal(v1.json.chain_ok, true);
  assert.equal(v1.json.entries, 3);
  assert.equal(v1.json.audit_closure, "none");
  assert.equal(v1.json.spot_check.checked, 0, "done event vanished with the line; nothing left to spot-check");

  // Appends continue from the FORGED head — the shortening is never flagged.
  plan(t, w, "w7b", [demoCell("c2", [], w)]);
  const lines = fs.readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
  assert.equal(lines.length, 4);
  assert.equal(lines[3].seq, 4, "seq continues from the truncated head, not the true history");
  assert.equal(lines[3].prev, lines[2].hash);
  assert.equal(lines[3].type, "plan");

  const v2 = w.run(["verify", "--config", w.configPath]);
  assert.equal(v2.code, 0);
  assert.equal(v2.json.entries, 4);
  assert.ok(fs.existsSync(path.join(w.stateHome, "receipts", "w7", "c1.json")),
    "c1 receipt is now orphan evidence — cell says done, ledger says it never happened");
  assert.equal(cellState(w, "w7", "c1").state, "done");
});
