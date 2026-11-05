// Shared test scaffolding: temp worlds + the hand-built ctx / fakeLedger
// pinned by docs/DESIGN-INTERNALS.md §Testing.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { sha256File } from "../src/kernel/canon.mjs";
import { layout } from "../src/kernel/state.mjs";
import { buildPolicy, loadProjectConfig, loadRegistry } from "../src/config/load.mjs";

// In-memory ledger stand-in, exactly the shape pinned by
// docs/DESIGN-INTERNALS.md §Testing. Real ledger is exercised only by the
// ledger team's own tests; config/manifest tests stay independent.
export function fakeLedger(overrides = {}) {
  const events = [];
  return {
    events,
    append: async (type, extra = {}) => {
      const entry = { seq: events.length + 1, type, ...extra };
      events.push(entry);
      return entry;
    },
    verify: async () => ({ chain_ok: true, entries: 1, head: "0".repeat(64) }),
    readAll: async () => ({ entries: events, head: "0".repeat(64), torn: null }),
    ...overrides,
  };
}

export async function tempRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aw-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// Standard fixture world: line "demo" rooted at <dir>/lineA with work/, line
// "other" at <dir>/other, plus registry.json and asylumwarden.json wired by
// hash. Shadow mode relocates the registry/state home per CONTRACT §10.
export async function makeLayout(t, { shadow = false, registry = null, configOverrides = null } = {}) {
  const dir = await tempRoot(t);
  const lineRoot = path.join(dir, "lineA");
  const workDir = path.join(lineRoot, "work");
  const otherRoot = path.join(dir, "other");
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(otherRoot, { recursive: true });

  const reg = registry ?? {
    version: 1,
    lines: {
      demo: {
        roots: [lineRoot],
        forbidden_surfaces: [".omo/evidence/INTENT-LEDGER.md"],
        forbidden_absolute: [],
        read_roots: [otherRoot],
      },
      other: { roots: [otherRoot], forbidden_surfaces: [], forbidden_absolute: [], read_roots: [] },
    },
  };

  let registryPath;
  let stateHome;
  let shadowHome = null;
  if (shadow) {
    shadowHome = path.join(dir, "shadow");
    await fs.mkdir(shadowHome, { recursive: true });
    registryPath = path.join(shadowHome, "shadow-registry.json");
    stateHome = shadowHome;
  } else {
    registryPath = path.join(dir, "registry.json");
    stateHome = path.join(dir, "state");
  }
  await writeJson(registryPath, reg);
  const registrySha256 = await sha256File(registryPath);

  let config = {
    version: 1,
    registry: registryPath,
    registry_sha256: registrySha256,
    self: "demo",
    state_home: stateHome,
    mode: shadow ? "shadow" : "normal",
    kinds: { custom: { description: "project-registered kind" } },
    anchor: null,
  };
  if (shadow) {
    config.shadow_of = "a".repeat(64);
    config.shadow_home = shadowHome;
  }
  if (configOverrides !== null) config = { ...config, ...configOverrides };

  const configPath = path.join(dir, "asylumwarden.json");
  await writeJson(configPath, config);

  return { dir, lineRoot, workDir, otherRoot, registryPath, registrySha256, stateHome, shadowHome, configPath, config };
}

// Swap the registry after layout creation (when the custom registry needs the
// fixture's real paths), re-pinning the hash in asylumwarden.json.
export async function rewriteRegistry(fx, registry) {
  await writeJson(fx.registryPath, registry);
  fx.registry = registry;
  fx.registrySha256 = await sha256File(fx.registryPath);
  fx.config = { ...fx.config, registry_sha256: fx.registrySha256 };
  await writeJson(fx.configPath, fx.config);
  return fx;
}

// Loaded + policy-built ctx exactly as the integration layer assembles it.
export async function worldFrom(fx, { ledger = null } = {}) {
  const loaded = await loadProjectConfig({ cwd: fx.dir });
  const reg = await loadRegistry({ config: loaded.config, registryPath: loaded.registryPath });
  const policy = buildPolicy({ config: loaded.config, registry: reg.registry });
  const ctx = {
    config: loaded.config,
    registry: reg.registry,
    policy,
    sl: layout(loaded.stateHome),
    mode: loaded.config.mode,
    ledger: ledger ?? fakeLedger(),
    configSha256: loaded.configSha256,
    registrySha256: reg.registrySha256,
  };
  return { fx, loaded, reg, policy, ctx };
}

export async function makeWorld(t, opts = {}) {
  const fx = await makeLayout(t, opts);
  return worldFrom(fx);
}

export function manifestFixture(fx, over = {}) {
  const wave = fx.shadowHome !== null && fx.shadowHome !== undefined ? "shadow-w1" : "w1";
  return {
    version: 1,
    wave,
    cells: [
      {
        id: "c1",
        kind: "gen",
        line: "demo",
        cwd: fx.workDir,
        allowed_roots: [fx.workDir],
        deps: [],
      },
    ],
    ...over,
  };
}
