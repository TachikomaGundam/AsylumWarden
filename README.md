# AsylumWarden

**Status: core + CLI implemented (milestones M1–M2), adapter layer in
progress. The npm package `asylumwarden@0.0.0` is a name reservation; the
first functional release will be `0.1.0`.**

AsylumWarden is a local, file-first control plane for multi-seat AI work. It
keeps the plan, leases, receipts, and ledger on disk. It does not run a daemon,
require a database, or replace the host's sandbox.

- GitHub: <https://github.com/TachikomaGundam/AsylumWarden>
- npm: `asylumwarden` (0.0.0 name reservation; functional release `0.1.0`
  follows the release gate in [`docs/RELEASING.md`](docs/RELEASING.md))
- License: MIT

## What it is

- A registry of work lines and their writable / read-only / forbidden surfaces.
- A DAG planner with cycle and dependency checks.
- Atomic claims with owner, epoch, TTL, and heartbeat.
- Receipt validation: commands, artifacts, read mentions, and path containment.
- An append-only, hash-chained ledger that is tamper-evident, not tamper-proof.
- A thin CLI and optional opencode adapter.

## What it is not

- Not a sandbox. Same-uid processes can still bypass declarations.
- Not a replacement for PCB's control plane or Abathur's gates.
- Not a required dependency of Abathur. It is an optional companion.
- Not a daemon, scheduler service, or task database.

## Design

The approved architecture is in
[`docs/architecture-handoff.md`](docs/architecture-handoff.md). Wire formats
and error codes have a single source: [`docs/CONTRACT.md`](docs/CONTRACT.md)
with machine-readable schemas in `schemas/`. Security limits are stated
plainly in [`docs/SECURITY.md`](docs/SECURITY.md). The PCB pilot boundary is
in [`docs/PILOT-PCB.md`](docs/PILOT-PCB.md). Release rules are in
[`docs/RELEASING.md`](docs/RELEASING.md).

## Boundary with Abathur

Abathur does not import AsylumWarden and does not install it. AsylumWarden may
read Abathur data, but the dependency is one-way:

```text
AsylumWarden  ---reads/obeys--->  versioned contract
Abathur       ---does not depend on--->  AsylumWarden
```

## License

MIT. See [`LICENSE`](LICENSE).
