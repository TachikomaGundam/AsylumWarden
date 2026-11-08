# TEST-PLAN — adversarial list

Derived from `docs/CONTRACT.md` and `docs/ARCHITECTURE.md` (M1/M2 acceptance). Every line names
the probe and the pass criterion. Fail-closed means the tool rejects; a test
passes when the rejection happens. Relaxing a rejection to make a test pass is
forbidden (AGENTS.md).

## T1 Schema layer (M1) — `test/contract/schemas.test.mjs`

| probe | pass criterion |
|---|---|
| valid config / registry / manifest / receipt / ledger fixtures | 0 violations |
| unknown key in any contract object | rejected (additionalProperties) |
| receipt with `mode:"shadow"` but no `shadow_of` (and vice versa) | rejected |
| normal receipt carrying `mode` key | rejected |
| ledger entry missing `prev` / `hash` | rejected |
| `__proto__` key in any JSON input | SCHEMA-VIOLATION (loader guard) |
| over-cap file (> 1 MiB config/receipt, > 256 KiB ledger line) | rejected |

## T2 Config & registry (fail-closed surface) — `test/unit/config.test.mjs`

| probe | pass criterion |
|---|---|
| no asylumwarden.json up-tree | CONFIG-MISSING exit 2 |
| registry sha256 drift | CONFIG-DRIFT exit 2 |
| line root missing / not a directory | ROOT-MISSING exit 2 |
| sibling prefix trap: root `/a/b` vs line root `/a/bc` | NOT overlap |
| root contains another line's root | ROOTS-OVERLAP exit 2 |
| shadow line root == or contains PCB repo root | FORBIDDEN-ROOT exit 2 |
| relative forbidden pattern anchored outside line root | GLOB-INVALID |
| trailing `/**` covers the directory itself | match |
| unknown cell kind not in `kinds` table | UNKNOWN-KIND exit 2 |

## T3 Manifest & plan — `test/unit/manifest.test.mjs`

| probe | pass criterion |
|---|---|
| dependency cycle | DEP-CYCLE exit 2 |
| duplicate dep entry | DEP-DUPLICATE exit 2 |
| dep id not in wave | DEP-UNKNOWN exit 2 |
| cwd outside allowed_roots | rejected |
| allowed root outside line roots | PATH-ESCAPE exit 2 |
| allowed root matching forbidden_absolute | hard reject |
| broad line root containing a forbidden surface | warning, not rejection |
| wave exists | WAVE-EXISTS exit 1; `--force` over done cells refuses |
| shadow wave id without `shadow-` prefix | rejected |

## T4 Ledger integrity — `test/unit/ledger.test.mjs`

| probe | pass criterion |
|---|---|
| happy chain (genesis + N) | verify chain_ok |
| flip 1 byte mid-entry | chain_ok false, LEDGER-BROKEN semantics |
| delete middle line | seq/prev break detected |
| torn last line (partial write) | verify reports torn line number; further append REFUSES LEDGER-TORN |
| 50 parallel appends | serialized: all lines self-consistent, unique seq, final verify ok |
| stale lock, dead pid | recovered, one retry, warning surfaced |
| live lock > 60 s | LEDGER-BUSY exit 2 |

## T5 Anchors — `test/unit/anchor.test.mjs`

| probe | pass criterion |
|---|---|
| command anchor `/bin/true` vs `/bin/false` | ok / {ok:false} |
| remote anchor 200 vs 500 (in-test server) | ok / degraded |
| file anchor closure | `"local"` — never counts toward closure |
| human-checkpoint anchor | ok only when head hash appears in signed record |
| anchor unreachable during claim/done | proceeds, degraded ANCHOR-DEGRADED recorded |
| maybeAnchor trigger: 50-seq delta | pushes |
| init with failing non-null anchor | ANCHOR-FAIL, no half-state left |

## T6 Leases (CONTRACT §6 required set) — `test/unit/lease.test.mjs`

| probe | pass criterion |
|---|---|
| double claim live lease | LEASE-HELD exit 1 |
| expired lease takeover | new epoch, event recorded |
| dead pid (CLI claimant exited) | lease honoured until expires_at — takeover is time-gated, pid is forensic |
| live pid, different host unreachable for probe | NOT early-reclaimed (time-gated only) |
| steal before max_hold_until | STEAL-DENIED |
| steal after max_hold_until | ok + steal event with prior owner evidence |
| renew forever past max_hold | LEASE-MAX-HOLD permanently for the epoch |
| renew wrong actor / wrong epoch | ACTOR-MISMATCH / EPOCH-MISMATCH |
| claim with pending deps | CELL-STATE listing blockers |
| requeue while leased | CELL-STATE |
| role_file mtime after session_started_at | RESTART-REQUIRED |

## T7 Receipts (M2 acceptance) — `test/unit/receipt.test.mjs`

| probe | pass criterion |
|---|---|
| any command exit != 0 with status done | RECEIPT-COMMANDS, cell state unchanged |
| artifact hash mismatch | RECEIPT-HASH, state unchanged |
| artifact symlink whose realpath escapes allowed root | PATH-ESCAPE |
| artifact under `forbidden_absolute` (incl. `*.consumed`) | FORBIDDEN-SURFACE exit 2 |
| artifact is PCB `state/plan-approvals/**` (read_root + forbidden in shadow) | rejected — shadow receipt can never impersonate approval evidence |
| read outside allowed∪read roots | READ-OUTSIDE |
| stored receipt bytes | byte-identical to submitted file (evidence preserved) |
| receipt validation failure | no cell mutation, no receipt stored |

## T8 Adversarial integration — `test/adversarial/` (post-integration, CLI-level)

| probe | pass criterion |
|---|---|
| two processes claim same cell (real CLI, 20 races) | exactly one CLAIMED per epoch; loser exit 1 |
| kill -9 mid-hold, peer reclaims after expiry | takeover + ledger evidence |
| full happy wave: plan→ready→claim→done (real CLI, temp HOME) | exit 0 chain, ready/blocked correct at every step |
| done on cell whose dep failed | rejected |
| shadow config pointed at real state_home | rejected (shadow state isolation) |
| registry replaced after plan (sha drift) | CONFIG-DRIFT on next command |
| ledger replaced with shorter valid chain (same-uid rewrite) | verify still chain_ok BUT anchor mismatch reports ANCHOR-STALE — documents the tamper-evident-not-proof limit |
| CLI JSON envelope on all commands | stable fields present; exit classes match CONTRACT §8.3 |
| import gate + zero-dep check | `npm run gate:imports` exit 0 |
| CLI works with adapter absent (M3 precondition) | all commands run without adapters/ |

## Ownership

- T1–T3: config/manifest team. T4–T5: ledger team. T6–T7: lease/receipt team.
- T8: integration session, after modules merge. Each test must be runnable
  via `npm test` from the repo root.
