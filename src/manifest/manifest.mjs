// Wave manifest validation — docs/CONTRACT.md §3; pinned signature:
// docs/DESIGN-INTERNALS.md §src/manifest/manifest.mjs.
// Layering: imports node stdlib + kernel + config only; shared state (config,
// registry, policy) flows in via arguments, never via lateral imports.

import fs from "node:fs/promises";
import path from "node:path";

import { fail, violation } from "../kernel/errors.mjs";
import { matchGlob } from "../kernel/glob.mjs";
import { validateSchema } from "../kernel/schemalite.mjs";
import { containsPath } from "../config/load.mjs";
import { loadSchema } from "../config/schemas.mjs";

const CORE_KINDS = new Set(["gen", "verify", "doc", "build"]);

// Manifest paths must already be expanded (CONTRACT §1: schemas enforce ^/,
// so '~' never reaches here) and carry no '..' segments.
function normManifestPath(raw, field) {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.split("/").includes("..")) {
    fail("MANIFEST-INVALID", `${field}: must be an absolute, normalized, ~-free path: ${String(raw)}`, [
      violation(field, "manifest-path", String(raw)),
    ]);
  }
  return path.resolve(raw);
}

// Literal prefix of a glob pattern up to (exclusive) the first wildcard
// segment — the region the pattern conservatively protects.
function staticPrefix(pattern) {
  const out = [];
  for (const seg of pattern.split("/")) {
    if (seg.includes("*") || seg.includes("?")) break;
    out.push(seg);
  }
  return path.resolve(out.join("/") || "/");
}

function hasWildcard(pattern) {
  return pattern.includes("*") || pattern.includes("?");
}

function isStrictDescendant(ancestor, desc) {
  return ancestor !== desc && containsPath(ancestor, desc);
}

// Breadth analysis for one allowed root: a forbidden region strictly *inside*
// the root is a warning for relative surfaces (board-wide grants stay usable,
// CONTRACT §3) but a hard FORBIDDEN-ROOT for forbidden_absolute.
function collectBreadth(policy, registry, lineName, root, warnings, at) {
  const l = policy.line(lineName);
  const anchor = l.roots[0];
  for (const rel of l.forbiddenRel) {
    const absPattern = path.resolve(anchor, rel);
    if (matchGlob(absPattern, root)) continue; // root equal/inside the surface: already hard-rejected
    if (isStrictDescendant(root, staticPrefix(absPattern))) {
      warnings.push(violation(at, "broad-root", `allowed root ${root} contains forbidden surface ${rel}`));
    }
  }
  for (const name of Object.getOwnPropertyNames(registry.lines)) {
    for (const pattern of registry.lines[name].forbidden_absolute ?? []) {
      if (matchGlob(pattern, root)) continue; // already hard-rejected by writableRootOf
      const prefix = staticPrefix(pattern);
      if (isStrictDescendant(root, prefix) || (prefix === root && hasWildcard(pattern))) {
        fail("FORBIDDEN-ROOT", `allowed root ${root} encloses forbidden_absolute region ${pattern}`, [
          violation(at, "forbidden-root", pattern),
        ]);
      }
    }
  }
}

function assertAcyclic(cells) {
  const deps = new Map(cells.map((c) => [c.id, c.deps]));
  const mark = new Map(); // absent = unvisited, 1 = on stack, 2 = done
  for (const origin of deps.keys()) {
    if (mark.get(origin) === 2) continue;
    const stack = [{ id: origin, next: 0 }];
    const trail = [origin];
    mark.set(origin, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const list = deps.get(frame.id);
      if (frame.next >= list.length) {
        mark.set(frame.id, 2);
        stack.pop();
        trail.pop();
        continue;
      }
      const dep = list[frame.next];
      frame.next += 1;
      const m = mark.get(dep);
      if (m === 1) {
        fail("DEP-CYCLE", `dependency cycle: ${[...trail, dep].join(" -> ")}`, [
          violation("deps", "dep-cycle", dep),
        ]);
      }
      if (m === undefined) {
        mark.set(dep, 1);
        stack.push({ id: dep, next: 0 });
        trail.push(dep);
      }
    }
  }
}

export async function validateManifest(raw, { config, registry, policy }) {
  const schema = await loadSchema("manifest");
  const violations = validateSchema(schema, raw, "manifest");
  if (violations.length > 0) {
    fail("MANIFEST-INVALID", "manifest schema violations", violations);
  }
  if (config?.mode === "shadow" && !raw.wave.startsWith("shadow-")) {
    fail("SCHEMA-VIOLATION", `shadow wave id must start with "shadow-": ${raw.wave}`, [
      violation("wave", "shadow-prefix", raw.wave),
    ]);
  }

  const warnings = [];
  const cells = [];
  const ids = new Set();
  const kindTable = config?.kinds ?? {};

  for (let i = 0; i < raw.cells.length; i += 1) {
    const cell = raw.cells[i];
    const at = `cells[${i}]`;
    if (ids.has(cell.id)) {
      fail("MANIFEST-INVALID", `duplicate cell id: ${cell.id}`, [violation(`${at}.id`, "duplicate-cell-id", cell.id)]);
    }
    ids.add(cell.id);
    if (!CORE_KINDS.has(cell.kind) && !Object.hasOwn(kindTable, cell.kind)) {
      fail("UNKNOWN-KIND", `unknown kind "${cell.kind}" in ${at}`, [violation(`${at}.kind`, "unknown-kind", cell.kind)]);
    }
    if (!Object.hasOwn(registry.lines, cell.line)) {
      fail("MANIFEST-INVALID", `unknown line "${cell.line}" in ${at}`, [violation(`${at}.line`, "unknown-line", cell.line)]);
    }

    const cwd = normManifestPath(cell.cwd, `${at}.cwd`);
    const allowedRoots = cell.allowed_roots.map((r, j) => normManifestPath(r, `${at}.allowed_roots[${j}]`));
    const readRoots = (cell.read_roots ?? []).map((r, j) => normManifestPath(r, `${at}.read_roots[${j}]`));

    for (const [j, root] of allowedRoots.entries()) {
      // Hard checks: inside the line's roots; not equal to or inside a
      // forbidden surface / forbidden_absolute region.
      policy.writableRootOf(cell.line, root);
      collectBreadth(policy, registry, cell.line, root, warnings, `${at}.allowed_roots[${j}]`);
    }

    let cwdStat = null;
    try {
      cwdStat = await fs.stat(cwd);
    } catch {
      cwdStat = null;
    }
    if (cwdStat === null || !cwdStat.isDirectory()) {
      fail("PATH-ESCAPE", `cwd does not exist or is not a directory: ${cwd}`, [violation(`${at}.cwd`, "cwd-dir", cwd)]);
    }
    if (!allowedRoots.some((root) => containsPath(root, cwd))) {
      fail("PATH-ESCAPE", `cwd ${cwd} is not inside any allowed_root`, [violation(`${at}.cwd`, "cwd-containment", cwd)]);
    }

    const deps = [...cell.deps];
    const seen = new Set();
    for (const [j, dep] of deps.entries()) {
      if (seen.has(dep)) {
        fail("DEP-DUPLICATE", `duplicate dep "${dep}" in ${at}`, [violation(`${at}.deps[${j}]`, "dep-duplicate", dep)]);
      }
      seen.add(dep);
    }

    cells.push({
      id: cell.id,
      kind: cell.kind,
      line: cell.line,
      cwd,
      allowed_roots: allowedRoots,
      read_roots: readRoots,
      deps,
      role: cell.role ?? null,
      role_file: cell.role_file !== undefined && cell.role_file !== null ? normManifestPath(cell.role_file, `${at}.role_file`) : null,
      session_started_at: cell.session_started_at ?? null,
      brief: cell.brief ?? null,
      acceptance: cell.acceptance ?? null,
    });
  }

  for (const [i, cell] of cells.entries()) {
    for (const [j, dep] of cell.deps.entries()) {
      if (!ids.has(dep)) {
        fail("DEP-UNKNOWN", `dep "${dep}" of cell ${cell.id} is not in the wave`, [
          violation(`cells[${i}].deps[${j}]`, "dep-unknown", dep),
        ]);
      }
    }
  }
  assertAcyclic(cells);

  return { manifest: { version: raw.version, wave: raw.wave, cells }, violations: [], warnings };
}
