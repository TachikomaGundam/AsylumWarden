// Append-only hash-chained ledger — CONTRACT §5. Never rewrites or truncates
// the ledger file. Appends are serialized through locks/ledger.lock (§5.3).
// Fail-closed throughout: a malformed line, broken chain, or unreadable
// corruption is reported, never papered over.

import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { fail, violation } from "../kernel/errors.mjs";
import { GENESIS_PREV, sha256Of } from "../kernel/canon.mjs";
import {
  CAP_CONFIG,
  CAP_LINE,
  ensureDir,
  fileExists,
  nowIso,
  pidAlive,
  readJsonCapped,
} from "../kernel/fsutil.mjs";
import { validateSchema } from "../kernel/schemalite.mjs";
import { HEX64_RE } from "../kernel/state.mjs";

export const LEDGER_TYPES = Object.freeze([
  "genesis",
  "plan",
  "claim",
  "renew",
  "release",
  "requeue",
  "steal",
  "done",
  "fail",
  "anchor",
]);

// Schema is read directly (kernel fsutil), NOT via src/config — the ledger
// layer must not depend on the config module (DESIGN-INTERNALS layering).
const SCHEMA_PATH = fileURLToPath(
  new URL("../../schemas/ledger.schema.json", import.meta.url),
);
// readJsonCapped deep-null-prototypes its result, which strips Array.prototype
// off schema arrays (`required`, `enum`) and breaks for...of/.some inside
// schemalite. Restore prototypes on the trusted build-time schema only; parsed
// ledger ENTRIES stay null-prototype (untrusted data, CONTRACT §1).
function plainify(node) {
  if (node === null || typeof node !== "object") return node;
  Object.setPrototypeOf(node, Array.isArray(node) ? Array.prototype : Object.prototype);
  for (const key of Object.getOwnPropertyNames(node)) node[key] = plainify(node[key]);
  return node;
}
let schemaPromise = null;
function ledgerSchema() {
  schemaPromise ??= readJsonCapped(SCHEMA_PATH, CAP_CONFIG, "INTERNAL").then(
    ({ value }) => plainify(value),
  );
  return schemaPromise;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

// Null-prototype parse with forbidden-key rejection (CONTRACT §1).
// Arrays keep Array.prototype: null-proto buys nothing on arrays (a JSON
// array cannot carry a "__proto__" key) and canon/for..of need .map/.length
// semantics — same invariant as kernel deepNullProto after the e2e fix.
function parseEntryLine(text) {
  return JSON.parse(text, (key, val) => {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`forbidden key "${key}"`);
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      Object.setPrototypeOf(val, null);
    }
    return val;
  });
}

// Entry hash per CONTRACT §5.1: sha256(canon(entry without `hash`)).
// canon sorts keys, so field insertion order is irrelevant.
function recomputeHash(entry) {
  const rec = { ...entry };
  const recorded = rec.hash;
  delete rec.hash;
  return { recorded, recomputed: sha256Of(rec) };
}

// Walk every line: parse, schema-validate, check seq/prev/hash and the
// genesis rule. Returns the internal record {entries, head, torn, chain_ok}.
//
// Torn semantics (§5.3, resolved by stricter reading):
// - last line unparseable (partial tail write) → torn reported; the prefix
//   chain is still verifiable, so chain_ok reflects the prefix. Any append
//   refuses on torn regardless (LEDGER-TORN, exit 2).
// - last line parses but fails schema/seq/prev/hash, or the file lacks a
//   trailing newline → torn reported AND chain_ok false (indistinguishable
//   from tamper; fail closed).
// - mid-file unparseable line → torn reported AND chain_ok false.
async function walkLedger(sl) {
  const result = { entries: [], head: null, torn: null, chain_ok: true };
  let text;
  try {
    text = await fs.readFile(sl.ledger, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return result; // absent ledger: empty walk
    fail("LEDGER-BROKEN", `cannot read ledger: ${err.message}`, [
      violation(sl.ledger, "read-error", err.message),
    ]);
  }
  if (text === "") return result;

  const rawLines = text.split("\n");
  let noTrailingNewline = false;
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop(); // single trailing newline is the writer's terminator
  } else {
    noTrailingNewline = true;
  }

  const schema = await ledgerSchema();
  let prevHash = GENESIS_PREV;
  for (let i = 0; i < rawLines.length; i += 1) {
    const n = i + 1;
    const line = rawLines[i];
    const isLast = i === rawLines.length - 1;

    if (Buffer.byteLength(line, "utf8") > CAP_LINE) {
      result.torn = { line: n, detail: "line exceeds 256 KiB cap" };
      result.chain_ok = false;
      break;
    }

    let entry;
    try {
      entry = parseEntryLine(line);
    } catch (err) {
      result.torn = { line: n, detail: `unparseable line: ${err.message}` };
      if (!isLast) result.chain_ok = false;
      break;
    }

    let breakDetail = null;
    const violations = validateSchema(schema, entry, `line ${n}`);
    if (violations.length > 0) {
      breakDetail = `schema violation: ${violations[0].field} ${violations[0].rule}: ${violations[0].detail}`;
    }
    if (breakDetail === null && entry.seq !== i + 1) {
      breakDetail = `seq ${String(entry.seq)} != expected ${String(i + 1)}`;
    }
    if (breakDetail === null && entry.prev !== prevHash) {
      breakDetail = `prev mismatch at seq ${String(entry.seq)}`;
    }
    if (breakDetail === null) {
      const { recorded, recomputed } = recomputeHash(entry);
      if (recorded !== recomputed) {
        breakDetail = `hash does not chain at seq ${String(entry.seq)}`;
      }
    }
    if (breakDetail === null && i === 0 && entry.type !== "genesis") {
      breakDetail = "first entry is not genesis";
    }
    // (genesis prev == GENESIS_PREV is covered by the prev check above:
    //  prevHash starts at GENESIS_PREV for i === 0.)

    if (breakDetail !== null) {
      result.chain_ok = false;
      if (isLast) result.torn = { line: n, detail: breakDetail };
    }
    result.entries.push(entry);
    result.head = typeof entry.hash === "string" ? entry.hash : result.head;
    // Continue the walk from the RECORDED hash so one break does not cascade
    // into false breaks on later lines; chain_ok is already false.
    prevHash = typeof entry.hash === "string" ? entry.hash : GENESIS_PREV;
  }

  if (noTrailingNewline && result.torn === null && rawLines.length > 0) {
    // Our writer always terminates lines with \n; a complete-looking final
    // line without the terminator means an interrupted write.
    result.torn = { line: rawLines.length, detail: "missing trailing newline" };
    result.chain_ok = false;
  }
  return result;
}

/**
 * Open the ledger API over a state layout (DESIGN-INTERNALS §src/ledger).
 * Optional overrides exist for tests (stale/busy windows, clock); defaults
 * are the CONTRACT §5.3 values.
 *
 * @param {object} opts
 * @param {object} opts.sl            state.layout() result
 * @param {object|null} [opts.config] project config (genesis fallback)
 * @param {() => string} [opts.nowFn] ISO clock override (must be RFC3339 ms UTC)
 * @param {number} [opts.staleAfterMs]     30_000 — dead-pid lock removable after
 * @param {number} [opts.busyAfterMs]      60_000 — live-holder lock fails after
 * @param {number} [opts.acquireDeadlineMs] 5_000 — contention wait cap, then LEDGER-BUSY
 * @param {number} [opts.pollMs]            5 — lock retry poll interval
 * @param {(msg:string)=>void|null} [opts.onWarning] stale-lock warning sink (CLI records as warning)
 */
export function openLedger({
  sl,
  config = null,
  nowFn = nowIso,
  staleAfterMs = 30_000,
  busyAfterMs = 60_000,
  acquireDeadlineMs = 5_000,
  pollMs = 5,
  onWarning = null,
} = {}) {
  if (
    !sl ||
    typeof sl.ledger !== "string" ||
    typeof sl.ledgerLock !== "string" ||
    typeof sl.locks !== "string"
  ) {
    fail("INTERNAL", "openLedger: sl must be a state.layout() object");
  }

  const now = () => nowFn();
  const nowMs = () => {
    const ms = Date.parse(nowFn());
    if (!Number.isFinite(ms)) fail("INTERNAL", `nowFn returned non-parseable time: ${nowFn()}`);
    return ms;
  };

  // ---- lock (CONTRACT §5.3) -------------------------------------------------

  async function inspectLock() {
    let text;
    let mtimeMs;
    try {
      text = (await fs.readFile(sl.ledgerLock)).toString("utf8");
      mtimeMs = (await fs.stat(sl.ledgerLock)).mtimeMs;
    } catch (err) {
      if (err?.code === "ENOENT") return { state: "gone" };
      return { state: "contended", detail: `lock unreadable: ${err.message}` };
    }
    const trimmed = text.trim();
    if (trimmed === "") {
      // Body is written immediately after O_EXCL create; an empty body is
      // either an in-progress acquire (grace window) or a holder that died
      // between create and write (beyond the busy window → stale).
      if (nowMs() - mtimeMs > busyAfterMs) {
        return { state: "stale", detail: "lock body empty beyond busy window" };
      }
      return { state: "contended", detail: "lock body not yet written" };
    }
    let body = null;
    try {
      body = JSON.parse(trimmed);
    } catch {
      body = null;
    }
    if (
      body === null ||
      typeof body !== "object" ||
      !Number.isInteger(body.pid) ||
      typeof body.ts !== "string"
    ) {
      // Unparseable non-empty body: never an in-progress create (that state
      // is empty). Older than the busy window → stale; else fail closed.
      const age = nowMs() - mtimeMs;
      if (age > busyAfterMs) {
        return { state: "stale", detail: "lock body unparseable beyond busy window" };
      }
      return { state: "busy", detail: "lock body unparseable" };
    }
    const tsMs = Date.parse(body.ts);
    const age = Number.isFinite(tsMs)
      ? Math.max(0, nowMs() - tsMs)
      : nowMs() - mtimeMs;
    const host = typeof body.host === "string" ? body.host : os.hostname();
    const alive = pidAlive(body.pid, host);
    if (!alive && age > staleAfterMs) {
      return { state: "stale", detail: `dead pid ${String(body.pid)}, age ${String(age)}ms` };
    }
    if (alive && age > busyAfterMs) {
      return { state: "busy", detail: `live pid ${String(body.pid)}, age ${String(age)}ms` };
    }
    return { state: "contended", detail: `held by pid ${String(body.pid)}` };
  }

  async function acquireLock() {
    await ensureDir(sl.locks);
    const deadline = nowMs() + acquireDeadlineMs;
    let staleRetried = false;
    for (;;) {
      const body = JSON.stringify({ pid: process.pid, host: os.hostname(), ts: now() });
      try {
        const fh = await fs.open(sl.ledgerLock, "wx", 0o600);
        try {
          await fh.writeFile(`${body}\n`, "utf8");
          await fh.sync();
        } finally {
          await fh.close();
        }
        return body;
      } catch (err) {
        if (err?.code !== "EEXIST") {
          fail("INTERNAL", `cannot create ledger lock: ${err.message}`);
        }
      }
      const info = await inspectLock();
      if (info.state === "stale") {
        // §5.3: remove once, retry once. A second stale verdict means the
        // rm/retry raced something pathological — fail closed, do not loop.
        if (staleRetried) {
          fail("LEDGER-BUSY", "stale ledger lock reappeared after retry", [
            violation(sl.ledgerLock, "lock-stale-retry", info.detail ?? ""),
          ]);
        }
        staleRetried = true;
        onWarning?.(`stale ledger lock removed (${info.detail})`);
        await fs.rm(sl.ledgerLock, { force: true });
        continue;
      }
      if (info.state === "busy") {
        fail("LEDGER-BUSY", `ledger lock held: ${info.detail ?? "busy"}`, [
          violation(sl.ledgerLock, "lock-busy", info.detail ?? ""),
        ]);
      }
      if (nowMs() >= deadline) {
        fail("LEDGER-BUSY", "ledger lock acquisition deadline exceeded", [
          violation(sl.ledgerLock, "lock-timeout", info.detail ?? ""),
        ]);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  // Best-effort release: only remove the lock if it is still OUR body, so a
  // zombie holder (its lock was stale-judged and replaced) cannot evict the
  // current legitimate holder.
  async function releaseLock(ours) {
    try {
      const cur = (await fs.readFile(sl.ledgerLock)).toString("utf8").trim();
      if (cur === ours.trim()) await fs.rm(sl.ledgerLock, { force: true });
    } catch {
      // Lock already gone or unreadable — nothing of ours to release.
    }
  }

  // ---- public API ------------------------------------------------------------

  /**
   * Append one entry. Shape validation happens BEFORE any disk touch; the
   * head is re-read under the lock (no cached head); a torn or broken chain
   * refuses the append (LEDGER-TORN / LEDGER-BROKEN, exit 2).
   */
  async function append(type, fields = {}) {
    if (!LEDGER_TYPES.includes(type)) {
      fail("INTERNAL", `unknown ledger entry type: ${String(type)}`);
    }
    const { wave = null, cell = null, actor = null, payload = {} } = fields;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      fail("INTERNAL", "ledger payload must be a plain object");
    }
    const ts = now();
    const schema = await ledgerSchema();
    const probe = { seq: 1, ts, type, wave, cell, actor, payload, prev: GENESIS_PREV, hash: GENESIS_PREV };
    const violations = validateSchema(schema, probe, "entry");
    if (violations.length > 0) {
      fail(
        "INTERNAL",
        `malformed ledger entry shape: ${violations[0].field} ${violations[0].rule}: ${violations[0].detail}`,
        violations,
      );
    }
    // Size pre-check on the probe (same ts/payload/wave/cell/actor and
    // 64-hex prev+hash as the real line; only seq width may differ by a few
    // bytes) so an oversized entry never touches disk. The exact check on the
    // final line below stays authoritative.
    const preBytes = Buffer.byteLength(JSON.stringify(probe), "utf8");
    if (preBytes > CAP_LINE) {
      fail("SCHEMA-VIOLATION", `ledger line exceeds ${String(CAP_LINE)} byte cap`, [
        violation("entry", "size-cap", `>=${String(preBytes)}`),
      ]);
    }

    const body = await acquireLock();
    try {
      const walk = await walkLedger(sl);
      if (walk.torn !== null) {
        fail("LEDGER-TORN", `refusing append after line ${String(walk.torn.line)}: ${walk.torn.detail}`, [
          violation(`ledger line ${String(walk.torn.line)}`, "torn", walk.torn.detail),
        ]);
      }
      if (!walk.chain_ok) {
        fail("LEDGER-BROKEN", "ledger chain invalid; refusing append");
      }
      const entry = {
        seq: walk.entries.length + 1,
        ts,
        type,
        wave,
        cell,
        actor,
        payload,
        prev: walk.head ?? GENESIS_PREV,
      };
      const hash = sha256Of(entry);
      const full = { ...entry, hash };
      const text = JSON.stringify(full);
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > CAP_LINE) {
        fail("SCHEMA-VIOLATION", `ledger line exceeds ${String(CAP_LINE)} byte cap`, [
          violation("entry", "size-cap", String(bytes)),
        ]);
      }
      const fh = await fs.open(sl.ledger, "a", 0o600);
      try {
        await fh.writeFile(`${text}\n`, "utf8");
        await fh.sync();
      } finally {
        await fh.close();
      }
      return full;
    } finally {
      await releaseLock(body);
    }
  }

  async function readAll() {
    const walk = await walkLedger(sl);
    return { entries: walk.entries, head: walk.head, torn: walk.torn };
  }

  async function verify() {
    const walk = await walkLedger(sl);
    return {
      chain_ok: walk.chain_ok,
      entries: walk.entries,
      head: walk.head,
      torn: walk.torn,
    };
  }

  /**
   * Write the genesis entry when the ledger is absent (or a zero-entry file).
   * Idempotent no-op when entries already exist. registry_sha256 prefers
   * ctx.registrySha256 (config loader output) and falls back to the config's
   * own `registry_sha256` key (CONTRACT §2.1); config_sha256 must come from
   * ctx.configSha256 — the config file never carries its own hash.
   */
  async function appendGenesisIfAbsent(ctx = {}) {
    if (ctx.sl && ctx.sl.ledger !== sl.ledger) {
      fail("INTERNAL", "appendGenesisIfAbsent: ctx.sl points at a different state home");
    }
    if (await fileExists(sl.ledger)) {
      const walk = await walkLedger(sl);
      if (walk.entries.length > 0) {
        return { created: false, head: walk.head };
      }
    }
    const cfg = ctx.config ?? config;
    const registrySha = ctx.registrySha256 ?? cfg?.registry_sha256 ?? null;
    const configSha = ctx.configSha256 ?? null;
    if (typeof registrySha !== "string" || !HEX64_RE.test(registrySha)) {
      fail("INTERNAL", "appendGenesisIfAbsent: registry sha256 missing or not 64hex (ctx.registrySha256 / config.registry_sha256)");
    }
    if (typeof configSha !== "string" || !HEX64_RE.test(configSha)) {
      fail("INTERNAL", "appendGenesisIfAbsent: ctx.configSha256 missing or not 64hex");
    }
    const entry = await append("genesis", {
      payload: { registry_sha256: registrySha, config_sha256: configSha },
    });
    return { created: true, entry };
  }

  return { append, readAll, verify, appendGenesisIfAbsent };
}
