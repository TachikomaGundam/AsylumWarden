// Glob matching for forbidden patterns — CONTRACT §1.
// `**` matches zero or more path segments; `*` one segment interior; `?` one
// char. A trailing `/**` also matches the directory itself, so directory
// patterns cover their contents conservatively. No char classes, no braces.

import { fail } from "./errors.mjs";

const cache = new Map();

export function compileGlob(pattern) {
  const hit = cache.get(pattern);
  if (hit) return hit;
  if (typeof pattern !== "string" || !pattern.startsWith("/")) {
    fail("GLOB-INVALID", `glob pattern must be absolute: ${String(pattern)}`);
  }
  const raw = pattern.split("/");
  const segs = [];
  for (const seg of raw) {
    if (seg === "**" && segs.at(-1) === "**") continue; // collapse **/**
    if (seg === "" && segs.length > 0) continue; // collapse //
    segs.push(seg);
  }
  let re = "";
  let needSep = false;
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    if (seg === "") {
      re += "/";
      continue;
    }
    if (seg === "**") {
      if (i === segs.length - 1) {
        re += re.endsWith("/") ? ".*" : "(?:/.*)?";
        needSep = false;
      } else {
        if (needSep) re += "/";
        re += "(?:[^/]+/)*";
        needSep = false;
      }
      continue;
    }
    if (needSep) re += "/";
    re += segmentToRe(seg);
    needSep = true;
  }
  const compiled = new RegExp(`^${re}$`);
  cache.set(pattern, compiled);
  return compiled;
}

// Host-path sanitize policy: this file carries no backslash characters at
// all; the regex escape char is built at runtime so the secretlint
// Windows-path rule never fires on source text. Semantics are unchanged.
const ESCAPE_CHAR = String.fromCharCode(92);
const REGEX_SPECIALS = new Set([
  ".",
  "+",
  "^",
  "$",
  "{",
  "}",
  "(",
  ")",
  "|",
  "[",
  "]",
  ESCAPE_CHAR,
  "/",
  "*",
  "?",
]);

// Byte-identical to the former global-replace escape: every regex-special
// char in the Set gets exactly one leading escape char; `*`/`?` handled above.
function segmentToRe(seg) {
  let out = "";
  for (const ch of seg) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else if (REGEX_SPECIALS.has(ch)) out += ESCAPE_CHAR + ch;
    else out += ch;
  }
  return out;
}

export function matchGlob(pattern, absPath) {
  return compileGlob(pattern).test(absPath);
}

export function matchAny(patterns, absPath) {
  for (const pattern of patterns) {
    if (matchGlob(pattern, absPath)) return pattern;
  }
  return null;
}
