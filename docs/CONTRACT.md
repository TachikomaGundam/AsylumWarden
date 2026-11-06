# CONTRACT — wire formats, semantics, error codes

This file is the single authoritative source for AsylumWarden's public
contract: file formats, field names, validation semantics, error codes, and
exit codes. The handoff (`docs/architecture-handoff.md` §8) is the design
record; where wording differs, this file governs the implementation. Schemas
under `schemas/` are the machine-readable view of the same rules. Contract
changes follow semver. Adapters may add private fields; core must never read
adapter-private fields.

## 1. Conventions

- **Node**: >= 22.22.1, ESM. Core (`src/`) imports Node stdlib only.
- **Time**: RFC 3339 UTC, `YYYY-MM-DDTHH:mm:ss.sssZ`. All comparisons in UTC.
- **Hashes**: SHA-256, lowercase 64-char hex, of UTF-8 bytes.
- **Canonical JSON** (`canon(x)`): recursive stable stringify — object keys
  sorted by UTF-16 code unit, arrays order-preserving, no insignificant
  whitespace, `JSON.stringify` number formatting. Used for every hash input.
- **IDs** (`SafeId`): wave ids and cell ids match
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Shadow wave ids additionally match
  `^shadow-`.
- **Paths in JSON**: absolute POSIX after `~` expansion. A leading `~/` is
  tolerated only inside `asylumwarden.json` and `registry.json` values and
  expands against `os.homedir()` at load time; manifest and receipt paths
  must already be expanded (schemas enforce `^/`). No `..` segments after
  resolution — the loader rejects non-normalized input.
- **Size caps** (violations fail closed with `SCHEMA-VIOLATION`):
  - config / registry / manifest / receipt files: 1 MiB (1_048_576 bytes)
  - one ledger line: 256 KiB
  - any single string value: 4096 chars
- **JSON parsing**: parsed objects get a null prototype (`JSON.parse` reviver
  or `Object.setPrototypeOf`). Keys `__proto__`, `prototype`, `constructor`
  in input objects are rejected. Unknown keys are rejected unless a section
  below explicitly allows them.
- **Glob syntax** (used by `forbidden_absolute` and relative
  `forbidden_surfaces`): patterns are matched against absolute, normalized
  paths. `**` matches any number of path segments (including zero); `*`
  matches within one segment; `?` matches one character. Matching is literal
  otherwise (no character classes, no brace expansion). A pattern that is not
  absolute where absolute is required fails closed with `GLOB-INVALID`.

## 2. Configuration

### 2.1 Project config `asylumwarden.json`

Discovered by: explicit `--config <path>`, else the nearest
`asylumwarden.json` walking up from `process.cwd()`. Missing config for any
command except `init` and `--help` fails closed with `CONFIG-MISSING`.

```json
{
  "version": 1,
  "registry": "~/.config/asylumwarden/registry.json",
  "registry_sha256": "<64hex>",
  "self": "abathur",
  "state_home": "~/.local/state/asylumwarden",
  "mode": "normal",
  "kinds": { "verify": { "description": "independent review, read-only" } },
  "anchor": null
}
```

Required keys: `version`, `registry`, `registry_sha256`, `self`,
`state_home`, `mode`. Optional keys: `kinds` (default `{}`), `anchor`
(default `null`). No other keys. `mode` is `"normal"` or `"shadow"`.
`version` is exactly `1`.

When `mode == "shadow"`, the config must also carry `shadow_of` (64hex, the
sha256 of the real registry at shadow-creation time), `shadow_home`
(absolute path), and `protect` (array of absolute paths, possibly empty).
`protect` names roots the shadow line must never equal or contain — the
machine-specific protected surfaces (for the PCB pilot line it is that
machine's PCB repo root, declared in the machine's shadow config, never
hardcoded in this repository). These three keys are forbidden in `normal`
mode.

Validation failures: `CONFIG-INVALID` (shape/type/value), `CONFIG-DRIFT`
(`registry_sha256` does not equal the sha256 of the registry file bytes).

### 2.2 Registry (machine-wide single source)

Canonical path `~/.config/asylumwarden/registry.json`. Every project
references it by hash; copies are forbidden except the named shadow
exception (§10).

```json
{
  "version": 1,
  "lines": {
    "abathur": {
      "roots": ["~/workspace/harness/Abathur"],
      "forbidden_surfaces": [".omo/evidence/INTENT-LEDGER.md"],
      "forbidden_absolute": [],
      "read_roots": []
    }
  }
}
```

Line keys: `roots` (required, non-empty), `forbidden_surfaces` (required,
possibly empty; patterns relative to the line's **first** root), optional
`forbidden_absolute` (absolute patterns; protects surfaces regardless of
which line touches them), optional `read_roots` (line-wide read grants, may
point outside the line's roots — reading is allowed, writing is not; they may
overlap `forbidden_absolute`: reads allowed, writes still rejected).

Registry validation (all fail closed):

- `REGISTRY-INVALID`: shape, duplicate keys, empty `roots`, bad line names
  (must be `SafeId`).
- `ROOT-MISSING`: a root does not exist or is not a directory.
- `ROOTS-OVERLAP`: within one line, or across lines, a root equals or
  contains another root.
- `FORBIDDEN-ROOT`: in shadow mode, any root equal to or containing an entry
  of the config's `protect` array (§2.1). Protected surfaces are config
  values, never code constants; an empty `protect` means the operator
  declared no protected roots.
- Relative `forbidden_surfaces` resolve against line root #1; use
  `forbidden_absolute` for any cross-line protection (relative patterns
  anchored at a foreign line root fail closed with `GLOB-INVALID`).

### 2.3 Anchor configuration

`anchor` is `null` or:

```json
{ "type": "command" | "remote" | "human-checkpoint" | "file",
  "target": "<string, meaning per type>",
  "signer": "<optional string label>" }
```

`file` anchors (same machine, same uid) are local checkpoints only. They
never count as external anchors and never satisfy a release gate. External
anchor types are `command` (argv array or shell-quoted command receiving the
anchor line on stdin), `remote` (HTTP(S) POST target), `human-checkpoint`
(path to a human-signed checkpoint record validated at read time).

`anchor == null` is legal for development: the chain still runs, but `verify`
always reports `audit_closure: "none"` and the release gate fails.

## 3. Manifest `wave.json`

Input to `plan`. Top-level keys: `version` (exactly `1`), `wave` (`SafeId`),
`cells[]` (1..1024). No other keys.

Cell keys — required: `id`, `kind`, `line`, `cwd`, `allowed_roots`, `deps`.
Optional: `read_roots`, `role`, `role_file`, `session_started_at`, `brief`,
`acceptance`. No other keys.

- `id`: `SafeId`, unique within the wave.
- `kind`: one of `gen`, `verify`, `doc`, `build`, or a key of the project
  config `kinds` table. Anything else fails closed with `UNKNOWN-KIND`.
- `line`: a name present in the registry.
- `cwd`: exists, is a directory, is inside one of `allowed_roots`.
- `allowed_roots`: non-empty; each inside the line's `roots`; each not equal
  to or inside any of the line's `forbidden_surfaces` /
  `forbidden_absolute` matches.
- `read_roots`: may be inside the line, in the line's `read_roots`, or any
  registry-declared `read_roots` of any line. Reads outside the union of the
  cell's `read_roots`, `allowed_roots`, and its line's `read_roots` are
  receipt violations.
- `deps`: array of cell ids present in the wave, no duplicates, cycle-free.
  Violations: `MANIFEST-INVALID` (shape), `DEP-UNKNOWN`, `DEP-CYCLE`,
  `DEP-DUPLICATE` (fail closed at plan time).
- `role_file` + `session_started_at`: role snapshot. At `claim`, if the
  role file's mtime is later than `session_started_at`, the claim is rejected
  with `RESTART-REQUIRED` (retryable; exit 1).

A wide `allowed_roots` that contains a `forbidden_surfaces` match is a plan
**warning** (`warnings[]` in the plan result), not a rejection — board-wide
grants stay usable. `forbidden_absolute` matches inside `allowed_roots` are a
hard rejection (`FORBIDDEN-ROOT`).

## 4. State layout

```text
<state_home>/
  config.json                 snapshot {config, config_sha256, created_at}
  ledger.jsonl                append-only hash chain (§5)
  anchor-state.json           {last_anchor_ts, last_anchor_seq, last_anchor_hash, failures}
  locks/ledger.lock           append lock (§5.3)
  waves/<wave>/
    meta.json                 {wave, config_sha256, registry_sha256, created_at, cells: {<id>: <cell-sha256>}}
    cells/<id>.json           cell state (§4.1)
    leases/<id>/owner.json    current lease (§6)
    leases/<id>/history.jsonl audit lines for steal/release/expiry
  receipts/<wave>/<id>.json   last accepted receipt (§7)
```

All JSON state files are written atomically: temp file in the same directory,
full write, `fsync`, `rename`, re-read verification.

### 4.1 Cell state file `cells/<id>.json`

```json
{
  "id": "…", "wave": "…", "kind": "…", "line": "…", "cwd": "…",
  "allowed_roots": ["…"], "read_roots": ["…"], "deps": ["…"],
  "role": null, "role_file": null, "session_started_at": null,
  "brief": null, "acceptance": null,
  "state": "pending" | "claimed" | "done" | "failed",
  "epoch": 0,
  "planned_at": "…", "updated_at": "…"
}
```

`epoch` is the epoch of the current (or most recent) lease; `0` before the
first claim.

## 5. Ledger

### 5.1 Entry format (one JSON object per line)

Keys, all required: `seq` (int >= 1), `ts`, `type`, `wave`, `cell`, `actor`,
`payload` (object, may be `{}`), `prev`, `hash`. `wave`/`cell`/`actor` may be
`null` where the event has none (e.g. `genesis`, `anchor`).

Entry hash: `hash = sha256(canon(entry_without_hash_field))`.
`seq` of the first entry is 1. `prev` of entry *n* is the `hash` of entry
*n-1*; the genesis entry's `prev` is 64 zeros.

### 5.2 Entry types

`genesis` (first entry, payload: `{registry_sha256, config_sha256}`),
`plan`, `claim`, `renew`, `release`, `requeue`, `steal`, `done`, `fail`,
`anchor` (payload: external anchor receipt summary). Unknown types written by
core are a defect; readers reject unknown types with `LEDGER-BROKEN`.

### 5.3 Append protocol

- Lock: `locks/ledger.lock` created with `O_CREAT | O_EXCL`; body
  `{pid, host, ts}`.
- A lock older than 30 s whose `pid` is dead is removed, then reacquired
  (recorded as a `warning` in the CLI result).
- A lock whose `pid` is alive and older than 60 s fails closed:
  `LEDGER-BUSY` (exit 2).
- Append = open with `O_APPEND`, write one complete line + `\n`, `fsync`,
  close. The ledger file is never rewritten or truncated.
- Torn tail recovery: `init`/`plan`/`claim`/`done`/`verify` detect a final
  line that is not parseable or whose hash does not chain: `verify` reports
  `LEDGER-TORN` (exit 2) and the offending line number; no command may
  auto-delete lines.

### 5.4 Anchors

- At `init`: write the genesis entry, then push the anchor (per §2.3). A
  failed anchor push for a non-`file`/`remote`/`command`/`human-checkpoint`
  configured anchor fails `init` (`ANCHOR-FAIL`, exit 2, state left
  unmodified). With `anchor: null`, init succeeds and records
  `audit_closure: "none"`.
- Trigger: every CLI invocation checks the chain; if
  `now - last_anchor_ts > 600 s` or `seq - last_anchor_seq >= 50`, attempt an
  anchor push. `done`/`fail` re-check immediately after appending. No
  background timers.
- Anchor payload recorded as an `anchor` entry:
  `{anchor_type, target_summary, head_seq, head_hash, ok}`.
- Anchor target unreachable: `claim`/`done` continue but append
  `{ok: false, error: "ANCHOR-STALE"}` context and the CLI result carries
  `degraded: "ANCHOR-DEGRADED"`; `verify` returns `ANCHOR-STALE` (exit 2)
  and `audit_closure: false`. A chain window since the last successful anchor
  must never be described as closed.

## 6. Leases

Every lease mutation (`claim`/`renew`/`release`/`requeue`/`done`/`fail`) runs
inside a per-cell exclusive lock (`waves/<wave>/leases/<cell>/claim.lock`,
same create/stale/busy posture as §5.3): the check-to-write sequence must be
atomic across processes, or two claims both pass the liveness check and race
into `owner.json`. Contention past the 5 s wait deadline fails as
`LEASE-BUSY` (exit 1, retryable).

Lease file `waves/<wave>/leases/<cell>/owner.json`:

```json
{
  "actor": "…", "pid": 1234, "host": "…", "epoch": 3,
  "acquired_at": "…", "heartbeat_at": "…", "expires_at": "…",
  "max_hold_until": "…", "ttl_seconds": 1800
}
```

- `claim`: succeeds when the cell is `pending` and every dep is `done`. The
  first claim sets `epoch = 1`. Reclaim of an expired lease increments
  `epoch`.
- Default `ttl_seconds` 1800 (allowed range 30..86400).
- `max_hold`: default `max(2*ttl, 30m)` from `acquired_at`; recorded as
  `max_hold_until`.
- `renew`: same `actor` AND same `epoch` only. Expired lease:
  `LEASE-EXPIRED` (exit 1). Same actor beyond `max_hold_until`:
  `LEASE-MAX-HOLD` (exit 1) — further renew is impossible, forever.
- `claim --steal`: only while `now > max_hold_until` of the current lease;
  takes the cell at `epoch+1`, appends `steal` with
  `{prior: {actor, epoch, max_hold_until}, evidence}`. Before
  `max_hold_until`: `STEAL-DENIED` (exit 1). A claim (without `--steal`) on
  a live lease: `LEASE-HELD` (exit 1).
- `pid`/`host` in the lease are forensic records only. Takeover is
  time-gated, never pid-gated: CLI claimants are short-lived processes that
  exit right after `claim`, so pid-liveness would void every lease. A crashed
  holder therefore blocks its cell only until `expires_at` (reclaim) or
  `max_hold_until` (steal), which is the handoff's blocking bound.
- `release`: same actor + epoch; removes the lease, cell returns to
  `pending`, epoch number is never reused.
- `requeue`: administrative reset of a `failed` cell to `pending`; no lease
  may exist. `CELL-STATE` otherwise.

## 7. Receipt

Written by the caller, consumed by `done` via `--receipt <file>`.

```json
{
  "version": 1,
  "cell": "…", "actor": "…", "epoch": 3,
  "status": "done" | "failed",
  "summary": "text",
  "commands": [{ "cmd": "…", "exit": 0 }],
  "artifacts": [{ "path": "/abs", "sha256": "<64hex>" }],
  "reads": ["/abs", "…"]
}
```

No other keys, except in shadow mode where `mode: "shadow"` and `shadow_of`
(64hex) are required (§10).

`done` validation — all must pass or the receipt is rejected and **cell
state is unchanged**:

1. `actor` + `epoch` match the live lease (`EPOCH-MISMATCH` /
   `ACTOR-MISMATCH`, exit 1).
2. `status == "done"` requires every `commands[].exit == 0`
   (`RECEIPT-COMMANDS`, exit 1).
3. `cell` matches the target cell; `version` is 1 (`SCHEMA-VIOLATION`).
4. Every artifact exists, is a regular file (not a symlink —
   `lstat` first), `realpath` is inside one of the cell's `allowed_roots`,
   and is not matched by any `forbidden_surfaces` / `forbidden_absolute`
   pattern (`FORBIDDEN-SURFACE`, exit 2; containment failures
   `PATH-ESCAPE`, exit 2).
5. Recomputed `sha256(file bytes)` equals the claimed hash
   (`RECEIPT-HASH`, exit 1).
6. Every `reads[]` path exists and its realpath lies inside `allowed_roots ∪
   read_roots ∪ line.read_roots` (`READ-OUTSIDE`, exit 1).

Receipts prove *path + content-at-time*. They never prove content benignity,
and (shadow mode) never prove approval. A successful `done`/`fail` consumes
the lease: `owner.json` is removed, keeping the invariant that a cell not in
`claimed` state carries no lease (otherwise `requeue` after `fail` would
deadlock).

## 8. CLI

Entry point: `asylumwarden <command> [options]`. Global options:
`--config <path>`, `--json` (default for machine output), `--state-home
<dir>` (test override), `--actor <name>`.

Commands:

| command | args | purpose |
|---|---|---|
| `init` | `[--force]` | create state home, genesis entry, anchor push; if registry file absent, refuse (`REGISTRY-MISSING`) unless `--bootstrap-registry` with `--self`/`--root` |
| `plan` | `<wave.json> [--force]` | validate + materialize wave |
| `ready` | `<wave>` | claimable cells (pending, deps done) |
| `claim` | `<wave> <cell> [--ttl S] [--steal]` | acquire lease |
| `renew` | `<wave> <cell> --epoch E [--ttl S]` | heartbeat |
| `release` | `<wave> <cell> --epoch E` | voluntary release |
| `requeue` | `<wave> <cell>` | failed → pending |
| `done` | `<wave> <cell> --epoch E --receipt F` | finish with receipt |
| `fail` | `<wave> <cell> --epoch E --reason TEXT` | finish failed |
| `status` | `[wave]` | one wave or all waves |
| `verify` | `[--wave W]` | ledger chain + anchor + receipt spot-check |
| `registry` | `check` | validate registry + print digest + line table |

### 8.1 JSON envelope (stable)

Success:

```json
{ "ok": true, "code": "OK", "message": "…",
  "wave": null, "cell": null, "actor": null, "epoch": null,
  "state": null, "expires_at": null, "receipt": null,
  "violations": [], "warnings": [], "degraded": null }
```

Failure:

```json
{ "ok": false, "code": "<ERROR-CODE>", "message": "…",
  "violations": [ { "field": "…", "rule": "…", "detail": "…" } ],
  "warnings": [], "degraded": null }
```

`violations`, `warnings`, `degraded` are additive extensions of §8.7 of the
handoff (which they must remain a superset of). Command payloads add their own
stable fields on top (e.g. `plan` adds `cells[]`, `ready` adds `ready[]`,
`verify` adds `entries`, `head`, `audit_closure`).

### 8.2 Exit codes

- `0` — success (`ok: true`).
- `1` — usage error or business rejection. Retryable after changing inputs
  or waiting.
- `2` — fail closed: contract, config, schema, ledger integrity. Retrying the
  same input cannot succeed.

### 8.3 Error codes

Exit 1 (usage / business): `USAGE`, `UNKNOWN-COMMAND` (bad argv, before any
state read), `USAGE` subsumes malformed flags.
`LEASE-HELD`, `LEASE-EXPIRED`, `LEASE-MAX-HOLD`, `LEASE-BUSY`, `STEAL-DENIED`,
`EPOCH-MISMATCH`, `ACTOR-MISMATCH`, `CELL-STATE`, `RESTART-REQUIRED`,
`RECEIPT-COMMANDS`, `RECEIPT-HASH`, `READ-OUTSIDE`, `WAVE-EXISTS`,
`WAVE-MISSING`, `CELL-MISSING`.

Exit 2 (fail closed): `CONFIG-MISSING`, `CONFIG-INVALID`, `CONFIG-DRIFT`,
`REGISTRY-MISSING`, `REGISTRY-INVALID`, `ROOTS-OVERLAP`, `ROOT-MISSING`,
`FORBIDDEN-ROOT`, `GLOB-INVALID`, `UNKNOWN-KIND`, `MANIFEST-INVALID`,
`DEP-UNKNOWN`, `DEP-CYCLE`, `DEP-DUPLICATE`, `PATH-ESCAPE`,
`FORBIDDEN-SURFACE`, `SCHEMA-VIOLATION`, `STATE-CORRUPT`, `LEDGER-BROKEN`,
`LEDGER-TORN`, `LEDGER-BUSY`, `ANCHOR-FAIL`, `ANCHOR-STALE`, `INTERNAL`.

The ledger is appended for every attempt that passed config + registry
loading, including rejected operations (payload carries the rejection code).

## 9. Views

- `ready <wave>`: cells with `state == "pending"` whose deps are all `done`.
- `status`: per cell — state, epoch, lease holder, expiry, receipt hash if
  done.
- `verify`: walk chain (seq/prev/hash), check ledger head vs. every wave's
  cell files and receipts (receipt file hash matches the `done` entry
  payload), then anchor state. Verdict fields: `chain_ok`, `entries`,
  `head`, `audit_closure` (`"external" | "local" | "none" | false`),
  `anchor` summary.

## 10. Shadow mode

- Activated by `mode: "shadow"` config. Requires `shadow_of`, `shadow_home`,
  and `protect` (§2.1).
- Shadow registry: fixed path `<shadow_home>/shadow-registry.json` — the
  named exception to §2.2. Shadow ledger: `<shadow_home>/ledger.jsonl`.
  Shadow state never shares files with `state_home` of the real line; the
  real `~/.local/state/asylumwarden/ledger.jsonl` is never appended by a
  shadow run.
- Every shadow wave id must start with `shadow-` (validator-enforced).
- Every shadow receipt must carry `mode: "shadow"` and `shadow_of`.
- `done` in shadow mode additionally rejects artifacts outside
  `shadow_home`; registry validation rejects any root equal to or containing
  a `protect` entry (`FORBIDDEN-ROOT`).
- Shadow receipts are never approval evidence: they can never satisfy a
  read-side check for `state/plan-approvals/**` or any other line's
  approval surfaces. Consumers treat `mode: "shadow"` as non-authoritative
  unconditionally.

## 11. Versioning

- `version` fields in config / registry / manifest / receipt are exactly `1`.
- A field addition is a minor release; a field removal, rename, semantic
  change, or exit-class change is a major (breaking) release. Before 1.0.0
  this is a minor bump, documented in `CHANGELOG.md`.
- Adapters must feature-detect via `asylumwarden --version` (prints
  `{name, version, contract: 1}` as JSON with `--json`).
