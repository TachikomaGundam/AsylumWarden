# AsylumWarden

Local, file-first control plane for multi-seat AI work: registry, DAG planner,
leases, receipts, hash-chained ledger.

**Status: architecture phase. No runtime code, no tests, no CI, no lockfile,
no package scripts yet.** `.codegraph/` is a symlink to an external index.

## Read first

- `docs/architecture-handoff.md` (Chinese) — the approved architecture and the
  authoritative spec. §8 = stable contracts, §10 = Abathur boundary,
  §10.1 = PCB pilot rules, §11 = planned repo layout, §16 = work order.
- `docs/PILOT-PCB.md`, `docs/RELEASING.md`.

## Hard boundaries (violating these is a cross-line incident)

- **No code copying.** The frozen prototype
  (`~/workspace/harness/Abathur/plugins/AsylumWarden/`) and Abathur's
  `tools/wave_engine/` are behavior references only. Rewrite from the contract.
- **One-way dependency.** AsylumWarden may read Abathur data; Abathur must
  never import, install, or depend on AsylumWarden. Don't wire anything into
  the Abathur repo.
- **PCB pilot is shadow-only.** Never write into
  `~/workspace/harness/PCB-Agent`; shadow receipts are never PCB
  approval evidence; CLI-only, no adapter installed in PCB sessions
  (`docs/PILOT-PCB.md`).
- **Core is zero-dependency Node stdlib.** `src/` must not import host SDKs
  (`@opencode-ai`, Codex/Claude packages). Adapters under `adapters/` depend on
  core, never the reverse. A build gate for this is planned (handoff §7).
- **Product promises:** zero runtime deps, zero daemons, zero databases.
  Don't add runtime dependencies. State is plain files under `state_home`.

## Work order (handoff §16, followed by milestones §12)

Docs + 4 JSON schemas first (`ARCHITECTURE.md`, `CONTRACT.md`, `SECURITY.md`,
`schemas/`), then the adversarial test list, then core + CLI, adapter last.
Target layout: handoff §11.

## Contract rules

- §8 fields (config, `wave.json`, ledger entries, lease semantics, receipts,
  CLI JSON shape) are public contract — changes follow semver.
- CLI exit codes are fixed: `0` success, `1` usage/business rejection,
  `2` fail-closed / cannot-answer.
- Fail-closed is the design: missing config keys, `UNKNOWN-KIND`, overlapping
  roots, schema violations must reject — never default-open. Don't relax a
  rejection to make a test pass.
- Fixed paths are contract values: registry single source
  `~/.config/asylumwarden/registry.json` (projects only reference its
  `registry_sha256`), state home `~/.local/state/asylumwarden`, PCB shadow home
  `~/.local/state/asylumwarden-shadow-pcb`. Don't relocate or fork them.
- Security model is declaration + receipt validation, **not a sandbox**
  (same-uid can bypass). `SECURITY.md` must keep this wording; never claim
  enforcement the tool cannot provide.

## Toolchain

- Node `>=22.22.1` (engines), ESM (`"type": "module"`).
- No lint/test/format tooling exists yet. When introducing it, pick explicitly
  and record commands here; prefer `node --test` per the zero-dep promise.

## Release & naming

- GitHub: `TachikomaGundam/AsylumWarden` (user account, exact case).
  npm: `asylumwarden` (all lowercase, unscoped). Never a case variant.
- Keep `"private": true` and version `0.0.0` until the first reviewed release.
- **`npm publish`, tags, and making the repo public are owner-only keys —
  agents never run them.** Release gate steps: `docs/RELEASING.md`.
