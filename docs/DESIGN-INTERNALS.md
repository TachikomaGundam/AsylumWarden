# DESIGN-INTERNALS — module API map (internal, not a public contract)

Public contract: `docs/CONTRACT.md`. This file pins the internal interfaces so
modules built independently compose without re-negotiation. Internal APIs may
change freely between releases; the public contract may not.

Layering (import direction only downward):

```text
src/cli/  ─▶ src/views/ src/config/ src/manifest/ src/lease/ src/receipt/ src/ledger/
src/views/ src/manifest/ src/lease/ src/receipt/ ─▶ src/config/ src/kernel/
src/config/ src/ledger/ ─▶ src/kernel/
src/kernel/ ─▶ node stdlib only
```

`src/context.mjs` (integration layer, written last) assembles everything.

## kernel (exists)

- `errors.mjs`: `WardenError(code,msg,violations)`, `fail(code,msg,violations)`,
  `violation(field,rule,detail)`, `exitClassFor(code)`, `EXIT_BUSINESS=1`,
  `EXIT_FAIL_CLOSED=2`.
- `canon.mjs`: `canon(value)` sorted-key stable stringify; `sha256Hex`,
  `sha256Of`, `sha256File(path)` (async), `GENESIS_PREV` (64 zeros).
- `fsutil.mjs`: `nowIso()` (ms precision UTC), `expandHome`, `readJsonCapped(path, cap, codeOnBad)`
  → `{value|nullproto,size}` (ENOENT passes through; other read errors → codeOnBad),
  `atomicWriteJson(path,value)` (tmp→fsync→rename→read-back), `ensureDir`,
  `fileExists`, `pidAlive(pid,host)`, `CAP_CONFIG`, `CAP_LINE`.
- `glob.mjs`: `compileGlob(absPattern)` → RegExp (`**` zero+ segments, trailing
  `/**` matches the dir itself), `matchGlob`, `matchAny(patterns,absPath)` → pattern|null.
- `schemalite.mjs`: `validateSchema(schema,value,pathLabel?)` → violations[];
  unsupported keyword in schema → `fail("INTERNAL")`.
- `state.mjs`: `layout(stateHome)` (all paths incl `ledgerLock`, `ownerFile`),
  `readStateJson` (STATE-CORRUPT), `writeStateJson`, `removeStateFile`,
  `readCell`/`writeCell`, `SAFE_ID_RE`, `HEX64_RE`.

## src/config/ — owner: delegation A

`load.mjs`:
- `loadProjectConfig({configPath?, cwd})` → `{config, configPath, configSha256,
  stateHome, registryPath}` — paths already expanded (`~`→abs, normalized);
  validates size cap + `schemas/config.schema.json` via schemalite
  (`SCHEMA-VIOLATION` with violations[]); walks up from cwd for
  `asylumwarden.json` unless `configPath` (else `CONFIG-MISSING`).
  Returned `config` object has extra non-persisted keys `_stateHome`,
  `_registryPath` set by the loader; or return them top-level — chosen: top-level.
- `loadRegistry(ctxLike)` → `{registry, registryPath, registrySha256}` —
  `REGISTRY-MISSING` (absent), sha256 file vs `registry_sha256` →
  `CONFIG-DRIFT`, schema validate (`REGISTRY-INVALID` for schema/semantic
  errors after load).
- `validateRegistrySemantics(registry, config)` — `ROOT-MISSING` (not dir),
  `ROOTS-OVERLAP` (within and across lines, equal-or-contains after
  normalization), shadow: `protect` key required (missing → CONFIG-INVALID;
  empty array legal) and any root equal/contains a `protect` entry →
  `FORBIDDEN-ROOT`; also shadow requires `state_home == shadow_home` (else
  CONFIG-INVALID) and registry path == `<shadow_home>/shadow-registry.json`.
- `buildPolicy({config, registry})` → `policy`:
  - `policy.line(name)` → `{name, roots, forbiddenRel[], forbiddenAbs[],
    readRoots[]}` (patterns compiled lazily) — unknown line → `REGISTRY-INVALID`.
  - `policy.forbiddenHit(absPath, lineName)` → pattern|null — combines
    relative-to-root-1 patterns and absolute patterns.
  - `policy.writableRootOf(lineName, absRoot)` → throws `PATH-ESCAPE` if
    outside line roots, `FORBIDDEN-ROOT` if it matches a forbidden pattern.
  - `policy.artifactOk(absRealPath, cell)` → throws `FORBIDDEN-SURFACE`
    (forbidden hit) / `PATH-ESCAPE` (not under any allowed_root).
  - `policy.readOk(absRealPath, cell, lineName)` → boolean.

`schemas.mjs`: `loadSchema("config"|"registry"|"manifest"|"receipt"|"ledger")`
— reads `schemas/*.schema.json` (path resolved relative to src root via
`import.meta.url`), caches, validates cap + parse (`INTERNAL`).

## src/manifest/ — owner: delegation A

`manifest.mjs`:
- `validateManifest(raw, {config, registry, policy})` → `{manifest, violations,
  warnings}` — schemalite first (fail-closed), then semantics: `UNKNOWN-KIND`,
  line known, `DEP-UNKNOWN/DUPLICATE/CYCLE`, duplicate cell ids, cwd is a
  directory inside an allowed root (`PATH-ESCAPE`), allowed roots inside line
  roots (`PATH-ESCAPE`), forbidden match inside allowed roots → hard
  `FORBIDDEN-ROOT`; line root containing a forbidden surface (line-wide
  breadth) → warning `{"rule":"broad-root"}`; shadow mode: wave id must match
  `^shadow-` (`SCHEMA-VIOLATION`).
- `planWave(ctx, {manifestPath, force})` → `{wave, cells:[{id,kind,line,cwd,state}], warnings}`
  — reads manifest file (`readJsonCapped` SCHEMA-VIOLATION), validates, ledger
  must exist (`ctx.ledger.verify()` chain check first; absent ledger →
  `LEDGER-BROKEN`), wave dir exists → `WAVE-EXISTS` unless `force` (force
  refuses if any cell is `claimed`/`done` → `CELL-STATE`), writes meta.json
  (`{wave, config_sha256, registry_sha256, created_at, cells:{id:cell_sha256}}`)
  + cells/<id>.json (state `pending`, epoch 0), appends `plan` event.

`ctx` usage (see integration): `ctx.{config,registry,policy,sl,mode,appendEvent}`.
Modules never import each other laterally; all shared state flows via ctx.

## src/ledger/ — owner: delegation B

`chain.mjs`:
- `openLedger({sl, config})` → ledger API (stateless functions over sl):
  - `append(type, {wave=null, cell=null, actor=null, payload={}})` → entry —
    validates type ∈ TYPES + entry via ledger.schema (`INTERNAL` on bug);
    takes `locks/ledger.lock` (O_EXCL; body `{pid,host,ts}`; stale >30s &
    dead pid → delete+retry once; live & >60s → `LEDGER-BUSY`), reads head,
    builds `{seq, ts:nowIso(), type, wave, cell, actor, payload, prev:headHash
    (or GENESIS_PREV), hash:sha256Of(entryWithoutHash)}`, appends one line,
    releases lock in `finally`.
  - `readAll()` → `{entries, head, torn: {line, detail}|null}` — last line
    only may be torn; a mid-file bad line is `LEDGER-TORN` too (report line).
  - `verify()` → `{chain_ok, entries, head, torn}` — seq/prev/hash walk,
    genesis first, prev-of-genesis == GENESIS_PREV.
  - `appendGenesisIfAbsent(ctx)` — writes `genesis` entry with
    `{registry_sha256, config_sha256}` when ledger file missing.
- Lock directory created by `ensureDir(sl.locks)` before O_EXCL attempt.

`anchor.mjs`:
- `pushAnchor(ctx, headEntry)` → `{ok, error?}` — per anchor type:
  `command`: spawn argv (`target` split via shell:false, JSON anchor line on
  stdin, 10s timeout, nonzero → fail); `remote`: fetch POST JSON, non-2xx →
  fail; `file`: append line to target path; `human-checkpoint`: read target
  file, require a line containing head hash, else fail. Failures never throw —
  returned as `{ok:false,error}` (caller maps ANCHOR-FAIL at init).
- `initAnchor(ctx)` — after genesis: anchor null → record anchor-state
  `{last_anchor_ts: null, audit_closure:"none"}`; else push, `{ok:false}` →
  `fail("ANCHOR-FAIL")` after removing the genesis state (init must not leave
  half state — implementation: verify anchor BEFORE writing genesis where
  possible; else rollback ledger file via rm — document choice in code).
- `maybeAnchor(ctx)` — read anchor-state; null anchor → `{degraded:null,
  closure:"none"}`; if `last_anchor_ts` null or now-ts>600s or headSeq-
  lastSeq>=50 → push; on push ok append `anchor` entry
  `{anchor_type,target_summary,head_seq,head_hash,ok:true}` and update
  anchor-state; on fail update failures, return `{degraded:"ANCHOR-DEGRADED"}`.
- `anchorSummary(ctx)` → `{closure:"external"|"local"|"none"|false, last_ts,
  last_seq, stale:boolean}` — closure "external" iff type ∈ {command,remote,
  human-checkpoint} and chain head == last anchored head; stale iff head
  beyond last anchor exists.

Anchor-state.json atomic via `writeStateJson`. Anchor ledger append happens
AFTER the anchor push succeeded (so the anchor entry itself is inside the
anchored window's future — documented limitation, matches §5.4).

## src/lease/ — owner: delegation C

`lease.mjs` (all take `(ctx, args)`, all append their event type, all mutate
cell via read-modify-atomic-write only AFTER lease file changes):
- `claim(ctx, {wave, cell, actor, ttlSeconds=1800, steal=false})` → owner
- `renew(ctx, {wave, cell, actor, epoch, ttlSeconds=1800})` → owner
- `release(ctx, {wave, cell, actor, epoch})` → `{released:true}`
- `requeue(ctx, {wave, cell})` → cell
Semantics: CONTRACT §6 (epoch, max_hold, steal window; takeover is
time-gated only, pid is forensic). TTL range 30..86400 (`USAGE`).
Missing wave → `WAVE-MISSING`; missing cell → `CELL-MISSING` (before lease
errors). Claim requires all deps `done` else business reject
`CELL-STATE` (payload lists blocked deps in violations). Role mtime check
(CONTRACT §3) → `RESTART-REQUIRED`. Lease history lines append to
`leases/<id>/history.jsonl` (best-effort audit, no schema).

## src/receipt/ — owner: delegation C

`receipt.mjs`:
- `doneWithReceipt(ctx, {wave, cell, actor, epoch, receiptPath})` →
  `{file, sha256}` — CONTRACT §7 order 1..6 (schema violations exit-2 class,
  semantic rejects 1-class per code table); on success: atomically copy
  receipt to `sl.receiptFile`, set cell done/failed per receipt status,
  append `done`/`fail` event `{receipt_sha256, status}`. Validation failures
  never mutate cell state. Shadow: extra checks (artifact under shadow_home,
  receipt carries mode/shadow_of, wave prefix).
- `failCell(ctx, {wave, cell, actor, epoch, reason})` → `{file, sha256}` —
  synthesizes failed receipt (status failed, summary=reason), same plumbing.

## src/views/ + src/cli/ — integration (main session)

- `views.mjs`: `readyCells(ctx,wave)`, `statusReport(ctx,wave?)`,
  `verifyAll(ctx,{wave?})` (chain verify + receipt spot-check + anchor
  summary; stale → CLI fails with ANCHOR-STALE exit 2).
- `cli/main.mjs`: parse argv (VALUE/BOOLEAN flag sets, unknown flag → USAGE),
  dispatch, envelope `{ok,code,message,...}` + violations/warnings/degraded,
  exit codes via `error.exitClass`; `--json` default true for machine use;
  `--version` → `{name:"asylumwarden",version,contract:1}`.
- `bin/asylumwarden.mjs`: `#!/usr/bin/env node` wrapper.

## Testing

- `node --test test/unit/ test/contract/ test/adversarial/` (root package.json
  scripts). Tests create temp state homes via `fs.mkdtemp(os.tmpdir()+"/aw-")`.
- Unit tests for config/manifest/lease/receipt build ctx by hand:
  `{config, registry, policy, sl, mode, ledger: fakeLedger}` where
  `fakeLedger` = in-memory `{append: async (t,e)=>…, verify: async()=>({chain_ok:true,entries:1,head:"0".repeat(64)}), readAll: …}` —
  real ledger only in ledger + integration tests. This keeps A/B/C independent.
- `test/contract/schemas.test.mjs`: every schema against valid + malformed
  fixtures; also assert all four fixture dirs round-trip.
- Adversarial list: `docs/TEST-PLAN.md`.
