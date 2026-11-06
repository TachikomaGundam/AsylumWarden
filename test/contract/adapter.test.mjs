// Contract tests for the thin opencode adapter (M3).
// Asserts the boundary rules of ARCHITECTURE.md M3 + AGENTS.md layering:
//   (a) import direction: nothing under src/ or bin/ references adapters/ —
//       proven twice: own static scan AND spawning tools/import-gate.mjs (rc 0);
//   (b) loading the plugin with a fake host registers tools whose handlers only
//       map args -> runCli argv: calling warden_status against a throwaway HOME
//       surfaces core's own CONFIG-MISSING envelope + exit 2 (mapping, not logic);
//   (c) exactly the 12 warden_* tools are registered;
//   (d) degrade: a missing host shape returns empty hooks and never throws.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const NL = "\n"; // sanitize policy: one backslash per source line

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const ADAPTER = path.join(ROOT, "adapters", "opencode", "index.js");

const EXPECTED_TOOLS = [
  "warden_init", "warden_plan", "warden_ready", "warden_claim", "warden_renew",
  "warden_release", "warden_requeue", "warden_done", "warden_fail", "warden_status",
  "warden_verify", "warden_registry_check",
];

// --- (a) import direction ----------------------------------------------------

// Sanitize policy: assembled from single-escape fragments (one backslash per
// line). Runtime regex is byte-identical except \( written as the equivalent
// class [(] — same language, no literal backslash pairs in source text.
const SEP = "\\s";
const IMPORT_SRC =
  "(?:" +
  "import" + SEP + "[^;]*?from" + SEP + "*" +
  "|import" + SEP + "*" +
  "|export" + SEP + "[^;]*?from" + SEP + "*" +
  "|require" + SEP + "*[(]" + SEP + "*" +
  ")" + `["']([^"']+)["']`;
const IMPORT_RE = new RegExp(IMPORT_SRC, "g");

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".mjs") || entry.name.endsWith(".js")) yield full;
  }
}

test("core never imports adapters/ (static scan of src/ and bin/)", async () => {
  for (const dirName of ["src", "bin"]) {
    for await (const file of walk(path.join(ROOT, dirName))) {
      const text = await fs.readFile(file, "utf8");
      for (const match of text.matchAll(IMPORT_RE)) {
        assert.ok(
          !match[1].includes("adapters"),
          `${path.relative(ROOT, file)} imports "${match[1]}" — core must never depend on adapters/`,
        );
      }
    }
  }
});

test("import gate passes with the adapter present (rc 0)", () => {
  const res = spawnSync(process.execPath, [path.join(ROOT, "tools", "import-gate.mjs")], {
    cwd: ROOT, encoding: "utf8",
  });
  assert.equal(res.status, 0, `import gate failed:\n${res.stderr}`);
});

// Strip // and /* */ comments so the scan judges code, not prose (the
// adapter's header quotes the historian SDK excerpt as documentation).
function stripComments(src) {
  let out = "";
  let i = 0;
  let quote = null; // '"' | "'" | '`' when inside a string literal
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") { out += next ?? ""; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i += 1; continue; }
    if (c === "/" && next === "/") { while (i < src.length && src[i] !== "\n") i += 1; continue; }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

test("adapter itself imports no host SDK", async () => {
  const text = stripComments(await fs.readFile(ADAPTER, "utf8"));
  for (const match of text.matchAll(IMPORT_RE)) {
    assert.ok(!match[1].startsWith("@opencode-ai"), `adapter imports host SDK "${match[1]}"`);
    assert.ok(
      match[1].startsWith("node:") || match[1].startsWith("./") || match[1].startsWith("../"),
      `adapter must import only node: builtins and core via relative paths, got "${match[1]}"`,
    );
  }
  assert.match(text, /from "[.]{2}[/][.]{2}[/]src[/]index[.]mjs"/, "adapter must enter core via src/index.mjs");
});

// --- fake host ---------------------------------------------------------------
// Shape derived from the real installed plugin opencode-wiki-historian@0.6.3
// (dist/index.js), read 2026-11-05: the package default-exports
//   const plugin = { id: 'opencode-historian', server }
// and server(input, options) resolves hooks; tool registration is the
// `tool` field: { historian_read: tool({ description, args, execute }) , ... }
// (dist/tools/read.js). input carries input.client (historian calls
// input.client.tui.showToast); options is the plugin's config object.

function fakeHostInput() {
  return {
    client: { tui: { showToast: async () => ({}) } },
    project: { id: "fake-project" },
    directory: process.cwd(),
  };
}

async function loadAdapter() {
  return import(pathToFileURL(ADAPTER).href);
}

// --- (c) tool registration ---------------------------------------------------

test("plugin registers exactly the 12 warden_* tools", async () => {
  const mod = await loadAdapter();
  assert.equal(typeof mod.default?.server, "function", "default export { id, server }");
  assert.equal(mod.default.id, "asylumwarden");
  const hooks = await mod.default.server(fakeHostInput(), {});
  const names = Object.keys(hooks.tool).sort();
  assert.deepEqual(names, [...EXPECTED_TOOLS].sort());
  for (const name of names) {
    const def = hooks.tool[name];
    assert.equal(typeof def.description, "string");
    assert.ok(def.description.length > 0);
    assert.equal(typeof def.args, "object");
    assert.equal(typeof def.execute, "function");
  }
});

// --- (b) handler = arg mapping, nothing else ---------------------------------

test("warden_status maps args -> runCli argv in-process; core answers CONFIG-MISSING exit 2", async () => {
  const mod = await loadAdapter();
  const hooks = await mod.default.server(fakeHostInput(), {});

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aw-adapter-"));
  const savedHome = process.env.HOME;
  try {
    process.env.HOME = tmp; // throwaway HOME: no config can be discovered under it
    const res = await hooks.tool.warden_status.execute({
      config: path.join(tmp, "asylumwarden.json"), // absent -> core CONFIG-MISSING
      stateHome: path.join(tmp, "state"),
    });
    assert.equal(typeof res.output, "string");
    assert.equal(res.exit, 2, `expected exit class 2 (fail closed), got ${res.exit}`);
    const envelope = JSON.parse(res.output);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, "CONFIG-MISSING"); // core's own envelope, verbatim
    // Superset of CONTRACT §8.1 failure envelope fields:
    for (const field of ["code", "message", "violations", "warnings", "degraded"]) {
      assert.ok(field in envelope, `envelope missing "${field}"`);
    }
  } finally {
    process.env.HOME = savedHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("buildArgv is a pure 1:1 param->argv mapping (no defaults, no reordering)", async () => {
  const mod = await loadAdapter();
  const specs = {
    claim: { command: ["claim"], positional: [{ key: "wave" }, { key: "cell" }],
      valueFlags: [{ key: "actor", flag: "actor" }, { key: "ttl", flag: "ttl" }, { key: "stateHome", flag: "state-home" }],
      boolFlags: [{ key: "steal", flag: "steal" }] },
  };
  assert.deepEqual(
    mod.buildArgv(specs.claim, { wave: "w1", cell: "c2", actor: "seat-a", ttl: 60, steal: true }),
    ["claim", "w1", "c2", "--actor", "seat-a", "--ttl", "60", "--steal"],
  );
  // Omitted params are simply absent — core fails closed, the adapter does not default.
  assert.deepEqual(mod.buildArgv(specs.claim, {}), ["claim"]);
  assert.deepEqual(mod.buildArgv(specs.claim, { wave: "w", cell: "c", stateHome: "/tmp/s" }),
    ["claim", "w", "c", "--state-home", "/tmp/s"]);
});

// --- (d) degrade -------------------------------------------------------------

test("missing/unexpected host shape degrades to empty hooks, never throws", async () => {
  const mod = await loadAdapter();
  for (const bad of [undefined, null, "host", 42]) {
    const hooks = await mod.default.server(bad, {});
    assert.deepEqual(hooks, {}, `server(${String(bad)}) must return empty hooks`);
  }
});
