# Security

> Status: architecture phase. Contract authority lives in
> [`docs/CONTRACT.md`](CONTRACT.md). This page states what the tool does and
> provably cannot do. It never claims enforcement the tool cannot provide.

## 1. Six hard statements

These six statements are the security model. They are load-bearing. No
document, adapter, or release note may soften them.

1. **This tool is declaration plus receipt validation. It is not a sandbox.**
   It checks declarations and validates receipts. It creates no containers,
   changes no mounts, and isolates no uids.

2. **Same-uid processes can bypass everything.** A process running under the
   same uid can rewrite state, forge receipts, and bypass the manifest. The
   tool cannot prevent this. It can only leave records that others can check.

3. **Path checks carry a TOCTOU window.** Path validation is a string and
   prefix declaration plus a realpath re-check after the write. A
   time-of-check to time-of-use gap remains. Real write denial lives in the
   mount layer, a separate uid, or a VM. None of those belong to this tool.

4. **The ledger hash chain is tamper-evident, not tamper-proof.** It detects
   accidental corruption and after-the-fact rewriting of entries. It does not
   defeat a same-uid process rewriting the whole window consistently. Audit
   closure additionally requires an external anchor (section 4).

5. **Receipt artifact hashes prove content-at-time, not content benignity.**
   A receipt says "this file held these bytes at that moment." It says nothing
   about whether the content is safe, correct, or well-intentioned.

6. **Cross-line read-only is a declaration.** The tool records and checks the
   declaration. The real denial belongs to the sandbox or mount layer. That
   power is the owner's key, never this tool's.

## 2. Accepted residual risks

From `docs/ARCHITECTURE.md` section 14. Each is accepted, not fixed:

| Risk | Consequence |
|---|---|
| Same-uid state rewrite and receipt forgery | Records only; prevention impossible at this layer |
| TOCTOU on path checks | Denial must live below the tool |
| No external anchor yet | Only "accidental corruption detected" may be claimed |
| Shared state home | One corruption affects multiple lines; backup and recovery procedures are required |
| A broad line root that contains forbidden surfaces | Warning only, not a hard rejection; a hard rejection would kill every whole-repo task |
| A cell `allowed_roots` equal to or inside a forbidden surface | Hard rejection (contract rule, see `docs/CONTRACT.md`) |
| PCB baseline snapshots | Same-uid can alter both the worktree and the ledger; the snapshot proves "no difference between the two probes", not "nobody touched it" |

## 3. Mechanical checks the tool does provide

Declaration is weak without checks that run anyway. These are required and
tested:

| Check | Mechanism |
|---|---|
| Host import gate | `src/` must not import host SDKs (`@opencode-ai`, Codex/Claude packages, adapter paths). Build gate fails the build on a hit. |
| Post-write verification | realpath plus sha256 taken after every artifact write; symlink swaps must fail. |
| Schema validation | Config, manifest, and receipt inputs run through JSON Schemas. Parsed objects use null prototypes (arrays keep array semantics). Size caps apply. Malformed input fails closed. |
| Ledger integrity | Single-writer lock or atomic append; EOF-only append; torn-write recovery is tested. |
| Lease adversarial tests | Concurrent claim, expiry takeover, live-process hold, `max_hold` steal. Takeover is time-gated; the lease pid is forensic (short-lived CLI claimants exit by design). |
| Forbidden-surface rejection tests | Missing `forbidden_surfaces` declaration fails closed; a cell `allowed_roots` inside a forbidden surface is rejected; cross-line writable roots are rejected; `forbidden_absolute` hits (including `*.consumed`) are rejected at `done`. |
| Unknown-kind rejection | An unregistered `kind` yields `UNKNOWN-KIND`, never a silent default. |
| Shadow receipt gate | `verify` rejects a `mode:"shadow"` receipt as a substitute for `state/plan-approvals/**` evidence. |
| Release gate | license set, `private` flag resolved, provenance present, contract tests green, adapter tests green. |

Fail-closed is the posture: a missing config key, overlapping roots, or a
schema violation rejects the operation. No rejection is relaxed to make a test
pass.

## 4. External anchors

The hash chain alone supports one claim: accidental corruption was detected.
Audit closure needs a record the same uid cannot rewrite.

- Anchor types that count toward the release gate: `command` (a human or
  external signing command), `remote` (a different host or service), and
  `human-checkpoint` (a human-signed record).
- A `file` anchor on the same machine under the same uid is a local checkpoint
  only. It never counts as an external anchor and cannot satisfy the release
  gate on its own.
- Genesis: `init` writes a `GENESIS` entry (first hash, registry sha256, time)
  to the anchor target. If that write fails, `init` fails. No silent
  degradation.
- Triggering: every CLI call checks the interval since the last anchor
  (threshold 10 minutes); every 50 events also triggers. There is no
  background timer, consistent with the zero-daemon promise.
- Unreachable anchor: `claim` and `done` continue, and the ledger records
  `ANCHOR-DEGRADED`. `verify` returns `ANCHOR-STALE`, the audit-closure claim
  is false, and `release` or publish is blocked by the gate.
- The chain window after the last successful anchor must never be described as
  closed. A same-uid process can rewrite that window whole. This is a known
  residual risk.

## 5. Keys the owner holds

These powers sit outside the tool, with the human owner:

- `npm publish`, git tags, and making the repository public
  ([`docs/RELEASING.md`](RELEASING.md)). Agents never hold these keys.
- Sandbox, mount-layer, and uid-isolation enforcement. This is where real write
  denial lives (statement 3 and statement 6).
- The anchor endpoint or signing flow for external anchors (section 4).

## 6. How to read a clean `verify` run

A passing `verify` means: declarations were consistent, receipts matched their
paths and hashes at capture time, and the chain verified against its last
external anchor. It does not mean: no same-uid tampering occurred, the content
is benign, or writes were physically prevented. Read every green result
through sections 1 and 4.
