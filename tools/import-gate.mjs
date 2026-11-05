#!/usr/bin/env node
// Import gate — AGENTS.md: core (src/, bin/) is zero-dependency Node stdlib.
// Allowed specifiers: node: builtins and relative paths (./ ../). Anything
// bare (npm package) or host-SDK names fails the build. adapters/ is exempt
// by design (adapters may import host SDKs; the reverse is forbidden and is
// checked by the adapters-direction rule below).

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");

const FORBIDDEN_SUBSTRINGS = [
  "@opencode-ai",
  "opencode",
  "oh-my-openagent",
  "@anthropic-ai",
  "@openai",
  "@google/generative-ai",
  "langchain",
];

const IMPORT_RE =
  /(?:import\s[^;]*?from\s*|import\s*|export\s[^;]*?from\s*|require\s*\(\s*)["']([^"']+)["']/g;

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".mjs") || entry.name.endsWith(".js")) yield full;
  }
}

const violations = [];

for (const dirName of ["src", "bin"]) {
  const dir = path.join(ROOT, dirName);
  try {
    await fs.stat(dir);
  } catch {
    continue; // dir may not exist yet in early phases
  }
  for await (const file of walk(dir)) {
    const text = await fs.readFile(file, "utf8");
    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[1];
      if (spec.startsWith("node:")) continue;
      if (spec.startsWith("./") || spec.startsWith("../")) {
        // core must never reach into adapters/ even via a relative path
        if (spec.includes("adapters")) {
          violations.push(`${file}: core reaches into adapters/ via ${spec}`);
        }
        continue;
      }
      violations.push(`${file}: non-stdlib import "${spec}"`);
    }
    for (const banned of FORBIDDEN_SUBSTRINGS) {
      // match host-SDK names even inside dynamic strings that look like imports
      if (new RegExp(`["'][^"']*${banned}`).test(text)) {
        violations.push(`${file}: host SDK reference "${banned}"`);
      }
    }
  }
}

// package.json runtime dependencies must stay empty (product promise).
const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
  const deps = pkg[field];
  if (deps && Object.keys(deps).length > 0) {
    violations.push(`package.json: ${field} must stay empty (zero-dep promise)`);
  }
}

if (violations.length > 0) {
  process.stderr.write(`import gate FAIL\n${violations.join("\n")}\n`);
  process.exit(2);
}
process.stdout.write("import gate OK: src/ and bin/ are node:stdlib+relative only; zero runtime deps\n");
