// Unit tests: src/manifest (CONTRACT §3/§4; M1 adversarial list)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { readStateJson } from "../../src/kernel/state.mjs";
import { validateManifest } from "../../src/manifest/manifest.mjs";
import { planWave } from "../../src/manifest/plan.mjs";
import { fakeLedger, makeLayout, makeWorld, manifestFixture, rewriteRegistry, worldFrom, writeJson } from "../helpers.mjs";

async function expectFail(fn, code) {
  try {
    await fn();
  } catch (error) {
    assert.equal(error?.name, "WardenError", `expected WardenError, got: ${error}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected rejection ${code}, but call succeeded`);
}

test("exit classes per CONTRACT §8.3", async () => {
  const { exitClassFor } = await import("../../src/kernel/errors.mjs");
  assert.equal(exitClassFor("WAVE-EXISTS"), 1);
  assert.equal(exitClassFor("CELL-STATE"), 1);
  assert.equal(exitClassFor("MANIFEST-INVALID"), 2);
  assert.equal(exitClassFor("LEDGER-BROKEN"), 2);
  assert.equal(exitClassFor("SCHEMA-VIOLATION"), 2);
});

function cellOver(fx, over) {
  return manifestFixture(fx, { cells: [{ ...manifestFixture(fx).cells[0], ...over }] });
}

// ---------------------------------------------------------------------------
// validateManifest
// ---------------------------------------------------------------------------

test("valid manifest normalizes (role_file absent is tolerated)", async (t) => {
  const { fx, ctx } = await makeWorld(t);
  const { manifest, violations, warnings } = await validateManifest(manifestFixture(fx), {
    config: ctx.config,
    registry: ctx.registry,
    policy: ctx.policy,
  });
  assert.deepEqual(violations, []);
  assert.deepEqual(warnings, []);
  assert.equal(manifest.cells.length, 1);
  assert.equal(manifest.cells[0].cwd, fx.workDir);
  assert.deepEqual(manifest.cells[0].read_roots, []);
  assert.equal(manifest.cells[0].role, null);
  assert.equal(manifest.cells[0].role_file, null);
});

test("wide allowed root containing a relative forbidden surface is a broad-root warning, not a rejection", async (t) => {
  const { fx, ctx } = await makeWorld(t);
  const raw = cellOver(fx, { allowed_roots: [fx.lineRoot] });
  const { warnings } = await validateManifest(raw, { config: ctx.config, registry: ctx.registry, policy: ctx.policy });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].rule, "broad-root");
});

test("unknown kind is UNKNOWN-KIND; config-registered kind passes", async (t) => {
  const { fx, ctx } = await makeWorld(t);
  const args = { config: ctx.config, registry: ctx.registry, policy: ctx.policy };
  await expectFail(() => validateManifest(cellOver(fx, { kind: "explode" }), args), "UNKNOWN-KIND");
  const ok = await validateManifest(cellOver(fx, { kind: "custom" }), args);
  assert.equal(ok.manifest.cells[0].kind, "custom");
});

test("unknown line is MANIFEST-INVALID", async (t) => {
  const { fx, ctx } = await makeWorld(t);
  await expectFail(
    () => validateManifest(cellOver(fx, { line: "ghost" }), { config: ctx.config, registry: ctx.registry, policy: ctx.policy }),
    "MANIFEST-INVALID",
  );
});

test("duplicate cell id is MANIFEST-INVALID", async (t) => {
  const { fx, ctx } = await makeWorld(t);
  const base = manifestFixture(fx).cells[0];
  const raw = manifestFixture(fx, { cells: [base, { ...base }] });
  await expectFail(
    () => validateManifest(raw, { config: ctx.config, registry: ctx.registry, policy: ctx.policy }),
    "MANIFEST-INVALID",
  );
});

test("unknown cell key is MANIFEST-INVALID (schema first, fail closed)", async (t) => {
  const { fx, ctx } = await makeWorld(t);
  const raw = cellOver(fx, { smuggled: true });
  await expectFail(
    () => validateManifest(raw, { config: ctx.config, registry: ctx.registry, policy: ctx.policy }),
    "MANIFEST-INVALID",
  );
});

test("deps: DEP-UNKNOWN, DEP-DUPLICATE, DEP-CYCLE (2-cycle, self-dep)", async (t) => {
  const { fx, ctx } = await makeWorld(t);
  const args = { config: ctx.config, registry: ctx.registry, policy: ctx.policy };
  const base = manifestFixture(fx).cells[0];

  await expectFail(() => validateManifest(cellOver(fx, { deps: ["ghost"] }), args), "DEP-UNKNOWN");
  await expectFail(() => validateManifest(cellOver(fx, { deps: ["ghost", "ghost"] }), args), "DEP-DUPLICATE");
  await expectFail(() => validateManifest(cellOver(fx, { deps: ["c1"] }), args), "DEP-CYCLE");

  const twoCycle = manifestFixture(fx, {
    cells: [base, { ...base, id: "c2", deps: ["c1"] }, { ...base, id: "c1b" }].map((c, i) =>
      i === 0 ? { ...c, deps: ["c2"] } : c,
    ),
  });
  await expectFail(() => validateManifest(twoCycle, args), "DEP-CYCLE");
});

test("deps resolve across shuffled order; acyclic diamond is accepted", async (t) => {
  const { fx, ctx } = await makeWorld(t);
  const base = manifestFixture(fx).cells[0];
  const raw = manifestFixture(fx, {
    cells: [
      { ...base, id: "top", deps: ["a", "b"] },
      { ...base, id: "b", deps: ["seed"] },
      { ...base, id: "a", deps: ["seed"] },
      { ...base, id: "seed", deps: [] },
    ],
  });
  const { manifest } = await validateManifest(raw, { config: ctx.config, registry: ctx.registry, policy: ctx.policy });
  assert.equal(manifest.cells.length, 4);
});

test("cwd must exist as a directory inside an allowed root: PATH-ESCAPE", async (t) => {
  const { fx, ctx } = await makeWorld(t);
  const args = { config: ctx.config, registry: ctx.registry, policy: ctx.policy };
  await expectFail(() => validateManifest(cellOver(fx, { cwd: path.join(fx.workDir, "ghost") }), args), "PATH-ESCAPE");
  await expectFail(
    () => validateManifest(cellOver(fx, { cwd: fx.workDir, allowed_roots: [path.join(fx.lineRoot, "side")] }), args),
    "PATH-ESCAPE",
  );
});

test("allowed root outside the line roots is PATH-ESCAPE", async (t) => {
  const { fx, ctx } = await makeWorld(t);
  await expectFail(
    () =>
      validateManifest(cellOver(fx, { cwd: fx.workDir, allowed_roots: [fx.otherRoot] }), {
        config: ctx.config,
        registry: ctx.registry,
        policy: ctx.policy,
      }),
    "PATH-ESCAPE",
  );
});

test("allowed root matching forbidden_absolute is FORBIDDEN-ROOT (hard)", async (t) => {
  const { fx } = await makeWorld(t);
  const secret = `${fx.lineRoot}/secret`;
  await rewriteRegistry(fx, {
    version: 1,
    lines: {
      demo: { roots: [fx.lineRoot], forbidden_surfaces: [], forbidden_absolute: [`${secret}/**`], read_roots: [] },
      other: { roots: [fx.otherRoot], forbidden_surfaces: [], forbidden_absolute: [], read_roots: [] },
    },
  });
  const { ctx } = await worldFrom(fx);
  await expectFail(
    () => validateManifest(cellOver(fx, { cwd: fx.workDir, allowed_roots: [secret] }), ctx),
    "FORBIDDEN-ROOT",
  );
});

test("allowed root strictly enclosing a forbidden_absolute region is FORBIDDEN-ROOT", async (t) => {
  const { fx } = await makeWorld(t);
  await rewriteRegistry(fx, {
    version: 1,
    lines: {
      demo: {
        roots: [fx.lineRoot],
        forbidden_surfaces: [],
        forbidden_absolute: [`${fx.lineRoot}/vault/keys/**`],
        read_roots: [],
      },
      other: { roots: [fx.otherRoot], forbidden_surfaces: [], forbidden_absolute: [], read_roots: [] },
    },
  });
  const { ctx } = await worldFrom(fx);
  await expectFail(
    () => validateManifest(cellOver(fx, { cwd: fx.workDir, allowed_roots: [fx.lineRoot] }), ctx),
    "FORBIDDEN-ROOT",
  );
});

test("manifest paths must be pre-expanded and normalized", async (t) => {
  const { fx, ctx } = await makeWorld(t);
  const args = { config: ctx.config, registry: ctx.registry, policy: ctx.policy };
  await expectFail(() => validateManifest(cellOver(fx, { cwd: "~/work" }), args), "MANIFEST-INVALID");
  await expectFail(
    () => validateManifest(cellOver(fx, { cwd: fx.workDir, allowed_roots: [`${fx.lineRoot}/../other`] }), args),
    "MANIFEST-INVALID",
  );
});

test("shadow mode: wave id must carry the shadow- prefix (SCHEMA-VIOLATION)", async (t) => {
  const { fx, ctx } = await makeWorld(t, { shadow: true });
  const args = { config: ctx.config, registry: ctx.registry, policy: ctx.policy };
  await expectFail(() => validateManifest(manifestFixture(fx, { wave: "w1" }), args), "SCHEMA-VIOLATION");
  const ok = await validateManifest(manifestFixture(fx), args); // shadow-w1
  assert.equal(ok.manifest.wave, "shadow-w1");
});

// ---------------------------------------------------------------------------
// planWave
// ---------------------------------------------------------------------------

test("planWave writes meta + cells and appends the plan event", async (t) => {
  const { fx, ctx } = await makeWorld(t);
  const manifestPath = path.join(fx.dir, "wave.json");
  await writeJson(manifestPath, manifestFixture(fx));

  const result = await planWave(ctx, { manifestPath });
  assert.equal(result.wave, "w1");
  assert.deepEqual(result.cells, [{ id: "c1", kind: "gen", line: "demo", cwd: fx.workDir, state: "pending" }]);
  assert.deepEqual(result.warnings, []);

  const meta = await readStateJson(ctx.sl.metaFile("w1"));
  assert.equal(meta.wave, "w1");
  assert.equal(meta.config_sha256, ctx.configSha256);
  assert.equal(meta.registry_sha256, ctx.registrySha256);
  assert.match(meta.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(Object.keys(meta.cells), ["c1"]);
  assert.match(meta.cells.c1, /^[0-9a-f]{64}$/);

  const cell = await readStateJson(ctx.sl.cellFile("w1", "c1"));
  assert.equal(cell.state, "pending");
  assert.equal(cell.epoch, 0);
  assert.equal(cell.wave, "w1");
  assert.deepEqual(Array.from(cell.allowed_roots), [fx.workDir]);
  assert.equal(cell.role, null);
  assert.equal(cell.planned_at, cell.updated_at);

  assert.equal(ctx.ledger.events.length, 1);
  const event = ctx.ledger.events[0];
  assert.equal(event.type, "plan");
  assert.equal(event.wave, "w1");
  assert.deepEqual(event.payload.cells, ["c1"]);
});

test("planWave refuses when the ledger is absent or broken", async (t) => {
  const { fx, ctx } = await makeWorld(t);
  const manifestPath = path.join(fx.dir, "wave.json");
  await writeJson(manifestPath, manifestFixture(fx));

  await expectFail(() => planWave({ ...ctx, ledger: undefined }, { manifestPath }), "LEDGER-BROKEN");
  await expectFail(
    () => planWave({ ...ctx, ledger: fakeLedger({ verify: async () => ({ chain_ok: false }) }) }, { manifestPath }),
    "LEDGER-BROKEN",
  );
  await expectFail(
    () => planWave({ ...ctx, ledger: fakeLedger({ verify: async () => { throw new Error("torn"); } }) }, { manifestPath }),
    "LEDGER-BROKEN",
  );
  // nothing was materialized by refused plans
  await assert.rejects(() => fs.stat(ctx.sl.waveDir("w1")));
});

test("re-plan: WAVE-EXISTS plain, force OK over pending, force refuses over claimed/done", async (t) => {
  const { fx, ctx } = await makeWorld(t);
  const manifestPath = path.join(fx.dir, "wave.json");
  await writeJson(manifestPath, manifestFixture(fx));

  await planWave(ctx, { manifestPath });
  await expectFail(() => planWave(ctx, { manifestPath }), "WAVE-EXISTS");

  const forced = await planWave(ctx, { manifestPath, force: true });
  assert.equal(forced.wave, "w1");
  assert.equal(ctx.ledger.events.filter((e) => e.type === "plan").length, 2);

  for (const hostile of ["claimed", "done"]) {
    const cell = await readStateJson(ctx.sl.cellFile("w1", "c1"));
    await writeJson(ctx.sl.cellFile("w1", "c1"), { ...cell, state: hostile });
    await expectFail(() => planWave(ctx, { manifestPath, force: true }), "CELL-STATE");
    // refusal must not have touched the hostile state (done cells are never lost)
    assert.equal((await readStateJson(ctx.sl.cellFile("w1", "c1"))).state, hostile);
  }
});

test("planWave input failures: missing manifest, duplicate JSON keys, size cap", async (t) => {
  const { fx, ctx } = await makeWorld(t);
  await expectFail(
    () => planWave(ctx, { manifestPath: path.join(fx.dir, "ghost.json") }),
    "MANIFEST-INVALID",
  );

  const dupPath = path.join(fx.dir, "dup.json");
  await fs.writeFile(
    dupPath,
    `{"version": 1, "wave": "w1", "wave": "w1b", "cells": [{"id": "c1", "kind": "gen", "line": "demo", "cwd": ${JSON.stringify(fx.workDir)}, "allowed_roots": ${JSON.stringify([fx.workDir])}, "deps": []}]}`,
    "utf8",
  );
  await expectFail(() => planWave(ctx, { manifestPath: dupPath }), "MANIFEST-INVALID");

  const fatPath = path.join(fx.dir, "fat.json");
  await writeJson(fatPath, { ...manifestFixture(fx), pad: "x".repeat(1_048_600) });
  await expectFail(() => planWave(ctx, { manifestPath: fatPath }), "SCHEMA-VIOLATION");
});

test("planWave shadow world plans a shadow- wave end to end", async (t) => {
  const { fx, ctx } = await makeWorld(t, { shadow: true });
  const manifestPath = path.join(fx.dir, "wave.json");
  await writeJson(manifestPath, manifestFixture(fx));
  const result = await planWave(ctx, { manifestPath });
  assert.equal(result.wave, "shadow-w1");
  assert.equal(ctx.policy.shadowHome, fx.shadowHome);
  await readStateJson(ctx.sl.cellFile("shadow-w1", "c1")); // lands under shadow state home
});
