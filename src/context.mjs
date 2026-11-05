// Context assembly — the only place that wires modules together.
// Layering: context may import every core module; modules never import this.

import path from "node:path";

import { fail } from "./kernel/errors.mjs";
import { expandHome } from "./kernel/fsutil.mjs";
import { layout } from "./kernel/state.mjs";
import { loadProjectConfig, loadRegistry, validateRegistrySemantics, buildPolicy } from "./config/load.mjs";
import { openLedger } from "./ledger/chain.mjs";
import { maybeAnchor } from "./ledger/anchor.mjs";

export async function makeContext({ configPath, cwd = process.cwd(), stateHome } = {}) {
  const loaded = await loadProjectConfig({ configPath, cwd });
  const registry = await loadRegistry(loaded);
  await validateRegistrySemantics(registry.registry, loaded.config);
  const policy = buildPolicy({ config: loaded.config, registry: registry.registry });
  const sl = layout(stateHome ?? loaded.stateHome);
  const ledger = openLedger({ sl, config: loaded.config });

  const ctx = {
    config: loaded.config,
    configPath: loaded.configPath,
    configSha256: loaded.configSha256,
    registry: registry.registry,
    registryPath: registry.registryPath,
    registrySha256: registry.registrySha256,
    policy,
    sl,
    mode: loaded.config.mode,
    stateHome: sl.stateHome,
    ledger,
    // Append + opportunistic anchor in one call; every state mutation uses it.
    async appendEvent(type, fields) {
      const entry = await ledger.append(type, fields);
      let degraded = null;
      try {
        degraded = (await maybeAnchor(ctx)).degraded ?? null;
      } catch {
        degraded = "ANCHOR-DEGRADED"; // anchor bookkeeping must never mask the real event
      }
      return { entry, degraded };
    },
  };
  return ctx;
}

export function expandPaths(list) {
  return list.map((p) => path.normalize(expandHome(p)));
}
