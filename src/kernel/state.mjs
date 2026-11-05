// State layout + state file accessors — CONTRACT §4. The layout is a
// contract value; every consumer builds paths through layout().

import path from "node:path";

import { atomicWriteJson, CAP_CONFIG, readJsonCapped } from "./fsutil.mjs";

export const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const HEX64_RE = /^[0-9a-f]{64}$/;

export function layout(stateHome) {
  const waves = path.join(stateHome, "waves");
  const receipts = path.join(stateHome, "receipts");
  const locks = path.join(stateHome, "locks");
  return {
    stateHome,
    ledger: path.join(stateHome, "ledger.jsonl"),
    anchorState: path.join(stateHome, "anchor-state.json"),
    locks,
    ledgerLock: path.join(locks, "ledger.lock"),
    waves,
    receipts,
    waveDir: (wave) => path.join(waves, wave),
    metaFile: (wave) => path.join(waves, wave, "meta.json"),
    cellsDir: (wave) => path.join(waves, wave, "cells"),
    cellFile: (wave, id) => path.join(waves, wave, "cells", `${id}.json`),
    leasesDir: (wave) => path.join(waves, wave, "leases"),
    leaseDir: (wave, id) => path.join(waves, wave, "leases", id),
    leaseLock: (wave, id) => path.join(waves, wave, "leases", id, "claim.lock"),
    ownerFile: (wave, id) => path.join(waves, wave, "leases", id, "owner.json"),
    leaseHistory: (wave, id) => path.join(waves, wave, "leases", id, "history.jsonl"),
    receiptFile: (wave, id) => path.join(receipts, wave, `${id}.json`),
  };
}

export async function readStateJson(filePath) {
  const { value } = await readJsonCapped(filePath, CAP_CONFIG, "STATE-CORRUPT");
  return value;
}

export async function writeStateJson(filePath, value) {
  await atomicWriteJson(filePath, value);
}

export async function removeStateFile(filePath) {
  const fs = await import("node:fs/promises");
  await fs.rm(filePath, { force: true });
}

export async function readCell(sl, wave, id) {
  return readStateJson(sl.cellFile(wave, id));
}

export async function writeCell(sl, wave, id, cell) {
  await writeStateJson(sl.cellFile(wave, id), cell);
}
