// Anchor unit tests — CONTRACT §2.3 + §5.4, DESIGN-INTERNALS §src/ledger.
// The local http server here is a test fixture (allowed); no sleeps beyond
// sub-second work.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { layout, readStateJson } from "../../src/kernel/state.mjs";
import { openLedger } from "../../src/ledger/chain.mjs";
import { anchorSummary, initAnchor, maybeAnchor, pushAnchor } from "../../src/ledger/anchor.mjs";

const NL = "\n"; // sanitize policy: one backslash per source line

const REG_SHA = "a".repeat(64);
const CFG_SHA = "b".repeat(64);

async function mkCtx(anchor = null) {
  const stateHome = await fs.mkdtemp(path.join(os.tmpdir(), "aw-anchor-"));
  const sl = layout(stateHome);
  const ledger = openLedger({ sl });
  const ctx = { sl, config: { anchor }, ledger };
  return { stateHome, sl, ledger, ctx };
}

async function withGenesis(ledger) {
  const g = await ledger.appendGenesisIfAbsent({ configSha256: CFG_SHA, registrySha256: REG_SHA });
  return g.entry;
}

async function readState(sl) {
  const value = await readStateJson(sl.anchorState);
  return { ...value }; // plain prototype for deepStrictEqual
}

async function pathExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function fileLines(p) {
  return (await fs.readFile(p, "utf8")).split("\n").filter((l) => l !== "");
}

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

test("command anchor: /bin/true ok, /bin/false fails with exit code", async () => {
  const okCase = await mkCtx({ type: "command", target: "/bin/true" });
  const failCase = await mkCtx({ type: "command", target: "/bin/false" });
  try {
    const head = await withGenesis(okCase.ledger);
    assert.deepEqual(await pushAnchor(okCase.ctx, head), { ok: true });

    await withGenesis(failCase.ledger);
    const failHead = (await failCase.ledger.readAll()).entries[0];
    const res = await pushAnchor(failCase.ctx, failHead);
    assert.equal(res.ok, false);
    assert.equal(res.error, "exit 1");
  } finally {
    await fs.rm(okCase.stateHome, { recursive: true, force: true });
    await fs.rm(failCase.stateHome, { recursive: true, force: true });
  }
});

test("command anchor accepts a JSON argv array target", async () => {
  const { stateHome, ledger, ctx } = await mkCtx({ type: "command", target: JSON.stringify(["/bin/echo", "anchor-me"]) });
  try {
    const head = await withGenesis(ledger);
    assert.deepEqual(await pushAnchor(ctx, head), { ok: true });
  } finally {
    await fs.rm(stateHome, { recursive: true, force: true });
  }
});

test("command anchor with unusable target returns failure (never throws)", async () => {
  const { stateHome, ledger, ctx } = await mkCtx({ type: "command", target: "" });
  try {
    const head = await withGenesis(ledger);
    const res = await pushAnchor(ctx, head);
    assert.equal(res.ok, false);
    assert.ok(res.error.includes("invalid command target"));
  } finally {
    await fs.rm(stateHome, { recursive: true, force: true });
  }
});

test("remote anchor: 200 ok with correct JSON body; 500 fails", async () => {
  const received = [];
  const okSrv = await startServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      received.push({ method: req.method, json: JSON.parse(body) });
      res.writeHead(200).end("ok");
    });
  });
  const badSrv = await startServer((_req, res) => { res.writeHead(500).end("nope"); });
  try {
    const okCase = await mkCtx({ type: "remote", target: `http://127.0.0.1:${okSrv.address().port}/anchor` });
    try {
      const head = await withGenesis(okCase.ledger);
      const res = await pushAnchor(okCase.ctx, head);
      assert.deepEqual(res, { ok: true });
      assert.equal(received.length, 1);
      assert.equal(received[0].method, "POST");
      assert.deepEqual(received[0].json, { head_seq: 1, head_hash: head.hash, chain_head_ts: head.ts });
    } finally {
      await fs.rm(okCase.stateHome, { recursive: true, force: true });
    }

    const badCase = await mkCtx({ type: "remote", target: `http://127.0.0.1:${badSrv.address().port}/anchor` });
    try {
      const head = await withGenesis(badCase.ledger);
      const res = await pushAnchor(badCase.ctx, head);
      assert.equal(res.ok, false);
      assert.equal(res.error, "http 500");
    } finally {
      await fs.rm(badCase.stateHome, { recursive: true, force: true });
    }
  } finally {
    await new Promise((r) => okSrv.close(r));
    await new Promise((r) => badSrv.close(r));
  }
});

test("file anchor: appends the anchor line; closure is local, not external", async () => {
  const { stateHome, sl, ledger, ctx } = await mkCtx();
  const target = path.join(stateHome, "anchor.log");
  ctx.config.anchor = { type: "file", target };
  try {
    const head = await withGenesis(ledger);
    assert.deepEqual(await pushAnchor(ctx, head), { ok: true });
    const lines = await fileLines(target);
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), { head_seq: 1, head_hash: head.hash, chain_head_ts: head.ts });

    const init = await initAnchor(ctx); // pushes genesis head again (idempotent target append)
    assert.equal(init.closure, "local");

    const summary = await anchorSummary(ctx);
    assert.equal(summary.closure, "local"); // NEVER "external" for type file
    assert.equal(summary.stale, false);
  } finally {
    await fs.rm(stateHome, { recursive: true, force: true });
  }
});

test("human-checkpoint anchor: succeeds only when a line contains the head hash", async () => {
  const { stateHome, sl, ledger, ctx } = await mkCtx();
  const target = path.join(stateHome, "checkpoint.txt");
  ctx.config.anchor = { type: "human-checkpoint", target };
  try {
    const head = await withGenesis(ledger);
    await fs.writeFile(target, `random human notes${NL}no signature here${NL}`);
    const unsigned = await pushAnchor(ctx, head);
    assert.equal(unsigned.ok, false);
    assert.ok(unsigned.error.includes("does not contain the chain head hash"));

    await fs.appendFile(target, `signed-off head ${head.hash} at 2026-11-05\n`);
    assert.deepEqual(await pushAnchor(ctx, head), { ok: true });
  } finally {
    await fs.rm(stateHome, { recursive: true, force: true });
  }
});

test("unknown anchor type returns failure", async () => {
  const { stateHome, ledger, ctx } = await mkCtx({ type: "carrier-pigeon", target: "nowhere" });
  try {
    const head = await withGenesis(ledger);
    const res = await pushAnchor(ctx, head);
    assert.equal(res.ok, false);
    assert.ok(res.error.includes("unknown anchor type"));
  } finally {
    await fs.rm(stateHome, { recursive: true, force: true });
  }
});

test("initAnchor with null anchor records audit_closure none", async () => {
  const { stateHome, sl, ledger, ctx } = await mkCtx(null);
  try {
    await withGenesis(ledger);
    const res = await initAnchor(ctx);
    assert.deepEqual(res, { ok: true, closure: "none" });
    assert.deepEqual(await readState(sl), {
      last_anchor_ts: null,
      last_anchor_seq: null,
      last_anchor_hash: null,
      failures: 0,
      audit_closure: "none",
    });
    assert.equal((await ledger.verify()).entries.length, 1); // no anchor entry
  } finally {
    await fs.rm(stateHome, { recursive: true, force: true });
  }
});

test("initAnchor success: anchor entry + state update; summary fresh", async () => {
  const { stateHome, sl, ledger, ctx } = await mkCtx({ type: "command", target: "/bin/true" });
  try {
    const head = await withGenesis(ledger);
    const res = await initAnchor(ctx);
    assert.equal(res.ok, true);
    assert.equal(res.closure, "external");

    const v = await ledger.verify();
    assert.equal(v.chain_ok, true);
    assert.equal(v.entries.length, 2);
    const anchorEntry = v.entries[1];
    assert.equal(anchorEntry.type, "anchor");
    assert.deepEqual({ ...anchorEntry.payload }, {
      anchor_type: "command",
      target_summary: "/bin/true",
      head_seq: 1,
      head_hash: head.hash,
      ok: true,
    });

    const st = await readState(sl);
    assert.equal(st.last_anchor_seq, 2); // the anchor entry marks the window
    assert.equal(st.last_anchor_hash, head.hash);
    assert.equal(st.failures, 0);
    assert.equal(st.audit_closure, "external");

    const summary = await anchorSummary(ctx);
    assert.deepEqual(summary, { closure: "external", last_ts: st.last_anchor_ts, last_seq: 2, stale: false });
  } finally {
    await fs.rm(stateHome, { recursive: true, force: true });
  }
});

test("initAnchor push failure fails ANCHOR-FAIL and rolls genesis back (state left unmodified)", async () => {
  const { stateHome, sl, ledger, ctx } = await mkCtx({ type: "command", target: "/bin/false" });
  try {
    await withGenesis(ledger);
    await assert.rejects(() => initAnchor(ctx), (err) => err.code === "ANCHOR-FAIL");
    assert.equal(await pathExists(sl.ledger), false, "sole genesis rolled back");
    assert.equal(await pathExists(sl.anchorState), false);
  } finally {
    await fs.rm(stateHome, { recursive: true, force: true });
  }
});

test("initAnchor failure with an established chain keeps the ledger", async () => {
  const { stateHome, sl, ledger, ctx } = await mkCtx({ type: "command", target: "/bin/false" });
  try {
    await withGenesis(ledger);
    await ledger.append("plan", { wave: "w1" });
    await assert.rejects(() => initAnchor(ctx), (err) => err.code === "ANCHOR-FAIL");
    const v = await ledger.verify();
    assert.equal(v.entries.length, 2); // rollback only applies to sole-genesis
  } finally {
    await fs.rm(stateHome, { recursive: true, force: true });
  }
});

test("maybeAnchor: null anchor → degraded null, closure none", async () => {
  const { stateHome, ledger, ctx } = await mkCtx(null);
  try {
    await withGenesis(ledger);
    assert.deepEqual(await maybeAnchor(ctx), { degraded: null, closure: "none" });
  } finally {
    await fs.rm(stateHome, { recursive: true, force: true });
  }
});

test("maybeAnchor: not due → no push, stale reported for the unanchored head", async () => {
  const { stateHome, ledger, ctx } = await mkCtx();
  const target = path.join(stateHome, "anchor.log");
  ctx.config.anchor = { type: "file", target };
  try {
    await withGenesis(ledger);
    await initAnchor(ctx);
    await ledger.append("plan", { wave: "w1" }); // head 3 vs last 2 → not due
    const res = await maybeAnchor(ctx);
    assert.equal(res.degraded, null);
    assert.equal(res.stale, true);
    assert.equal((await ledger.verify()).entries.length, 3); // no anchor entry appended
    assert.equal((await fileLines(target)).length, 1); // only the init push; nothing new
  } finally {
    await fs.rm(stateHome, { recursive: true, force: true });
  }
});

test("maybeAnchor: triggers on seq delta 50", async () => {
  const { stateHome, sl, ledger, ctx } = await mkCtx();
  const target = path.join(stateHome, "anchor.log");
  ctx.config.anchor = { type: "file", target };
  try {
    await withGenesis(ledger);
    await initAnchor(ctx); // anchor entry seq 2, last_anchor_seq 2
    for (let i = 1; i <= 50; i += 1) {
      await ledger.append("plan", { wave: "w50", cell: `c${String(i)}` });
    }
    const res = await maybeAnchor(ctx);
    assert.equal(res.degraded, null);
    assert.equal(res.stale, false);

    const v = await ledger.verify();
    assert.equal(v.chain_ok, true);
    assert.equal(v.entries.length, 53); // genesis + anchor + 50 + anchor
    const last = v.entries[52];
    assert.equal(last.type, "anchor");
    assert.deepEqual({ ...last.payload }, {
      anchor_type: "file",
      target_summary: target,
      head_seq: 52,
      head_hash: v.entries[51].hash,
      ok: true,
    });
    const st = await readState(sl);
    assert.equal(st.last_anchor_seq, 53);
    assert.equal(st.last_anchor_hash, v.entries[51].hash);
    assert.equal((await fileLines(target)).length, 2);
  } finally {
    await fs.rm(stateHome, { recursive: true, force: true });
  }
});

test("maybeAnchor: time trigger past the interval", async () => {
  const { stateHome, sl, ledger, ctx } = await mkCtx();
  const target = path.join(stateHome, "anchor.log");
  ctx.config.anchor = { type: "file", target };
  try {
    await withGenesis(ledger);
    await initAnchor(ctx);
    await ledger.append("plan", { wave: "w1" });
    ctx.nowFn = () => new Date(Date.now() + 601_000).toISOString(); // +601 s > 600 s
    const res = await maybeAnchor(ctx);
    assert.equal(res.degraded, null);
    assert.equal((await ledger.verify()).entries.length, 4);
    assert.equal((await fileLines(target)).length, 2);
    const st = await readState(sl);
    assert.equal(st.last_anchor_seq, 4);
  } finally {
    await fs.rm(stateHome, { recursive: true, force: true });
  }
});

test("maybeAnchor: push failure → ANCHOR-DEGRADED, failures incremented, no anchor entry", async () => {
  const { stateHome, sl, ledger, ctx } = await mkCtx({ type: "command", target: "/bin/false" });
  try {
    await withGenesis(ledger);
    const res = await maybeAnchor(ctx); // never anchored → due
    assert.equal(res.degraded, "ANCHOR-DEGRADED");
    assert.equal(res.closure, "external");
    assert.equal(res.error, "exit 1");
    assert.equal((await ledger.verify()).entries.length, 1); // no anchor entry on failure
    const st = await readState(sl);
    assert.equal(st.failures, 1);
    assert.equal(st.last_anchor_seq, null);

    const again = await maybeAnchor(ctx);
    assert.equal(again.degraded, "ANCHOR-DEGRADED");
    assert.equal((await readState(sl)).failures, 2);
  } finally {
    await fs.rm(stateHome, { recursive: true, force: true });
  }
});

test("anchorSummary with null anchor: closure none, stale when entries exist", async () => {
  const { stateHome, ledger, ctx } = await mkCtx(null);
  try {
    assert.deepEqual(await anchorSummary(ctx), { closure: "none", last_ts: null, last_seq: null, stale: false });
    await withGenesis(ledger);
    assert.deepEqual(await anchorSummary(ctx), { closure: "none", last_ts: null, last_seq: null, stale: true });
  } finally {
    await fs.rm(stateHome, { recursive: true, force: true });
  }
});
