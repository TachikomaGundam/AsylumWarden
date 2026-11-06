// Project config + registry loading and machine policy construction.
// Public semantics: docs/CONTRACT.md §2; pinned signatures:
// docs/DESIGN-INTERNALS.md §src/config/load.mjs.

import fs from "node:fs/promises";
import path from "node:path";

import { fail, violation } from "../kernel/errors.mjs";
import { sha256File } from "../kernel/canon.mjs";
import { CAP_CONFIG, expandHome, fileExists, readJsonCapped } from "../kernel/fsutil.mjs";
import { matchGlob } from "../kernel/glob.mjs";
import { validateSchema } from "../kernel/schemalite.mjs";
import { SAFE_ID_RE } from "../kernel/state.mjs";
import { loadSchema, restoreArrayProtocols } from "./schemas.mjs";

const CONFIG_FILENAME = "asylumwarden.json";

// Prefix-safe containment via path.relative: '/a/bc' is NOT inside '/a/b'
// (a raw string startsWith would say it is).
export function containsPath(outer, inner) {
  if (outer === inner) return true;
  const rel = path.relative(outer, inner);
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !path.isAbsolute(rel);
}

function normalizeAbs(raw, code, field) {
  if (typeof raw !== "string") {
    fail(code, `${field}: path must be a string`, [violation(field, "path-type", String(raw))]);
  }
  const expanded = expandHome(raw);
  if (!expanded.startsWith("/")) {
    fail(code, `${field}: path must be absolute or ~-anchored: ${raw}`, [violation(field, "path-absolute", raw)]);
  }
  if (expanded.split("/").includes("..")) {
    fail(code, `${field}: ".." segments are rejected: ${raw}`, [violation(field, "path-normalized", raw)]);
  }
  return path.resolve(expanded);
}

// ---------------------------------------------------------------------------
// Duplicate JSON key detection. JSON.parse silently last-wins, so a hidden
// duplicate key (CONTRACT §2.2 REGISTRY-INVALID) is invisible to the parsed
// value. The input to this scanner is always already-parsed-valid JSON, so
// only structural tracking is required.
// ---------------------------------------------------------------------------

// Host-path sanitize policy: escape sequences stay on their own line so no
// source line carries two backslashes (secretlint Windows-path rule hygiene).
const WS_CHARS = new Set([
  " ",
  "\t",
  "\n",
  "\r",
]);

export function findDuplicateKey(text) {
  const stack = [];
  let i = 0;
  let state = "value";
  const n = text.length;
  const ws = (c) => c === " " || c === "\t" || c === "\n" || c === "\r";

  const skipString = () => {
    i += 1; // opening quote
    while (i < n) {
      if (text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text[i] === '"') {
        i += 1;
        return;
      }
      i += 1;
    }
  };
  const readKey = () => {
    i += 1; // opening quote
    let out = "";
    while (i < n) {
      const c = text[i];
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') {
        i += 1;
        return out;
      }
      out += c;
      i += 1;
    }
    return out;
  };

  while (i < n && state !== "done") {
    const c = text[i];
    if (ws(c)) {
      i += 1;
      continue;
    }
    const frame = stack[stack.length - 1];
    if (state === "value") {
      if (c === "{") {
        i += 1;
        stack.push({ obj: true, keys: new Set() });
        state = "key";
        continue;
      }
      if (c === "[") {
        i += 1;
        stack.push({ obj: false, keys: null });
        state = "value";
        continue;
      }
      if (c === "]") {
        i += 1;
        stack.pop();
        state = stack.length > 0 ? "after" : "done";
        continue;
      }
      if (c === '"') {
        skipString();
        state = stack.length > 0 ? "after" : "done";
        continue;
      }
      // number / true / false / null: run to a structural delimiter
      while (i < n && !ws(text[i]) && text[i] !== "," && text[i] !== "}" && text[i] !== "]") {
        i += 1;
      }
      state = stack.length > 0 ? "after" : "done";
      continue;
    }
    if (state === "key") {
      if (c === "}") {
        i += 1;
        stack.pop();
        state = stack.length > 0 ? "after" : "done";
        continue;
      }
      const key = readKey();
      if (frame.keys.has(key)) return key;
      frame.keys.add(key);
      state = "colon";
      continue;
    }
    if (state === "colon") {
      i += 1; // ':' — input is valid JSON
      state = "value";
      continue;
    }
    // state === "after"
    if (c === ",") {
      i += 1;
      state = frame.obj ? "key" : "value";
      continue;
    }
    i += 1; // '}' or ']'
    stack.pop();
    state = stack.length > 0 ? "after" : "done";
  }
  return null;
}

export async function assertNoDuplicateKeys(filePath, code) {
  const text = await fs.readFile(filePath, "utf8");
  const key = findDuplicateKey(text);
  if (key !== null) {
    fail(code, `duplicate JSON key "${key}" in ${filePath}`, [violation(filePath, "duplicate-key", key)]);
  }
}

// ---------------------------------------------------------------------------
// Project config (CONTRACT §2.1)
// ---------------------------------------------------------------------------

async function discoverConfig(origin) {
  let dir = path.resolve(origin);
  for (;;) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (await fileExists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      fail("CONFIG-MISSING", `no ${CONFIG_FILENAME} found walking up from ${path.resolve(origin)}`, [
        violation("configPath", "discovery", origin),
      ]);
    }
    dir = parent;
  }
}

export async function loadProjectConfig({ configPath, cwd } = {}) {
  const origin = cwd ?? process.cwd();
  let resolvedPath;
  if (configPath === undefined || configPath === null) {
    resolvedPath = await discoverConfig(origin);
  } else {
    if (typeof configPath !== "string") fail("CONFIG-INVALID", "--config must be a path string");
    const expanded = expandHome(configPath);
    if (expanded.split("/").includes("..")) {
      fail("CONFIG-INVALID", `config path has ".." segments: ${configPath}`);
    }
    resolvedPath = path.resolve(origin, expanded);
  }

  let raw;
  try {
    ({ value: raw } = await readJsonCapped(resolvedPath, CAP_CONFIG, "SCHEMA-VIOLATION"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("CONFIG-MISSING", `config file not found: ${resolvedPath}`, [
        violation("configPath", "missing", resolvedPath),
      ]);
    }
    if (error?.name === "WardenError") throw error;
    fail("CONFIG-INVALID", `cannot read config ${resolvedPath}: ${error?.message}`);
  }
  restoreArrayProtocols(raw);
  const schema = await loadSchema("config");
  const violations = validateSchema(schema, raw, "config");
  if (violations.length > 0) {
    fail("SCHEMA-VIOLATION", `config schema violations in ${resolvedPath}`, violations);
  }

  // Values the schema cannot express: path normalization of load-time paths
  // (~ is tolerated only in config / registry values, CONTRACT §1).
  const registryPath = normalizeAbs(raw.registry, "CONFIG-INVALID", "registry");
  const stateHome = normalizeAbs(raw.state_home, "CONFIG-INVALID", "state_home");

  const config = raw;
  if (!Object.hasOwn(config, "kinds")) config.kinds = {};
  if (!Object.hasOwn(config, "anchor")) config.anchor = null;
  const configSha256 = await sha256File(resolvedPath);

  return { config, configPath: resolvedPath, configSha256, stateHome, registryPath };
}

// ---------------------------------------------------------------------------
// Registry (CONTRACT §2.2)
// ---------------------------------------------------------------------------

function normalizeRegistryLinePaths(decl, line) {
  for (const field of ["roots", "read_roots", "forbidden_absolute"]) {
    for (const p of decl[field] ?? []) {
      if (typeof p !== "string" || !p.startsWith("/") || p.split("/").includes("..")) {
        fail("REGISTRY-INVALID", `line ${line}: bad ${field} path: ${String(p)}`, [
          violation(`lines.${line}.${field}`, "registry-path", String(p)),
        ]);
      }
    }
  }
  // A relative forbidden_surfaces pattern must stay anchored at the line's
  // root #1; traversal toward another line's root fails closed.
  for (const p of decl.forbidden_surfaces) {
    if (p.split("/").includes("..")) {
      fail("GLOB-INVALID", `line ${line}: relative forbidden pattern may not traverse: ${p}`, [
        violation(`lines.${line}.forbidden_surfaces`, "glob-relative", p),
      ]);
    }
  }
}

export async function loadRegistry(ctxLike) {
  const config = ctxLike?.config;
  if (config === undefined || config === null) {
    fail("INTERNAL", "loadRegistry: ctxLike.config is required");
  }
  const registryPath =
    ctxLike.registryPath ?? normalizeAbs(config.registry, "REGISTRY-INVALID", "registry");

  let raw;
  try {
    ({ value: raw } = await readJsonCapped(registryPath, CAP_CONFIG, "SCHEMA-VIOLATION"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("REGISTRY-MISSING", `registry file not found: ${registryPath}`, [
        violation("registry", "missing", registryPath),
      ]);
    }
    if (error?.name === "WardenError") throw error;
    fail("REGISTRY-INVALID", `cannot read registry ${registryPath}: ${error?.message}`);
  }
  restoreArrayProtocols(raw);
  await assertNoDuplicateKeys(registryPath, "REGISTRY-INVALID");

  const registrySha256 = await sha256File(registryPath);
  if (registrySha256 !== config.registry_sha256) {
    fail(
      "CONFIG-DRIFT",
      `registry hash drift: ${registryPath} hashes to ${registrySha256}, config declares ${config.registry_sha256}`,
      [violation("registry_sha256", "drift", registryPath)],
    );
  }

  const schema = await loadSchema("registry");
  const violations = validateSchema(schema, raw, "registry");
  if (violations.length > 0) {
    fail("REGISTRY-INVALID", `registry schema violations in ${registryPath}`, violations);
  }
  for (const line of Object.getOwnPropertyNames(raw.lines)) {
    if (!SAFE_ID_RE.test(line)) {
      fail("REGISTRY-INVALID", `bad line name: ${line}`, [violation(`lines.${line}`, "safe-id", line)]);
    }
    normalizeRegistryLinePaths(raw.lines[line], line);
  }
  await validateRegistrySemantics(raw, config);

  return { registry: raw, registryPath, registrySha256 };
}

export async function validateRegistrySemantics(registry, config) {
  const all = []; // {line, root} — every normalized root across the registry
  for (const line of Object.getOwnPropertyNames(registry.lines)) {
    const roots = registry.lines[line].roots.map((r) => path.resolve(expandHome(r)));
    for (const root of roots) {
      let stat = null;
      try {
        stat = await fs.stat(root);
      } catch {
        stat = null;
      }
      if (stat === null || !stat.isDirectory()) {
        fail("ROOT-MISSING", `line ${line}: root missing or not a directory: ${root}`, [
          violation(`lines.${line}.roots`, "root-missing", root),
        ]);
      }
      all.push({ line, root });
    }
  }

  // Equal-or-contains across every pair — within one line and across lines.
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      if (containsPath(all[i].root, all[j].root) || containsPath(all[j].root, all[i].root)) {
        fail(
          "ROOTS-OVERLAP",
          `roots overlap: ${all[i].line}:${all[i].root} vs ${all[j].line}:${all[j].root}`,
          [violation("lines", "roots-overlap", `${all[i].root} / ${all[j].root}`)],
        );
      }
    }
  }

  if (config?.mode !== "shadow") return;

  const shadowHome = normalizeAbs(config.shadow_home, "CONFIG-INVALID", "shadow_home");
  const stateHome = normalizeAbs(config.state_home, "CONFIG-INVALID", "state_home");
  if (stateHome !== shadowHome) {
    fail("CONFIG-INVALID", `shadow mode: state_home (${stateHome}) must equal shadow_home (${shadowHome})`, [
      violation("state_home", "shadow-home-match", shadowHome),
    ]);
  }
  const registryPath = normalizeAbs(config.registry, "CONFIG-INVALID", "registry");
  const expected = path.join(shadowHome, "shadow-registry.json");
  if (registryPath !== expected) {
    fail("CONFIG-INVALID", `shadow mode: registry must be ${expected}, got ${registryPath}`, [
      violation("registry", "shadow-registry-path", registryPath),
    ]);
  }

  // Shadow containment (CONTRACT §2.1 / §2.2 / §10). Protected surfaces are
  // config values (`protect`, possibly empty), never code constants; normal
  // mode forbids the key itself via the config schema (additionalProperties).
  if (!Array.isArray(config.protect)) {
    fail("CONFIG-INVALID", "shadow mode: config.protect is required (array of absolute paths, possibly empty)", [
      violation("protect", "shadow-protect-required", typeof config.protect),
    ]);
  }
  const protectedRoots = config.protect.map((p, i) => normalizeAbs(p, "CONFIG-INVALID", `protect[${i}]`));
  for (const { line, root } of all) {
    for (const prot of protectedRoots) {
      if (containsPath(root, prot)) {
        fail("FORBIDDEN-ROOT", `shadow mode: line ${line} root ${root} equals or contains protected root ${prot}`, [
          violation(`lines.${line}.roots`, "forbidden-root", root),
        ]);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Machine policy (DESIGN-INTERNALS §src/config: buildPolicy)
// ---------------------------------------------------------------------------

export function buildPolicy({ config, registry }) {
  if (config === undefined || config === null) fail("INTERNAL", "buildPolicy: config is required");
  if (registry === undefined || registry === null) fail("INTERNAL", "buildPolicy: registry is required");
  const shadowMode = config.mode === "shadow";
  const lineCache = new Map();

  function line(name) {
    if (!Object.hasOwn(registry.lines, name)) {
      fail("REGISTRY-INVALID", `unknown line: ${String(name)}`, [
        violation("line", "unknown-line", String(name)),
      ]);
    }
    let built = lineCache.get(name);
    if (built === undefined) {
      const decl = registry.lines[name];
      built = {
        name,
        roots: decl.roots.map((r) => path.resolve(expandHome(r))),
        forbiddenRel: [...(decl.forbidden_surfaces ?? [])],
        forbiddenAbs: [...(decl.forbidden_absolute ?? [])],
        readRoots: [...(decl.read_roots ?? [])].map((r) => path.resolve(expandHome(r))),
      };
      lineCache.set(name, built);
    }
    return built;
  }

  function forbiddenHit(absPath, lineName) {
    const l = line(lineName);
    const target = path.resolve(absPath);
    for (const pattern of l.forbiddenRel) {
      if (matchGlob(path.resolve(l.roots[0], pattern), target)) return pattern;
    }
    for (const pattern of l.forbiddenAbs) {
      if (matchGlob(pattern, target)) return pattern;
    }
    return null;
  }

  // forbidden_absolute protects surfaces "regardless of which line touches
  // them" (CONTRACT §2.2), so foreign lines' absolute patterns gate too.
  function globalForbiddenHit(absPath, exceptLine) {
    const target = path.resolve(absPath);
    for (const name of Object.getOwnPropertyNames(registry.lines)) {
      if (name === exceptLine) continue;
      for (const pattern of registry.lines[name].forbidden_absolute ?? []) {
        if (matchGlob(pattern, target)) return pattern;
      }
    }
    return null;
  }

  function writableRootOf(lineName, absRoot) {
    const l = line(lineName);
    const root = path.resolve(absRoot);
    if (!l.roots.some((outer) => containsPath(outer, root))) {
      fail("PATH-ESCAPE", `writable root ${root} is outside line ${lineName} roots`, [
        violation("allowed_roots", "path-escape", root),
      ]);
    }
    const hit = forbiddenHit(root, lineName) ?? globalForbiddenHit(root, lineName);
    if (hit !== null) {
      fail("FORBIDDEN-ROOT", `writable root ${root} matches forbidden pattern ${hit}`, [
        violation("allowed_roots", "forbidden-root", hit),
      ]);
    }
    return root;
  }

  // Containment must follow symlinks (escape via a symlinked directory must
  // fail). For a not-yet-existing tail, resolve the deepest existing ancestor.
  // A path component that exists to lstat() but cannot be realpath()'d (dangling
  // or looping symlink) is unprovable and therefore an escape.
  async function realpathDeepest(absPath) {
    const target = path.resolve(absPath);
    let current = target;
    for (;;) {
      try {
        const real = await fs.realpath(current);
        // mapped: the deepest-existing-ancestor resolution re-anchored on the
        // original tail, so callers still see the full logical path.
        const rest = current === target ? "" : path.relative(current, target);
        return { real, mapped: rest === "" ? real : path.join(real, rest) };
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
          let dangling = null;
          try {
            dangling = await fs.lstat(current);
          } catch {
            dangling = null;
          }
          if (dangling !== null) {
            fail("PATH-ESCAPE", `unresolvable symlink in path: ${current}`, [
              violation("path", "symlink-escape", current),
            ]);
          }
          const parent = path.dirname(current);
          if (parent === current) {
            fail("PATH-ESCAPE", `cannot resolve any existing ancestor of ${target}`, [
              violation("path", "path-escape", target),
            ]);
          }
          current = parent;
          continue;
        }
        fail("PATH-ESCAPE", `cannot resolve ${current}: ${error?.message ?? "fs error"}`, [
          violation("path", "path-escape", current),
        ]);
      }
    }
  }

  async function artifactOk(absPath, cell) {
    const { real, mapped } = await realpathDeepest(absPath);
    const hit = forbiddenHit(real, cell.line) ?? globalForbiddenHit(real, cell.line);
    if (hit !== null) {
      fail("FORBIDDEN-SURFACE", `artifact ${real} matches forbidden pattern ${hit}`, [
        violation("artifact", "forbidden-surface", hit),
      ]);
    }
    const roots = cell.allowed_roots ?? [];
    if (!roots.some((root) => containsPath(path.resolve(root), real))) {
      fail("PATH-ESCAPE", `artifact ${real} is not inside any allowed_root of cell ${String(cell.id)}`, [
        violation("artifact", "path-escape", real),
      ]);
    }
    return mapped;
  }

  async function readOk(absPath, cell, lineName) {
    const { real } = await realpathDeepest(absPath);
    const l = line(lineName);
    const zones = [...(cell.allowed_roots ?? []), ...(cell.read_roots ?? []), ...l.readRoots];
    return zones.some((zone) => containsPath(path.resolve(zone), real));
  }

  return {
    mode: config.mode ?? null,
    shadowHome: shadowMode ? path.resolve(expandHome(config.shadow_home)) : null,
    line,
    forbiddenHit,
    writableRootOf,
    artifactOk,
    readOk,
  };
}
