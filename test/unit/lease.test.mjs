// Unit tests for src/lease/lease.mjs — hand-built ctx + fakeLedger per
// DESIGN-INTERNALS §Testing. No src/ledger, no src/config imports.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { claim, release, renew, requeue } from "../../src/lease/lease.mjs";
import { layout, writeCell } from "../../src/kernel/state.mjs";
import { atomicWriteJson } from "../../src/kernel/fsutil.mjs";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const ISO_T0 = new Date(T0).toISOString();

async function buildTestCtx() {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aw-lease-")));
  const stateHome = path.join(tmp, "state");
  const sl = layout(stateHome);
  await fs.mkdir(sl.waveDir("w1"), { recursive: true });
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
  const ctx = {
    config: { mode: "normal" },
    // Stub policy: lease.mjs never calls policy (role/dep checks are pure
    // state), but the ctx shape is pinned, so carry the full interface.
    policy: {
      line: (name) => ({ name, roots: [], forbiddenRel: [], forbiddenAbs: [], readRoots: [] }),
      forbiddenHit: () => null,
      artifactOk: () => {},
      readOk: () => true,
    },
    sl,
    mode: "normal",
    ledger,
    nowFn: () => new Date(nowMs).toISOString(),
  };
  return { ctx, sl, ledger, advance: (seconds) => { nowMs += seconds * 1000; } };
}

async function seedCell(sl, { wave = "w1", id, state = "pending", epoch = 0, deps = [], roleFile = null, sessionStartedAt = null } = {}) {
  const cell = {
    id,
    wave,
    kind: "verify",
    line: "testline",
    cwd: tmpCwd(sl),
    allowed_roots: [tmpCwd(sl)],
    read_roots: [],
    deps,
    role: null,
    role_file: roleFile,
    session_started_at: sessionStartedAt,
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

function tmpCwd(sl) {
  return path.dirname(sl.stateHome); // the mkdtemp root
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

async function writeOwnerFixture(sl, wave, id, overrides = {}) {
  const owner = {
    actor: "ghost",
    pid: 999999999,
    host: os.hostname(),
    epoch: 5,
    acquired_at: new Date(T0 - 10_000).toISOString(),
    heartbeat_at: new Date(T0 - 10_000).toISOString(),
    expires_at: new Date(T0 + 3_600_000).toISOString(),
    max_hold_until: new Date(T0 + 7_200_000).toISOString(),
    ttl_seconds: 1800,
    ...overrides,
  };
  await atomicWriteJson(sl.ownerFile(wave, id), owner);
  return owner;
}

const LEASE_KEYS = ["actor", "pid", "host", "epoch", "acquired_at", "heartbeat_at", "expires_at", "max_hold_until", "ttl_seconds"];

// ---------------------------------------------------------------- happy paths

test("claim→renew→release: happy path, event order [claim, renew, release], epoch preserved on release", async () => {
  const { ctx, sl, ledger } = await buildTestCtx();
  await seedCell(sl, { id: "c1" });

  const owner = await claim(ctx, { wave: "w1", cell: "c1", actor: "a1" });
  assert.deepEqual(Object.keys(owner).sort(), [...LEASE_KEYS].sort());
  assert.equal(owner.epoch, 1);
  assert.equal(owner.actor, "a1");
  assert.equal(owner.ttl_seconds, 1800);
  assert.equal(Date.parse(owner.expires_at), T0 + 1800_000);
  assert.equal(Date.parse(owner.max_hold_until), T0 + 3600_000); // max(2*1800, 1800) = 3600
  let cell = await readCellRaw(sl, "w1", "c1");
  assert.equal(cell.state, "claimed");
  assert.equal(cell.epoch, 1);

  const renewed = await renew(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1 });
  assert.equal(renewed.ttl_seconds, 1800);
  cell = await readCellRaw(sl, "w1", "c1");
  assert.equal(cell.state, "claimed");

  const rel = await release(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1 });
  assert.deepEqual(rel, { released: true });
  cell = await readCellRaw(sl, "w1", "c1");
  assert.equal(cell.state, "pending");
  assert.equal(cell.epoch, 1); // epoch kept, never reused
  await assert.rejects(() => fs.stat(sl.ownerFile("w1", "c1")), { code: "ENOENT" });

  assert.deepEqual(eventTypes(ledger), ["claim", "renew", "release"]);
  assert.equal(ledger.events[0].payload.epoch, 1);
});

test("claim: max_hold_until = acquired_at + max(2*ttl, 1800)", async () => {
  const { ctx, sl } = await buildTestCtx();
  await seedCell(sl, { id: "c1" });
  const owner = await claim(ctx, { wave: "w1", cell: "c1", actor: "a1", ttlSeconds: 30 });
  // 2*30 = 60 < 1800 → the 30-minute floor applies (CONTRACT §6).
  assert.equal(Date.parse(owner.max_hold_until) - Date.parse(owner.acquired_at), 1800_000);
  assert.equal(Date.parse(owner.expires_at) - Date.parse(owner.acquired_at), 30_000);
});

test("release then claim: epoch+1", async () => {
  const { ctx, sl, ledger } = await buildTestCtx();
  await seedCell(sl, { id: "c1" });
  await claim(ctx, { wave: "w1", cell: "c1", actor: "a1" });
  await release(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1 });
  const owner = await claim(ctx, { wave: "w1", cell: "c1", actor: "a2" });
  assert.equal(owner.epoch, 2);
  assert.deepEqual(eventTypes(ledger), ["claim", "release", "claim"]);
});

// ------------------------------------------------------------------ rejections

test("claim: unknown wave → WAVE-MISSING; unknown cell → CELL-MISSING", async () => {
  const { ctx, sl } = await buildTestCtx();
  await expectCode(() => claim(ctx, { wave: "nosuch", cell: "c1", actor: "a1" }), "WAVE-MISSING");
  await seedCell(sl, { id: "c1" });
  await expectCode(() => claim(ctx, { wave: "w1", cell: "nosuch", actor: "a1" }), "CELL-MISSING");
});

test("claim blocked by a pending dep: CELL-STATE with violations naming the dep", async () => {
  const { ctx, ledger } = await buildTestCtx();
  await seedCell(sl0(ctx), { id: "dep" });
  await seedCell(sl0(ctx), { id: "c1", deps: ["dep"] });
  await assert.rejects(
    () => claim(ctx, { wave: "w1", cell: "c1", actor: "a1" }),
    (err) => {
      assert.equal(err.code, "CELL-STATE");
      assert.ok(err.violations.some((v) => v.field === "deps.dep" && v.rule === "dep-not-done" && v.detail === "pending"));
      return true;
    },
  );
  assert.deepEqual(eventTypes(ledger), []); // rejection appends nothing (CLI's job)
});

function sl0(ctx) {
  return ctx.sl;
}

test("claim with all deps done succeeds", async () => {
  const { ctx, sl } = await buildTestCtx();
  await seedCell(sl, { id: "dep", state: "done" });
  await seedCell(sl, { id: "c1", deps: ["dep"] });
  const owner = await claim(ctx, { wave: "w1", cell: "c1", actor: "a1" });
  assert.equal(owner.epoch, 1);
});

test("double claim → LEASE-HELD, no mutation", async () => {
  const { ctx, sl, ledger } = await buildTestCtx();
  await seedCell(sl, { id: "c1" });
  const owner = await claim(ctx, { wave: "w1", cell: "c1", actor: "a1" });
  await expectCode(() => claim(ctx, { wave: "w1", cell: "c1", actor: "a2" }), "LEASE-HELD");
  assert.deepEqual(await loadJson(sl.ownerFile("w1", "c1")), owner);
  assert.equal((await readCellRaw(sl, "w1", "c1")).state, "claimed");
  assert.deepEqual(eventTypes(ledger), ["claim"]);
});

test("claim on done/failed cell → CELL-STATE", async () => {
  const { ctx, sl } = await buildTestCtx();
  await seedCell(sl, { id: "done1", state: "done" });
  await seedCell(sl, { id: "fail1", state: "failed" });
  await expectCode(() => claim(ctx, { wave: "w1", cell: "done1", actor: "a1" }), "CELL-STATE");
  await expectCode(() => claim(ctx, { wave: "w1", cell: "fail1", actor: "a1" }), "CELL-STATE");
});

test("expired lease takeover: epoch+1, claim event payload.reclaim=expired", async () => {
  const { ctx, sl, ledger, advance } = await buildTestCtx();
  await seedCell(sl, { id: "c1" });
  await claim(ctx, { wave: "w1", cell: "c1", actor: "a1", ttlSeconds: 3600 });
  advance(3601); // expired, still inside max_hold (7200)
  const owner = await claim(ctx, { wave: "w1", cell: "c1", actor: "a2" });
  assert.equal(owner.epoch, 2);
  assert.equal(owner.actor, "a2");
  assert.deepEqual(eventTypes(ledger), ["claim", "claim"]);
  assert.equal(ledger.events[1].payload.reclaim, "expired");
  assert.equal(ledger.events[1].payload.epoch, 2);
});

test("dead pid does NOT trigger early reclaim (CLI reality: claimants exit; CONTRACT §6 amended): LEASE-HELD", async () => {
  const { ctx, sl, ledger } = await buildTestCtx();
  await seedCell(sl, { id: "c1", state: "claimed", epoch: 5 });
  await writeOwnerFixture(sl, "w1", "c1"); // pid 999999999, host this machine
  await expectCode(() => claim(ctx, { wave: "w1", cell: "c1", actor: "a2" }), "LEASE-HELD");
  assert.deepEqual(eventTypes(ledger), []);
});

test("live-pid lease is not reclaimed before expiry: LEASE-HELD", async () => {
  const { ctx, sl } = await buildTestCtx();
  await seedCell(sl, { id: "c1", state: "claimed", epoch: 5 });
  await writeOwnerFixture(sl, "w1", "c1", { pid: process.pid });
  await expectCode(() => claim(ctx, { wave: "w1", cell: "c1", actor: "a2" }), "LEASE-HELD");
});

test("foreign-host lease is honoured until expiry: LEASE-HELD", async () => {
  const { ctx, sl } = await buildTestCtx();
  await seedCell(sl, { id: "c1", state: "claimed", epoch: 5 });
  await writeOwnerFixture(sl, "w1", "c1", { pid: 999999999, host: "some-other-host" });
  await expectCode(() => claim(ctx, { wave: "w1", cell: "c1", actor: "a2" }), "LEASE-HELD");
});

// ---------------------------------------------------------------------- steal

test("steal before max_hold_until → STEAL-DENIED (live lease)", async () => {
  const { ctx, advance } = await buildTestCtx();
  await seedCell(ctx.sl, { id: "c1" });
  await claim(ctx, { wave: "w1", cell: "c1", actor: "a1", ttlSeconds: 3600 });
  advance(60);
  await expectCode(() => claim(ctx, { wave: "w1", cell: "c1", actor: "a2", steal: true }), "STEAL-DENIED");
});

test("steal=true on an expired lease takes the reclaim door (claim event), not the steal door", async () => {
  // Interpretation pinned here: reclaim (expired) is checked before
  // the steal gate, so --steal on an expired lease claims normally. The
  // STEAL-DENIED / steal-event pair below covers live leases.
  const { ctx, ledger, advance } = await buildTestCtx();
  await seedCell(ctx.sl, { id: "c1" });
  await claim(ctx, { wave: "w1", cell: "c1", actor: "a1", ttlSeconds: 3600 });
  advance(3601); // expired at +3600, max_hold at +7200
  const owner = await claim(ctx, { wave: "w1", cell: "c1", actor: "a2", steal: true });
  assert.equal(owner.epoch, 2);
  assert.equal(owner.actor, "a2");
  assert.deepEqual(eventTypes(ledger), ["claim", "claim"]);
  assert.equal(ledger.events[1].payload.reclaim, "expired");
});

test("steal=true on an expired lease behaves like reclaim (claim event, not steal)", async () => {
  const { ctx, ledger, advance } = await buildTestCtx();
  await seedCell(ctx.sl, { id: "c1" });
  await claim(ctx, { wave: "w1", cell: "c1", actor: "a1", ttlSeconds: 1800 });
  advance(1801); // expired, within max_hold floor
  const owner = await claim(ctx, { wave: "w1", cell: "c1", actor: "a2", steal: true });
  assert.equal(owner.epoch, 2);
  assert.deepEqual(eventTypes(ledger), ["claim", "claim"]);
  assert.equal(ledger.events[1].payload.reclaim, "expired");
});

test("steal past max_hold_until of a live (renew-extended) lease: epoch+1 + steal event", async () => {
  const { ctx, sl, ledger, advance } = await buildTestCtx();
  await seedCell(ctx.sl, { id: "c1" });
  await claim(ctx, { wave: "w1", cell: "c1", actor: "a1", ttlSeconds: 1800 }); // expires +1800, max_hold +3600
  advance(1799);
  await renew(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1 }); // expires +3599
  advance(3598 - 1799);
  await renew(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1 }); // expires +5398 > max_hold +3600
  advance(3); // now +3601: live (expires +5398) but past max_hold +3600
  const prior = await loadJson(ctx.sl.ownerFile("w1", "c1"));
  const owner = await claim(ctx, { wave: "w1", cell: "c1", actor: "a2", steal: true });
  assert.equal(owner.epoch, 2);
  assert.equal(owner.actor, "a2");
  const stealEvent = ledger.events.at(-1);
  assert.equal(stealEvent.type, "steal");
  assert.deepEqual(stealEvent.payload.prior, {
    actor: prior.actor,
    epoch: prior.epoch,
    max_hold_until: prior.max_hold_until,
  });
  assert.equal(stealEvent.payload.evidence.host, os.hostname());
  assert.equal(stealEvent.payload.evidence.pid, process.pid);
  assert.ok(typeof stealEvent.payload.evidence.now === "string");
  const cell = await readCellRaw(sl, "w1", "c1");
  assert.equal(cell.state, "claimed");
  assert.equal(cell.epoch, 2);
});

test("steal=true with no lease file behaves like a fresh claim", async () => {
  const { ctx, ledger } = await buildTestCtx();
  await seedCell(ctx.sl, { id: "c1" });
  const owner = await claim(ctx, { wave: "w1", cell: "c1", actor: "a1", steal: true });
  assert.equal(owner.epoch, 1);
  assert.deepEqual(eventTypes(ledger), ["claim"]);
});

// ---------------------------------------------------------------------- renew

test("renew after max_hold_until → LEASE-MAX-HOLD, forever for this epoch", async () => {
  const { ctx, advance } = await buildTestCtx();
  await seedCell(ctx.sl, { id: "c1" });
  await claim(ctx, { wave: "w1", cell: "c1", actor: "a1", ttlSeconds: 1800 }); // max_hold +3600
  advance(1799);
  await renew(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1 }); // expires +3599
  advance(1799); // now +3598
  await renew(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1 }); // expires +5398
  advance(3); // now +3601: not expired, past max_hold
  await expectCode(() => renew(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1 }), "LEASE-MAX-HOLD");
  advance(1); // forever: max_hold_until is fixed, time only moves forward
  await expectCode(() => renew(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1 }), "LEASE-MAX-HOLD");
});

test("renew on expired lease → LEASE-EXPIRED", async () => {
  const { ctx, advance } = await buildTestCtx();
  await seedCell(ctx.sl, { id: "c1" });
  await claim(ctx, { wave: "w1", cell: "c1", actor: "a1" });
  advance(1801);
  await expectCode(() => renew(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1 }), "LEASE-EXPIRED");
});

test("renew wrong actor → ACTOR-MISMATCH (checked before epoch); wrong epoch → EPOCH-MISMATCH", async () => {
  const { ctx } = await buildTestCtx();
  await seedCell(ctx.sl, { id: "c1" });
  await claim(ctx, { wave: "w1", cell: "c1", actor: "a1" });
  await expectCode(() => renew(ctx, { wave: "w1", cell: "c1", actor: "a2", epoch: 1 }), "ACTOR-MISMATCH");
  await expectCode(() => renew(ctx, { wave: "w1", cell: "c1", actor: "a2", epoch: 9 }), "ACTOR-MISMATCH"); // actor first
  await expectCode(() => renew(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 9 }), "EPOCH-MISMATCH");
});

test("renew on pending cell → CELL-STATE; claimed-without-lease → STATE-CORRUPT", async () => {
  const { ctx, sl } = await buildTestCtx();
  await seedCell(sl, { id: "c1" });
  await expectCode(() => renew(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1 }), "CELL-STATE");
  await seedCell(sl, { id: "c2", state: "claimed", epoch: 1 });
  await expectCode(() => renew(ctx, { wave: "w1", cell: "c2", actor: "a1", epoch: 1 }), "STATE-CORRUPT");
});

// -------------------------------------------------------------------- release

test("release wrong actor/epoch → ACTOR-MISMATCH/EPOCH-MISMATCH", async () => {
  const { ctx } = await buildTestCtx();
  await seedCell(ctx.sl, { id: "c1" });
  await claim(ctx, { wave: "w1", cell: "c1", actor: "a1" });
  await expectCode(() => release(ctx, { wave: "w1", cell: "c1", actor: "a2", epoch: 1 }), "ACTOR-MISMATCH");
  await expectCode(() => release(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 7 }), "EPOCH-MISMATCH");
});

test("release with no lease → CELL-STATE", async () => {
  const { ctx } = await buildTestCtx();
  await seedCell(ctx.sl, { id: "c1" });
  await expectCode(() => release(ctx, { wave: "w1", cell: "c1", actor: "a1", epoch: 1 }), "CELL-STATE");
});

// -------------------------------------------------------------------- requeue

test("requeue: failed → pending only; lease must not exist", async () => {
  const { ctx, sl, ledger } = await buildTestCtx();
  await seedCell(sl, { id: "c1", state: "failed", epoch: 3 });
  await seedCell(sl, { id: "c2" });
  await seedCell(sl, { id: "c3", state: "failed", epoch: 2 });
  await writeOwnerFixture(sl, "w1", "c3", { epoch: 2 });

  const cell = await requeue(ctx, { wave: "w1", cell: "c1" });
  assert.equal(cell.state, "pending");
  assert.equal((await readCellRaw(sl, "w1", "c1")).epoch, 3); // epoch preserved

  await expectCode(() => requeue(ctx, { wave: "w1", cell: "c2" }), "CELL-STATE"); // pending
  await expectCode(() => requeue(ctx, { wave: "w1", cell: "c3" }), "CELL-STATE"); // failed but lease exists
  assert.deepEqual(eventTypes(ledger), ["requeue"]);
});

// -------------------------------------------------------------- ttl & snapshot

test("claim ttl outside 30..86400 → USAGE before any I/O effect", async () => {
  const { ctx, sl, ledger } = await buildTestCtx();
  await seedCell(sl, { id: "c1" });
  await expectCode(() => claim(ctx, { wave: "w1", cell: "c1", actor: "a1", ttlSeconds: 10 }), "USAGE");
  await expectCode(() => claim(ctx, { wave: "w1", cell: "c1", actor: "a1", ttlSeconds: 86401 }), "USAGE");
  await expectCode(() => claim(ctx, { wave: "w1", cell: "c1", actor: "a1", ttlSeconds: 1.5 }), "USAGE");
  assert.deepEqual(eventTypes(ledger), []);
});

test("role snapshot: role_file mtime after session_started_at → RESTART-REQUIRED", async () => {
  const { ctx, sl } = await buildTestCtx();
  const roleFile = path.join(tmpCwd(sl), "ROLE.md");
  await fs.writeFile(roleFile, "# role\n", "utf8"); // mtime = wall-clock now
  await seedCell(sl, {
    id: "c1",
    roleFile,
    sessionStartedAt: new Date(Date.now() - 60_000).toISOString(), // session started before the file changed
  });
  await expectCode(() => claim(ctx, { wave: "w1", cell: "c1", actor: "a1" }), "RESTART-REQUIRED");
});

test("role snapshot: fresh session (started after mtime) claims fine", async () => {
  const { ctx, sl } = await buildTestCtx();
  const roleFile = path.join(tmpCwd(sl), "ROLE.md");
  await fs.writeFile(roleFile, "# role\n", "utf8");
  await seedCell(sl, {
    id: "c1",
    roleFile,
    sessionStartedAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const owner = await claim(ctx, { wave: "w1", cell: "c1", actor: "a1" });
  assert.equal(owner.epoch, 1);
});

test("role snapshot: missing role_file is treated as no snapshot (documented choice)", async () => {
  const { ctx, sl } = await buildTestCtx();
  await seedCell(sl, {
    id: "c1",
    roleFile: path.join(tmpCwd(sl), "gone.md"),
    sessionStartedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const owner = await claim(ctx, { wave: "w1", cell: "c1", actor: "a1" });
  assert.equal(owner.epoch, 1);
});

// ------------------------------------------------------------------- corruption

test("lease file with an extra key → STATE-CORRUPT on claim", async () => {
  const { ctx, sl } = await buildTestCtx();
  await seedCell(sl, { id: "c1", state: "claimed", epoch: 5 });
  const owner = await writeOwnerFixture(sl, "w1", "c1", { pid: process.pid });
  await atomicWriteJson(sl.ownerFile("w1", "c1"), { ...owner, extra_key: "nope" });
  await expectCode(() => claim(ctx, { wave: "w1", cell: "c1", actor: "a1" }), "STATE-CORRUPT");
});

test("claimed cell with missing owner.json → STATE-CORRUPT on claim (fail closed, no auto-heal)", async () => {
  const { ctx, sl } = await buildTestCtx();
  await seedCell(sl, { id: "c1", state: "claimed", epoch: 4 });
  await expectCode(() => claim(ctx, { wave: "w1", cell: "c1", actor: "a1" }), "STATE-CORRUPT");
});

test("claim rejects non-SafeId ids with USAGE", async () => {
  const { ctx } = await buildTestCtx();
  await expectCode(() => claim(ctx, { wave: "../evil", cell: "c1", actor: "a1" }), "USAGE");
  await expectCode(() => claim(ctx, { wave: "w1", cell: "a/b", actor: "a1" }), "USAGE");
});
