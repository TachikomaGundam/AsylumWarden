// Unit tests for src/receipt/receipt.mjs — hand-built ctx + fakeLedger per
// DESIGN-INTERNALS §Testing. No src/ledger / src/config imports; the stub
// policy implements the pinned interface with kernel matchAny.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { doneWithReceipt, failCell } from "../../src/receipt/receipt.mjs";
import { claim, release } from "../../src/lease/lease.mjs"; // same delegation, fair game for wiring tests
import { layout, writeCell } from "../../src/kernel/state.mjs";
import { sha256File } from "../../src/kernel/canon.mjs";
import { matchAny } from "../../src/kernel/glob.mjs";
import { fail } from "../../src/kernel/errors.mjs";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const ISO_T0 = new Date(T0).toISOString();
const SHADOW_OF = "ab".repeat(32);

async function buildTestCtx({ mode = "normal" } = {}) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aw-receipt-")));
  const stateHome = path.join(tmp, "state");
  const sl = layout(stateHome);
  const dirs = {
    tmp,
    stateHome,
    allowed: path.join(tmp, "line", "work"),
    docs: path.join(tmp, "line", "docs"),
    outside: path.join(tmp, "outside"),
    forbidden: path.join(tmp, "outside", "forbidden"),
    shadowHome: path.join(tmp, "shadow-home"),
  };
  for (const dir of [sl.waves, dirs.allowed, dirs.docs, dirs.outside, dirs.forbidden, dirs.shadowHome]) {
    await fs.mkdir(dir, { recursive: true });
  }
  const forbiddenAbs = [`${dirs.forbidden}/**`];
  const lineReadRoots = [];
  // Kernel null-prototype note: cell.allowed_roots / cell.read_roots arrive
  // from disk without Array.prototype — index loops only in this stub too.
  const under = (roots, abs) => {
    for (let i = 0; i < roots.length; i += 1) {
      const r = roots[i];
      if (abs === r || abs.startsWith(`${r}/`)) return true;
    }
    return false;
  };
  const unionOf = (...lists) => {
    const out = [];
    for (const list of lists) for (let i = 0; i < list.length; i += 1) out.push(list[i]);
    return out;
  };
  const policy = {
    line: (name) => ({ name, roots: [dirs.allowed], forbiddenRel: [], forbiddenAbs, readRoots: lineReadRoots }),
    forbiddenHit: (abs) => matchAny(forbiddenAbs, abs),
    artifactOk: (abs, cell) => {
      // Pinned order: forbidden first, then allowed-root containment.
      const hit = matchAny(forbiddenAbs, abs);
      if (hit !== null) fail("FORBIDDEN-SURFACE", `forbidden surface ${hit}: ${abs}`);
      if (!under(cell.allowed_roots ?? [], abs)) fail("PATH-ESCAPE", `outside allowed_roots: ${abs}`);
    },
    readOk: (abs, cell) =>
      under(unionOf(cell.allowed_roots ?? [], cell.read_roots ?? [], lineReadRoots), abs),
  };
  let nowMs = T0;
  const ledger = {
    events: [],
    append: async (type, fields = {}) => {
      ledger.events.push({ type, ...fields });
      return { type };
    },
    verify: async () => ({ chain_ok: true, entries: 1, head: "0".repeat(64) }),
    readAll: async () => ({ entries: ledger.events, head: "0".repeat(64), torn: null }),
  };
  const config =
    mode === "shadow"
      ? { mode: "shadow", shadow_home: dirs.shadowHome, shadow_of: SHADOW_OF }
      : { mode: "normal" };
  const ctx = { config, policy, sl, mode, ledger, nowFn: () => new Date(nowMs).toISOString() };
  return { ctx, sl, dirs, ledger };
}

async function seedCell(sl, { wave = "w1", id, state = "pending", epoch = 0, allowedRoots = null, readRoots = [] } = {}) {
  const cell = {
    id,
    wave,
    kind: "verify",
    line: "testline",
    cwd: path.dirname(sl.stateHome),
    allowed_roots: allowedRoots ?? [path.join(path.dirname(sl.stateHome), "line", "work")],
    read_roots: readRoots,
    deps: [],
    role: null,
    role_file: null,
    session_started_at: null,
    brief: null,
    acceptance: null,
    state,
    epoch,
    planned_at: ISO_T0,
    updated_at: ISO_T0,
  };
  await writeCell(sl, wave, id, cell);
  return cell;
}

async function writeFile(filePath, text = "payload\n") {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  return filePath;
}

async function writeReceipt(dirs, name, receipt) {
  const receiptPath = path.join(dirs.tmp, name);
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8"); // bytes deliberately non-canonical
  return receiptPath;
}

const loadJson = async (p) => JSON.parse(await fs.readFile(p, "utf8"));
const readCellRaw = async (sl, wave, id) => loadJson(sl.cellFile(wave, id));
const eventTypes = (ledger) => ledger.events.map((e) => e.type);

async function expectCode(promiseFn, code) {
  await assert.rejects(promiseFn, (err) => {
    assert.equal(err.name, "WardenError", `expected WardenError, got ${err.stack}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return true;
  });
}

function baseReceipt({
  cell = "c1",
  actor = "a1",
  epoch = 1,
  status = "done",
  summary = "all good",
  commands = [{ cmd: "node --test", exit: 0 }],
  artifacts = [],
  reads = [],
  extra = {},
} = {}) {
  return {
    version: 1,
    cell,
    actor,
    epoch,
    status,
    summary,
    commands,
    artifacts,
    reads,
    ...extra,
  };
}

// Claim a live lease on w1/c1 for actor a1.
async function claimedLease(ctx, { wave = "w1", cell = "c1", actor = "a1" } = {}) {
  await seedCell(ctx.sl, { wave, id: cell });
  return claim(ctx, { wave, cell, actor });
}

// ------------------------------------------------------------------ happy path

test("doneWithReceipt happy path: cell done, stored receipt byte-identical, [claim, done] events", async () => {
  const { ctx, sl, dirs, ledger } = await buildTestCtx();
  await claimedLease(ctx);
  const artFile = await writeFile(path.join(dirs.allowed, "out.txt"), "hello artifact\n");
  const docFile = await writeFile(path.join(dirs.docs, "spec.md"), "read me\n");
  const receiptPath = await writeReceipt(dirs, "receipt.json", baseReceipt({
    artifacts: [{ path: artFile, sha256: await sha256File(artFile) }],
    reads: [docFile, path.join(dirs.allowed, "out.txt")],
  }));
  // widen read roots so the docs/ read passes the stub union
  const cellRow = await readCellRaw(sl, "w1", "c1");
  await writeCell(sl, "w1", "c1", { ...cellRow, read_roots: [dirs.docs] });

  const result = await doneWithReceipt(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1, receiptPath });

  const sourceSha = await sha256File(receiptPath);
  assert.equal(result.sha256, sourceSha);
  assert.equal(result.file, sl.receiptFile("w1", "c1"));
  assert.equal(await sha256File(result.file), sourceSha); // exact bytes preserved
  assert.deepEqual(await fs.readFile(result.file), await fs.readFile(receiptPath));

  const cell = await readCellRaw(sl, "w1", "c1");
  assert.equal(cell.state, "done");
  assert.equal(cell.epoch, 1); // epoch untouched by done

  assert.deepEqual(eventTypes(ledger), ["claim", "done"]);
  assert.deepEqual(ledger.events[1].payload, { receipt_sha256: sourceSha, status: "done" });
  assert.equal(ledger.events[1].actor, "a1");
});

test("doneWithReceipt with status failed lands the cell failed and appends a fail event", async () => {
  const { ctx, sl, dirs, ledger } = await buildTestCtx();
  await claimedLease(ctx);
  const receiptPath = await writeReceipt(dirs, "receipt.json", baseReceipt({
    status: "failed",
    commands: [{ cmd: "node --test", exit: 1 }],
    summary: "tests red",
  }));
  await doneWithReceipt(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1, receiptPath });
  assert.equal((await readCellRaw(sl, "w1", "c1")).state, "failed");
  assert.deepEqual(eventTypes(ledger), ["claim", "fail"]);
});

// ------------------------------------------------------------------ rejections

test("unknown receipt key → SCHEMA-VIOLATION, zero mutation", async () => {
  const { ctx, sl, dirs, ledger } = await buildTestCtx();
  await claimedLease(ctx);
  const receiptPath = await writeReceipt(dirs, "receipt.json", baseReceipt({
    extra: { bogus_key: "nope" },
  }));
  await expectCode(
    () => doneWithReceipt(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1, receiptPath }),
    "SCHEMA-VIOLATION",
  );
  assert.equal((await readCellRaw(sl, "w1", "c1")).state, "claimed");
  await assert.rejects(() => fs.stat(sl.receiptFile("w1", "c1")), { code: "ENOENT" });
  assert.deepEqual(eventTypes(ledger), ["claim"]);
});

test("status done with a nonzero command exit → RECEIPT-COMMANDS", async () => {
  const { ctx, dirs } = await buildTestCtx();
  await claimedLease(ctx);
  const receiptPath = await writeReceipt(dirs, "receipt.json", baseReceipt({
    commands: [{ cmd: "make", exit: 0 }, { cmd: "make test", exit: 2 }],
  }));
  await expectCode(
    () => doneWithReceipt(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1, receiptPath }),
    "RECEIPT-COMMANDS",
  );
});

test("artifact hash mismatch → RECEIPT-HASH; missing artifact → RECEIPT-HASH (detail missing)", async () => {
  const { ctx, dirs } = await buildTestCtx();
  await claimedLease(ctx);
  const artFile = await writeFile(path.join(dirs.allowed, "out.txt"));
  const badHash = await writeReceipt(dirs, "r1.json", baseReceipt({
    artifacts: [{ path: artFile, sha256: "f".repeat(64) }],
  }));
  await expectCode(
    () => doneWithReceipt(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1, receiptPath: badHash }),
    "RECEIPT-HASH",
  );
  const missing = await writeReceipt(dirs, "r2.json", baseReceipt({
    artifacts: [{ path: path.join(dirs.allowed, "ghost.txt"), sha256: "0".repeat(64) }],
  }));
  await assert.rejects(
    () => doneWithReceipt(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1, receiptPath: missing }),
    (err) => {
      assert.equal(err.code, "RECEIPT-HASH");
      assert.ok(err.violations.some((v) => v.rule === "artifact-missing" && v.detail === "missing"));
      return true;
    },
  );
});

test("symlink artifact → PATH-ESCAPE (link inside allowed root, target escapes)", async () => {
  const { ctx, dirs } = await buildTestCtx();
  await claimedLease(ctx);
  const target = await writeFile(path.join(dirs.outside, "escape.txt"));
  const link = path.join(dirs.allowed, "link.txt");
  await fs.symlink(target, link);
  const receiptPath = await writeReceipt(dirs, "receipt.json", baseReceipt({
    artifacts: [{ path: link, sha256: await sha256File(target) }],
  }));
  await expectCode(
    () => doneWithReceipt(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1, receiptPath }),
    "PATH-ESCAPE",
  );
});

test("artifact outside allowed roots → PATH-ESCAPE", async () => {
  const { ctx, dirs } = await buildTestCtx();
  await claimedLease(ctx);
  const sneaky = await writeFile(path.join(dirs.outside, "sneaky.txt"));
  const receiptPath = await writeReceipt(dirs, "receipt.json", baseReceipt({
    artifacts: [{ path: sneaky, sha256: await sha256File(sneaky) }],
  }));
  await expectCode(
    () => doneWithReceipt(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1, receiptPath }),
    "PATH-ESCAPE",
  );
});

test("artifact matching forbidden_absolute pattern → FORBIDDEN-SURFACE", async () => {
  const { ctx, dirs } = await buildTestCtx();
  // Cell grants the broad tmp root so containment would pass; the forbidden
  // pattern must still reject (forbiddenHit is checked before containment).
  await seedCell(ctx.sl, { id: "c1", allowedRoots: [dirs.tmp] });
  await claim(ctx, { wave: "w1", cell: "c1", actor: "a1" });
  const secret = await writeFile(path.join(dirs.forbidden, "secret.key"));
  const receiptPath = await writeReceipt(dirs, "receipt.json", baseReceipt({
    artifacts: [{ path: secret, sha256: await sha256File(secret) }],
  }));
  await expectCode(
    () => doneWithReceipt(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1, receiptPath }),
    "FORBIDDEN-SURFACE",
  );
});

test("reads outside the allowed union → READ-OUTSIDE; nonexistent read path → READ-OUTSIDE", async () => {
  const { ctx, dirs } = await buildTestCtx();
  await claimedLease(ctx);
  const outsideFile = await writeFile(path.join(dirs.outside, "notes.txt"));
  const r1 = await writeReceipt(dirs, "r1.json", baseReceipt({ reads: [outsideFile] }));
  await expectCode(
    () => doneWithReceipt(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1, receiptPath: r1 }),
    "READ-OUTSIDE",
  );
  const r2 = await writeReceipt(dirs, "r2.json", baseReceipt({ reads: [path.join(dirs.allowed, "ghost.md")] }));
  await expectCode(
    () => doneWithReceipt(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1, receiptPath: r2 }),
    "READ-OUTSIDE",
  );
});

test("receipt actor/epoch vs lease: ACTOR-MISMATCH checked before EPOCH-MISMATCH", async () => {
  const { ctx, dirs } = await buildTestCtx();
  await claimedLease(ctx);
  const receiptPath = await writeReceipt(dirs, "receipt.json", baseReceipt({}));
  await expectCode(
    () => doneWithReceipt(ctx, { wave: "w1", cell: "c1", actor: "a2", epoch: 1, receiptPath }),
    "ACTOR-MISMATCH",
  );
  await expectCode(
    () => doneWithReceipt(ctx, { wave: "w1", cell: "c1", actor: "a2", epoch: 9, receiptPath }),
    "ACTOR-MISMATCH",
  );
  await expectCode(
    () => doneWithReceipt(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 9, receiptPath }),
    "EPOCH-MISMATCH",
  );
});

test("done without a live lease → CELL-STATE; cell id mismatch → SCHEMA-VIOLATION", async () => {
  const { ctx, dirs } = await buildTestCtx();
  await claimedLease(ctx);
  const receiptPath = await writeReceipt(dirs, "receipt.json", baseReceipt({}));
  await release(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1 });
  await expectCode(
    () => doneWithReceipt(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1, receiptPath }),
    "CELL-STATE",
  );

  await claim(ctx, { wave: "w1", cell: "c1", actor: "a1" });
  const wrongCell = await writeReceipt(dirs, "wrong.json", baseReceipt({ cell: "other" }));
  await expectCode(
    () => doneWithReceipt(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 2, receiptPath: wrongCell }),
    "SCHEMA-VIOLATION",
  );
});

test("missing receipt file → SCHEMA-VIOLATION", async () => {
  const { ctx } = await buildTestCtx();
  await claimedLease(ctx);
  await expectCode(
    () => doneWithReceipt(ctx, {
      wave: "w1", cell: "c1", actor: "a1", epoch: 1,
      receiptPath: "/nonexistent-dir-aw/receipt.json",
    }),
    "SCHEMA-VIOLATION",
  );
});

test("normal-mode receipt carrying shadow keys → SCHEMA-VIOLATION", async () => {
  const { ctx, dirs } = await buildTestCtx();
  await claimedLease(ctx);
  const receiptPath = await writeReceipt(dirs, "receipt.json", baseReceipt({
    extra: { mode: "shadow", shadow_of: SHADOW_OF },
  }));
  await expectCode(
    () => doneWithReceipt(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1, receiptPath }),
    "SCHEMA-VIOLATION",
  );
});

// -------------------------------------------------------------------- failCell

test("failCell: synthesizes failed receipt, cell failed, fail event with reason", async () => {
  const { ctx, sl, ledger } = await buildTestCtx();
  await claimedLease(ctx);
  const result = await failCell(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1, reason: "exploded" });
  const stored = await loadJson(result.file);
  assert.equal(stored.version, 1);
  assert.equal(stored.cell, "c1");
  assert.equal(stored.actor, "a1");
  assert.equal(stored.epoch, 1);
  assert.equal(stored.status, "failed");
  assert.equal(stored.summary, "exploded");
  assert.deepEqual(stored.commands, []);
  assert.deepEqual(stored.artifacts, []);
  assert.deepEqual(stored.reads, []);
  assert.equal(result.sha256, await sha256File(result.file));
  assert.equal((await readCellRaw(sl, "w1", "c1")).state, "failed");
  assert.deepEqual(eventTypes(ledger), ["claim", "fail"]);
  assert.equal(ledger.events[1].payload.reason, "exploded");
  assert.equal(ledger.events[1].payload.status, "failed");
});

test("failCell input checks: empty reason → USAGE; wrong actor → ACTOR-MISMATCH; no lease → CELL-STATE", async () => {
  const { ctx } = await buildTestCtx();
  await claimedLease(ctx);
  await expectCode(
    () => failCell(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1, reason: "" }),
    "USAGE",
  );
  await expectCode(
    () => failCell(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1, reason: "x".repeat(4097) }),
    "USAGE",
  );
  await expectCode(
    () => failCell(ctx, { wave: "w1", cell: "c1", actor: "a2", epoch: 1, reason: "boom" }),
    "ACTOR-MISMATCH",
  );
  await release(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1 });
  await expectCode(
    () => failCell(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1, reason: "boom" }),
    "CELL-STATE",
  );
});

// ---------------------------------------------------------------------- shadow

test("shadow happy path: wave shadow-*, receipt carries mode+shadow_of, artifact under shadow_home", async () => {
  const { ctx, sl, dirs, ledger } = await buildTestCtx({ mode: "shadow" });
  const wave = "shadow-w1";
  await fs.mkdir(sl.waveDir(wave), { recursive: true });
  await seedCell(sl, { wave, id: "s1", allowedRoots: [dirs.shadowHome] });
  await claim(ctx, { wave, cell: "s1", actor: "a1" });
  const artFile = await writeFile(path.join(dirs.shadowHome, "out.txt"), "shadow artifact\n");
  const receiptPath = await writeReceipt(dirs, "receipt.json", baseReceipt({
    cell: "s1",
    artifacts: [{ path: artFile, sha256: await sha256File(artFile) }],
    extra: { mode: "shadow", shadow_of: SHADOW_OF },
  }));
  const result = await doneWithReceipt(ctx, { wave, cell: "s1", actor: "a1", epoch: 1, receiptPath });
  assert.equal(result.sha256, await sha256File(receiptPath));
  assert.equal((await readCellRaw(sl, wave, "s1")).state, "done");
  assert.deepEqual(eventTypes(ledger), ["claim", "done"]);
});

test("shadow: artifact outside shadow_home → PATH-ESCAPE", async () => {
  const { ctx, sl, dirs } = await buildTestCtx({ mode: "shadow" });
  const wave = "shadow-w1";
  await fs.mkdir(sl.waveDir(wave), { recursive: true });
  // Allowed root is OUTSIDE shadow_home: containment passes, shadow rule bites.
  await seedCell(sl, { wave, id: "s1", allowedRoots: [dirs.tmp] });
  await claim(ctx, { wave, cell: "s1", actor: "a1" });
  const artFile = await writeFile(path.join(dirs.tmp, "leak.txt"), "leak\n");
  const receiptPath = await writeReceipt(dirs, "receipt.json", baseReceipt({
    cell: "s1",
    artifacts: [{ path: artFile, sha256: await sha256File(artFile) }],
    extra: { mode: "shadow", shadow_of: SHADOW_OF },
  }));
  await expectCode(
    () => doneWithReceipt(ctx, { wave, cell: "s1", actor: "a1", epoch: 1, receiptPath }),
    "PATH-ESCAPE",
  );
});

test("shadow: receipt missing shadow_of → SCHEMA-VIOLATION", async () => {
  const { ctx, sl, dirs } = await buildTestCtx({ mode: "shadow" });
  const wave = "shadow-w1";
  await fs.mkdir(sl.waveDir(wave), { recursive: true });
  await seedCell(sl, { wave, id: "s1", allowedRoots: [dirs.shadowHome] });
  await claim(ctx, { wave, cell: "s1", actor: "a1" });
  const receiptPath = await writeReceipt(dirs, "receipt.json", baseReceipt({ cell: "s1" }));
  await expectCode(
    () => doneWithReceipt(ctx, { wave, cell: "s1", actor: "a1", epoch: 1, receiptPath }),
    "SCHEMA-VIOLATION",
  );
});

test("shadow: wave id without shadow- prefix → SCHEMA-VIOLATION", async () => {
  const { ctx, dirs } = await buildTestCtx({ mode: "shadow" });
  await claimedLease(ctx); // wave "w1" — missing the prefix
  const receiptPath = await writeReceipt(dirs, "receipt.json", baseReceipt({
    extra: { mode: "shadow", shadow_of: SHADOW_OF },
  }));
  await expectCode(
    () => doneWithReceipt(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1, receiptPath }),
    "SCHEMA-VIOLATION",
  );
});

test("shadow failCell synthesizes a shadow-shaped receipt", async () => {
  const { ctx, sl, dirs } = await buildTestCtx({ mode: "shadow" });
  const wave = "shadow-w1";
  await fs.mkdir(sl.waveDir(wave), { recursive: true });
  await seedCell(sl, { wave, id: "s1", allowedRoots: [dirs.shadowHome] });
  await claim(ctx, { wave, cell: "s1", actor: "a1" });
  const result = await failCell(ctx, { wave, cell: "s1", actor: "a1", epoch: 1, reason: "shadow boom" });
  const stored = await loadJson(result.file);
  assert.equal(stored.mode, "shadow");
  assert.equal(stored.shadow_of, SHADOW_OF);
  assert.equal(stored.status, "failed");
});
