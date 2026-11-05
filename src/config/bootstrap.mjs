// Registry bootstrap — creates an ABSENT machine registry from explicit
// operator inputs, then prints registry_sha256 for the operator to reference
// from asylumwarden.json. It never edits config files (config is the
// operator's declaration) and never overwrites without --force.

import path from "node:path";

import { fail, violation } from "../kernel/errors.mjs";
import { atomicWriteJson, expandHome, fileExists } from "../kernel/fsutil.mjs";
import { sha256Hex } from "../kernel/canon.mjs";
import { SAFE_ID_RE } from "../kernel/state.mjs";

export async function bootstrapRegistry({ registryPath, self, root, force = false }) {
  if (!self || !SAFE_ID_RE.test(self)) {
    fail("USAGE", "--self must be a safe id", [violation("--self", "safe-id", String(self))]);
  }
  if (!root) {
    fail("USAGE", "--root is required with --bootstrap-registry", [violation("--root", "required", "")]);
  }
  const absRoot = path.normalize(expandHome(root));
  const absRegistry = path.normalize(expandHome(registryPath));
  if ((await fileExists(absRegistry)) && !force) {
    fail("USAGE", `registry already exists: ${absRegistry} (use --force to replace)`, [
      violation("registry", "exists", absRegistry),
    ]);
  }
  const registry = {
    version: 1,
    lines: {
      [self]: { roots: [absRoot], forbidden_surfaces: [] },
    },
  };
  await atomicWriteJson(absRegistry, registry);
  const bytes = await (await import("node:fs/promises")).readFile(absRegistry);
  return { registryPath: absRegistry, sha256: sha256Hex(bytes) };
}
