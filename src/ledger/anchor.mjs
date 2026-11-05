// External anchoring — CONTRACT §2.3 + §5.4, DESIGN-INTERNALS §src/ledger.
// All push failures are RETURNED as {ok:false,error}, never thrown. The only
// throw is initAnchor's ANCHOR-FAIL (a named fail-closed outcome per §5.4).

import { spawn } from "node:child_process";
import fs from "node:fs/promises";

import { fail } from "../kernel/errors.mjs";
import { nowIso } from "../kernel/fsutil.mjs";
import { readStateJson, writeStateJson } from "../kernel/state.mjs";

const DEFAULT_ANCHOR_TIMEOUT_MS = 10_000;
const DEFAULT_ANCHOR_INTERVAL_MS = 600_000; // §5.4: 600 s
const DEFAULT_ANCHOR_SEQ_DELTA = 50; // §5.4: 50 entries
const EXTERNAL_TYPES = new Set(["command", "remote", "human-checkpoint"]);

// audit_closure by configured anchor type (CONTRACT §9). "file" is a local
// checkpoint — mechanically allowed, never external (§2.3). Staleness is a
// separate field; the CLI maps stale && external to ANCHOR-STALE.
export function closureForAnchor(anchor) {
  if (anchor === null || anchor === undefined) return "none";
  if (anchor.type === "file") return "local";
  if (EXTERNAL_TYPES.has(anchor.type)) return "external";
  return "none";
}

function summarize(target) {
  const s = String(target);
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

function anchorLine(headEntry) {
  return JSON.stringify({
    head_seq: headEntry.seq,
    head_hash: headEntry.hash,
    chain_head_ts: headEntry.ts,
  });
}

// target: shell-quoted string, or a JSON array of argv strings. Tokenization
// is quote-aware (single/double); no expansions — spawn runs with shell:false.
function splitCommand(target) {
  const raw = String(target);
  if (raw.startsWith("[")) {
    let argv;
    try {
      argv = JSON.parse(raw);
    } catch {
      throw new Error("command target looks like a JSON array but does not parse");
    }
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      !argv.every((a) => typeof a === "string" && a.length > 0)
    ) {
      throw new Error("command target JSON array must be a non-empty array of non-empty strings");
    }
    return argv;
  }
  const argv = [];
  let cur = "";
  let quote = null;
  let started = false;
  for (const ch of raw) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) {
        argv.push(cur);
        cur = "";
        started = false;
      }
    } else {
      cur += ch;
      started = true;
    }
  }
  if (quote !== null) throw new Error("command target has an unterminated quote");
  if (started) argv.push(cur);
  if (argv.length === 0) throw new Error("command target is empty");
  return argv;
}

function pushCommand(target, line, timeoutMs) {
  return new Promise((resolve) => {
    let argv;
    try {
      argv = splitCommand(target);
    } catch (err) {
      resolve({ ok: false, error: `invalid command target: ${err.message}` });
      return;
    }
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
      });
    } catch (err) {
      resolve({ ok: false, error: `spawn failed: ${err.message}` });
      return;
    }
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      done({ ok: false, error: "timeout" });
    }, timeoutMs);
    child.stdin.on("error", () => {
      /* EPIPE when the target exits before reading stdin */
    });
    child.stdin.write(`${line}\n`, "utf8");
    child.stdin.end();
    child.on("error", (err) => done({ ok: false, error: `spawn failed: ${err.message}` }));
    child.on("close", (code) => {
      if (code === 0) done({ ok: true });
      else done({ ok: false, error: `exit ${String(code)}` });
    });
  });
}

async function pushRemote(target, line, timeoutMs) {
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: line,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, error: `http ${String(res.status)}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `fetch failed: ${err.message}` };
  }
}

async function pushFile(target, line) {
  let fh;
  try {
    fh = await fs.open(target, "a", 0o600);
    await fh.writeFile(`${line}\n`, "utf8");
    await fh.sync();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `file anchor write failed: ${err.message}` };
  } finally {
    await fh?.close();
  }
}

async function pushHumanCheckpoint(target, headHash) {
  let text;
  try {
    text = await fs.readFile(target, "utf8");
  } catch (err) {
    return { ok: false, error: `checkpoint file unreadable: ${err.message}` };
  }
  const signed = text.split("\n").some((l) => l.includes(headHash));
  if (!signed) {
    return { ok: false, error: "checkpoint record does not contain the chain head hash" };
  }
  return { ok: true };
}

/**
 * Push the current head to the configured anchor. Failures are returned,
 * never thrown. ctx.config.anchor drives type selection.
 */
export async function pushAnchor(ctx, headEntry) {
  try {
    const anchor = ctx.config?.anchor ?? null;
    if (anchor === null || anchor === undefined) {
      return { ok: false, error: "anchor not configured" };
    }
    if (
      headEntry === null ||
      headEntry === undefined ||
      typeof headEntry.hash !== "string" ||
      !Number.isInteger(headEntry.seq)
    ) {
      return { ok: false, error: "no head entry to anchor" };
    }
    const timeoutMs = ctx.anchorTimeoutMs ?? DEFAULT_ANCHOR_TIMEOUT_MS;
    const line = anchorLine(headEntry);
    switch (anchor.type) {
      case "command":
        return await pushCommand(anchor.target, line, timeoutMs);
      case "remote":
        return await pushRemote(anchor.target, line, timeoutMs);
      case "file":
        return await pushFile(anchor.target, line);
      case "human-checkpoint":
        return await pushHumanCheckpoint(anchor.target, headEntry.hash);
      default:
        return { ok: false, error: `unknown anchor type: ${String(anchor.type)}` };
    }
  } catch (err) {
    return { ok: false, error: `anchor push error: ${err?.message ?? String(err)}` };
  }
}

async function readAnchorState(sl) {
  try {
    const value = await readStateJson(sl.anchorState);
    if (value === null || typeof value !== "object") return null;
    return { ...value }; // plain proto for mutation + rewrite
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err; // STATE-CORRUPT etc. stays fail-closed
  }
}

function staleOf(headEntry, state) {
  if (headEntry === null) return false;
  const lastSeq = state?.last_anchor_seq ?? null;
  if (lastSeq === null || lastSeq === undefined) return true; // entries exist, nothing anchored
  return headEntry.seq > lastSeq;
}

async function headEntryOf(ctx) {
  const { entries } = await ctx.ledger.readAll();
  return entries.length > 0 ? entries[entries.length - 1] : null;
}

/**
 * init-time anchor (after the genesis entry exists). anchor null → record a
 * fresh anchor-state with audit_closure "none". Otherwise push the genesis
 * head; a failed push fails init with ANCHOR-FAIL and leaves state
 * unmodified (§5.4): if the ledger holds only the genesis entry just written
 * and no anchor-state exists yet, the genesis file is removed — the
 * rollback choice documented in DESIGN-INTERNALS.
 */
export async function initAnchor(ctx) {
  const sl = ctx.sl;
  const anchor = ctx.config?.anchor ?? null;
  if (anchor === null || anchor === undefined) {
    await writeStateJson(sl.anchorState, {
      last_anchor_ts: null,
      last_anchor_seq: null,
      last_anchor_hash: null,
      failures: 0,
      audit_closure: "none",
    });
    return { ok: true, closure: "none" };
  }
  const headEntry = await headEntryOf(ctx);
  if (headEntry === null) {
    fail("INTERNAL", "initAnchor: no ledger entries (genesis not written yet)");
  }
  const result = await pushAnchor(ctx, headEntry);
  if (!result.ok) {
    await rollbackGenesisIfSole(ctx, headEntry);
    fail("ANCHOR-FAIL", `anchor push failed at init: ${result.error}`);
  }
  const closure = closureForAnchor(anchor);
  const entry = await ctx.ledger.append("anchor", {
    payload: {
      anchor_type: anchor.type,
      target_summary: summarize(anchor.target),
      head_seq: headEntry.seq,
      head_hash: headEntry.hash,
      ok: true,
    },
  });
  await writeStateJson(sl.anchorState, {
    last_anchor_ts: entry.ts,
    last_anchor_seq: entry.seq,
    last_anchor_hash: headEntry.hash,
    failures: 0,
    audit_closure: closure,
  });
  return { ok: true, closure, entry };
}

async function rollbackGenesisIfSole(ctx, headEntry) {
  try {
    if (headEntry.seq !== 1 || headEntry.type !== "genesis") return;
    if (await fileExistsAsync(ctx.sl.anchorState)) return;
    const { entries, torn } = await ctx.ledger.readAll();
    if (entries.length === 1 && entries[0].hash === headEntry.hash && torn === null) {
      await fs.rm(ctx.sl.ledger, { force: true });
    }
  } catch {
    // Rollback is best-effort; the ANCHOR-FAIL throw still stands.
  }
}

async function fileExistsAsync(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Per-invocation anchor trigger check (§5.4, no timers). Pushes when due:
 * never anchored, or now - last_anchor_ts > interval, or head seq delta
 * since the last anchor >= threshold. On success appends the `anchor` entry
 * (which lands AFTER the anchored window — documented limitation) and
 * updates anchor-state; on failure increments failures and reports
 * degraded: "ANCHOR-DEGRADED".
 */
export async function maybeAnchor(ctx) {
  const sl = ctx.sl;
  const anchor = ctx.config?.anchor ?? null;
  const closure = closureForAnchor(anchor);
  if (anchor === null || anchor === undefined) {
    return { degraded: null, closure };
  }
  const state = await readAnchorState(sl);
  const headEntry = await headEntryOf(ctx);
  if (headEntry === null) {
    return { degraded: null, closure, stale: false };
  }
  const nowFn = ctx.nowFn ?? nowIso;
  const intervalMs = ctx.anchorIntervalMs ?? DEFAULT_ANCHOR_INTERVAL_MS;
  const seqDelta = ctx.anchorSeqDelta ?? DEFAULT_ANCHOR_SEQ_DELTA;
  const lastTs = state?.last_anchor_ts ?? null;
  const nowMs = Date.parse(nowFn());
  const lastMs = lastTs === null ? null : Date.parse(lastTs);
  const due =
    lastMs === null ||
    !Number.isFinite(lastMs) ||
    nowMs - lastMs > intervalMs ||
    headEntry.seq - (state?.last_anchor_seq ?? 0) >= seqDelta;
  if (!due) {
    return { degraded: null, closure, stale: staleOf(headEntry, state) };
  }
  const result = await pushAnchor(ctx, headEntry);
  if (result.ok) {
    const entry = await ctx.ledger.append("anchor", {
      payload: {
        anchor_type: anchor.type,
        target_summary: summarize(anchor.target),
        head_seq: headEntry.seq,
        head_hash: headEntry.hash,
        ok: true,
      },
    });
    await writeStateJson(sl.anchorState, {
      last_anchor_ts: entry.ts,
      last_anchor_seq: entry.seq,
      last_anchor_hash: headEntry.hash,
      failures: state?.failures ?? 0,
      audit_closure: closure,
    });
    return { degraded: null, closure, stale: false };
  }
  await writeStateJson(sl.anchorState, {
    last_anchor_ts: lastTs,
    last_anchor_seq: state?.last_anchor_seq ?? null,
    last_anchor_hash: state?.last_anchor_hash ?? null,
    failures: (state?.failures ?? 0) + 1,
    audit_closure: closure,
  });
  return { degraded: "ANCHOR-DEGRADED", closure, error: result.error, stale: staleOf(headEntry, state) };
}

/**
 * Anchor verdict fields for `verify` (CONTRACT §9): closure by configured
 * type, last anchored position, staleness. CLI maps stale && external →
 * ANCHOR-STALE (exit 2) and none/absent-state to release-gate failure — not
 * this layer's job.
 */
export async function anchorSummary(ctx) {
  const anchor = ctx.config?.anchor ?? null;
  const closure = closureForAnchor(anchor);
  if (anchor === null || anchor === undefined) {
    const headEntry = await headEntryOf(ctx);
    return { closure: "none", last_ts: null, last_seq: null, stale: headEntry !== null };
  }
  const state = await readAnchorState(ctx.sl);
  const headEntry = await headEntryOf(ctx);
  return {
    closure,
    last_ts: state?.last_anchor_ts ?? null,
    last_seq: state?.last_anchor_seq ?? null,
    stale: staleOf(headEntry, state),
  };
}
