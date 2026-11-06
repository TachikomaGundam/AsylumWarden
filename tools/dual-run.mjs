#!/usr/bin/env node
// M4 dual-run harness: replay one fixture manifest through BOTH decision
// engines — AsylumWarden (this repo's CLI) and Abathur's frozen wave_engine —
// and diff every decision. Prepares the M4 window; the real-wave dual-run is
// run later by the seats.
//
// Isolation law (all enforced in code, not aspirational):
//   - wave_engine runs ONLY with `--base <fresh temp>` and `--line-roots
//     <temp file>`; its default base is a real state dir and is never touched.
//   - `launch` is a FORBIDDEN command here: it emits task(...) dispatch lines.
//     wave.py's claim requires state "launched", so the harness flips
//     new -> launched by editing the launchpack JSON directly inside ITS OWN
//     temp base (the temp state is ours; the engine binary is never modified).
//   - AsylumWarden runs under env HOME=<temp> with --config <temp>, so the
//     registry (~/.config/asylumwarden/registry.json) and state home
//     (~/.local/state/asylumwarden) resolve inside the temp world. Nothing
//     under the real ~/.config or ~/.local/state is read or written.
//   - The Abathur repo is read-only input (wave.py path is a constant).
//   - All state lives under fs.mkdtemp; removed after each fixture/reconcile
//     unless --keep. In --manifest mode the REAL manifest and --roots dirs are
//     operator-supplied machine paths read as arguments only — never stored
//     in repo files, never echoed into tracked source.
//
// Two modes:
//   --selftest   replay the fixture matrix (reference implementation of the
//                shared engine/warden runners; exit 0 = every row hits).
//   --manifest   DRY reconcile one REAL wave_engine manifest between the two
//                engines on this machine (M4 window support). Probes: plan on
//                both, ready-set, then per-cell CLAIMABILITY compared side by
//                side (engine deps_satisfied semantics read from the engine's
//                own temp launchpacks vs warden `ready` incl. blocked_by).
//                The reconciler NEVER claims/dones real cells — production
//                claim/done belongs to the seats, not to this harness.
//                `launch` is never invoked here either (dispatch lines).
//
// Exit codes: 0 all fixture rows hit expectations / no DIFF reconcile row;
// 2 a row mismatched or DIFF (printed) or a spawn failed; 1 usage error.
// Zero runtime dependencies: node: stdlib only.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import process from "node:process";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const AW_BIN = path.join(REPO_ROOT, "bin", "asylumwarden.mjs");
// Same machine value, no username in source text (sanitize policy).
const WAVE_PY = path.join(os.homedir(), "workspace/harness/Abathur/tools/wave_engine/wave.py"); // read-only reference
const FIXTURE_DIR = path.join(import.meta.dirname, "dual-run-fixtures");
const NL = "\n"; // sanitize policy: one backslash per source line
const ACTOR = "dualrun";

// ---------------------------------------------------------------- adjudication
// One row per probe. Cites the contract/source that settles the verdict.
// MATCH rows carry the shared semantic; divergent rows cite who is stricter
// and where the posture lives. These are the M4 window's pre-registered
// rulings — no post-hoc excuses after the real wave runs.
const ADJUDICATION = {
  "plan": "both validators gate the same rule set (ids/deps/kinds/roots/cwd) fail-closed at plan time",
  "ready": "same ready-set semantics: pending + all deps done (CONTRACT §9; wave.py launch/deps_satisfied)",
  "claim": "lease accept on a dependency-satisfied cell; engine has no lease/epoch, comparison is accept-level",
  "done": "clean receipt inside allowed_roots accepted by both (CONTRACT §7; wave.py cmd_done)",
  "fail": "cell marked failed on both (CONTRACT §6; wave.py cmd_fail)",
  "requeue": "failed -> re-runnable on both; warden pending, engine new (CONTRACT §6; wave.py cmd_requeue)",
  "reclaim": "re-claim after requeue accepted by both",
  "reclaim-epoch": "engine has no epoch concept (no lease layer); warden reclaim sets epoch 2 per CONTRACT §6 — warden-only fact, not a DIFF",
  "verify": "warden ledger hash chain + audit_closure:none (CONTRACT §5, §2.3 anchor:null); engine has no ledger/anchor concept — WARDEN-ONLY, not counted as DIFF",
  "plan-forbidden": "engine `protected surface` INVALID (wave.py forbidden_violations) ↔ warden FORBIDDEN-ROOT (src/config/load.mjs writableRootOf); SECURITY.md §2 pins this as hard rejection on both sides",
  "plan-cwd": "engine `cwd outside allowed_roots` INVALID ↔ warden PATH-ESCAPE cwd-containment (src/manifest/manifest.mjs:158); same rule, different code name",
  "plan-warn": "broad allowed_root containing a forbidden surface is warn-and-accept on both (wave.py broad_forbidden_overlaps; CONTRACT §3 + src/manifest/manifest.mjs broad-root warning)",
  "plan-line-roots": "engine accepts an allowed_root under no declared line root (wave.py only checks cross-line overlap); warden requires allowed_roots ⊆ line roots (CONTRACT §3, src/config/load.mjs:426 writableRootOf). WARDEN STRICTER: line-root containment is a declared contract rule; engine posture is cross-line-only. EXPECTED-DIVERGENT",
  "plan-protected-abs": "a broad allowed_root that ENCLOSES an absolute protected surface: engine warns (wave.py broad_forbidden_overlaps), warden hard-rejects forbidden_absolute enclosure (src/manifest/manifest.mjs:65 FORBIDDEN-ROOT). WARDEN STRICTER on absolute declarations; reconcile maps protected dirs under the line root to the parity (warn-on-both) relative channel. EXPECTED-DIVERGENT",
  "claimable": "dry claimability: engine ready = state new + deps_satisfied over its own temp launchpacks (wave.py deps_satisfied) ↔ warden ready = state pending + deps done with blocked_by (src/views/views.mjs readyCells, CONTRACT §9). Same rule; compared WITHOUT claiming",
  "done-pollution": "engine DONE-POLLUTED: warn+flag, cell still marked done (wave.py cmd_done). Warden hard-rejects PATH-ESCAPE exit 2, cell state unchanged (CONTRACT §7.4). WARDEN FAIL-CLOSED STRICTTER — handoff §9 security posture; docs/SECURITY.md §3 post-write realpath re-check is a rejection, not a warning. EXPECTED-DIVERGENT",
  "drift": "LINE-ROOTS-DRIFT (wave.py cmd_done re-hashes the pinned line_roots file) ↔ CONFIG-DRIFT (warden re-hashes the pinned registry per invocation, CONTRACT §2.1). Same meaning: plan-time pin violated at use time. MATCH",
  "role-missing": "engine UNKNOWN-ROLE rejects the whole manifest at plan (wave.py role_check). Warden treats a missing role_file as no snapshot and lets claim proceed (src/lease/lease.mjs:211-224 documented choice). NOTE: the M4 brief cited a 'CHANGELOG 63752b1 era note' — no such entry exists in CHANGELOG.md (probed 2026-11-06); the authoritative in-repo source is the lease.mjs comment. EXPECTED-DIVERGENT",
  "role-stale": "both say RESTART-REQUIRED but at different gates: engine at plan (wave.py role_check mtime vs --session-start), warden at claim (src/lease/lease.mjs checkRoleSnapshot mtime vs session_started_at, CONTRACT §3). Engine plan rejection blocks the wave entirely; warden blocks only that claim. EXPECTED-DIVERGENT",
};

// Fixture-qualified overrides where the probe word alone is ambiguous.
Object.assign(ADJUDICATION, {
  "f2:plan": ADJUDICATION["plan-line-roots"],
  "f3:plan": ADJUDICATION["plan-forbidden"],
  "f4:plan": ADJUDICATION["plan-cwd"],
  "f5:plan": ADJUDICATION["plan-warn"],
  "f8:plan": ADJUDICATION["role-missing"],
  "f8:claim": ADJUDICATION["role-missing"],
  "f9:plan": ADJUDICATION["role-stale"],
  "f9:claim": ADJUDICATION["role-stale"],
});

function adjudicationFor(fixture, probeName) {
  // Fixture-qualified exact key wins (e.g. "f2:plan" -> line-roots divergence),
  // otherwise the longest generic key that prefixes the stripped probe name.
  if (Object.hasOwn(ADJUDICATION, probeName)) return ADJUDICATION[probeName];
  const key = probeName.slice(fixture.length + 1); // strip "fN:" prefix
  let best = null;
  for (const [k, v] of Object.entries(ADJUDICATION)) {
    if (k.includes(":")) continue;
    if (key.startsWith(k) && (best === null || k.length > best[0].length)) best = [k, v];
  }
  if (best) return best[1];
  throw new Error(`no adjudication entry for ${probeName}`);
}

// ---------------------------------------------------------------- tiny helpers
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function writeJson(p, obj) { mkdirp(path.dirname(p)); fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8"); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }
function sha256File(p) { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }
function shufflelessSort(a) { return [...a].sort(); }

function run(cmd, args, { env, cwd } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    env: env ?? { PATH: process.env.PATH },
    cwd: cwd ?? os.tmpdir(),
    timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// ---------------------------------------------------------------- engine side
// wave.py invocations. argv shape: wave.py --base <temp> <cmd> [...]. `launch`
// is never invoked (it prints dispatch lines); new -> launched is a direct
// launchpack edit inside the harness-owned temp base.
class Engine {
  constructor(world, wave, lineRootsPath) {
    this.base = world.base;
    this.wave = wave;
    this.lineRootsPath = lineRootsPath;
  }
  call(cmd, args = [], extraFlags = []) {
    return run("python3", [WAVE_PY, "--base", this.base, cmd, ...args, ...extraFlags], { cwd: this.base });
  }
  plan(manifestPath, { roleDir = null, sessionStart = null } = {}) {
    const flags = ["--line-roots", this.lineRootsPath];
    if (roleDir) flags.push("--role-dir", roleDir, "--session-start", sessionStart);
    const r = this.call("plan", [manifestPath], flags);
    if (r.code === 0 && r.stdout.includes("planned wave")) {
      return { verdict: r.stdout.includes("WARNING: protected-surface overlap") ? "accepted+warned" : "accepted", code: r.code };
    }
    // code === null: python3 never answered (spawn/timeout) — the reconcile
    // caller turns that into a named spawn DIFF, not a rejection verdict.
    return { verdict: enginePlanClass(`${r.stderr}${NL}${r.stdout}`), detail: r.stderr.trim().split(NL)[0], code: r.code };
  }
  flipLaunched(cell) {
    const p = path.join(this.base, this.wave, `${cell}.json`);
    const pack = readJson(p);
    if (pack.state !== "new") throw new Error(`flipLaunched: ${cell} state is ${pack.state}`);
    const iso = new Date().toISOString().replace(/[.][0-9]{3}Z$/, "Z");
    pack.state = "launched";
    pack.launched_at = iso;
    pack.launched_epoch = Date.now() / 1000;
    writeJson(p, pack);
  }
  claim(cell) {
    const r = this.call("claim", [this.wave, cell]);
    if (r.code === 0 && r.stdout.includes("claimed ")) return { verdict: "ok" };
    return { verdict: engineActionClass(r.stderr, "claim") };
  }
  done(cell, receiptPath) {
    const r = this.call("done", [this.wave, cell], ["--receipt", receiptPath]);
    if (r.stdout.includes("DONE-POLLUTED")) return { verdict: "DONE-POLLUTED" };
    if (r.code === 0 && r.stdout.startsWith("done ")) return { verdict: "ok" };
    return { verdict: engineActionClass(r.stderr, "done") };
  }
  fail(cell) {
    const r = this.call("fail", [this.wave, cell], ["--note", "dual-run synthetic failure"]);
    if (r.code === 0 && r.stdout.includes("failed ")) return { verdict: "ok" };
    return { verdict: engineActionClass(r.stderr, "fail") };
  }
  requeue(cell) {
    const r = this.call("requeue", [this.wave, cell], ["--note", "dual-run synthetic requeue"]);
    if (r.code === 0 && r.stdout.includes("requeued ")) return { verdict: "ok" };
    return { verdict: engineActionClass(r.stderr, "requeue") };
  }
  // Read-only claimability view over the engine's own temp launchpacks,
  // mirroring wave.py deps_satisfied: a missing or not-done dep blocks.
  readyRows() {
    const meta = readJson(path.join(this.base, this.wave, "meta.json"));
    const cells = meta.cells.map((cid) => readJson(path.join(this.base, this.wave, `${cid}.json`)));
    const byId = new Map(cells.map((c) => [c.cell_id, c]));
    const done = new Set(cells.filter((c) => c.state === "done").map((c) => c.cell_id));
    return cells.map((c) => ({
      id: c.cell_id,
      state: c.state,
      ready: c.state === "new" && c.deps.every((d) => done.has(d)),
      blocked_by: shufflelessSort(c.deps.filter((d) => !done.has(d) || !byId.has(d))),
    }));
  }
  readySet() {
    return shufflelessSort(this.readyRows().filter((r) => r.ready).map((r) => r.id));
  }
}

function enginePlanClass(s) {
  if (s.includes("UNKNOWN-ROLE")) return "reject:UNKNOWN-ROLE";
  if (s.includes("RESTART-REQUIRED")) return "reject:RESTART-REQUIRED";
  const m = s.match(/INVALID: (.*)/);
  const line = m ? m[1] : s;
  if (line.includes("cross-line")) return "reject:CROSS-LINE";
  if (line.includes("protected surface")) return "reject:FORBIDDEN";
  if (line.includes("cwd")) return "reject:CWD";
  if (line.includes("kind must be")) return "reject:KIND";
  if (line.includes("brief_path")) return "reject:BRIEF";
  if (line.includes("dep")) return "reject:DEP";
  return "reject:OTHER";
}
function engineActionClass(stderr, cmd) {
  if (stderr.includes("LINE-ROOTS-DRIFT")) return "reject:LINE-ROOTS-DRIFT";
  if (stderr.includes("cannot claim") || stderr.includes("cannot done") || stderr.includes("cannot fail") || stderr.includes("cannot requeue")) return "reject:STATE";
  return `reject:OTHER-${cmd.toUpperCase()}`;
}

// ---------------------------------------------------------------- warden side
class Warden {
  constructor(world, configPath) {
    this.configPath = configPath;
    this.env = { PATH: process.env.PATH, HOME: world.home };
    this.lastEpoch = null;
  }
  call(cmd, args = []) {
    const r = run(process.execPath, [AW_BIN, "--config", this.configPath, cmd, ...args], { env: this.env, cwd: this.env.HOME });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* surfaced below */ }
    return { code: r.code, json, stdout: r.stdout, stderr: r.stderr };
  }
  init() {
    const r = this.call("init");
    if (!r.json?.ok) throw new Error(`warden init failed: ${r.stdout || r.stderr}`);
  }
  plan(manifestPath) {
    const r = this.call("plan", [manifestPath]);
    if (r.json?.ok) return { verdict: (r.json.warnings ?? []).length > 0 ? "accepted+warned" : "accepted", code: r.code };
    // code === null: the CLI never answered (spawn/timeout) — named spawn DIFF.
    return { verdict: `reject:${r.json?.code ?? `PARSE-${r.code}`}`, detail: r.json?.message, code: r.code };
  }
  readyRows(wave) {
    const r = this.call("ready", [wave]);
    if (!r.json?.ok) throw new Error(`warden ready failed: ${r.stdout || r.stderr}`);
    return r.json.ready;
  }
  readySet(wave) {
    return shufflelessSort(this.readyRows(wave).filter((c) => c.ready).map((c) => c.id));
  }
  claim(wave, cell) {
    const r = this.call("claim", [wave, cell, "--actor", ACTOR]);
    if (!r.json?.ok) return { verdict: `reject:${r.json?.code}` };
    this.lastEpoch = r.json.epoch;
    return { verdict: "ok", epoch: r.json.epoch };
  }
  done(wave, cell, receiptPath, epoch = this.lastEpoch) {
    const r = this.call("done", [wave, cell, "--actor", ACTOR, "--epoch", String(epoch), "--receipt", receiptPath]);
    if (r.json?.ok) return { verdict: "ok" };
    return { verdict: `reject:${r.json?.code}` };
  }
  fail(wave, cell, epoch = this.lastEpoch) {
    const r = this.call("fail", [wave, cell, "--actor", ACTOR, "--epoch", String(epoch), "--reason", "dual-run synthetic failure"]);
    if (r.json?.ok) return { verdict: "ok" };
    return { verdict: `reject:${r.json?.code}` };
  }
  requeue(wave, cell) {
    const r = this.call("requeue", [wave, cell]);
    if (r.json?.ok) return { verdict: "ok" };
    return { verdict: `reject:${r.json?.code}` };
  }
  verify(wave) {
    const r = this.call("verify", [wave]);
    if (!r.json?.ok) return { verdict: `reject:${r.json?.code}` };
    const closure = r.json.audit_closure === false ? "false" : String(r.json.audit_closure);
    return { verdict: `${r.json.chain_ok ? "chain-ok" : "chain-BROKEN"},audit-closure=${closure}` };
  }
}

// ---------------------------------------------------------------- world build
// One temp world per fixture. Layout is fixed so both engines see identical
// roots/surfaces from one fixture source:
//   world/
//     lineA/            <- self line root ("dualrun" both engines)
//       work/           <- clean cell root (no forbidden surface inside)
//       protected/      <- forbidden surface, relative pattern "protected"
//     lineB/            <- second line "other" (cross-line reference)
//     outside/          <- under NO line root (f2/f6 probes)
//     briefs/, roles/, receipts/
//     home/.config/asylumwarden/registry.json + home/.local/state/... (temp HOME)
//     base/             <- wave.py --base (fresh, never the default state dir)
//     aw/asylumwarden.json, lineroots.json, manifests/
function buildWorld(fixture) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `aw-dualrun-${fixture.fixture}-`)));
  const w = {
    root,
    lineA: path.join(root, "lineA"),
    work: path.join(root, "lineA", "work"),
    protected: path.join(root, "lineA", "protected"),
    lineB: path.join(root, "lineB"),
    outside: path.join(root, "outside"),
    briefs: path.join(root, "briefs"),
    roles: path.join(root, "roles"),
    receipts: path.join(root, "receipts"),
    home: path.join(root, "home"),
    base: path.join(root, "base"),
    aw: path.join(root, "aw"),
  };
  for (const d of [w.work, w.protected, w.lineB, w.outside, w.briefs, w.roles, w.receipts, w.base, w.aw]) mkdirp(d);

  // Single fixture source -> both config formats, same roots/surfaces.
  writePolicyFiles(w, "dualrun", {
    dualrun: { roots: [w.lineA], forbiddenRel: ["protected"], forbiddenAbs: [] },
    other: { roots: [w.lineB], forbiddenRel: [], forbiddenAbs: [] },
  });
  return w;
}

// One declaration -> both policy dialects, parallel semantics by construction:
//   lineroots.json  {self, lines:{<line>:{roots, forbidden_surfaces}}} for wave.py
//                   (relative entries resolve against the line's first root —
//                   wave.py forbidden_entries; absolute entries are taken as-is)
//   registry.json   {version:1, lines:{<linespec>}} for warden under the temp HOME
//                   (forbidden_surfaces relative to roots[0], forbidden_absolute
//                   absolute — src/config/load.mjs buildPolicy)
// linesSpec: { [line]: { roots: [...abs], forbiddenRel: [...], forbiddenAbs: [...abs] } }
function writePolicyFiles(w, selfLine, linesSpec) {
  w.lineRootsPath = path.join(w.root, "lineroots.json");
  const engineLines = {};
  const registryLines = {};
  for (const [line, spec] of Object.entries(linesSpec)) {
    engineLines[line] = { roots: spec.roots, forbidden_surfaces: [...spec.forbiddenRel, ...spec.forbiddenAbs] };
    registryLines[line] = {
      roots: spec.roots,
      forbidden_surfaces: spec.forbiddenRel,
      forbidden_absolute: spec.forbiddenAbs,
      read_roots: [],
    };
  }
  writeJson(w.lineRootsPath, { self: selfLine, lines: engineLines });

  w.registryPath = path.join(w.home, ".config", "asylumwarden", "registry.json");
  writeJson(w.registryPath, { version: 1, lines: registryLines });
  const registrySha = sha256File(w.registryPath);
  w.configPath = path.join(w.aw, "asylumwarden.json");
  writeJson(w.configPath, {
    version: 1,
    registry: "~/.config/asylumwarden/registry.json",
    registry_sha256: registrySha,
    self: selfLine,
    state_home: "~/.local/state/asylumwarden",
    mode: "normal",
    kinds: {},
    anchor: null,
  });
}

function rootOf(w, kind) {
  return { work: w.work, line: w.lineA, protected: w.protected, outside: w.outside, lineB: w.lineB }[kind];
}

// One fixture source -> both manifest dialects.
function buildManifests(w, fixture) {
  const roleSpec = fixture.role ?? null;
  const engineCells = [];
  const wardenCells = [];
  for (const cell of fixture.cells) {
    const brief = path.join(w.briefs, `${cell.id}.md`);
    fs.writeFileSync(brief, `# dual-run brief ${cell.id}${NL}${NL}synthetic${NL}`, "utf8");
    const allowed = [rootOf(w, cell.root_kind)];
    const cwd = rootOf(w, cell.cwd_kind ?? cell.root_kind);
    engineCells.push({
      cell_id: cell.id,
      kind: cell.kind ?? "gen",
      brief_path: brief,
      allowed_roots: allowed,
      ...(cell.read_kind ? { read_roots: [rootOf(w, cell.read_kind)] } : {}),
      cwd,
      deps: cell.deps ?? [],
      ...(roleSpec ? { role: roleSpec.role } : {}),
    });
    wardenCells.push({
      id: cell.id,
      kind: cell.kind ?? "gen",
      line: "dualrun",
      cwd,
      allowed_roots: allowed,
      deps: cell.deps ?? [],
      brief: brief,
      ...(roleSpec ? {
        role: roleSpec.role,
        role_file: path.join(w.roles, `${roleSpec.role}.md`),
        session_started_at: new Date(Date.now() + (roleSpec.session_offset_seconds ?? 0) * 1000).toISOString(),
      } : {}),
    });
    if (roleSpec?.role_file_exists) {
      fs.writeFileSync(path.join(w.roles, `${roleSpec.role}.md`), `# role ${roleSpec.role}\n`, "utf8");
    }
  }
  const engineManifest = path.join(w.aw, "engine-manifest.json");
  const wardenManifest = path.join(w.aw, "wave.json");
  writeJson(engineManifest, { wave_id: fixture.wave, cells: engineCells });
  writeJson(wardenManifest, { version: 1, wave: fixture.wave, cells: wardenCells });
  return { engineManifest, wardenManifest };
}

// Synthetic receipt: one file, both dialects read it (warden wants JSON §7,
// wave.py text-scans the same file). Artifacts land inside allowed roots;
// pollution fixtures add an artifact under world/outside/ (exists, hashed).
function makeReceipt(w, cellId, { poison = false, epoch = 1 } = {}) {
  const artifactsDir = path.join(w.work, "artifacts");
  mkdirp(artifactsDir);
  const clean = path.join(artifactsDir, `${cellId}.txt`);
  fs.writeFileSync(clean, `artifact ${cellId}\n`, "utf8");
  const artifacts = [{ path: clean, sha256: sha256File(clean) }];
  if (poison) {
    const poisonPath = path.join(w.outside, `${cellId}-poison.txt`);
    fs.writeFileSync(poisonPath, `written outside allowed_roots by ${cellId}\n`, "utf8");
    artifacts.push({ path: poisonPath, sha256: sha256File(poisonPath) });
  }
  const receiptPath = path.join(w.receipts, `${cellId}.json`);
  writeJson(receiptPath, {
    version: 1,
    cell: cellId,
    actor: ACTOR,
    epoch,
    status: "done",
    summary: "dual-run synthetic receipt",
    commands: [{ cmd: "echo synthetic", exit: 0 }],
    artifacts,
    reads: [],
  });
  return receiptPath;
}

// ---------------------------------------------------------------- fixture run
// Each runner emits {probe, engine, warden} rows; the fixture JSON pins the
// expected rows. Plan probes always run first (both engines), then the replay.
function planPair(world, engine, warden, fixture, manifests) {
  const roleFlags = fixture.role ? { roleDir: world.roles, sessionStart: new Date(Date.now() + (fixture.role.session_offset_seconds ?? 0) * 1000).toISOString() } : {};
  const e = engine.plan(manifests.engineManifest, roleFlags);
  const wd = warden.plan(manifests.wardenManifest);
  return { e, warden: wd };
}

const RUNNERS = {
  "f1-valid-dag": planAndReplay({
    // alpha -> beta dep chain, full happy path + drift probe between.
    steps: [
      { probe: "ready", kind: "ready" },
      { probe: "claim-alpha", kind: "claim", cell: "alpha" },
      { probe: "done-alpha", kind: "done", cell: "alpha" },
      { probe: "ready-after-alpha", kind: "ready" },
      { probe: "claim-beta", kind: "claim", cell: "beta" },
      { probe: "drift-done-beta", kind: "drift-done", cell: "beta" },
      { probe: "done-beta", kind: "done", cell: "beta" },
      { probe: "verify", kind: "verify" },
    ],
  }),
  "f7-retry-loop": planAndReplay({
    steps: [
      { probe: "claim", kind: "claim", cell: "retry" },
      { probe: "fail", kind: "fail", cell: "retry" },
      { probe: "requeue", kind: "requeue", cell: "retry" },
      { probe: "reclaim", kind: "claim", cell: "retry" },
      { probe: "reclaim-epoch", kind: "epoch", cell: "retry" },
    ],
  }),
  "f6-receipt-pollution": planAndReplay({
    steps: [
      { probe: "claim", kind: "claim", cell: "poison" },
      { probe: "done-pollution", kind: "done", cell: "poison", poison: true },
    ],
  }),
  "f2-root-not-declared": planOnly(),
  "f3-forbidden-hit": planOnly(),
  "f4-cwd-outside-allowed": planOnly(),
  "f5-broad-overlap": planOnly(),
  "f8-role-missing": planAndReplay({
    steps: [{ probe: "claim", kind: "claim", cell: "ghost" }],
  }),
  "f9-role-stale": planAndReplay({
    steps: [{ probe: "claim", kind: "claim", cell: "stale" }],
  }),
};

function planOnly() {
  return async function runFixture({ world, engine, warden, fixture, manifests }) {
    const rows = [];
    const plan = planPair(world, engine, warden, fixture, manifests);
    rows.push({ probe: `${fixture.probe_prefix}:plan`, engine: plan.e.verdict, warden: plan.warden.verdict });
    return rows;
  };
}

function planAndReplay({ steps }) {
  return async function runFixture({ world, engine, warden, fixture, manifests }) {
    const rows = [];
    const plan = planPair(world, engine, warden, fixture, manifests);
    rows.push({ probe: `${fixture.probe_prefix}:plan`, engine: plan.e.verdict, warden: plan.warden.verdict });
    const enginePlanRejected = plan.e.verdict.startsWith("reject:");
    let drift = null;
    for (const step of steps) {
      const probe = `${fixture.probe_prefix}:${step.probe}`;
      if (step.kind === "ready") {
        rows.push({ probe, engine: `[${engine.readySet().join(" ")}]`, warden: `[${warden.readySet(fixture.wave).join(" ")}]` });
      } else if (step.kind === "claim") {
        let e = "n/a(plan-rejected)";
        if (!enginePlanRejected) {
          engine.flipLaunched(step.cell);
          e = engine.claim(step.cell).verdict;
        }
        const wd = plan.warden.verdict.startsWith("reject:") ? "n/a(plan-rejected)" : warden.claim(fixture.wave, step.cell).verdict;
        rows.push({ probe, engine: e, warden: wd });
      } else if (step.kind === "done") {
        const receipt = makeReceipt(world, step.cell, { poison: Boolean(step.poison) });
        const e = engine.done(step.cell, receipt).verdict;
        const wd = warden.done(fixture.wave, step.cell, receipt).verdict;
        rows.push({ probe, engine: e, warden: wd });
      } else if (step.kind === "drift-done") {
        // Mutate BOTH policy sources after plan; both engines must refuse the
        // receipt at their pinned-hash gate; then restore and close for real.
        const regBytes = fs.readFileSync(world.registryPath);
        const lrBytes = fs.readFileSync(world.lineRootsPath);
        fs.appendFileSync(world.lineRootsPath, "\n");
        fs.appendFileSync(world.registryPath, " ");
        drift = { regBytes, lrBytes };
        const e = engine.done(step.cell, makeReceipt(world, step.cell)).verdict;
        const wd = warden.done(fixture.wave, step.cell, path.join(world.receipts, `${step.cell}.json`)).verdict;
        fs.writeFileSync(world.lineRootsPath, drift.lrBytes);
        fs.writeFileSync(world.registryPath, drift.regBytes);
        drift = null;
        rows.push({ probe, engine: e, warden: wd });
      } else if (step.kind === "fail") {
        rows.push({ probe, engine: engine.fail(step.cell).verdict, warden: warden.fail(fixture.wave, step.cell).verdict });
      } else if (step.kind === "requeue") {
        rows.push({ probe, engine: engine.requeue(step.cell).verdict, warden: warden.requeue(fixture.wave, step.cell).verdict });
      } else if (step.kind === "epoch") {
        rows.push({ probe, engine: "no-epoch-concept", warden: `epoch=${warden.lastEpoch}` });
      } else if (step.kind === "verify") {
        rows.push({ probe, engine: "no-ledger-concept", warden: warden.verify(fixture.wave).verdict });
      } else {
        throw new Error(`unknown step kind ${step.kind}`);
      }
    }
    if (drift) throw new Error("drift files not restored");
    return rows;
  };
}

// ---------------------------------------------------------------- real-manifest reconcile
// --manifest mode: DRY reconciliation of an ACTUAL production wave_engine
// manifest. The manifest and --roots/--protected paths are operator-supplied
// machine paths read as arguments; nothing is persisted into the repo and no
// host path is baked into this source. Both engines plan into fresh temp
// state, then per-cell CLAIMABILITY is compared without claiming anything:
// the engine's deps_satisfied semantics read from its own temp launchpacks
// (read-only) vs warden `ready` including blocked_by. claim/done/launch are
// never invoked — production cell ownership belongs to the seats.
const LINE_SAFE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/; // registry + manifest schema line/wave id shape

function buildRealWorld({ lineName, roots, protectedDirs, baseOpt }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aw-dualrun-real-")));
  const w = {
    root,
    home: path.join(root, "home"),
    base: baseOpt ?? path.join(root, "base"),
    aw: path.join(root, "aw"),
  };
  for (const d of [w.base, w.aw]) mkdirp(d);
  // A protected surface under the line's first root goes through the RELATIVE
  // channel: parallel warn/protect semantics on both engines (wave.py
  // forbidden_entries resolves relatives against roots[0]; warden buildPolicy
  // forbiddenHit resolves relative patterns against l.roots[0]). Anything else
  // stays absolute — warden is stricter there on broad-root enclosure, which
  // ADJUDICATION["plan-protected-abs"] pre-registers as EXPECTED-DIVERGENT.
  const forbiddenRel = [];
  const forbiddenAbs = [];
  for (const p of protectedDirs) {
    const rel = path.relative(roots[0], p);
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) forbiddenRel.push(rel);
    else forbiddenAbs.push(p);
  }
  writePolicyFiles(w, lineName, { [lineName]: { roots, forbiddenRel, forbiddenAbs } });
  return w;
}

// wave_engine dialect -> warden dialect (same cell set, one line). Role gates
// stay where each engine puts them (engine: plan-time flags we do not supply;
// warden: claim-time) — a role-bearing real manifest diverges at plan and the
// table names it, which is exactly what the reconciler is for.
function wardenManifestFromEngine(man, lineName, outPath) {
  const cells = (man.cells ?? []).map((c) => ({
    id: c.cell_id,
    kind: c.kind,
    line: lineName,
    cwd: c.cwd,
    allowed_roots: c.allowed_roots,
    ...(c.read_roots?.length ? { read_roots: c.read_roots } : {}),
    deps: c.deps ?? [],
    ...(c.brief_path ? { brief: c.brief_path } : {}),
    ...(c.role ? { role: c.role } : {}),
  }));
  writeJson(outPath, { version: 1, wave: man.wave_id, cells });
  return outPath;
}

// Plan-row adjudication map for the reconcile, keyed on the pre-registered
// ADJUDICATION rulings. Only these cross-name equivalences and pre-registered
// warden-stricter classes are anything but DIFF — everything unlisted diverges.
function classifyRealPlan(e, wd) {
  const ev = e.verdict;
  const wv = wd.verdict;
  if (ev === wv) return "MATCH";
  const msg = String(wd.detail ?? "");
  if (ev === "reject:FORBIDDEN" && wv === "reject:FORBIDDEN-ROOT") return "MATCH"; // plan-forbidden
  if (ev === "reject:CWD" && wv === "reject:PATH-ESCAPE" && /cwd/.test(msg)) return "MATCH"; // plan-cwd
  if (ev === "reject:DEP" && (wv === "reject:DEP-UNKNOWN" || wv === "reject:DEP-CYCLE")) return "MATCH";
  if (ev === "reject:KIND" && wv === "reject:UNKNOWN-KIND") return "MATCH";
  if (ev.startsWith("accepted") && wv === "reject:PATH-ESCAPE" && /outside line/.test(msg)) return "EXPECTED-DIVERGENT"; // plan-line-roots
  if (ev.startsWith("accepted") && wv === "reject:FORBIDDEN-ROOT" && /encloses forbidden_absolute/.test(msg)) return "EXPECTED-DIVERGENT"; // plan-protected-abs
  return "DIFF";
}

const claimLabel = (r, freshState) =>
  r.state !== undefined && r.state !== freshState
    ? `not-${freshState}:${r.state}`
    : r.ready ? "ready" : `blocked:[${[...new Set(r.blocked_by)].sort().join(" ")}]`;

function usage() {
  console.log("usage: node tools/dual-run.mjs --selftest [--keep] [--fixture <name-substring>]");
  console.log("       node tools/dual-run.mjs --manifest <abs manifest.json> --line-name <line>");
  console.log("           --roots <dir>[,<dir>...] [--protected <dir>,...] [--base <fresh tmp dir>] [--keep]");
  console.log("selftest: replays every fixture through wave_engine (frozen reference) and the");
  console.log("asylumwarden CLI in fresh temp worlds, then diffs every decision.");
  console.log("manifest: DRY-reconciles one REAL wave_engine manifest ({wave_id, cells} with");
  console.log("cell_id/brief_path/allowed_roots/read_roots?/cwd/kind/deps): plan on both, then");
  console.log("ready-set and per-cell claimability (deps_satisfied vs ready+blocked_by).");
  console.log("Never claims/dones/launches real cells. Engine state: --base (default fresh");
  console.log("mkdtemp). Warden state: fresh temp HOME + generated temp registry/config (normal");
  console.log("mode, shadow never used). --keep preserves the temp dirs and prints their paths.");
  console.log("exit: 0 no DIFF rows, 2 any DIFF or spawn failure, 1 usage error.");
}

function parseRealArgs(argv) {
  const specs = { "--manifest": 1, "--line-name": 1, "--roots": 1, "--protected": 0, "--base": 1 };
  const flags = { "--manifest": null, "--line-name": null, "--roots": null, "--protected": null, "--base": null };
  const errors = [];
  let keep = false;
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === "--keep") { keep = true; continue; }
    if (!Object.hasOwn(specs, tok)) { errors.push(`unknown argument: ${tok}`); continue; }
    // Values are absolute paths / id lists — never start with "--", so the
    // lookahead is unambiguous; --protected takes an OPTIONAL list value.
    const nxt = argv[i + 1];
    const hasVal = specs[tok] === 1 || (nxt !== undefined && !nxt.startsWith("--"));
    if (specs[tok] === 1 && (nxt === undefined || nxt.startsWith("--"))) { errors.push(`${tok} requires a value`); continue; }
    if (flags[tok] !== null) { errors.push(`${tok} given twice`); continue; }
    flags[tok] = hasVal ? nxt : "";
    if (hasVal) i += 1;
  }
  const list = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (!flags["--manifest"]) errors.push("--manifest is required");
  else if (!path.isAbsolute(flags["--manifest"])) errors.push("--manifest must be an absolute path");
  else if (!fs.existsSync(flags["--manifest"]) || !fs.statSync(flags["--manifest"]).isFile()) errors.push(`--manifest not a readable file: ${flags["--manifest"]}`);
  if (!flags["--line-name"]) errors.push("--line-name is required");
  else if (!LINE_SAFE_RE.test(flags["--line-name"])) errors.push(`--line-name must match ${LINE_SAFE_RE}`);
  const roots = list(flags["--roots"]);
  if (roots.length === 0) errors.push("--roots is required (comma-separated absolute dirs)");
  for (const r of roots) {
    if (!path.isAbsolute(r)) errors.push(`root not absolute: ${r}`);
    else if (!fs.existsSync(r) || !fs.statSync(r).isDirectory()) errors.push(`root is not an existing directory: ${r}`);
  }
  const protectedDirs = list(flags["--protected"]);
  for (const p of protectedDirs) if (!path.isAbsolute(p)) errors.push(`protected dir not absolute: ${p}`);
  if (flags["--base"] !== null && !path.isAbsolute(flags["--base"])) errors.push("--base must be an absolute path");
  return { errors, opts: { manifest: flags["--manifest"], lineName: flags["--line-name"], roots, protectedDirs, base: flags["--base"], keep } };
}

async function reconcile({ manifest, lineName, roots, protectedDirs, base, keep }) {
  const started = Date.now();
  const counts = { MATCH: 0, "EXPECTED-DIVERGENT": 0, DIFF: 0 };
  const table = [];
  const diffDetails = [];
  const addRow = (probe, engine, warden, verdict, adjudication) => {
    counts[verdict] += 1;
    const row = { probe, engine, warden, verdict, adjudication };
    table.push(row);
    return row;
  };
  const spawnRow = (probe, who, detail) =>
    addRow(probe, who === "engine" ? `spawn-fail:${detail}` : "n/a", who === "warden" ? `spawn-fail:${detail}` : "n/a",
      "DIFF", `${who} process did not answer (spawn/timeout); fail closed`);

  let world = null;
  try {
    const man = readJson(manifest);
    if (!man.wave_id || !Array.isArray(man.cells)) {
      addRow("manifest:load", `invalid:need wave_id + cells[]`, "n/a", "DIFF", "manifest not in wave_engine dialect; fail closed");
    } else {
      world = buildRealWorld({ lineName, roots, protectedDirs, baseOpt: base });
      const wardenManifest = wardenManifestFromEngine(man, lineName, path.join(world.aw, "wave.json"));
      const engine = new Engine(world, man.wave_id, world.lineRootsPath);
      const warden = new Warden(world, world.configPath);
      console.log(`dual-run reconcile (dry): line=${lineName} wave=${man.wave_id} cells=${man.cells.length} base=${world.base}`);
      try {
        warden.init();
      } catch (err) {
        spawnRow("manifest:warden-init", "warden", String(err?.message ?? err).slice(0, 120));
      }
      if (!table.some((r) => r.verdict === "DIFF")) {
        const pe = engine.plan(manifest);
        const pw = pe.code === null ? { verdict: "n/a", code: 0 } : warden.plan(wardenManifest);
        if (pe.code === null) {
          spawnRow("manifest:plan", "engine", `code=null stderr=${JSON.stringify(pe.detail ?? "")}`);
        } else if (pw.code === null) {
          spawnRow("manifest:plan", "warden", `code=null stderr=${JSON.stringify(pw.detail ?? "")}`);
        } else {
          const planVerdict = classifyRealPlan(pe, pw);
          addRow("manifest:plan", pe.verdict, pw.verdict, planVerdict, adjudicationFor("manifest", "manifest:plan"));
          if (planVerdict === "DIFF") diffDetails.push(`plan: engine=${pe.verdict}${pe.detail ? ` (${pe.detail})` : ""} | warden=${pw.verdict}${pw.detail ? ` (${pw.detail})` : ""}`);
          const eRej = pe.verdict.startsWith("reject:");
          const wRej = pw.verdict.startsWith("reject:");
          if (!eRej || !wRej) {
            const eRows = eRej ? null : new Map(engine.readyRows().map((r) => [r.id, r]));
            const wRows = wRej ? null : new Map(warden.readyRows(man.wave_id).map((r) => [r.id, r]));
            const planNa = eRej || wRej ? (planVerdict === "EXPECTED-DIVERGENT" ? "EXPECTED-DIVERGENT" : "DIFF") : null;
            const eReady = eRows ? `[${[...eRows.values()].filter((r) => r.ready).map((r) => r.id).sort().join(" ")}]` : "n/a(plan-rejected)";
            const wReady = wRows ? `[${[...wRows.values()].filter((r) => r.ready).map((r) => r.id).sort().join(" ")}]` : "n/a(plan-rejected)";
            const readyVerdict = planNa ?? (eReady === wReady ? "MATCH" : "DIFF");
            addRow("manifest:ready", eReady, wReady, readyVerdict, adjudicationFor("manifest", "manifest:ready"));
            if (readyVerdict === "DIFF") diffDetails.push(`ready: engine=${eReady} | warden=${wReady}`);
            for (const cell of man.cells) {
              const cid = cell.cell_id;
              if (!cid) continue;
              const ev = eRows ? claimLabel(eRows.get(cid) ?? { ready: false, blocked_by: ["[missing launchpack]"] }, "new") : "n/a(engine plan-rejected)";
              const wv = wRows ? claimLabel(wRows.get(cid) ?? { ready: false, blocked_by: ["[missing cell]"] }, "pending") : "n/a(warden plan-rejected)";
              const verdict = planNa ?? (ev === wv ? "MATCH" : "DIFF");
              const probe = `manifest:claimable-${cid}`;
              addRow(probe, ev, wv, verdict, adjudicationFor("manifest", probe));
              if (verdict === "DIFF") diffDetails.push(`${cid}: engine=${ev} | warden=${wv}`);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error(String(err?.stack ?? err)); // full trace to stderr; table row stays clipped
    addRow("manifest:harness", `error:${String(err?.message ?? err).slice(0, 120)}`, "n/a", "DIFF", "reconcile aborted fail-closed; see message");
  } finally {
    if (world) {
      if (keep) console.log(`kept world: ${world.root}\nkept engine base: ${world.base}\nkept warden HOME: ${world.home}\nkept warden config: ${world.configPath}`);
      else fs.rmSync(world.root, { recursive: true, force: true });
    }
  }

  console.log(fmtTable(table));
  for (const d of diffDetails) console.log(`DIFF detail ${d}`);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nrows: MATCH=${counts.MATCH} EXPECTED-DIVERGENT=${counts["EXPECTED-DIVERGENT"]} DIFF=${counts.DIFF}  (${secs}s)`);
  if (counts.DIFF > 0) {
    console.log(`RECONCILE FAIL: ${counts.DIFF} DIFF row(s)`);
    return 2;
  }
  console.log("RECONCILE PASS (dry: plan/ready/claimability only; nothing claimed or done)");
  return 0;
}

// ---------------------------------------------------------------- selftest
function fmtTable(rows) {
  const headers = ["probe", "engine verdict", "warden verdict", "verdict", "adjudication"];
  const widths = [44, 26, 26, 18, 40];
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const line = (cells) => `| ${cells.map((c, i) => clip(String(c), widths[i]).padEnd(widths[i])).join(" | ")} |`;
  const out = [line(headers), `|${widths.map((n) => "-".repeat(n + 2)).join("|")}|`];
  for (const r of rows) out.push(line([r.probe, r.engine, r.warden, r.verdict, r.adjudication]));
  return out.join("\n");
}

async function selftest({ keep = false, only = null } = {}) {
  const started = Date.now();
  const files = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) throw new Error(`no fixtures in ${FIXTURE_DIR}`);
  let failures = 0;
  const counts = { MATCH: 0, "EXPECTED-DIVERGENT": 0, "WARDEN-ONLY": 0, DIFF: 0 };
  const divergentRows = [];

  for (const file of files) {
    const fixture = readJson(path.join(FIXTURE_DIR, file));
    if (only && !fixture.fixture.includes(only)) continue;
    const runner = RUNNERS[fixture.fixture];
    if (!runner) throw new Error(`no runner for fixture ${fixture.fixture}`);
    const world = buildWorld(fixture);
    try {
      const manifests = buildManifests(world, fixture);
      const engine = new Engine(world, fixture.wave, world.lineRootsPath);
      const warden = new Warden(world, world.configPath);
      warden.init();
      const rows = await runner({ world, engine, warden, fixture, manifests });

      // Pair actual rows against the fixture's expected table, row by row.
      const expected = fixture.expected ?? [];
      const problems = [];
      if (rows.length !== expected.length) problems.push(`row count: expected ${expected.length}, ran ${rows.length}`);
      const table = [];
      for (let i = 0; i < Math.max(rows.length, expected.length); i += 1) {
        const act = rows[i];
        const exp = expected[i];
        if (!act) { problems.push(`extra expected row: ${exp.probe}`); continue; }
        if (!exp) { problems.push(`unexpected row ran: ${act.probe}`); continue; }
        const hit = act.probe === exp.probe && act.engine === exp.engine && act.warden === exp.warden;
        const verdict = hit ? exp.verdict : "DIFF";
        counts[verdict] += 1;
        const adjudication = adjudicationFor(fixture.probe_prefix, act.probe);
        table.push({ ...act, verdict, adjudication });
        if (!hit) {
          failures += 1;
          problems.push(`row ${exp.probe}: expected engine=${exp.engine} warden=${exp.warden} verdict=${exp.verdict}; actual engine=${act.engine} warden=${act.warden}`);
        } else if (exp.verdict === "EXPECTED-DIVERGENT") {
          divergentRows.push([act.probe, adjudication]);
        }
      }
      console.log(`\n== ${fixture.fixture} ==`);
      console.log(fmtTable(table));
      for (const p of problems) console.log(`FAIL ${fixture.fixture}: ${p}`);
    } finally {
      if (keep) console.log(`kept world: ${world.root}`);
      else fs.rmSync(world.root, { recursive: true, force: true });
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nrows: MATCH=${counts.MATCH} EXPECTED-DIVERGENT=${counts["EXPECTED-DIVERGENT"]} WARDEN-ONLY=${counts["WARDEN-ONLY"]} DIFF=${counts.DIFF}  (${secs}s)`);
  if (failures > 0) {
    console.log(`SELFTEST FAIL: ${failures} row(s) missed expectations`);
    return 2;
  }
  if (secs > 55) console.log("WARNING: selftest wall time approaching the 60s budget");
  console.log("SELFTEST PASS");
  return 0;
}

// ---------------------------------------------------------------- main
const argv = process.argv.slice(2);
if (argv.includes("--manifest")) {
  const { errors, opts } = parseRealArgs(argv);
  if (errors.length > 0) {
    for (const e of errors) console.log(`usage error: ${e}`);
    console.log("");
    usage();
    process.exit(1);
  }
  process.exitCode = await reconcile(opts);
} else if (argv.includes("--selftest")) {
  const keep = argv.includes("--keep");
  const onlyIdx = argv.indexOf("--fixture");
  const only = onlyIdx === -1 ? null : argv[onlyIdx + 1];
  if (onlyIdx !== -1 && !only) {
    console.log("--fixture requires a value");
    process.exit(1);
  }
  process.exitCode = await selftest({ keep, only });
} else {
  usage();
  process.exit(1);
}
