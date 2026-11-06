// Ledger chain unit tests — CONTRACT §5, DESIGN-INTERNALS §src/ledger + §Testing.
// Temp state homes via fs.mkdtemp(os.tmpdir()+"/aw-"). No sleeps beyond the
// injected lock-poll budgets (<2 s total).

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GENESIS_PREV, sha256Of } from "../../src/kernel/canon.mjs";
import { layout } from "../../src/kernel/state.mjs";
import { nowIso } from "../../src/kernel/fsutil.mjs";
import { openLedger } from "../../src/ledger/chain.mjs";

const NL = "\n"; // sanitize policy: one backslash per source line

const REG_SHA = "a".repeat(64);
const CFG_SHA = "b".repeat(64);
const GENESIS_CTX = { configSha256: CFG_SHA, registrySha256: REG_SHA };

async function mkLedger(overrides = {}) {
  const stateHome = await fs.mkdtemp(path.join(os.tmpdir(), "aw-ledger-"));
  const sl = layout(stateHome);
  const ledger = openLedger({ sl, config: { registry_sha256: REG_SHA }, ...overrides });
  return { stateHome, sl, ledger };
}

async function rmHome(stateHome) {
  await fs.rm(stateHome, { recursive: true, force: true });
}

async function codeOf(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err?.code ?? `non-WardenError: ${err?.message}`;
  }
}

async function pathExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

test("genesis + 3 entries verify chain_ok", async () => {
  const { stateHome, sl, ledger } = await mkLedger();
  try {
    const g = await ledger.appendGenesisIfAbsent(GENESIS_CTX);
    assert.equal(g.created, true);
    assert.equal(g.entry.seq, 1);
    assert.equal(g.entry.type, "genesis");
    assert.equal(g.entry.prev, GENESIS_PREV);
    assert.deepEqual(g.entry.payload, { registry_sha256: REG_SHA, config_sha256: CFG_SHA });

    await ledger.append("plan", { wave: "w1", actor: "seater" });
    await ledger.append("claim", { wave: "w1", cell: "c1", actor: "worker" });
    await ledger.append("done", { wave: "w1", cell: "c1", actor: "worker", payload: { receipt_sha256: "c".repeat(64) } });

    const v = await ledger.verify();
    assert.equal(v.chain_ok, true);
    assert.equal(v.entries.length, 4);
    assert.equal(v.torn, null);
    assert.equal(v.head, v.entries[3].hash);

    const lines = (await fs.readFile(sl.ledger, "utf8")).split("\n").filter((l) => l !== "");
    assert.equal(lines.length, 4);
  } finally {
    await rmHome(stateHome);
  }
});

test("appendGenesisIfAbsent is an idempotent no-op when present", async () => {
  const { stateHome, ledger } = await mkLedger();
  try {
    await ledger.appendGenesisIfAbsent(GENESIS_CTX);
    const second = await ledger.appendGenesisIfAbsent({ configSha256: "f".repeat(64), registrySha256: "e".repeat(64) });
    assert.equal(second.created, false);
    const v = await ledger.verify();
    assert.equal(v.entries.length, 1);
    assert.equal(v.entries[0].payload.config_sha256, CFG_SHA); // original kept
  } finally {
    await rmHome(stateHome);
  }
});

test("verify on absent ledger: chain_ok true, empty", async () => {
  const { stateHome, ledger } = await mkLedger();
  try {
    const v = await ledger.verify();
    assert.equal(v.chain_ok, true);
    assert.deepEqual(v.entries, []);
    assert.equal(v.head, null);
    assert.equal(v.torn, null);
  } finally {
    await rmHome(stateHome);
  }
});

test("flipping 1 byte in an entry body breaks the chain (LEDGER-BROKEN semantics)", async () => {
  const { stateHome, sl, ledger } = await mkLedger();
  try {
    await ledger.appendGenesisIfAbsent(GENESIS_CTX);
    await ledger.append("plan", { wave: "w1", actor: "seater" });
    await ledger.append("claim", { wave: "w1", cell: "c1", actor: "worker" });
    await ledger.append("done", { wave: "w1", cell: "c1" });

    const text = await fs.readFile(sl.ledger, "utf8");
    const lines = text.split("\n").filter((l) => l !== "");
    const tampered = JSON.parse(lines[1]); // seq 2 — middle entry
    tampered.actor = "attacker";
    lines[1] = JSON.stringify(tampered); // keeps the OLD recorded hash
    await fs.writeFile(sl.ledger, `${lines.join(NL)}${NL}`);

    const v = await ledger.verify();
    assert.equal(v.chain_ok, false); // hash recompute mismatch — caller maps LEDGER-BROKEN
    assert.equal(v.entries.length, 4);
  } finally {
    await rmHome(stateHome);
  }
});

test("removing a middle line breaks seq/prev chain", async () => {
  const { stateHome, sl, ledger } = await mkLedger();
  try {
    await ledger.appendGenesisIfAbsent(GENESIS_CTX);
    await ledger.append("plan", { wave: "w1" });
    await ledger.append("claim", { wave: "w1", cell: "c1" });
    await ledger.append("done", { wave: "w1", cell: "c1" });

    const lines = (await fs.readFile(sl.ledger, "utf8")).split("\n").filter((l) => l !== "");
    lines.splice(1, 1); // remove seq 2
    await fs.writeFile(sl.ledger, `${lines.join(NL)}${NL}`);

    const v = await ledger.verify();
    assert.equal(v.chain_ok, false);
  } finally {
    await rmHome(stateHome);
  }
});

test("first entry must be genesis", async () => {
  const { stateHome, sl, ledger } = await mkLedger();
  try {
    const entry = {
      seq: 1, ts: nowIso(), type: "plan", wave: "w1", cell: null,
      actor: null, payload: {}, prev: GENESIS_PREV,
    };
    const line = JSON.stringify({ ...entry, hash: sha256Of(entry) });
    await fs.mkdir(path.dirname(sl.ledger), { recursive: true });
    await fs.writeFile(sl.ledger, `${line}\n`);
    const v = await ledger.verify();
    assert.equal(v.chain_ok, false);
  } finally {
    await rmHome(stateHome);
  }
});

test("50 concurrent appends serialize: chain_ok, unique seq 2..51, no interleave", async () => {
  const { stateHome, sl, ledger } = await mkLedger();
  try {
    await ledger.appendGenesisIfAbsent(GENESIS_CTX);
    const appends = [];
    for (let i = 1; i <= 50; i += 1) {
      appends.push(ledger.append("plan", { wave: "w50", cell: `c${String(i)}`, actor: "race", payload: { i } }));
    }
    const entries = await Promise.all(appends);
    assert.equal(entries.length, 50);

    const v = await ledger.verify();
    assert.equal(v.chain_ok, true, "chain must survive 50-way contention");
    assert.equal(v.entries.length, 51);
    assert.equal(v.torn, null);

    const seqs = new Set(v.entries.map((e) => e.seq));
    assert.equal(seqs.size, 51);
    for (let s = 1; s <= 51; s += 1) assert.ok(seqs.has(s), `seq ${String(s)} present`);

    const idx = new Map(v.entries.map((e, j) => [e.seq, j]));
    for (const e of v.entries) assert.equal(e.prev, v.entries[idx.get(e.seq) - 1]?.hash ?? GENESIS_PREV);

    const lines = (await fs.readFile(sl.ledger, "utf8")).split("\n").filter((l) => l !== "");
    assert.equal(lines.length, 51);
    // every physical line self-consistent (line j+1 carries seq j+1)
    for (let j = 0; j < lines.length; j += 1) {
      assert.equal(JSON.parse(lines[j]).seq, j + 1);
    }
  } finally {
    await rmHome(stateHome);
  }
});

test("torn tail: verify + readAll report the right line; append refuses LEDGER-TORN", async () => {
  const { stateHome, sl, ledger } = await mkLedger();
  try {
    await ledger.appendGenesisIfAbsent(GENESIS_CTX);
    await ledger.append("plan", { wave: "w1" });
    await ledger.append("claim", { wave: "w1", cell: "c1" });
    await ledger.append("done", { wave: "w1", cell: "c1" });

    // partial JSON without trailing newline — the classic interrupted write
    await fs.appendFile(sl.ledger, '{"seq":5,"ts":"2026-11-0');

    const v = await ledger.verify();
    assert.notEqual(v.torn, null);
    assert.equal(v.torn.line, 5);
    // prefix of 4 intact entries still verifies; the CLI maps torn → LEDGER-TORN exit 2
    assert.equal(v.chain_ok, true);
    assert.equal(v.entries.length, 4);
    assert.equal(v.head, v.entries[3].hash);

    const r = await ledger.readAll();
    assert.notEqual(r.torn, null);
    assert.equal(r.torn.line, 5);
    assert.equal(r.entries.length, 4);

    // appending after a torn tail must fail closed, ledger untouched
    const code = await codeOf(ledger.append("plan", { wave: "w2" }));
    assert.equal(code, "LEDGER-TORN");
    const after = await ledger.verify();
    assert.equal(after.entries.length, 4);
    assert.equal(after.torn.line, 5);
  } finally {
    await rmHome(stateHome);
  }
});

test("stale lock (dead pid, old ts) is removed and the append succeeds", async () => {
  const { stateHome, sl, ledger } = await mkLedger();
  try {
    await ledger.appendGenesisIfAbsent(GENESIS_CTX);
    await fs.mkdir(sl.locks, { recursive: true });
    const oldTs = new Date(Date.now() - 35_000).toISOString();
    await fs.writeFile(sl.ledgerLock, `${JSON.stringify({ pid: 999999999, host: os.hostname(), ts: oldTs })}\n`);

    let warning = null;
    const warned = openLedger({ sl, config: {}, onWarning: (m) => { warning = m; } });
    const entry = await warned.append("plan", { wave: "w1" });
    assert.equal(entry.seq, 2);
    assert.ok(warning !== null && warning.includes("stale"), "stale removal surfaces a warning");
    assert.equal(await pathExists(sl.ledgerLock), false);
    const v = await ledger.verify();
    assert.equal(v.chain_ok, true);
    assert.equal(v.entries.length, 2);
  } finally {
    await rmHome(stateHome);
  }
});

test("live lock with old ts (own pid) fails closed LEDGER-BUSY and is not removed", async () => {
  const { stateHome, sl, ledger } = await mkLedger();
  try {
    await ledger.appendGenesisIfAbsent(GENESIS_CTX);
    await fs.mkdir(sl.locks, { recursive: true });
    const oldTs = new Date(Date.now() - 61_000).toISOString();
    await fs.writeFile(sl.ledgerLock, `${JSON.stringify({ pid: process.pid, host: os.hostname(), ts: oldTs })}\n`);

    const code = await codeOf(ledger.append("plan", { wave: "w1" }));
    assert.equal(code, "LEDGER-BUSY");
    assert.equal(await pathExists(sl.ledgerLock), true, "live holder's lock is never auto-removed");
  } finally {
    await rmHome(stateHome);
  }
});

test("corrupt lock body: fresh → LEDGER-BUSY; older than busy window → stale-cleaned", async () => {
  const { stateHome, sl, ledger } = await mkLedger();
  try {
    await ledger.appendGenesisIfAbsent(GENESIS_CTX);
    await fs.mkdir(sl.locks, { recursive: true });

    await fs.writeFile(sl.ledgerLock, "this is not json {{{");
    const busy = await codeOf(ledger.append("plan", { wave: "w1" }));
    assert.equal(busy, "LEDGER-BUSY");

    const old = (Date.now() - 120_000) / 1000;
    await fs.utimes(sl.ledgerLock, old, old);
    const entry = await ledger.append("plan", { wave: "w1" });
    assert.equal(entry.seq, 2);
    assert.equal(await pathExists(sl.ledgerLock), false);
  } finally {
    await rmHome(stateHome);
  }
});

test("in-progress lock (empty body) is contended, then LEDGER-BUSY past the deadline", async () => {
  const { stateHome, sl, ledger } = await mkLedger({ acquireDeadlineMs: 80, pollMs: 10 });
  try {
    await ledger.appendGenesisIfAbsent(GENESIS_CTX);
    await fs.mkdir(sl.locks, { recursive: true });
    await fs.writeFile(sl.ledgerLock, "");
    const code = await codeOf(ledger.append("plan", { wave: "w1" }));
    assert.equal(code, "LEDGER-BUSY");
  } finally {
    await rmHome(stateHome);
  }
});

test("append validates shape BEFORE touching disk (INTERNAL / SCHEMA-VIOLATION)", async () => {
  const { stateHome, sl, ledger } = await mkLedger();
  try {
    assert.equal(await codeOf(ledger.append("not-a-type", {})), "INTERNAL");
    assert.equal(await codeOf(ledger.append("plan", { wave: "bad wave!" })), "INTERNAL");
    assert.equal(await codeOf(ledger.append("plan", { payload: "nope" })), "INTERNAL");
    assert.equal(
      await codeOf(ledger.append("plan", { payload: { blob: "x".repeat(300_000) } })),
      "SCHEMA-VIOLATION",
    );
    assert.equal(await pathExists(sl.ledger), false, "no disk touch on invalid appends");
    assert.equal(await pathExists(sl.locks), false, "invalid appends never create the lock dir");
  } finally {
    await rmHome(stateHome);
  }
});

test("mid-file unparseable line: torn report with chain_ok false; append refuses", async () => {
  const { stateHome, sl, ledger } = await mkLedger();
  try {
    await ledger.appendGenesisIfAbsent(GENESIS_CTX);
    await ledger.append("plan", { wave: "w1" });
    await ledger.append("done", { wave: "w1" });

    const lines = (await fs.readFile(sl.ledger, "utf8")).split("\n").filter((l) => l !== "");
    lines.splice(1, 0, "NOT JSON AT ALL");
    await fs.writeFile(sl.ledger, `${lines.join(NL)}${NL}`);

    const v = await ledger.verify();
    assert.notEqual(v.torn, null);
    assert.equal(v.torn.line, 2);
    assert.equal(v.chain_ok, false);
    assert.equal(await codeOf(ledger.append("plan", { wave: "w2" })), "LEDGER-TORN");
  } finally {
    await rmHome(stateHome);
  }
});

test("__proto__ keys in a ledger line are rejected (fail closed)", async () => {
  const { stateHome, sl, ledger } = await mkLedger();
  try {
    await ledger.appendGenesisIfAbsent(GENESIS_CTX);
    await fs.appendFile(sl.ledger, '{"seq":2,"ts":"2026-11-05T00:00:00.000Z","__proto__":{"x":1}}\n');
    const v = await ledger.verify();
    assert.notEqual(v.torn, null);
    assert.equal(v.torn.line, 2);
    assert.equal(v.chain_ok, true); // unparseable last line: prefix intact, torn reported
  } finally {
    await rmHome(stateHome);
  }
});
