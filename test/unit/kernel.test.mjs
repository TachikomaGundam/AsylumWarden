import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import test from "node:test";

import { canon, sha256Of, GENESIS_PREV } from "../../src/kernel/canon.mjs";
import {
  atomicWriteJson,
  expandHome,
  readJsonCapped,
  pidAlive,
} from "../../src/kernel/fsutil.mjs";
import { compileGlob, matchGlob, matchAny } from "../../src/kernel/glob.mjs";
import { validateSchema } from "../../src/kernel/schemalite.mjs";
import { layout, SAFE_ID_RE } from "../../src/kernel/state.mjs";
import { exitClassFor, WardenError } from "../../src/kernel/errors.mjs";

test("canon: key order does not change hash", () => {
  assert.equal(sha256Of({ a: 1, b: [2, { c: 3 }] }), sha256Of({ b: [2, { c: 3 }], a: 1 }));
  assert.equal(canon({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test("canon: arrays are order-sensitive", () => {
  assert.notEqual(sha256Of([1, 2]), sha256Of([2, 1]));
});

test("canon: GENESIS_PREV is 64 zeros", () => {
  assert.equal(GENESIS_PREV.length, 64);
  assert.match(GENESIS_PREV, /^0{64}$/);
});

test("glob: trailing /** matches the directory itself and all depths", () => {
  assert.ok(matchGlob("/pcb/reports/**", "/pcb/reports"));
  assert.ok(matchGlob("/pcb/reports/**", "/pcb/reports/recovery/d.json"));
});

test("glob: middle ** spans zero or more segments", () => {
  assert.ok(matchGlob("/a/**/b", "/a/b"));
  assert.ok(matchGlob("/a/**/b", "/a/x/y/b"));
  assert.ok(!matchGlob("/a/**/b", "/a/x/y/bc"));
});

test("glob: single star stays inside one segment", () => {
  assert.ok(matchGlob("/a/*/b", "/a/x/b"));
  assert.ok(!matchGlob("/a/*/b", "/a/x/y/b"));
});

test("glob: *.consumed matches at any depth via ** prefix", () => {
  assert.ok(matchGlob("/pcb/**/*.consumed", "/pcb/recovery/x.consumed"));
  assert.ok(matchGlob("/pcb/**/*.consumed", "/pcb/x.consumed"));
  assert.ok(!matchGlob("/pcb/**/*.consumed", "/pcb/x.json"));
});

test("glob: literal dots are not regex dots", () => {
  assert.ok(!matchGlob("/a.b/**", "/axb/c"));
});

test("glob: relative pattern fails closed", () => {
  assert.throws(() => compileGlob("a/b"), (e) => e.code === "GLOB-INVALID");
});

test("glob: matchAny returns the matching pattern", () => {
  assert.equal(matchAny(["/x/**", "/y/z"], "/y/z"), "/y/z");
  assert.equal(matchAny(["/x/**"], "/y/z"), null);
});

test("schemalite: const, required, additionalProperties", () => {
  const schema = {
    type: "object",
    properties: { version: { const: 1 }, name: { type: "string" } },
    required: ["version", "name"],
    additionalProperties: false,
  };
  assert.deepEqual(validateSchema(schema, { version: 1, name: "x" }), []);
  assert.ok(validateSchema(schema, { version: 2, name: "x" }).length >= 1);
  assert.ok(validateSchema(schema, { version: 1 }).some((v) => v.rule === "required"));
  assert.ok(
    validateSchema(schema, { version: 1, name: "x", extra: 1 }).some(
      (v) => v.rule === "additionalProperties",
    ),
  );
});

test("schemalite: unknown schema keyword fails closed with INTERNAL", () => {
  assert.throws(
    () => validateSchema({ oneOf: [] }, {}),
    (e) => e.code === "INTERNAL",
  );
});

test("schemalite: date-time format is enforced", () => {
  const schema = { type: "string", format: "date-time" };
  assert.deepEqual(validateSchema(schema, "2026-11-05T06:00:00.000Z"), []);
  assert.ok(validateSchema(schema, "yesterday").length === 1);
});

test("schemalite: anyOf requires at least one variant", () => {
  const schema = {
    anyOf: [
      { type: "object", properties: { mode: { const: "normal" } }, required: ["mode"], additionalProperties: false },
      { type: "object", properties: { mode: { const: "shadow" } }, required: ["mode"], additionalProperties: false },
    ],
  };
  assert.deepEqual(validateSchema(schema, { mode: "normal" }), []);
  assert.ok(validateSchema(schema, { mode: "weird" }).some((v) => v.rule === "anyOf"));
});

test("fsutil: atomic write then capped read round-trips", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aw-kernel-"));
  const file = path.join(dir, "deep", "state.json");
  await atomicWriteJson(file, { ok: 1 });
  const { value } = await readJsonCapped(file);
  assert.equal(value.ok, 1);
  assert.equal(Object.getPrototypeOf(value), null);
});

test("fsutil: size cap fails closed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aw-kernel-"));
  const file = path.join(dir, "big.json");
  await fs.writeFile(file, JSON.stringify({ pad: "x".repeat(200) }));
  await assert.rejects(readJsonCapped(file, 64, "SCHEMA-VIOLATION"), (e) => e.code === "SCHEMA-VIOLATION");
});

test("fsutil: __proto__ keys are rejected", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aw-kernel-"));
  const file = path.join(dir, "evil.json");
  await fs.writeFile(file, '{"a":{"__proto__":{"polluted":1}}}');
  await assert.rejects(readJsonCapped(file), (e) => e.code === "SCHEMA-VIOLATION");
});

test("fsutil: unparseable JSON reports the caller's code", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aw-kernel-"));
  const file = path.join(dir, "torn.json");
  await fs.writeFile(file, '{"a":');
  await assert.rejects(readJsonCapped(file, 1024, "STATE-CORRUPT"), (e) => e.code === "STATE-CORRUPT");
});

test("fsutil: ENOENT passes through for optional reads", async () => {
  await assert.rejects(
    readJsonCapped(path.join(os.tmpdir(), "aw-nonexistent", "x.json")),
    (e) => e.code === "ENOENT",
  );
});

test("fsutil: expandHome and pidAlive", () => {
  assert.ok(expandHome("~/x").startsWith(os.homedir()));
  assert.equal(expandHome("/abs/y"), "/abs/y");
  assert.ok(pidAlive(process.pid, os.hostname()));
  assert.ok(!pidAlive(2 ** 31 - 2, os.hostname()));
  assert.ok(pidAlive(2 ** 31 - 2, "somewhere.else")); // foreign host → assume alive
});

test("state: layout builds contract paths", () => {
  const sl = layout("/home/u/.local/state/asylumwarden");
  assert.equal(sl.ledger, "/home/u/.local/state/asylumwarden/ledger.jsonl");
  assert.equal(sl.cellFile("w1", "c1"), "/home/u/.local/state/asylumwarden/waves/w1/cells/c1.json");
  assert.equal(sl.ownerFile("w1", "c1"), "/home/u/.local/state/asylumwarden/waves/w1/leases/c1/owner.json");
});

test("state: safe id regex", () => {
  assert.ok(SAFE_ID_RE.test("wave-2026_11.05"));
  assert.ok(!SAFE_ID_RE.test("-lead"));
  assert.ok(!SAFE_ID_RE.test("a".repeat(65)));
  assert.ok(!SAFE_ID_RE.test("bad/slash"));
});

test("errors: exit class mapping is fail-closed for unknown codes", () => {
  assert.equal(exitClassFor("LEASE-HELD"), 1);
  assert.equal(exitClassFor("LEDGER-BROKEN"), 2);
  assert.equal(exitClassFor("SOMETHING-NEW"), 2);
  assert.equal(new WardenError("USAGE", "x").exitClass, 1);
});
