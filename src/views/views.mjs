// Views — read side: ready / status / verify (CONTRACT §9).

import fs from "node:fs/promises";
import path from "node:path";

import { fail, WardenError, violation } from "../kernel/errors.mjs";
import { sha256File } from "../kernel/canon.mjs";
import { readStateJson } from "../kernel/state.mjs";
import { anchorSummary } from "../ledger/anchor.mjs";

async function listWaveIds(sl) {
  try {
    const entries = await fs.readdir(sl.waves, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function readWaveCells(ctx, wave) {
  try {
    await fs.stat(ctx.sl.metaFile(wave));
  } catch {
    fail("WAVE-MISSING", `no such wave: ${wave}`, [violation("wave", "wave-missing", wave)]);
  }
  const ids = (await fs.readdir(ctx.sl.cellsDir(wave)))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
  const cells = [];
  for (const id of ids) cells.push(await readStateJson(ctx.sl.cellFile(wave, id)));
  return cells;
}

async function leaseView(ctx, wave, cell) {
  if (cell.state !== "claimed") return null;
  try {
    return await readStateJson(ctx.sl.ownerFile(wave, cell.id));
  } catch {
    return null; // claimed with a lost lease file is surfaced by verify, not here
  }
}

export async function readyCells(ctx, wave) {
  const cells = await readWaveCells(ctx, wave);
  const done = new Set(cells.filter((c) => c.state === "done").map((c) => c.id));
  return cells.map((cell) => ({
    id: cell.id,
    kind: cell.kind,
    line: cell.line,
    cwd: cell.cwd,
    deps: cell.deps,
    state: cell.state,
    ready: cell.state === "pending" && cell.deps.every((d) => done.has(d)),
    blocked_by: cell.deps.filter((d) => !done.has(d)),
  }));
}

export async function statusReport(ctx, wave) {
  const waves = wave ? [wave] : await listWaveIds(ctx.sl);
  const out = [];
  for (const id of waves) {
    const cells = await readWaveCells(ctx, id);
    const rows = [];
    for (const cell of cells) {
      const lease = await leaseView(ctx, id, cell);
      let receiptSha = null;
      if (cell.state === "done" || cell.state === "failed") {
        try {
          receiptSha = await sha256File(ctx.sl.receiptFile(id, cell.id));
        } catch {
          receiptSha = "MISSING";
        }
      }
      rows.push({
        id: cell.id,
        kind: cell.kind,
        line: cell.line,
        state: cell.state,
        epoch: cell.epoch,
        holder: lease?.actor ?? null,
        expires_at: lease?.expires_at ?? null,
        receipt_sha256: receiptSha,
      });
    }
    out.push({ wave: id, cells: rows });
  }
  return { waves: out };
}

export async function verifyAll(ctx, { wave } = {}) {
  const chain = await ctx.ledger.verify();
  if (chain.torn) {
    fail("LEDGER-TORN", `ledger line ${chain.torn.line} is torn or unparseable`, [
      violation(`ledger:${chain.torn.line}`, "torn", chain.torn.detail),
    ]);
  }
  if (!chain.chain_ok) {
    fail("LEDGER-BROKEN", "ledger chain verification failed", chain.violations ?? []);
  }

  // Spot-check: every done/fail event's receipt file must still hash to the
  // recorded sha (evidence preserved, CONTRACT §7).
  const { entries } = chain;
  const expected = new Map();
  for (const entry of entries) {
    if ((entry.type === "done" || entry.type === "fail") && entry.wave && entry.cell) {
      expected.set(`${entry.wave}/${entry.cell}`, entry.payload.receipt_sha256 ?? null);
    }
  }
  const mismatches = [];
  let checked = 0;
  for (const [key, sha] of expected) {
    const [w, c] = key.split("/");
    try {
      const actual = await sha256File(ctx.sl.receiptFile(w, c));
      checked += 1;
      if (sha !== null && actual !== sha) {
        mismatches.push({ cell: key, expected: sha, actual });
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!wave || w === wave) mismatches.push({ cell: key, expected: sha, actual: "MISSING" });
    }
  }
  if (mismatches.length > 0) {
    fail("LEDGER-BROKEN", "receipt spot-check failed", mismatches.map((m) =>
      violation(`receipt:${m.cell}`, "receipt-hash-mismatch", `${m.actual} != ${m.expected}`)));
  }

  const anchor = await anchorSummary(ctx);
  if (anchor.stale && anchor.closure !== "none") {
    throw new WardenError(
      "ANCHOR-STALE",
      `ledger head seq ${chain.head_seq ?? ""} is beyond last anchor seq ${anchor.last_seq}; audit closure NOT claimed`,
      [violation("anchor", "stale", JSON.stringify(anchor))],
    );
  }
  return {
    chain_ok: true,
    entries: entries.length,
    head: chain.head,
    audit_closure: anchor.closure,
    anchor,
    spot_check: { checked, mismatches: [] },
  };
}
