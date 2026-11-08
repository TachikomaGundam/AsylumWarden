# Architecture

> Status: architecture phase. Contract authority lives in
> [`docs/CONTRACT.md`](CONTRACT.md). This document covers structure, decisions,
> and boundaries. It does not restate wire formats.

## 1. What this project is

AsylumWarden is a local, file-first control plane for multi-seat AI work on one
machine under one uid. It plans waves of work, hands out leases, validates
receipts, and records every state change in an append-only, hash-chained
ledger.

Goals: wave dependencies, atomic claims, TTL leases, receipt validation.
Cross-line access is read-only by default, and a write must land inside the
writer's own line roots. Forbidden surfaces have one source; a missing
declaration fails closed. Node projects use the library; every other stack
uses the CLI.

Non-goals:

- Not a sandbox. It creates no containers, changes no mounts, isolates no uids.
- Not a model gateway. It calls no models and stores no keys.
- Not a task database. State is plain files.
- Not part of Abathur's kernel. The dependency runs one way (section 7).
- v1 has no cross-machine consistency, no web UI, and no multi-tenancy.

## 2. The shape decision: form C

Five shapes were evaluated. This document records the chosen shape; the
historical review record is kept outside the product repository.

| Option | Shape | Verdict |
|---|---|---|
| A | Pure opencode plugin | Rejected |
| B | Pure library | Rejected |
| C | Core library + CLI + thin adapters | **Chosen** |
| D | Vendored copies per consuming repo | Rejected |
| E | Daemon / always-on service | Rejected |

### 2.1 Why not a pure plugin (A)

A pure plugin writes host semantics into the product.

- Only opencode sessions can use it directly. VideoGen's Python flow, plain
  shell, Codex, and Claude would each need their own integration.
- Changing hosts means rewriting the only consumption path.
- Tool names, parameter shapes, and event mapping tangle with core lifecycle
  logic, so the core cannot be tested on its own.

The plugin experience survives, as an adapter. It is not the product body.

### 2.2 Why not a pure library (B)

A pure library loses the in-session tool experience.

- Every project writes its own glue.
- opencode users get no native `warden_*` tools.
- A CLI must exist anyway, or Python projects cannot consume the tool cheaply.

The library and CLI are the body. The plugin is an optional shell.

### 2.3 Why no vendored copies (D)

Vendoring puts six copies of the source across six lines.

- Ledger format, lease semantics, and security fixes drift per repository.
- An audit cannot give one verdict across the copies.
- A bug fix in one repository never reaches the others.
- Versions, hashes, and behavior matrices cannot be reconciled.

Vendoring is allowed only when all six conditions hold. Each is mechanically
checkable:

1. The target environment is fully offline and cannot install from npm.
2. The copy serves exactly one consumer.
3. The vendor snapshot records version, sha256, and upstream commit.
4. A written upstream-sync policy exists with an expiry review date.
5. Local modification of the core is not allowed; changes go upstream.
6. The vendor entry is registered in the ledger.

If any condition fails, use a dependency. Do not copy.

### 2.4 Why not a daemon (E)

A service introduces ports, permissions, start ordering, database migrations,
backups, and a monitoring surface. That breaks the product promises in
section 3. v1 needs no cross-machine strong consistency. Cross-machine work is
a separate future topic, not a v1 default.

## 3. Product promises

| Promise | Meaning |
|---|---|
| Zero runtime dependencies | `src/` imports Node stdlib only |
| Zero daemons | Every operation runs inside one CLI invocation |
| Zero databases | State is plain files under `state_home` |

The security threat model sits beside these promises in
[`docs/SECURITY.md`](SECURITY.md).

## 4. Component map

```text
Human terminal (the key holder)
        |
        v
AsylumWarden core
  config      lines, roots, forbidden surfaces, state directory
  manifest    waves, cells, dependencies, role snapshots
  planner     validation, normalization, persistence
  leases      atomic claims, TTL, epoch, heartbeat, crash recovery
  receipts    command, artifact, and read capture with hash checks
  ledger      append-only hash chain, external anchors
  views       ready / status / verify
        |
        +-------------------+-------------------+
        |                   |                   |
   opencode adapter    Codex/Claude adapter   CLI (JSON)
        |                   |                   |
        +-------------------+-------------------+
                            |
                  Python / shell / other projects
```

Dependency direction is one-way and enforced:

```text
adapters -> core
CLI      -> core
core     -> Node stdlib
core     NOT -> opencode / Codex / Claude / Python
```

A build gate checks this mechanically: if `src/` contains `@opencode-ai`, a
host package name, or an adapter path, the build fails.

Field-level shapes live only in [`docs/CONTRACT.md`](CONTRACT.md). See
section 9.

## 5. Repository layout

Target layout:

```text
AsylumWarden/
  package.json                 asylumwarden
  src/
    config/
    manifest/
    store/
    lease/
    receipt/
    ledger/
    views/
    cli/
  schemas/
    config.schema.json
    manifest.schema.json
    receipt.schema.json
    ledger.schema.json
  adapters/
    opencode/
  test/
    unit/
    contract/
    adversarial/
  docs/
    ARCHITECTURE.md
    CONTRACT.md
    SECURITY.md
    MIGRATION.md
    RELEASING.md
  README.md
  LICENSE
```

- `adapters/opencode/` is written last (milestone M3). Adapters depend on
  core; core never depends back.
- Standalone adapter packages stay inside `adapters/` until an independent
  release cadence exists. No Python library in v1; the CLI covers other stacks.

## 6. Milestone ladder

M0 (architecture) is done. Acceptance criteria: the M1–M5 table below.

| Milestone | Deliverables | Acceptance |
|---|---|---|
| M1 contracts | 4 JSON Schemas, contract-test skeleton, error-code table | Valid and malformed samples pass one by one; unknown-field policy explicit; no host imports; schemas cover the shadow-registry path, `forbidden_absolute` semantics, the `kinds` table, `max_hold`, shadow receipt fields, and whether `read_roots` may sit outside line roots or overlap `forbidden_absolute` (read allowed, write still rejected) |
| M2 core + CLI | config, manifest, state, lease, receipt, ledger, views, CLI | Unit plus adversarial tests; same-uid boundary documented and implemented the same way; ledger torn-write recovery; a shadow receipt impersonating `state/plan-approvals/**` is rejected; `forbidden_absolute` hits are rejected at `done` |
| M3 opencode adapter | Thin adapter: parameter mapping and tool registration only | Core imports no host; adapter contract tests pass; the CLI still works when the plugin is unavailable |
| M4 dual-run | Dual-run report for one real wave, diff list, migration decision | ready / blocked / rejection reasons match item by item; every mismatch has a named ruling; `wave_engine` is frozen |
| M5 release (human gate) | license, `private: false`, version, provenance, release notes, npm publish | Release gate fully green; install verified; supply-chain checked; GitHub repo name and npm package name match the fixed case |

M5 is an owner-only gate. Agents never publish, tag, or make the repo public
([`docs/RELEASING.md`](RELEASING.md)).

## 7. Boundary with Abathur

AsylumWarden is an independent project. The dependency is one-way:

```text
AsylumWarden  --may read-->      Abathur data
Abathur       --never depends--> AsylumWarden
```

Abathur may call AsylumWarden as an external CLI or library. AsylumWarden
imports nothing from Abathur and is never wired into the Abathur repository.

Disposition of the overlapping build (`tools/wave_engine/` in Abathur):

- `wave_engine` is a reference implementation, not a runtime. No code is
  copied; only methodology is borrowed.
- Line roots keep exactly one authoritative source. Migration order:
  1. Freeze `wave_engine`. No new features.
  2. Write the target configuration as `asylumwarden.json`.
  3. Dual-run one real wave. Compare ready, blocked, and rejection reasons
     item by item.
  4. After equivalence is proven, convert `line_roots.json` to a read-only
     archive.
  5. Documentation points at one source.
- Before the dual-run passes: `wave_engine` is not deleted, and the two
  configurations never both accept writes.
- Host-specific glue such as `orchestrate.py` stays in its own project. It does
  not enter the AsylumWarden core.

The frozen prototype under the Abathur tree is a behavior reference only. The
new repository is rewritten from the contract, never copied.

## 8. PCB pilot: shadow only

The first pilot runs in the PCB series Agent workspace and tests dispatch
ledger portability. It is shadow mode only: zero writes to the PCB repository,
shadow receipts are never PCB approval evidence, no adapter in PCB sessions,
CLI only. It never replaces PCB's own control plane.

The full mechanical rules, baseline snapshots, and pass/fail criteria are in
[`docs/PILOT-PCB.md`](PILOT-PCB.md).

## 9. Where the contracts live

Single-source rule: every wire format and error code has exactly one
authoritative definition.

| Fact | Authoritative source |
|---|---|
| Config, `wave.json`, ledger entry, lease, receipt, CLI JSON shapes | `docs/CONTRACT.md` + `schemas/` |
| Exit codes and error codes | `docs/CONTRACT.md` |
| Release and naming rules | `docs/RELEASING.md` |
| PCB pilot rules | `docs/PILOT-PCB.md` |

Contract changes follow semver. Adapter-private fields (tool names, parameter
shapes, host event mapping, display copy) must never enter the contract.
