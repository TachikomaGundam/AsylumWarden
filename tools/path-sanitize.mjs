#!/usr/bin/env node
// Repo invariant: the machine's real home directory and its username must
// not appear in tracked content. This is a privacy invariant about THIS
// repo's contents — deliberately narrower than any external scanner's
// pattern set: source code may legitimately contain generic /home/<user>/
// examples, regex classes, or escaped backslashes, and repo code must never
// be reshaped to satisfy a scanner's incidental pattern quirks. Gate checks
// belong at the gate (border runs at push time); this script guards the
// invariant that holds regardless of any tool: real host identity stays out.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const home = os.homedir(); // e.g. /home/<user>
const username = path.basename(home);

const HOME_TOKEN = new RegExp(`/home/${username}(?![A-Za-z0-9_-])`);
const HOME_RE = new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT })
  .toString("utf8")
  .split("\0")
  .filter((f) => f.length > 0);

const hits = [];
for (const rel of files) {
  let text;
  try {
    text = fs.readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    continue; // binary or unreadable: not text content
  }
  text.split(/\r?\n/).forEach((line, i) => {
    if (HOME_RE.test(line) || HOME_TOKEN.test(line)) {
      hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
    }
  });
}

if (hits.length > 0) {
  process.stderr.write(`host-identity leak: ${hits.length} hit(s)\n${hits.join("\n")}\n`);
  process.exit(2);
}
process.stdout.write(`host-identity check OK: ${files.length} tracked files, zero real-home/username hits\n`);
