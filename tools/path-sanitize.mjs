#!/usr/bin/env node
// Host-path sanitize scanner: every tracked file's content must hold zero
// hits of the two secretlint path rules (username-bearing POSIX home path;
// Windows-path shape heuristic) plus the literal home directory string.
// This file constructs both regexes at runtime (String.fromCharCode) so it
// carries no backslash characters in its own source text. No allowlist: the
// sanitize policy is zero hits, everywhere.
// Exit codes: 0 clean, 2 hits found (file:line listing on stderr), 1 usage.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import process from "node:process";

const BS = String.fromCharCode(92); // one backslash character
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

const HOME_RE = new RegExp("[/]home[/][a-z]+[/]");
const WINPATH_RE = new RegExp(BS + BS + "[^" + BS + BS + CR + LF + "]+" + BS + BS);
const HOME_LITERAL = os.homedir();

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split(String.fromCharCode(0))
  .filter((f) => f !== "");

const hits = [];
let scanned = 0;
for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    hits.push(`${file}:0 unreadable: ${String(error?.code ?? error)}`);
    continue;
  }
  scanned += 1;
  text.split(LF).forEach((line, i) => {
    if (HOME_RE.test(line)) hits.push(`${file}:${i + 1}: home-path rule`);
    else if (WINPATH_RE.test(line)) hits.push(`${file}:${i + 1}: windows-path rule`);
    else if (line.includes(HOME_LITERAL)) hits.push(`${file}:${i + 1}: home-dir literal`);
  });
}

if (hits.length > 0) {
  process.stderr.write(`path sanitize FAIL: ${hits.length} hit(s)\n`);
  for (const h of hits) process.stderr.write(`${h}\n`);
  process.exit(2);
}
process.stdout.write(`path sanitize OK: ${scanned} tracked files, 0 hits\n`);
