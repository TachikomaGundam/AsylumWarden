#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const WORK_DIRS = new Set(["handoffs", "dockets", "work", "workfiles", "notes", "sessions", "tmp"]);
const WORK_NAME = /(handoff|docket|session-close|worklog)/i;

function classify(path) {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  if (parts.some((part) => WORK_DIRS.has(part.toLowerCase()))) return "work-directory";
  if (WORK_NAME.test(parts.at(-1) ?? "")) return "work-file-name";
  return null;
}

const listed = spawnSync("git", ["ls-files", "-z"], { cwd: process.cwd(), encoding: "utf8" });
if (listed.status !== 0) {
  process.stderr.write(`WORKFILE-GATE ERROR ${listed.stderr?.trim() || "git ls-files failed"}\n`);
  process.exit(2);
}
const violations = listed.stdout
  .split("\0")
  .filter(Boolean)
  .map((path) => ({ path, reason: classify(path) }))
  .filter((item) => item.reason);

if (violations.length) {
  for (const item of violations) {
    process.stderr.write(`WORKFILE-GATE FAIL ${item.path} (${item.reason})\n`);
  }
  process.stderr.write(`WORKFILE-GATE FAIL violations=${violations.length}; move work artifacts out of the product repo\n`);
  process.exit(1);
}
process.stdout.write("WORKFILE-GATE OK\n");
