// Lease placement — CONTRACT §6, DESIGN-INTERNALS §src/lease.
//
// Module law (pinned):
// - Every entry point validates BEFORE any mutation; rejections throw
//   WardenError and leave disk state byte-identical (fail-closed).
// - Write order on success: owner.json → cell state (atomic) → lease history
//   line (best-effort audit) → ledger append.
// - Modules append only SUCCESS events; rejected-attempt ledger lines are the
//   CLI layer's job (CONTRACT §8.3 lives under §8 "CLI").
// - `failCell` lives in src/receipt (pinned split); this module exports
//   claim/renew/release/requeue only.
// - No lateral imports (layering): receipt.mjs re-implements its own lease
//   loader rather than importing this file.
// - ctx.nowFn() (optional, ISO string) is the only clock source: tests inject
//   it; production falls back to fsutil.nowIso (Date).

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fail, violation } from "../kernel/errors.mjs";
import { ensureDir, fileExists, nowIso, readJsonCapped, atomicWriteJson } from "../kernel/fsutil.mjs";
import { withExclusiveLock } from "../kernel/lock.mjs";
import { readCell, writeCell, removeStateFile, SAFE_ID_RE } from "../kernel/state.mjs";

const TTL_MIN = 30;
const TTL_MAX = 86400;
const MAX_HOLD_FLOOR_SECONDS = 1800; // max(2*ttl, 30m) — CONTRACT §6

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const LEASE_KEYS = new Set([
  "actor",
  "pid",
  "host",
  "epoch",
  "acquired_at",
  "heartbeat_at",
  "expires_at",
  "max_hold_until",
  "ttl_seconds",
]);

// ---------------------------------------------------------------- primitives

function nowIsoOf(ctx) {
  return (ctx?.nowFn ?? nowIso)();
}

function msOf(iso, what) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) fail("STATE-CORRUPT", `unparseable timestamp in ${what}: ${iso}`);
  return ms;
}

function addSecondsMs(ms, seconds) {
  return new Date(ms + seconds * 1000).toISOString();
}

function maxHoldSeconds(ttlSeconds) {
  return Math.max(2 * ttlSeconds, MAX_HOLD_FLOOR_SECONDS);
}

function isIsoString(value) {
  return typeof value === "string" && ISO_RE.test(value) && Number.isFinite(Date.parse(value));
}

// Lease JSON shape is a contract value (CONTRACT §6): exact key set, no extra
// keys. Any deviation is STATE-CORRUPT (fail closed, exit 2).
function validateLeaseShape(owner, filePath) {
  if (owner === null || typeof owner !== "object" || Array.isArray(owner)) {
    fail("STATE-CORRUPT", `lease is not an object: ${filePath}`);
  }
  const keys = Object.getOwnPropertyNames(owner);
  for (const key of keys) {
    if (!LEASE_KEYS.has(key)) {
      fail("STATE-CORRUPT", `lease has unknown key "${key}": ${filePath}`, [
        violation(filePath, "lease-unknown-key", key),
      ]);
    }
  }
  for (const key of LEASE_KEYS) {
    if (!Object.hasOwn(owner, key)) {
      fail("STATE-CORRUPT", `lease missing key "${key}": ${filePath}`, [
        violation(filePath, "lease-missing-key", key),
      ]);
    }
  }
  if (typeof owner.actor !== "string" || owner.actor.length === 0) {
    fail("STATE-CORRUPT", `lease actor invalid: ${filePath}`);
  }
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) {
    fail("STATE-CORRUPT", `lease pid invalid: ${filePath}`);
  }
  if (typeof owner.host !== "string" || owner.host.length === 0) {
    fail("STATE-CORRUPT", `lease host invalid: ${filePath}`);
  }
  if (!Number.isInteger(owner.epoch) || owner.epoch < 1) {
    fail("STATE-CORRUPT", `lease epoch invalid: ${filePath}`);
  }
  if (!Number.isInteger(owner.ttl_seconds) || owner.ttl_seconds < TTL_MIN || owner.ttl_seconds > TTL_MAX) {
    fail("STATE-CORRUPT", `lease ttl_seconds invalid: ${filePath}`);
  }
  for (const key of ["acquired_at", "heartbeat_at", "expires_at", "max_hold_until"]) {
    if (!isIsoString(owner[key])) {
      fail("STATE-CORRUPT", `lease ${key} is not RFC3339: ${filePath}`);
    }
  }
}

// ------------------------------------------------------------------- helpers

function validateTtl(ttlSeconds) {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < TTL_MIN || ttlSeconds > TTL_MAX) {
    fail("USAGE", `ttl_seconds must be an integer in ${TTL_MIN}..${TTL_MAX}, got ${String(ttlSeconds)}`, [
      violation("ttl_seconds", "range", String(ttlSeconds)),
    ]);
  }
}

function validateSafeId(name, value) {
  if (typeof value !== "string" || !SAFE_ID_RE.test(value)) {
    fail("USAGE", `${name} must be a SafeId, got ${String(value)}`, [
      violation(name, "safe-id", String(value)),
    ]);
  }
}

// Wave/cell existence gate, before any lease error (DESIGN-INTERNALS §src/lease).
async function loadCellOrFail(ctx, wave, cell) {
  validateSafeId("wave", wave);
  validateSafeId("cell", cell);
  if (!(await fileExists(ctx.sl.waveDir(wave)))) {
    fail("WAVE-MISSING", `wave not found: ${wave}`, [violation("wave", "wave-missing", wave)]);
  }
  try {
    return await readCell(ctx.sl, wave, cell);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      fail("CELL-MISSING", `cell not found: ${wave}/${cell}`, [
        violation("cell", "cell-missing", `${wave}/${cell}`),
      ]);
    }
    throw error; // STATE-CORRUPT etc. propagate unchanged (fail closed)
  }
}

async function loadLeaseOrNull(ctx, wave, cell) {
  const filePath = ctx.sl.ownerFile(wave, cell);
  let owner;
  try {
    ({ value: owner } = await readJsonCapped(filePath, undefined, "STATE-CORRUPT"));
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
  validateLeaseShape(owner, filePath);
  return owner;
}

function cellEpochOf(cell, filePath) {
  if (!Number.isInteger(cell.epoch) || cell.epoch < 0) {
    fail("STATE-CORRUPT", `cell epoch invalid: ${filePath}`, [
      violation("epoch", "cell-state", String(cell.epoch)),
    ]);
  }
  return cell.epoch;
}

function newOwner({ actor, ttlSeconds, epoch, nowMs }) {
  return {
    actor,
    pid: process.pid,
    host: os.hostname(),
    epoch,
    acquired_at: new Date(nowMs).toISOString(),
    heartbeat_at: new Date(nowMs).toISOString(),
    expires_at: addSecondsMs(nowMs, ttlSeconds),
    max_hold_until: addSecondsMs(nowMs, maxHoldSeconds(ttlSeconds)),
    ttl_seconds: ttlSeconds,
  };
}

// Best-effort audit line into leases/<id>/history.jsonl (no schema, no
// failure propagation — the ledger is the authoritative record).
async function appendHistory(ctx, wave, cell, line) {
  try {
    const filePath = ctx.sl.leaseHistory(wave, cell);
    await ensureDir(path.dirname(filePath));
    await fs.appendFile(filePath, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    // audit-only file: swallow. §6 design intent; ledger stays authoritative.
  }
}

async function commitAcquire(ctx, { wave, cell, actor, owner, cellRow, event, payload, historyLine }) {
  // Pinned write order: owner first, then cell, then history (best-effort),
  // then ledger. A crash between owner and cell leaves a lease on a stale
  // cell state; claim/renew surface that as STATE-CORRUPT, never open.
  await atomicWriteJson(ctx.sl.ownerFile(wave, cell), owner);
  await writeCell(ctx.sl, wave, cell, {
    ...cellRow,
    state: "claimed",
    epoch: owner.epoch,
    updated_at: owner.acquired_at,
  });
  if (historyLine) await appendHistory(ctx, wave, cell, historyLine);
  await ctx.ledger.append(event, { wave, cell, actor, payload });
  return owner;
}

// CONTRACT §3 end: role snapshot freshness. Missing role file is treated as
// no snapshot (documented choice: a deleted role file cannot be proven
// stale, and RESTART-REQUIRED is retryable noise for a cell that no longer
// carries a role); any other stat failure cannot prove freshness and fails
// closed as RESTART-REQUIRED (retryable).
async function checkRoleSnapshot(ctx, cellRow) {
  if (typeof cellRow.role_file !== "string" || cellRow.role_file.length === 0) return;
  if (typeof cellRow.session_started_at !== "string" || cellRow.session_started_at.length === 0) return;
  const startedMs = msOf(cellRow.session_started_at, "cell.session_started_at");
  let mtimeMs;
  try {
    ({ mtimeMs } = await fs.stat(cellRow.role_file));
  } catch (error) {
    if (error && error.code === "ENOENT") return; // no snapshot → nothing to enforce
    fail("RESTART-REQUIRED", `cannot stat role_file ${cellRow.role_file}: ${error.message}`, [
      violation("role_file", "role-check-unknown", error.message),
    ]);
  }
  if (mtimeMs > startedMs) {
    fail("RESTART-REQUIRED", `role file ${cellRow.role_file} changed after session start`, [
      violation("role_file", "role-stale", new Date(mtimeMs).toISOString()),
    ]);
  }
}

// --------------------------------------------------------------------- claim

/**
 * claim(ctx, {wave, cell, actor, ttlSeconds=1800, steal=false}) → owner
 * CONTRACT §6 semantics; see module header for ordering law.
 */
async function claimLocked(ctx, { wave, cell, actor, ttlSeconds = 1800, steal = false }) {
  // Pure input checks first — no I/O, no mutation.
  validateTtl(ttlSeconds);
  if (typeof actor !== "string" || actor.length === 0) {
    fail("USAGE", "claim requires a non-empty actor");
  }
  const cellRow = await loadCellOrFail(ctx, wave, cell);
  const cellPath = ctx.sl.cellFile(wave, cell);

  if (cellRow.state === "done" || cellRow.state === "failed") {
    fail("CELL-STATE", `cell ${wave}/${cell} is ${cellRow.state}; cannot claim`, [
      violation("state", "cell-state", cellRow.state),
    ]);
  }
  if (cellRow.state !== "pending" && cellRow.state !== "claimed") {
    fail("STATE-CORRUPT", `cell ${wave}/${cell} has unknown state ${String(cellRow.state)}`);
  }

  // Deps gate applies to fresh claims (pending cells). A claimed cell is past
  // its dep gate; reclaim/steal must not re-litigate deps (§6).
  if (cellRow.state === "pending") {
    // Kernel null-prototype note: readJsonCapped arrays have no
    // Symbol.iterator — iterate disk-read arrays by index only.
    const deps = Array.isArray(cellRow.deps) ? cellRow.deps : [];
    const blocked = [];
    for (let i = 0; i < deps.length; i += 1) {
      const dep = deps[i];
      let depRow;
      try {
        depRow = await readCell(ctx.sl, wave, dep);
      } catch (error) {
        if (error && error.code === "ENOENT") {
          fail("STATE-CORRUPT", `dep cell missing from wave: ${wave}/${dep}`, [
            violation(`deps.${dep}`, "dep-missing", "cell file absent"),
          ]);
        }
        throw error;
      }
      if (depRow.state !== "done") blocked.push({ dep, state: depRow.state });
    }
    if (blocked.length > 0) {
      fail(
        "CELL-STATE",
        `cell ${wave}/${cell} blocked by unfinished deps: ${blocked.map((b) => `${b.dep}(${b.state})`).join(", ")}`,
        blocked.map((b) => violation(`deps.${b.dep}`, "dep-not-done", b.state)),
      );
    }
  }

  await checkRoleSnapshot(ctx, cellRow);

  const nowIsoStr = nowIsoOf(ctx);
  const nowMs = msOf(nowIsoStr, "now");
  const owner = await loadLeaseOrNull(ctx, wave, cell);
  const cellEpoch = cellEpochOf(cellRow, cellPath);

  let newEpoch;
  let event = "claim";
  let payload = { epoch: 0, ttl_seconds: ttlSeconds };
  let historyLine = null;

  if (owner !== null) {
    const expired = nowMs > msOf(owner.expires_at, "lease.expires_at");
    // Takeover is time-gated ONLY (CONTRACT §6, amended pre-1.0): the pid in
    // a lease is forensic. Short-lived CLI invocations die right after claim,
    // so pid-liveness would make every lease instantly "dead" and void
    // LEASE-HELD entirely. Crash or not, occupancy is bounded by expires_at
    // (reclaim) and max_hold_until (steal) — the handoff's blocking bound.
    if (steal) {
      // CONTRACT §6 pins the steal gate to max_hold_until of the current
      // lease — nothing else. Even an expired-but-within-max-hold lease is
      // STEAL-DENIED on the steal path; the reclaim path is the non-steal
      // door for that window. An expired lease with steal=true behaves like
      // reclaim, per the pinned task flow.
      if (expired) {
        newEpoch = Math.max(cellEpoch, owner.epoch) + 1;
        payload = { epoch: newEpoch, ttl_seconds: ttlSeconds, reclaim: "expired" };
        historyLine = { ts: nowIsoStr, event: "claim", actor, epoch: newEpoch, reclaim: payload.reclaim };
      } else if (nowMs > msOf(owner.max_hold_until, "lease.max_hold_until")) {
        // Live lease past its max hold: steal at epoch+1 with evidence.
        newEpoch = Math.max(cellEpoch, owner.epoch) + 1;
        const prior = { actor: owner.actor, epoch: owner.epoch, max_hold_until: owner.max_hold_until };
        const evidence = { now: nowIsoStr, host: os.hostname(), pid: process.pid };
        event = "steal";
        payload = { prior, evidence };
        historyLine = { ts: nowIsoStr, event: "steal", actor, epoch: newEpoch, prior, evidence };
      } else {
        fail("STEAL-DENIED", `cell ${wave}/${cell} held until ${owner.max_hold_until}; steal window not open`, [
          violation("max_hold_until", "steal-window", owner.max_hold_until),
        ]);
      }
    } else if (expired) {
      newEpoch = Math.max(cellEpoch, owner.epoch) + 1;
      payload = { epoch: newEpoch, ttl_seconds: ttlSeconds, reclaim: "expired" };
      historyLine = { ts: nowIsoStr, event: "claim", actor, epoch: newEpoch, reclaim: payload.reclaim };
    } else {
      fail("LEASE-HELD", `cell ${wave}/${cell} leased to ${owner.actor} (epoch ${owner.epoch}) until ${owner.expires_at}`, [
        violation("lease", "lease-held", `${owner.actor}@${owner.host}:${owner.pid}`),
      ]);
    }
  } else {
    if (cellRow.state === "claimed") {
      // Cell claims a holder but no lease file exists: the invariant
      // "claimed ⇒ owner.json present" is broken (crashed release).
      // Fail closed for human repair — never auto-heal into a new epoch.
      fail("STATE-CORRUPT", `cell ${wave}/${cell} is claimed but owner.json is missing`, [
        violation("lease", "claimed-without-lease", cellPath),
      ]);
    }
    newEpoch = cellEpoch + 1; // first claim: 0 → 1; after release: preserved epoch + 1
    payload = { epoch: newEpoch, ttl_seconds: ttlSeconds };
  }

  const ownerRow = newOwner({ actor, ttlSeconds, epoch: newEpoch, nowMs });
  return commitAcquire(ctx, {
    wave,
    cell,
    actor,
    owner: ownerRow,
    cellRow,
    event,
    payload,
    historyLine,
  });
}

// --------------------------------------------------------------------- renew

/**
 * renew(ctx, {wave, cell, actor, epoch, ttlSeconds=1800}) → owner
 * Heartbeat: refreshes heartbeat_at/expires_at/ttl_seconds. acquired_at and
 * max_hold_until are fixed forever (pinned): once now > max_hold_until the
 * lease can never be renewed again in this epoch.
 */
async function renewLocked(ctx, { wave, cell, actor, epoch, ttlSeconds = 1800 }) {
  validateTtl(ttlSeconds);
  if (typeof actor !== "string" || actor.length === 0) fail("USAGE", "renew requires a non-empty actor");
  const cellRow = await loadCellOrFail(ctx, wave, cell);
  const cellPath = ctx.sl.cellFile(wave, cell);
  if (cellRow.state !== "claimed") {
    fail("CELL-STATE", `cell ${wave}/${cell} is ${String(cellRow.state)}, not claimed`, [
      violation("state", "cell-state", String(cellRow.state)),
    ]);
  }
  const owner = await loadLeaseOrNull(ctx, wave, cell);
  if (owner === null) {
    // Cell is claimed but the lease file is gone — broken invariant.
    fail("STATE-CORRUPT", `cell ${wave}/${cell} is claimed but owner.json is missing`, [
      violation("lease", "claimed-without-lease", cellPath),
    ]);
  }
  if (owner.actor !== actor) {
    fail("ACTOR-MISMATCH", `lease held by ${owner.actor}, renew attempted as ${actor}`, [
      violation("actor", "actor-mismatch", owner.actor),
    ]);
  }
  if (owner.epoch !== epoch) {
    fail("EPOCH-MISMATCH", `lease epoch is ${owner.epoch}, renew attempted with ${epoch}`, [
      violation("epoch", "epoch-mismatch", String(owner.epoch)),
    ]);
  }
  const nowIsoStr = nowIsoOf(ctx);
  const nowMs = msOf(nowIsoStr, "now");
  if (nowMs > msOf(owner.expires_at, "lease.expires_at")) {
    fail("LEASE-EXPIRED", `lease expired at ${owner.expires_at}`, [
      violation("expires_at", "lease-expired", owner.expires_at),
    ]);
  }
  if (nowMs > msOf(owner.max_hold_until, "lease.max_hold_until")) {
    fail("LEASE-MAX-HOLD", `lease past max_hold_until ${owner.max_hold_until}; renewal impossible forever in this epoch`, [
      violation("max_hold_until", "lease-max-hold", owner.max_hold_until),
    ]);
  }
  const updated = {
    ...owner,
    heartbeat_at: nowIsoStr,
    expires_at: addSecondsMs(nowMs, ttlSeconds),
    ttl_seconds: ttlSeconds,
  };
  validateLeaseShape(updated, ctx.sl.ownerFile(wave, cell));
  await atomicWriteJson(ctx.sl.ownerFile(wave, cell), updated);
  await writeCell(ctx.sl, wave, cell, { ...cellRow, updated_at: nowIsoStr });
  await ctx.ledger.append("renew", { wave, cell, actor, payload: { epoch } });
  return updated;
}

// ------------------------------------------------------------------- release

/**
 * release(ctx, {wave, cell, actor, epoch}) → {released: true}
 * Pinned flow: actor+epoch check (actor first) → remove owner.json →
 * cell → pending keeping epoch (epoch numbers are never reused) → release
 * event. No cell-state precheck beyond wave/cell existence: the lease is the
 * authority for release, so a crashed release (cell pending, lease present)
 * is self-healing. Consequence (contract §6/§10 tension): a failed cell with
 * a live lease can be cleared with release (failed → pending), making the
 * requeue "no lease may exist" guard reachable without state surgery.
 */
async function releaseLocked(ctx, { wave, cell, actor, epoch }) {
  if (typeof actor !== "string" || actor.length === 0) fail("USAGE", "release requires a non-empty actor");
  const cellRow = await loadCellOrFail(ctx, wave, cell);
  const owner = await loadLeaseOrNull(ctx, wave, cell);
  if (owner === null) {
    if (cellRow.state === "claimed") {
      fail("STATE-CORRUPT", `cell ${wave}/${cell} is claimed but owner.json is missing`, [
        violation("lease", "claimed-without-lease", ctx.sl.cellFile(wave, cell)),
      ]);
    }
    fail("CELL-STATE", `no lease to release on ${wave}/${cell}`, [violation("lease", "no-lease", "absent")]);
  }
  if (owner.actor !== actor) {
    fail("ACTOR-MISMATCH", `lease held by ${owner.actor}, release attempted as ${actor}`, [
      violation("actor", "actor-mismatch", owner.actor),
    ]);
  }
  if (owner.epoch !== epoch) {
    fail("EPOCH-MISMATCH", `lease epoch is ${owner.epoch}, release attempted with ${epoch}`, [
      violation("epoch", "epoch-mismatch", String(owner.epoch)),
    ]);
  }
  const nowIsoStr = nowIsoOf(ctx);
  // Lease-file change first (DESIGN-INTERNALS write-order law), then cell.
  await removeStateFile(ctx.sl.ownerFile(wave, cell));
  await writeCell(ctx.sl, wave, cell, { ...cellRow, state: "pending", epoch: owner.epoch, updated_at: nowIsoStr });
  await appendHistory(ctx, wave, cell, { ts: nowIsoStr, event: "release", actor, epoch: owner.epoch });
  await ctx.ledger.append("release", { wave, cell, actor, payload: { epoch: owner.epoch } });
  return { released: true };
}

// ------------------------------------------------------------------- requeue

/**
 * requeue(ctx, {wave, cell}) → cell
 * Administrative reset: failed → pending only. No lease may exist
 * (CELL-STATE otherwise). Epoch is preserved; the next claim takes epoch+1.
 */
async function requeueLocked(ctx, { wave, cell }) {
  const cellRow = await loadCellOrFail(ctx, wave, cell);
  if (cellRow.state !== "failed") {
    fail("CELL-STATE", `requeue requires state failed, found ${String(cellRow.state)}`, [
      violation("state", "cell-state", String(cellRow.state)),
    ]);
  }
  if (await fileExists(ctx.sl.ownerFile(wave, cell))) {
    fail("CELL-STATE", `requeue refused: lease exists on ${wave}/${cell}`, [
      violation("lease", "lease-exists", ctx.sl.ownerFile(wave, cell)),
    ]);
  }
  const nowIsoStr = nowIsoOf(ctx);
  await writeCell(ctx.sl, wave, cell, { ...cellRow, state: "pending", updated_at: nowIsoStr });
  await ctx.ledger.append("requeue", { wave, cell, actor: null, payload: { epoch: cellRow.epoch } });
  return { ...cellRow, state: "pending", updated_at: nowIsoStr };
}

// Per-cell serialization (E2E race defect class, T8 row 1): the lease
// check-to-write sequence must be atomic across processes, or two claims
// both pass the liveness check and race into owner.json (multi-winner +
// atomic-write read-back false alarms). Lock is held for the milliseconds
// of file work; contention past the wait deadline fails closed as
// LEASE-BUSY (retryable, exit 1).

// Wave/cell existence is proven BEFORE locking: acquiring the lock runs
// ensureDir, and letting it mint directories for unknown waves would flip
// WAVE-MISSING into CELL-MISSING inside claimLocked's checks.
async function requireWaveCell(ctx, wave, cell) {
  validateSafeId("wave", wave);
  validateSafeId("cell", cell);
  const fs = await import("node:fs/promises");
  try {
    await fs.stat(ctx.sl.metaFile(wave));
  } catch {
    // plan always writes meta.json; the cells-dir alternative keeps
    // hand-seeded wave fixtures working. Absent both = no wave.
    try {
      await fs.stat(ctx.sl.cellsDir(wave));
    } catch {
      fail("WAVE-MISSING", `no such wave: ${wave}`, [violation("wave", "wave-missing", wave)]);
    }
  }
  try {
    await fs.stat(ctx.sl.cellFile(wave, cell));
  } catch {
    fail("CELL-MISSING", `cell not found: ${wave}/${cell}`, [violation("cell", "cell-missing", `${wave}/${cell}`)]);
  }
}

async function withCellLock(ctx, wave, cell, fn) {
  await requireWaveCell(ctx, wave, cell);
  return withExclusiveLock(
    ctx.sl.leaseLock(wave, cell),
    { busyCode: "LEASE-BUSY", busyMessage: `lease mutation busy for ${wave}/${cell}` },
    fn,
  );
}

export async function claim(ctx, args) {
  return withCellLock(ctx, args.wave, args.cell, () => claimLocked(ctx, args));
}

export async function renew(ctx, args) {
  return withCellLock(ctx, args.wave, args.cell, () => renewLocked(ctx, args));
}

export async function release(ctx, args) {
  return withCellLock(ctx, args.wave, args.cell, () => releaseLocked(ctx, args));
}

export async function requeue(ctx, args) {
  return withCellLock(ctx, args.wave, args.cell, () => requeueLocked(ctx, args));
}
