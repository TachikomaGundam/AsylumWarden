// Schema loading for the five contract schemas — docs/DESIGN-INTERNALS.md
// §src/config/schemas.mjs. Path resolved relative to src root via
// import.meta.url; results cached; cap + parse failures are INTERNAL.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { fail } from "../kernel/errors.mjs";
import { CAP_CONFIG, readJsonCapped } from "../kernel/fsutil.mjs";

// Kernel's deepNullProto nulls the prototype of arrays too, which strips
// Symbol.iterator and array methods — even schemalite's own `for (const ... of
// allOf)` then throws. Parsed artifacts must regain Array.prototype on arrays
// (objects stay null-prototype) before consumption. Prototype-pollution defense
// is unaffected: it lives in fsutil's guardKeys, which rejects the dangerous
// keys at parse time.
export function restoreArrayProtocols(node) {
  if (Array.isArray(node)) {
    Object.setPrototypeOf(node, Array.prototype);
    for (let i = 0; i < node.length; i += 1) restoreArrayProtocols(node[i]);
    return node;
  }
  if (node !== null && typeof node === "object") {
    for (const key of Object.getOwnPropertyNames(node)) restoreArrayProtocols(node[key]);
  }
  return node;
}

const SCHEMAS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
);

const KNOWN = new Set(["config", "registry", "manifest", "receipt", "ledger"]);
const cache = new Map();

export async function loadSchema(name) {
  if (!KNOWN.has(name)) {
    fail("INTERNAL", `loadSchema: unknown schema "${String(name)}"`);
  }
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const filePath = path.join(SCHEMAS_DIR, `${name}.schema.json`);
  let parsed;
  try {
    ({ value: parsed } = await readJsonCapped(filePath, CAP_CONFIG, "INTERNAL"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("INTERNAL", `loadSchema: schema file missing: ${filePath}`);
    }
    throw error;
  }
  restoreArrayProtocols(parsed);
  cache.set(name, parsed);
  return parsed;
}
