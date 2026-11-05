// Contract tests: the five schemas under schemas/ — every one against valid
// and malformed fixtures; the four file-format fixtures must round-trip
// (validate clean, reject injected unknown keys). CONTRACT §2/§3/§5/§7.

import test from "node:test";
import assert from "node:assert/strict";

import { validateSchema } from "../../src/kernel/schemalite.mjs";
import { loadSchema } from "../../src/config/schemas.mjs";

const HEX = "0123456789abcdef".repeat(4);

// --- valid fixtures (one per contract file format + ledger entries) --------

const fixtures = {
  config: () => ({
    version: 1,
    registry: "~/.config/asylumwarden/registry.json",
    registry_sha256: HEX,
    self: "demo",
    state_home: "~/.local/state/asylumwarden",
    mode: "normal",
    kinds: { verify: { description: "independent review, read-only" } },
    anchor: { type: "file", target: "/srv/anchor/chain.log", signer: "ops" },
  }),
  registry: () => ({
    version: 1,
    lines: {
      demo: {
        roots: ["/srv/lines/demo"],
        forbidden_surfaces: [".omo/evidence/INTENT-LEDGER.md"],
        forbidden_absolute: ["/srv/shared/protected/**"],
        read_roots: ["/srv/lines/other"],
      },
    },
  }),
  manifest: () => ({
    version: 1,
    wave: "shadow-w1",
    cells: [
      {
        id: "c1",
        kind: "gen",
        line: "demo",
        cwd: "/srv/lines/demo/work",
        allowed_roots: ["/srv/lines/demo/work"],
        read_roots: ["/srv/lines/other"],
        deps: [],
        role: "builder",
        role_file: "/srv/lines/demo/AGENTS.md",
        session_started_at: "2026-11-05T00:00:00.000Z",
        brief: "do the thing",
        acceptance: "tests green",
      },
    ],
  }),
  receipt: () => ({
    version: 1,
    cell: "c1",
    actor: "seat-1",
    epoch: 3,
    status: "done",
    summary: "all green",
    commands: [{ cmd: "node --test", exit: 0 }],
    artifacts: [{ path: "/srv/lines/demo/work/out.bin", sha256: HEX }],
    reads: ["/srv/lines/other/ref.txt"],
  }),
  ledger: () => ({
    seq: 1,
    ts: "2026-11-05T00:00:00.000Z",
    type: "genesis",
    wave: null,
    cell: null,
    actor: null,
    payload: { registry_sha256: HEX, config_sha256: HEX },
    prev: "0".repeat(64),
    hash: HEX,
  }),
};

async function check(name, value) {
  return validateSchema(await loadSchema(name), value, name);
}

// ---------------------------------------------------------------------------

test("loadSchema exposes the five contract schemas and caches", async () => {
  for (const name of Object.keys(fixtures)) {
    const schema = await loadSchema(name);
    assert.equal(schema.$id, `asylumwarden/${name}.schema.json`);
    assert.equal(await loadSchema(name), schema, "cached instance");
  }
  try {
    await loadSchema("bogus");
    assert.fail("unknown schema name must fail INTERNAL");
  } catch (error) {
    assert.equal(error.code, "INTERNAL");
    assert.equal(error.exitClass, 2);
  }
});

test("all four file-format fixtures + ledger round-trip clean", async () => {
  for (const [name, build] of Object.entries(fixtures)) {
    assert.deepEqual(await check(name, build()), [], `${name} valid fixture must validate clean`);
  }
});

test("unknown keys rejected in all four file-format fixtures", async () => {
  for (const [name, build] of Object.entries(fixtures)) {
    const dirty = { ...build(), smuggled: true };
    assert.ok((await check(name, dirty)).length > 0, `${name}: unknown top-level key must be rejected`);
  }
  const manifest = fixtures.manifest();
  manifest.cells[0].smuggled = true;
  assert.ok((await check("manifest", manifest)).length > 0, "unknown cell key must be rejected");
});

// --- config ----------------------------------------------------------------

test("config: variants and rejections", async () => {
  // minimal normal form (optional keys absent)
  const minimal = fixtures.config();
  delete minimal.kinds;
  delete minimal.anchor;
  assert.deepEqual(await check("config", minimal), []);

  // shadow variant: requires shadow_of + shadow_home
  const shadow = {
    ...fixtures.config(),
    mode: "shadow",
    shadow_of: "a".repeat(64),
    shadow_home: "~/.local/state/asylumwarden-shadow-pcb",
  };
  assert.deepEqual(await check("config", shadow), []);

  assert.ok((await check("config", { ...shadow, shadow_of: "zz" })).length > 0, "shadow_of must be 64hex");
  const noHome = { ...shadow };
  delete noHome.shadow_home;
  assert.ok((await check("config", noHome)).length > 0, "shadow mode requires shadow_home");
  assert.ok((await check("config", { ...fixtures.config(), mode: "normal", shadow_of: "a".repeat(64), shadow_home: "/x" })).length > 0,
    "shadow keys forbidden in normal mode");

  assert.ok((await check("config", { ...fixtures.config(), version: 2 })).length > 0);
  assert.ok((await check("config", { ...fixtures.config(), registry_sha256: "ABC" })).length > 0);
  assert.ok((await check("config", { ...fixtures.config(), registry: "relative/path.json" })).length > 0);
  const noSelf = { ...fixtures.config() };
  delete noSelf.self;
  assert.ok((await check("config", noSelf)).length > 0);
  assert.ok((await check("config", { ...fixtures.config(), anchor: { type: "carrier-pigeon", target: "/x" } })).length > 0);
});

// --- registry ---------------------------------------------------------------

test("registry: variants and rejections", async () => {
  // minimal line: only required keys
  const minimal = { version: 1, lines: { demo: { roots: ["/srv/a"], forbidden_surfaces: [] } } };
  assert.deepEqual(await check("registry", minimal), []);

  assert.ok((await check("registry", { version: 1, lines: {} })).length > 0, "minProperties 1");
  assert.ok((await check("registry", { version: 1, lines: { demo: { roots: [], forbidden_surfaces: [] } } })).length > 0);
  assert.ok((await check("registry", { version: 2, lines: fixtures.registry().lines })).length > 0);
  // forbidden_surfaces items must be relative, forbidden_absolute items absolute
  const abs = { version: 1, lines: { demo: { roots: ["/srv/a"], forbidden_surfaces: ["/abs/pattern"] } } };
  assert.ok((await check("registry", abs)).length > 0);
  const relAbs = { version: 1, lines: { demo: { roots: ["/srv/a"], forbidden_surfaces: [], forbidden_absolute: ["rel/pat"] } } };
  assert.ok((await check("registry", relAbs)).length > 0);
  const extra = { version: 1, lines: { demo: { roots: ["/srv/a"], forbidden_surfaces: [], smuggled: 1 } } };
  assert.ok((await check("registry", extra)).length > 0);
});

// --- manifest ---------------------------------------------------------------

test("manifest: variants and rejections", async () => {
  const minimal = {
    version: 1,
    wave: "w1",
    cells: [{ id: "c1", kind: "gen", line: "demo", cwd: "/srv/a", allowed_roots: ["/srv/a"], deps: [] }],
  };
  assert.deepEqual(await check("manifest", minimal), []);

  assert.ok((await check("manifest", { ...minimal, cells: [] })).length > 0, "minItems 1");
  assert.ok((await check("manifest", { ...minimal, wave: "-bad" })).length > 0, "wave SafeId");
  const noDeps = { ...minimal, cells: [{ ...minimal.cells[0] }] };
  delete noDeps.cells[0].deps;
  assert.ok((await check("manifest", noDeps)).length > 0, "deps is required");
  assert.ok((await check("manifest", { ...minimal, cells: [{ ...minimal.cells[0], cwd: "~/work" }] })).length > 0,
    "manifest paths must already be expanded");
  assert.ok((await check("manifest", { ...minimal, cells: [{ ...minimal.cells[0], kind: "GEN US" }] })).length > 0);
});

// --- receipt ----------------------------------------------------------------

test("receipt: normal + shadow variants and rejections", async () => {
  const minimal = { version: 1, cell: "c1", actor: "a", epoch: 1, status: "failed", summary: "why" };
  assert.deepEqual(await check("receipt", minimal), []);

  const shadow = { ...fixtures.receipt(), mode: "shadow", shadow_of: "a".repeat(64) };
  assert.deepEqual(await check("receipt", shadow), []);

  const modeNoShadowOf = { ...fixtures.receipt(), mode: "shadow" };
  assert.ok((await check("receipt", modeNoShadowOf)).length > 0, "shadow receipt requires shadow_of");
  const hashNoMode = { ...fixtures.receipt(), shadow_of: "a".repeat(64) };
  assert.ok((await check("receipt", hashNoMode)).length > 0, "shadow_of without mode rejected");

  assert.ok((await check("receipt", { ...fixtures.receipt(), epoch: 0 })).length > 0, "epoch minimum 1");
  assert.ok((await check("receipt", { ...fixtures.receipt(), status: "skipped" })).length > 0);
  assert.ok((await check("receipt", { ...fixtures.receipt(), commands: [{ cmd: "x", exit: -1 }] })).length > 0);
  assert.ok((await check("receipt", { ...fixtures.receipt(), artifacts: [{ path: "rel/x", sha256: HEX }] })).length > 0);
});

// --- ledger -----------------------------------------------------------------

test("ledger entry: variants and rejections", async () => {
  assert.deepEqual(await check("ledger", fixtures.ledger()), []);
  const plan = { ...fixtures.ledger(), seq: 2, type: "plan", wave: "w1", prev: HEX };
  assert.deepEqual(await check("ledger", plan), []);

  assert.ok((await check("ledger", { ...fixtures.ledger(), type: "bogus" })).length > 0);
  assert.ok((await check("ledger", { ...fixtures.ledger(), seq: 0 })).length > 0);
  const noHash = { ...fixtures.ledger() };
  delete noHash.hash;
  assert.ok((await check("ledger", noHash)).length > 0);
  assert.ok((await check("ledger", { ...fixtures.ledger(), prev: "0".repeat(63) })).length > 0);
  assert.ok((await check("ledger", { ...fixtures.ledger(), ts: "yesterday" })).length > 0);
  assert.ok((await check("ledger", { ...fixtures.ledger(), smuggled: 1 })).length > 0);
});
