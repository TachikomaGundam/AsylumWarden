# Changelog

Contract changes follow semver; before 1.0.0 breaking contract changes are
minor bumps recorded here (CONTRACT §11).

## 0.0.0 — 2026-11-05

Name-reservation publish. No runtime code, no contract surface.

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
