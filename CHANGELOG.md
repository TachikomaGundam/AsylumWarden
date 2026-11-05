# Changelog

Contract changes follow semver; before 1.0.0 breaking contract changes are
minor bumps recorded here (CONTRACT §11).

## 0.0.0 — 2026-11-05

Name-reservation publish. No runtime code, no contract surface.

## contract revision (pre-0.1.0) — 2026-11-05

Lease concurrency amended (CONTRACT §6), found by the T8 adversarial suite:

- Defect: `claim` checked lease liveness then wrote `owner.json` without
  inter-process mutual exclusion — 20 concurrent claims produced multiple
  winners, and losers tripped the atomic-write read-back guard (exit 2
  INTERNAL instead of exit 1 LEASE-HELD).
- Fix: every lease mutation (`claim`/`renew`/`release`/`requeue`/`done`/
  `fail`) runs inside a per-cell exclusive lock
  (`waves/<w>/leases/<c>/claim.lock`, same posture as the ledger lock).
- New error code: `LEASE-BUSY` (exit 1, retryable) when lock contention
  exceeds the 5 s wait deadline.
- Wave/cell id validation and existence checks happen before lock
  acquisition (no filesystem probing with unsanitized ids, no directory
  minting for unknown waves).

## contract revision (pre-0.1.0) — 2026-11-05

Lease takeover semantics amended (CONTRACT §6) during integration E2E:

- Removed: dead-pid early reclaim (claim succeeding before `expires_at`
  because the recorded pid was dead).
- Reason: claimants are short-lived CLI processes that exit immediately
  after `claim`; pid-liveness made every lease instantly reclaimable and
  voided `LEASE-HELD` entirely.
- Replacement: takeover is time-gated only — expiry enables reclaim,
  `max_hold_until` enables `--steal`. The lease `pid`/`host` are forensic
  fields. Crash occupancy stays bounded by the same limits the handoff
  requires ("a malicious claimer delays a cell at most `max_hold`").
