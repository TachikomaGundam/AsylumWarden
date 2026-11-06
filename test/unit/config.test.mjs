// Unit tests: src/config (CONTRACT §1/§2; M1 adversarial list)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildPolicy,
  containsPath,
  findDuplicateKey,
  loadProjectConfig,
  loadRegistry,
  validateRegistrySemantics,
} from "../../src/config/load.mjs";
import { makeLayout, rewriteRegistry, tempRoot, writeJson } from "../helpers.mjs";

// Host-path sanitize policy: no source line may hold two backslashes, so the
// regex escape for \s lives in one constant on its own line.
const SEP = "\\s";

async function expectFail(fn, code) {
  try {
    await fn();
  } catch (error) {
    assert.equal(error?.name, "WardenError", `expected WardenError, got: ${error}`);
    assert.equal(error.code, code);
    assert.ok(Array.isArray(error.violations), "violations must be an array");
    return error;
  }
  assert.fail(`expected fail-closed ${code}, but call succeeded`);
}

// ---------------------------------------------------------------------------
// loadProjectConfig
// ---------------------------------------------------------------------------

test("config discovery walks up from cwd and returns expanded top-level paths", async (t) => {
  const fx = await makeLayout(t);
  const deep = path.join(fx.workDir, "a", "b", "c");
  await fs.mkdir(deep, { recursive: true });
  const loaded = await loadProjectConfig({ cwd: deep });
  assert.equal(loaded.configPath, fx.configPath);
  assert.equal(loaded.stateHome, fx.stateHome);
  assert.equal(loaded.registryPath, fx.registryPath);
  assert.equal(loaded.config.mode, "normal");
  assert.ok(loaded.config.kinds.custom, "kinds default/retain");
  assert.equal(loaded.config.anchor, null);
  assert.match(loaded.configSha256, /^[0-9a-f]{64}$/);
});

test("explicit configPath bypasses discovery; missing file is CONFIG-MISSING", async (t) => {
  const fx = await makeLayout(t);
  const loaded = await loadProjectConfig({ configPath: fx.configPath, cwd: os.tmpdir() });
  assert.equal(loaded.configPath, fx.configPath);
  await expectFail(
    () => loadProjectConfig({ configPath: path.join(fx.dir, "nope.json"), cwd: fx.dir }),
    "CONFIG-MISSING",
  );
});

test("no asylumwarden.json anywhere up the tree is CONFIG-MISSING", async (t) => {
  const dir = await tempRoot(t);
  await expectFail(() => loadProjectConfig({ cwd: dir }), "CONFIG-MISSING");
});

test("unknown config key fails closed SCHEMA-VIOLATION (exit 2)", async (t) => {
  const fx = await makeLayout(t);
  await writeJson(fx.configPath, { ...fx.config, bogus: 1 });
  const err = await expectFail(() => loadProjectConfig({ cwd: fx.dir }), "SCHEMA-VIOLATION");
  assert.equal(err.exitClass, 2);
  assert.ok(err.violations.length > 0);
});

test("malformed config values fail closed", async (t) => {
  const fx = await makeLayout(t);
  await writeJson(fx.configPath, { ...fx.config, version: 2 });
  await expectFail(() => loadProjectConfig({ cwd: fx.dir }), "SCHEMA-VIOLATION");
  await writeJson(fx.configPath, { ...fx.config, registry_sha256: "XYZ" });
  await expectFail(() => loadProjectConfig({ cwd: fx.dir }), "SCHEMA-VIOLATION");
  await writeJson(fx.configPath, { ...fx.config, mode: "sideways" });
  await expectFail(() => loadProjectConfig({ cwd: fx.dir }), "SCHEMA-VIOLATION");
  await writeJson(fx.configPath, { ...fx.config, state_home: "relative/path" });
  await expectFail(() => loadProjectConfig({ cwd: fx.dir }), "SCHEMA-VIOLATION");
});

test("'..' segments in config paths are rejected CONFIG-INVALID", async (t) => {
  const fx = await makeLayout(t);
  await writeJson(fx.configPath, { ...fx.config, state_home: `${fx.dir}/../escape` });
  await expectFail(() => loadProjectConfig({ cwd: fx.dir }), "CONFIG-INVALID");
});

test("'~' expansion happens at load time for config values", async (t) => {
  const fx = await makeLayout(t);
  await writeJson(fx.configPath, {
    ...fx.config,
    state_home: "~/aw-state-test-nonexistent",
    registry: "~/.aw-nonexistent/registry.json",
  });
  const loaded = await loadProjectConfig({ cwd: fx.dir });
  assert.equal(loaded.stateHome, path.join(os.homedir(), "aw-state-test-nonexistent"));
  assert.equal(loaded.registryPath, path.join(os.homedir(), ".aw-nonexistent/registry.json"));
  const err = await expectFail(
    () => loadRegistry({ config: loaded.config, registryPath: loaded.registryPath }),
    "REGISTRY-MISSING",
  );
  assert.ok(err.message.includes(os.homedir()), "expanded path must reach the error message");
});

// ---------------------------------------------------------------------------
// loadRegistry + semantics
// ---------------------------------------------------------------------------

test("registry loads by hash pin; byte drift is CONFIG-DRIFT", async (t) => {
  const fx = await makeLayout(t);
  const loaded = await loadProjectConfig({ cwd: fx.dir });
  const reg = await loadRegistry({ config: loaded.config, registryPath: loaded.registryPath });
  assert.equal(reg.registrySha256, fx.registrySha256);
  assert.equal(reg.registryPath, fx.registryPath);

  await fs.appendFile(fx.registryPath, "\n", "utf8"); // any byte change breaks the pin
  await expectFail(
    () => loadRegistry({ config: loaded.config, registryPath: loaded.registryPath }),
    "CONFIG-DRIFT",
  );
});

test("absent registry is REGISTRY-MISSING", async (t) => {
  const fx = await makeLayout(t);
  await expectFail(
    () => loadRegistry({ config: fx.config, registryPath: path.join(fx.dir, "ghost.json") }),
    "REGISTRY-MISSING",
  );
});

test("bad line name is REGISTRY-INVALID", async (t) => {
  const fx = await makeLayout(t, {
    registry: { version: 1, lines: { "Bad Line!": { roots: ["/aw-nonexistent"], forbidden_surfaces: [] } } },
  });
  const loaded = await loadProjectConfig({ cwd: fx.dir });
  await expectFail(
    () => loadRegistry({ config: loaded.config, registryPath: loaded.registryPath }),
    "REGISTRY-INVALID",
  );
});

test("duplicate JSON keys in registry fail closed REGISTRY-INVALID", async (t) => {
  const fx = await makeLayout(t);
  const text = await fs.readFile(fx.registryPath, "utf8");
  // Second "lines" key after the first closes; JSON.parse would silently last-win.
  const injected = text.replace(
    new RegExp("[}]" + SEP + "*[}]" + SEP + "*$"),
    '}, "lines": { "demo": { "roots": ["/tmp"], "forbidden_surfaces": [] } } }',
  );
  assert.notEqual(injected, text, "fixture injection must land");
  await fs.writeFile(fx.registryPath, injected, "utf8");
  const loaded = await loadProjectConfig({ cwd: fx.dir });
  await expectFail(
    () => loadRegistry({ config: loaded.config, registryPath: loaded.registryPath }),
    "REGISTRY-INVALID",
  );
});

test("findDuplicateKey: valid nesting, strings, siblings vs real duplicates", () => {
  assert.equal(findDuplicateKey('{"a":{"b":1},"b":2}'), null);
  assert.equal(findDuplicateKey('[{"k":1},{"k":2}]'), null);
  assert.equal(findDuplicateKey('{"a":"brace } and comma , and quote \\" here"}'), null);
  assert.equal(findDuplicateKey('{"a":[1,2,{"z":1,"z":2}]}'), "z");
  assert.equal(findDuplicateKey('{"a":1,"a":2}'), "a");
});

test("ROOT-MISSING: root absent or not a directory", async (t) => {
  const fx = await makeLayout(t);
  const fileNotDir = path.join(fx.dir, "notadir");
  await fs.writeFile(fileNotDir, "x", "utf8");
  await expectFail(
    () =>
      validateRegistrySemantics(
        { version: 1, lines: { demo: { roots: [path.join(fx.dir, "ghost")], forbidden_surfaces: [] } } },
        fx.config,
      ),
    "ROOT-MISSING",
  );
  await expectFail(
    () =>
      validateRegistrySemantics(
        { version: 1, lines: { demo: { roots: [fileNotDir], forbidden_surfaces: [] } } },
        fx.config,
      ),
    "ROOT-MISSING",
  );
});

test("ROOTS-OVERLAP: equal / contains, across and within lines; sibling prefixes are legal", async (t) => {
  const fx = await makeLayout(t);
  const b = path.join(fx.dir, "b");
  const bc = path.join(fx.dir, "bc");
  const bSub = path.join(b, "sub");
  await fs.mkdir(bc, { recursive: true });
  await fs.mkdir(bSub, { recursive: true });

  // '/dir/b' vs '/dir/bc' must NOT overlap (string startsWith would lie).
  await validateRegistrySemantics(
    {
      version: 1,
      lines: {
        one: { roots: [b], forbidden_surfaces: [] },
        two: { roots: [bc], forbidden_surfaces: [] },
      },
    },
    fx.config,
  );
  assert.equal(containsPath(b, bc), false);

  await expectFail(
    () =>
      validateRegistrySemantics(
        {
          version: 1,
          lines: { one: { roots: [b], forbidden_surfaces: [] }, two: { roots: [`${b}/`], forbidden_surfaces: [] } },
        },
        fx.config,
      ),
    "ROOTS-OVERLAP",
  );
  // parent contains child
  await expectFail(
    () =>
      validateRegistrySemantics(
        {
          version: 1,
          lines: { one: { roots: [b], forbidden_surfaces: [] }, two: { roots: [bSub], forbidden_surfaces: [] } },
        },
        fx.config,
      ),
    "ROOTS-OVERLAP",
  );
  // within a single line
  await expectFail(
    () => validateRegistrySemantics({ version: 1, lines: { one: { roots: [b, bSub], forbidden_surfaces: [] } } }, fx.config),
    "ROOTS-OVERLAP",
  );
});

test("relative forbidden_surfaces may not traverse toward another root: GLOB-INVALID", async (t) => {
  // The traversal check precedes existence checks, so a literal root is fine.
  const fx = await makeLayout(t, {
    registry: {
      version: 1,
      lines: { demo: { roots: ["/aw-nonexistent"], forbidden_surfaces: ["../other/secret"] } },
    },
  });
  const loaded = await loadProjectConfig({ cwd: fx.dir });
  await expectFail(
    () => loadRegistry({ config: loaded.config, registryPath: loaded.registryPath }),
    "GLOB-INVALID",
  );
});

// ---------------------------------------------------------------------------
// Shadow rules (CONTRACT §2.2 / §10)
// ---------------------------------------------------------------------------

test("shadow layout validates cleanly (sanity)", async (t) => {
  const fx = await makeLayout(t, { shadow: true });
  const loaded = await loadProjectConfig({ cwd: fx.dir });
  const reg = await loadRegistry({ config: loaded.config, registryPath: loaded.registryPath });
  assert.equal(reg.registryPath, path.join(fx.shadowHome, "shadow-registry.json"));
});

test("shadow: state_home must equal shadow_home", async (t) => {
  const fx = await makeLayout(t, { shadow: true, configOverrides: { state_home: "/somewhere/else" } });
  await expectFail(() => loadProjectConfig({ cwd: fx.dir }).then((l) => loadRegistry(l)), "CONFIG-INVALID");
});

test("shadow: registry must be <shadow_home>/shadow-registry.json", async (t) => {
  const fx = await makeLayout(t, { shadow: true });
  const loaded = await loadProjectConfig({ cwd: fx.dir });
  const reg = await loadRegistry(loaded);
  const tampered = { ...loaded.config, registry: path.join(fx.dir, "registry.json") };
  await expectFail(() => validateRegistrySemantics(reg.registry, tampered), "CONFIG-INVALID");
});

test("shadow: roots equal to or containing a protect entry are FORBIDDEN-ROOT", async (t) => {
  // Protected roots are config values (CONTRACT §2.1): the fixture declares
  // protect: [<tmp>/protected-root]; equal AND containing roots both fail.
  for (const pick of ["equal", "containing"]) {
    const fx = await makeLayout(t, { shadow: true });
    const root = pick === "equal" ? fx.protectedRoot : fx.dir;
    await rewriteRegistry(fx, {
      version: 1,
      lines: { pcb: { roots: [root], forbidden_surfaces: [], forbidden_absolute: [], read_roots: [] } },
    });
    const loaded = await loadProjectConfig({ cwd: fx.dir });
    await expectFail(() => loadRegistry(loaded), "FORBIDDEN-ROOT");
  }
});

test("shadow: sibling protect entry does not gate a clean layout", async (t) => {
  const fx = await makeLayout(t, { shadow: true });
  const loaded = await loadProjectConfig({ cwd: fx.dir });
  await loadRegistry(loaded); // must not throw: lineA/other do not contain protected-root
});

test("shadow: empty protect is legal (operator declared no protected roots)", async (t) => {
  const fx = await makeLayout(t, { shadow: true, configOverrides: { protect: [] } });
  const loaded = await loadProjectConfig({ cwd: fx.dir });
  const reg = await loadRegistry(loaded);
  assert.equal(reg.registryPath, path.join(fx.shadowHome, "shadow-registry.json"));
});

test("shadow: missing protect key is CONFIG-INVALID (required, fail-closed)", async (t) => {
  const fx = await makeLayout(t, { shadow: true });
  const loaded = await loadProjectConfig({ cwd: fx.dir });
  const reg = await loadRegistry(loaded);
  const stripped = { ...loaded.config };
  delete stripped.protect;
  await expectFail(() => validateRegistrySemantics(reg.registry, stripped), "CONFIG-INVALID");
});

// ---------------------------------------------------------------------------
// buildPolicy
// ---------------------------------------------------------------------------

async function policyWorld(t) {
  const dir = await tempRoot(t);
  const lineRoot = path.join(dir, "lineA");
  const work = path.join(lineRoot, "work");
  const secret = path.join(lineRoot, "secret");
  const other = path.join(dir, "other");
  const third = path.join(dir, "third");
  await fs.mkdir(work, { recursive: true });
  await fs.mkdir(secret, { recursive: true });
  await fs.mkdir(other, { recursive: true });
  await fs.mkdir(third, { recursive: true });
  const registry = {
    version: 1,
    lines: {
      demo: {
        roots: [lineRoot],
        forbidden_surfaces: [".omo/evidence/INTENT-LEDGER.md"],
        forbidden_absolute: [`${secret}/**`],
        read_roots: [other],
      },
      other: {
        roots: [other],
        forbidden_surfaces: [],
        forbidden_absolute: [`${lineRoot}/protected/**`],
        read_roots: [],
      },
    },
  };
  const policy = buildPolicy({ config: { mode: "normal" }, registry });
  return { dir, lineRoot, work, secret, other, third, registry, policy };
}

test("policy.line: unknown line is REGISTRY-INVALID", async (t) => {
  const { policy } = await policyWorld(t);
  assert.throws(() => policy.line("ghost"), (e) => e.name === "WardenError" && e.code === "REGISTRY-INVALID");
});

test("forbiddenHit: relative patterns anchor at root #1; trailing /** matches the dir itself and children", async (t) => {
  const { policy, lineRoot, work, secret } = await policyWorld(t);
  assert.equal(
    policy.forbiddenHit(path.join(lineRoot, ".omo", "evidence", "INTENT-LEDGER.md"), "demo"),
    ".omo/evidence/INTENT-LEDGER.md",
  );
  assert.equal(policy.forbiddenHit(work, "demo"), null);
  // trailing /** matches the directory itself, not only its children
  assert.equal(policy.forbiddenHit(secret, "demo"), `${secret}/**`);
  assert.equal(policy.forbiddenHit(path.join(secret, "a", "b.pem"), "demo"), `${secret}/**`);
});

test("writableRootOf: outside line roots PATH-ESCAPE; forbidden root FORBIDDEN-ROOT; cross-line absolute also gates", async (t) => {
  const { policy, lineRoot, work, secret, other } = await policyWorld(t);
  assert.equal(policy.writableRootOf("demo", work), work);
  assert.throws(() => policy.writableRootOf("demo", other), (e) => e.code === "PATH-ESCAPE");
  assert.throws(() => policy.writableRootOf("demo", secret), (e) => e.code === "FORBIDDEN-ROOT");
  // other line's forbidden_absolute protects regardless of touching line
  assert.throws(
    () => policy.writableRootOf("demo", path.join(lineRoot, "protected")),
    (e) => e.code === "FORBIDDEN-ROOT",
  );
});

test("artifactOk: containment, forbidden surface, symlink escape, dangling symlink, missing tail", async (t) => {
  const { policy, lineRoot, work, secret, other, third } = await policyWorld(t);
  const cell = { id: "c1", line: "demo", allowed_roots: [lineRoot] };
  const file = path.join(work, "out.bin");
  await fs.writeFile(file, "x", "utf8");
  assert.equal(await policy.artifactOk(file, cell), await fs.realpath(file));

  // missing tail resolves through the deepest existing ancestor
  const fresh = await policy.artifactOk(path.join(work, "sub", "new.txt"), cell);
  assert.ok(fresh.endsWith(path.join("sub", "new.txt")));

  await expectFail(() => policy.artifactOk(path.join(third, "x"), cell), "PATH-ESCAPE");
  await expectFail(() => policy.artifactOk(path.join(secret, "k.pem"), cell), "FORBIDDEN-SURFACE");

  await fs.symlink(other, path.join(lineRoot, "link"));
  await expectFail(() => policy.artifactOk(path.join(lineRoot, "link", "f.txt"), cell), "PATH-ESCAPE");

  await fs.symlink(path.join(third, "missing-target"), path.join(lineRoot, "dangling"));
  await expectFail(() => policy.artifactOk(path.join(lineRoot, "dangling"), cell), "PATH-ESCAPE");
});

test("readOk: cell allowed ∪ cell read_roots ∪ line read_roots", async (t) => {
  const { policy, lineRoot, work, other, third } = await policyWorld(t);
  const cell = { id: "c1", line: "demo", allowed_roots: [work], read_roots: [] };
  assert.equal(await policy.readOk(path.join(work, "a"), cell, "demo"), true);
  assert.equal(await policy.readOk(path.join(other, "b"), cell, "demo"), true); // line read_roots
  assert.equal(await policy.readOk(path.join(third, "c"), cell, "demo"), false);
  const cellWithRead = { ...cell, read_roots: [third] };
  assert.equal(await policy.readOk(path.join(third, "c"), cellWithRead, "demo"), true);
});
