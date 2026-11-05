// Wave planning — docs/CONTRACT.md §3/§4; pinned signature:
// docs/DESIGN-INTERNALS.md §src/manifest/plan.mjs.
// The ledger arrives as ctx.ledger ({append, verify, readAll}) from the
// integration layer; this module never imports the ledger module itself.

import fs from "node:fs/promises";

import { fail, violation } from "../kernel/errors.mjs";
import { sha256Of } from "../kernel/canon.mjs";
import { atomicWriteJson, CAP_CONFIG, fileExists, nowIso, readJsonCapped } from "../kernel/fsutil.mjs";
import { HEX64_RE, readStateJson } from "../kernel/state.mjs";
import { assertNoDuplicateKeys } from "../config/load.mjs";
import { restoreArrayProtocols } from "../config/schemas.mjs";
import { validateManifest } from "./manifest.mjs";

// Integrity gate before any state read that could be poisoned by a broken
// chain: without a verifiable ledger, nothing may be planned.
async function assertLedgerHealthy(ctx) {
  let verdict = null;
  try {
    verdict = (await ctx?.ledger?.verify?.()) ?? null;
  } catch {
    verdict = null;
  }
  if (verdict === null || verdict.chain_ok !== true) {
    fail("LEDGER-BROKEN", "ledger missing or chain not verifiable; plan refused", [
      violation("ledger", "chain", "unverifiable"),
    ]);
  }
}

// A --force re-plan may overwrite only inert cells; an in-flight (claimed) or
// finished (done) cell's state must never be silently erased.
async function assertOverwritable(sl, wave) {
  let names;
  try {
    names = await fs.readdir(sl.cellsDir(wave));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const cellId = name.slice(0, -".json".length);
    const existing = await readStateJson(sl.cellFile(wave, cellId));
    if (existing?.state === "claimed" || existing?.state === "done") {
      fail("CELL-STATE", `--force refused: cell ${cellId} of wave ${wave} is ${existing.state}`, [
        violation(`cells.${cellId}`, "cell-state", existing.state),
      ]);
    }
  }
}

export async function planWave(ctx, { manifestPath, force = false }) {
  await assertLedgerHealthy(ctx);

  let raw;
  try {
    ({ value: raw } = await readJsonCapped(manifestPath, CAP_CONFIG, "SCHEMA-VIOLATION"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("MANIFEST-INVALID", `manifest file not found: ${String(manifestPath)}`, [
        violation("manifestPath", "missing", String(manifestPath)),
      ]);
    }
    if (error?.name === "WardenError") throw error;
    fail("MANIFEST-INVALID", `cannot read manifest ${String(manifestPath)}: ${error?.message}`);
  }
  restoreArrayProtocols(raw);
  await assertNoDuplicateKeys(manifestPath, "MANIFEST-INVALID");

  const { manifest, warnings } = await validateManifest(raw, {
    config: ctx.config,
    registry: ctx.registry,
    policy: ctx.policy,
  });

  const sl = ctx.sl;
  const wave = manifest.wave;
  if (await fileExists(sl.waveDir(wave))) {
    if (!force) {
      fail("WAVE-EXISTS", `wave ${wave} is already planned in ${sl.waveDir(wave)}`, [
        violation("wave", "wave-exists", wave),
      ]);
    }
    await assertOverwritable(sl, wave);
  }

  for (const value of [ctx.configSha256, ctx.registrySha256]) {
    if (typeof value !== "string" || !HEX64_RE.test(value)) {
      fail("INTERNAL", "planWave: ctx.configSha256 / ctx.registrySha256 must be 64-hex digests");
    }
  }

  const plannedAt = nowIso();
  const cells = {};
  for (const cell of manifest.cells) {
    const state = {
      id: cell.id,
      wave,
      kind: cell.kind,
      line: cell.line,
      cwd: cell.cwd,
      allowed_roots: cell.allowed_roots,
      read_roots: cell.read_roots,
      deps: cell.deps,
      role: cell.role,
      role_file: cell.role_file,
      session_started_at: cell.session_started_at,
      brief: cell.brief,
      acceptance: cell.acceptance,
      state: "pending",
      epoch: 0,
      planned_at: plannedAt,
      updated_at: plannedAt,
    };
    await atomicWriteJson(sl.cellFile(wave, cell.id), state);
    cells[cell.id] = sha256Of(state);
  }
  await atomicWriteJson(sl.metaFile(wave), {
    wave,
    config_sha256: ctx.configSha256,
    registry_sha256: ctx.registrySha256,
    created_at: plannedAt,
    cells,
  });

  // The plan event is appended only after every write landed, so a failed
  // plan never leaves a phantom wave on the ledger.
  await ctx.ledger.append("plan", {
    wave,
    cell: null,
    actor: null,
    payload: { cells: Object.keys(cells) },
  });

  return {
    wave,
    cells: manifest.cells.map((c) => ({ id: c.id, kind: c.kind, line: c.line, cwd: c.cwd, state: "pending" })),
    warnings,
  };
}
