import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fail, violation } from "./errors.mjs";

export const CAP_CONFIG = 1_048_576; // 1 MiB — config / registry / manifest / receipt
export const CAP_LINE = 262_144; // 256 KiB — one ledger line
export const CAP_STRING = 4096;

export function nowIso() {
  return new Date().toISOString().replace(/(\.\d{3})Z$/, "$1Z");
}

export function expandHome(raw) {
  if (typeof raw !== "string") fail("INTERNAL", "expandHome: non-string path");
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function guardKeys(node, where) {
  if (node === null || typeof node !== "object") return;
  for (const key of Object.getOwnPropertyNames(node)) {
    if (FORBIDDEN_KEYS.has(key)) {
      fail("SCHEMA-VIOLATION", `forbidden key ${key} at ${where}`, [
        violation(where, "forbidden-key", key),
      ]);
    }
  }
  for (const key of Object.getOwnPropertyNames(node)) {
    guardKeys(node[key], `${where}.${key}`);
  }
}

// Read + parse with size cap, null prototype, and forbidden-key rejection.
// codeOnBad selects the code family: state files are STATE-CORRUPT,
// user-supplied JSON is SCHEMA-VIOLATION.
export async function readJsonCapped(filePath, cap = CAP_CONFIG, codeOnBad = "STATE-CORRUPT") {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) {
      fail(codeOnBad, `not a regular file: ${filePath}`, [violation(filePath, "not-file", "")]);
    }
    if (stat.size > cap) {
      fail(codeOnBad, `file exceeds ${cap} byte cap: ${filePath}`, [
        violation(filePath, "size-cap", String(stat.size)),
      ]);
    }
    const text = await handle.readFile({ encoding: "utf8" });
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail(codeOnBad, `unparseable JSON: ${filePath}`, [violation(filePath, "json-parse", "")]);
    }
    guardKeys(parsed, path.basename(filePath));
    return { value: deepNullProto(parsed), size: stat.size };
  } catch (error) {
    if (error && error.code === "ENOENT") throw error;
    if (error && error.name === "WardenError") throw error;
    fail(codeOnBad, `cannot read ${filePath}: ${error.message}`, [
      violation(filePath, "read-error", error.message),
    ]);
  } finally {
    await handle?.close();
  }
}

function deepNullProto(node) {
  if (node === null || typeof node !== "object") return node;
  // Arrays keep Array.prototype: JSON arrays cannot carry __proto__ via
  // index keys, and consumers legitimately call .map/.filter/.every.
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) node[i] = deepNullProto(node[i]);
    return node;
  }
  for (const key of Object.getOwnPropertyNames(node)) {
    node[key] = deepNullProto(node[key]);
  }
  Object.setPrototypeOf(node, null);
  return node;
}

// Atomic JSON write: tmp (same dir) → full write → fsync → rename → re-read.
export async function atomicWriteJson(filePath, value) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`,
  );
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  let handle;
  try {
    handle = await fs.open(tmp, "w", 0o600);
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle?.close();
  }
  try {
    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    fail("INTERNAL", `atomic rename failed for ${filePath}: ${error.message}`);
  }
  // Read-back verification per write protocol.
  const back = await fs.readFile(filePath, "utf8");
  if (back !== payload) {
    fail("INTERNAL", `atomic write read-back mismatch: ${filePath}`);
  }
}

export async function ensureDir(dirPath, mode = 0o700) {
  await fs.mkdir(dirPath, { recursive: true, mode });
}

export async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export function pidAlive(pid, host) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (host !== os.hostname()) {
    // Cannot probe foreign hosts: assume alive; expiry is time-gated.
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export { existsSync };
