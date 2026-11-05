// Receipt validation + done/fail placement — CONTRACT §7, DESIGN-INTERNALS
// §src/receipt.
//
// Module law (pinned):
// - Validation order is CONTRACT §7 EXACT: lease(actor→epoch) → receipt read
//   (1 MiB cap, SCHEMA-VIOLATION) → schemalite → cell-id → commands →
//   artifacts → reads → shadow extras → COMMIT. Any validation failure
//   throws WardenError with ZERO state mutation.
// - The stored receipt FILE preserves the caller's exact bytes (evidence
//   artifact): writeRawAtomic below is the kernel atomic-write pattern
//   (tmp+fsync+rename+read-back) applied to raw bytes.
// - No lateral imports: this module re-implements its own lease loader
//   rather than importing src/lease (layering rule).
// - Modules append only SUCCESS events; CLI appends rejected attempts.
// - ctx.nowFn() is the only clock source (tests inject).

import fs from "node:fs/promises";
import path from "node:path";

import { fail, violation } from "../kernel/errors.mjs";
import { sha256File, sha256Hex } from "../kernel/canon.mjs";
import { CAP_CONFIG, fileExists, nowIso, readJsonCapped } from "../kernel/fsutil.mjs";
import { readCell, writeCell, HEX64_RE, SAFE_ID_RE } from "../kernel/state.mjs";
import { withExclusiveLock } from "../kernel/lock.mjs";
import { validateSchema } from "../kernel/schemalite.mjs";

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

function isIsoString(value) {
  return typeof value === "string" && ISO_RE.test(value) && Number.isFinite(Date.parse(value));
}

function validateLeaseShape(owner, filePath) {
  if (owner === null || typeof owner !== "object" || Array.isArray(owner)) {
    fail("STATE-CORRUPT", `lease is not an object: ${filePath}`);
  }
  for (const key of Object.getOwnPropertyNames(owner)) {
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
  if (typeof owner.actor !== "string" || owner.actor.length === 0) fail("STATE-CORRUPT", `lease actor invalid: ${filePath}`);
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) fail("STATE-CORRUPT", `lease pid invalid: ${filePath}`);
  if (typeof owner.host !== "string" || owner.host.length === 0) fail("STATE-CORRUPT", `lease host invalid: ${filePath}`);
  if (!Number.isInteger(owner.epoch) || owner.epoch < 1) fail("STATE-CORRUPT", `lease epoch invalid: ${filePath}`);
  if (!Number.isInteger(owner.ttl_seconds) || owner.ttl_seconds < 30 || owner.ttl_seconds > 86400) {
    fail("STATE-CORRUPT", `lease ttl_seconds invalid: ${filePath}`);
  }
  for (const key of ["acquired_at", "heartbeat_at", "expires_at", "max_hold_until"]) {
    if (!isIsoString(owner[key])) fail("STATE-CORRUPT", `lease ${key} is not RFC3339: ${filePath}`);
  }
}

function validateSafeId(name, value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    fail("USAGE", `${name} must be a SafeId, got ${String(value)}`, [violation(name, "safe-id", String(value))]);
  }
}

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
      fail("CELL-MISSING", `cell not found: ${wave}/${cell}`, [violation("cell", "cell-missing", `${wave}/${cell}`)]);
    }
    throw error;
  }
}

// §7 step 1 authority: the live lease. Lease absent is a business reject
// (CELL-STATE, exit 1) — the terminal path of the §6 protocol (release first)
// is a retryable caller mistake. The deeper broken invariant "cell claimed
// but no lease file" stays fail-closed as STATE-CORRUPT.
async function loadLeaseForDone(ctx, wave, cell, cellRow) {
  const filePath = ctx.sl.ownerFile(wave, cell);
  let owner;
  try {
    ({ value: owner } = await readJsonCapped(filePath, undefined, "STATE-CORRUPT"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      if (cellRow.state === "claimed") {
        fail("STATE-CORRUPT", `cell ${wave}/${cell} is claimed but owner.json is missing`, [
          violation("lease", "claimed-without-lease", ctx.sl.cellFile(wave, cell)),
        ]);
      }
      fail("CELL-STATE", `no live lease for done on ${wave}/${cell}`, [violation("lease", "no-lease", "absent")]);
    }
    throw error;
  }
  validateLeaseShape(owner, filePath);
  return owner;
}

function checkLeaseIdentity(owner, actor, epoch) {
  if (owner.actor !== actor) {
    fail("ACTOR-MISMATCH", `lease held by ${owner.actor}, done attempted as ${actor}`, [
      violation("actor", "actor-mismatch", owner.actor),
    ]);
  }
  if (owner.epoch !== epoch) {
    fail("EPOCH-MISMATCH", `lease epoch is ${owner.epoch}, done attempted with ${epoch}`, [
      violation("epoch", "epoch-mismatch", String(owner.epoch)),
    ]);
  }
}

// path.relative based containment (realpath'd inputs; no trailing-slash trap).
function isInside(root, abs) {
  const rel = path.relative(root, abs);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Receipt-provided paths must already be absolute and normalized (CONTRACT
// §1: the loader rejects non-normalized input; no ".." segments).
function assertNormalizedAbs(raw, code, what) {
  if (typeof raw !== "string" || !raw.startsWith("/")) {
    fail(code, `${what} must be an absolute path: ${String(raw)}`, [violation(what, "abs-path", String(raw))]);
  }
  if (path.posix.normalize(raw) !== raw) {
    fail(code, `${what} is not a normalized absolute path: ${raw}`, [violation(what, "normalized", raw)]);
  }
}

// Receipt schema is pinned in DESIGN-INTERNALS as loaded via import.meta.url;
// src/config/schemas.mjs is the integration loader, but lateral/upward
// imports are banned for this module, so it loads its own cached copy.
// Plain JSON.parse (NOT readJsonCapped): readJsonCapped null-prototypes every
// array, and kernel schemalite iterates SCHEMA keyword arrays (allOf/anyOf/
// required) with for...of, which requires Array.prototype. The VALUE side is
// iterated by index only, so the null-proto receipt value stays compatible.
// The schema file is this repo's own trusted artifact; size cap + parse still
// fail closed with INTERNAL.
let receiptSchemaCache = null;
async function loadReceiptSchema() {
  if (receiptSchemaCache !== null) return receiptSchemaCache;
  const schemaPath = path.resolve(import.meta.dirname, "..", "..", "schemas", "receipt.schema.json");
  let raw;
  try {
    raw = await fs.readFile(schemaPath);
  } catch (error) {
    fail("INTERNAL", `cannot read receipt schema ${schemaPath}: ${error.message}`);
  }
  if (raw.length > CAP_CONFIG) {
    fail("INTERNAL", `receipt schema exceeds ${CAP_CONFIG} byte cap`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    fail("INTERNAL", `receipt schema is unparseable JSON: ${schemaPath}`);
  }
  receiptSchemaCache = parsed;
  return receiptSchemaCache;
}

// Atomic raw-byte write mirroring kernel atomicWriteJson (tmp same-dir → full
// write → fsync → rename → read-back) but preserving the caller's exact
// bytes: the receipt file IS the evidence artifact, not a re-serialization.
async function writeRawAtomic(filePath, bytes) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`);
  let handle;
  try {
    handle = await fs.open(tmp, "w", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close();
  }
  try {
    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    fail("INTERNAL", `atomic rename failed for ${filePath}: ${error.message}`);
  }
  const back = await fs.readFile(filePath);
  if (!back.equals(Buffer.from(bytes))) {
    fail("INTERNAL", `atomic write read-back mismatch: ${filePath}`);
  }
}

// Validate artifact/claim hash etc. AFTER all containment checks pass.
async function validateArtifacts(ctx, receipt, cellRow) {
  // Kernel null-prototype note: readJsonCapped arrays have no
  // Symbol.iterator — iterate disk-read arrays by index only.
  const artifacts = Array.isArray(receipt.artifacts) ? receipt.artifacts : [];
  const reals = [];
  for (let i = 0; i < artifacts.length; i += 1) {
    const artifact = artifacts[i];
    const artifactPath = artifact.path;
    assertNormalizedAbs(artifactPath, "PATH-ESCAPE", "artifact.path");
    let stat;
    try {
      stat = await fs.lstat(artifactPath);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        // Pinned choice: a nonexistent artifact is RECEIPT-HASH (exit 1,
        // business) with detail "missing" — the claimed hash cannot exist.
        // PATH-ESCAPE is reserved for containment failures.
        fail("RECEIPT-HASH", `artifact missing: ${artifactPath}`, [
          violation(artifactPath, "artifact-missing", "missing"),
        ]);
      }
      // Unverifiable containment fails closed on the containment code.
      fail("PATH-ESCAPE", `cannot lstat artifact ${artifactPath}: ${error.message}`, [
        violation(artifactPath, "artifact-lstat", error.message),
      ]);
    }
    if (stat.isSymbolicLink()) {
      fail("PATH-ESCAPE", `artifact is a symlink: ${artifactPath}`, [
        violation(artifactPath, "artifact-symlink", "lstat"),
      ]);
    }
    if (!stat.isFile()) {
      fail("PATH-ESCAPE", `artifact is not a regular file: ${artifactPath}`, [
        violation(artifactPath, "artifact-not-file", "lstat"),
      ]);
    }
    let real;
    try {
      real = await fs.realpath(artifactPath);
    } catch (error) {
      fail("PATH-ESCAPE", `cannot resolve artifact ${artifactPath}: ${error.message}`, [
        violation(artifactPath, "artifact-realpath", error.message),
      ]);
    }
    // Catches a symlink swap between lstat and realpath (TOCTOU guard).
    if (real !== artifactPath) {
      fail("PATH-ESCAPE", `artifact realpath differs from claimed path: ${artifactPath} -> ${real}`, [
        violation(artifactPath, "artifact-swap", real),
      ]);
    }
    // policy.artifactOk throws FORBIDDEN-SURFACE (forbidden hit first, per
    // pinned artifactOk semantics) or PATH-ESCAPE (outside allowed_roots).
    // Real policy impls are async (realpath inside); await so the
    // rejection propagates instead of floating as a rejected promise.
    await ctx.policy.artifactOk(real, cellRow);
    const actual = await sha256File(real);
    if (actual !== artifact.sha256) {
      fail("RECEIPT-HASH", `artifact hash mismatch: ${artifactPath}`, [
        violation(artifactPath, "hash-mismatch", `claimed ${artifact.sha256}, actual ${actual}`),
      ]);
    }
    reals.push(real);
  }
  return reals;
}

async function validateReads(ctx, receipt, cellRow) {
  const reads = Array.isArray(receipt.reads) ? receipt.reads : [];
  const lineName = typeof cellRow.line === "string" ? cellRow.line : "";
  for (let i = 0; i < reads.length; i += 1) {
    const readPath = reads[i];
    assertNormalizedAbs(readPath, "READ-OUTSIDE", "reads[]");
    let real;
    try {
      real = await fs.realpath(readPath);
    } catch {
      // §7 step 6: every reads[] path must exist; absent is out-of-bounds.
      fail("READ-OUTSIDE", `read path missing or unresolvable: ${readPath}`, [
        violation(readPath, "read-missing", "absent"),
      ]);
    }
    if (real !== readPath) {
      fail("READ-OUTSIDE", `read realpath differs from claimed path: ${readPath} -> ${real}`, [
        violation(readPath, "read-swap", real),
      ]);
    }
    if ((await ctx.policy.readOk(real, cellRow, lineName)) !== true) {
      fail("READ-OUTSIDE", `read path outside allowed union: ${real}`, [
        violation(readPath, "read-outside", real),
      ]);
    }
  }
}

// CONTRACT §10 shadow extras, run after the §7 core pass. Wave prefix and
// receipt shape are shape violations (SCHEMA-VIOLATION, exit 2); an artifact
// outside shadow_home is a containment failure (PATH-ESCAPE, exit 2).
function validateShadow(ctx, receipt, wave, artifactReals) {
  if (ctx.mode !== "shadow") return;
  if (receipt.mode !== "shadow" || !HEX64_RE.test(String(receipt.shadow_of ?? ""))) {
    fail("SCHEMA-VIOLATION", "shadow receipt must carry mode=\"shadow\" and a 64hex shadow_of", [
      violation("shadow_of", "shadow-shape", String(receipt.shadow_of)),
    ]);
  }
  if (!wave.startsWith("shadow-")) {
    fail("SCHEMA-VIOLATION", `shadow wave id must start with "shadow-", got ${wave}`, [
      violation("wave", "shadow-prefix", wave),
    ]);
  }
  const shadowHome = ctx.config?.shadow_home;
  assertNormalizedAbs(shadowHome, "PATH-ESCAPE", "config.shadow_home");
  for (const real of artifactReals) {
    if (!isInside(shadowHome, real)) {
      fail("PATH-ESCAPE", `shadow artifact outside shadow_home ${shadowHome}: ${real}`, [
        violation(real, "shadow-home-containment", shadowHome),
      ]);
    }
  }
}

// Normal-mode receipts must not carry shadow keys (CONTRACT §7: "No other
// keys, except in shadow mode..."). The schema's shadow branch is
// mode-agnostic, so the context check lives here.
function checkShadowKeyPurity(ctx, receipt) {
  if (ctx.mode === "shadow") return;
  if (Object.hasOwn(receipt, "mode") || Object.hasOwn(receipt, "shadow_of")) {
    fail("SCHEMA-VIOLATION", "normal-mode receipt must not carry mode/shadow_of", [
      violation("mode", "shadow-keys-in-normal-mode", "forbidden"),
    ]);
  }
}

/**
 * doneWithReceipt(ctx, {wave, cell, actor, epoch, receiptPath}) → {file, sha256}
 * CONTRACT §7 exact order; zero mutation on any rejection.
 */
async function doneLocked(ctx, { wave, cell, actor, epoch, receiptPath }) {
  if (typeof actor !== "string" || actor.length === 0) fail("USAGE", "done requires a non-empty actor");
  const cellRow = await loadCellOrFail(ctx, wave, cell);

  // §7 step 1 — lease identity (actor before epoch, pinned).
  const owner = await loadLeaseForDone(ctx, wave, cell, cellRow);
  checkLeaseIdentity(owner, actor, epoch);

  // §7 receipt read: 1 MiB cap, SCHEMA-VIOLATION family; ENOENT is mapped
  // into the same code family (a caller mistake, exit 2 by the receipt code
  // table since the file content cannot be repaired by waiting).
  let parsed;
  try {
    ({ value: parsed } = await readJsonCapped(receiptPath, CAP_CONFIG, "SCHEMA-VIOLATION"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      fail("SCHEMA-VIOLATION", `receipt file missing: ${String(receiptPath)}`, [
        violation("receipt", "receipt-missing", String(receiptPath)),
      ]);
    }
    throw error;
  }

  // schemalite (unknown keys rejected — schema additionalProperties:false).
  const schema = await loadReceiptSchema();
  const violations = validateSchema(schema, parsed);
  if (violations.length > 0) {
    fail("SCHEMA-VIOLATION", `receipt violates receipt.schema.json: ${violations[0].field}: ${violations[0].rule}`, violations);
  }

  // §7 step 3 — cell id must match the target (contract pins SCHEMA-VIOLATION
  // for this bullet).
  if (parsed.cell !== cell) {
    fail("SCHEMA-VIOLATION", `receipt cell ${String(parsed.cell)} does not match target ${cell}`, [
      violation("cell", "cell-match", String(parsed.cell)),
    ]);
  }
  checkShadowKeyPurity(ctx, parsed);

  // §7 step 2 — status done requires every command exit 0. (Order within the
  // §7 numbering: commands before artifacts/reads, after shape/cell match.)
  const commands = Array.isArray(parsed.commands) ? parsed.commands : [];
  if (parsed.status === "done") {
    for (let i = 0; i < commands.length; i += 1) {
      const command = commands[i];
      if (command.exit !== 0) {
        fail("RECEIPT-COMMANDS", `receipt status done but command exited ${command.exit}: ${command.cmd}`, [
          violation("commands", "command-exit", String(command.exit)),
        ]);
      }
    }
  }

  // §7 steps 4+5 — artifacts: containment (lstat/realpath/policy) first, then
  // the hash recompute, for every artifact, before any read-path work.
  const artifactReals = await validateArtifacts(ctx, parsed, cellRow);

  // §7 step 6 — reads.
  await validateReads(ctx, parsed, cellRow);

  // §10 shadow extras.
  validateShadow(ctx, parsed, wave, artifactReals);

  // ---- COMMIT (all validation above passed; nothing mutated until here) ----
  // Receipt FILE stores exactly the caller's bytes (evidence artifact). The
  // stored sha256 and ledger receipt_sha256 are of these file bytes. Accepted
  // time-of-validation window: §7 proves "content-at-time", the source file
  // is caller-owned.
  const rawBytes = await fs.readFile(receiptPath);
  const stored = ctx.sl.receiptFile(wave, cell);
  await writeRawAtomic(stored, rawBytes);
  const receiptSha = sha256Hex(rawBytes);

  const nowIsoStr = nowIsoOf(ctx);
  const finalState = parsed.status === "done" ? "done" : "failed";
  await writeCell(ctx.sl, wave, cell, { ...cellRow, state: finalState, updated_at: nowIsoStr });
  // Finishing consumes the lease (CONTRACT §6/§7): a cell that is not
  // claimed must not carry a lease, or requeue-after-fail would deadlock.
  await fs.rm(ctx.sl.ownerFile(wave, cell), { force: true });
  await ctx.ledger.append(finalState === "done" ? "done" : "fail", {
    wave,
    cell,
    actor,
    payload: { receipt_sha256: receiptSha, status: parsed.status },
  });
  return { file: stored, sha256: receiptSha };
}

/**
 * failCell(ctx, {wave, cell, actor, epoch, reason}) → {file, sha256}
 * Synthesizes a failed receipt and lands the cell failed. Same lease
 * identity law as done; input validated before any mutation.
 */
async function failCellLocked(ctx, { wave, cell, actor, epoch, reason }) {
  if (typeof actor !== "string" || actor.length === 0) fail("USAGE", "fail requires a non-empty actor");
  if (typeof reason !== "string" || reason.length === 0) {
    fail("USAGE", "fail requires a non-empty --reason", [violation("reason", "usage", "empty")]);
  }
  if (reason.length > 4096) {
    fail("USAGE", `reason exceeds 4096-char string cap (${reason.length})`, [
      violation("reason", "string-cap", String(reason.length)),
    ]);
  }
  const cellRow = await loadCellOrFail(ctx, wave, cell);
  const owner = await loadLeaseForDone(ctx, wave, cell, cellRow);
  checkLeaseIdentity(owner, actor, epoch);

  const receipt = {
    version: 1,
    cell,
    actor,
    epoch: owner.epoch,
    status: "failed",
    summary: reason,
    commands: [],
    artifacts: [],
    reads: [],
  };
  if (ctx.mode === "shadow") {
    receipt.mode = "shadow";
    receipt.shadow_of = ctx.config?.shadow_of;
    if (typeof receipt.shadow_of !== "string" || !HEX64_RE.test(receipt.shadow_of)) {
      // Config shape problem (exit-2 family), caught before any mutation.
      fail("SCHEMA-VIOLATION", "shadow config lacks a 64hex shadow_of", [
        violation("shadow_of", "config-shadow", String(receipt.shadow_of)),
      ]);
    }
  }

  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  const stored = ctx.sl.receiptFile(wave, cell);
  await writeRawAtomic(stored, bytes);
  const receiptSha = sha256Hex(bytes);

  const nowIsoStr = nowIsoOf(ctx);
  await writeCell(ctx.sl, wave, cell, { ...cellRow, state: "failed", updated_at: nowIsoStr });
  // Finishing consumes the lease (see doneWithReceipt).
  await fs.rm(ctx.sl.ownerFile(wave, cell), { force: true });
  await ctx.ledger.append("fail", {
    wave,
    cell,
    actor,
    payload: { reason, receipt_sha256: receiptSha, status: "failed" },
  });
  return { file: stored, sha256: receiptSha };
}

// Validation + commit run inside the per-cell lease lock (same critical
// section as claim/renew/release): lease identity checks, state flip, and
// owner removal must be atomic against a concurrent steal/reclaim, and a
// validation pass must not be based on a lease that vanished mid-check.

// Wave/cell existence is proven BEFORE locking: acquiring the lock runs
// ensureDir, and letting it mint directories for unknown waves would flip
// WAVE-MISSING into CELL-MISSING inside claimLocked's checks.
async function requireWaveCell(ctx, wave, cell) {
  for (const [name, value] of [["wave", wave], ["cell", cell]]) {
    if (typeof value !== "string" || !SAFE_ID_RE.test(value)) {
      fail("USAGE", `${name} must be a safe id: ${String(value)}`, [
        violation(name, "safe-id", String(value)),
      ]);
    }
  }
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

export async function doneWithReceipt(ctx, args) {
  return withCellLock(ctx, args.wave, args.cell, () => doneLocked(ctx, args));
}

export async function failCell(ctx, args) {
  return withCellLock(ctx, args.wave, args.cell, () => failCellLocked(ctx, args));
}
