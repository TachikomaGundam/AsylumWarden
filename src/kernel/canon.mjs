import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { fail } from "./errors.mjs";

// Canonical JSON — CONTRACT §1. Recursive stable stringify: keys sorted by
// UTF-16 code unit, arrays order-preserving, no insignificant whitespace.
export function canon(value) {
  return stableStringify(value, new Set());
}

function stableStringify(value, seen) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string" || type === "boolean") return JSON.stringify(value);
  if (type === "number") {
    if (!Number.isFinite(value)) fail("INTERNAL", "canon: non-finite number");
    return JSON.stringify(value);
  }
  if (type !== "object") fail("INTERNAL", `canon: unsupported type ${type}`);
  if (seen.has(value)) fail("INTERNAL", "canon: cyclic structure");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
    }
    const keys = Object.keys(value).sort();
    const parts = keys.map(
      (key) => `${JSON.stringify(key)}:${stableStringify(value[key], seen)}`,
    );
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function sha256Hex(bytesOrString) {
  const hash = createHash("sha256");
  hash.update(bytesOrString);
  return hash.digest("hex");
}

export function sha256Of(value) {
  return sha256Hex(canon(value));
}

export const GENESIS_PREV = "0".repeat(64);

// Streaming file digest. Callers must have already checked the entry is a
// regular file (not a symlink / directory) when containment matters.
export async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}
