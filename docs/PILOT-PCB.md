# PCB pilot: shadow-only

The first pilot runs in the PCB series Agent workspace. It tests portability of
the dispatch ledger. It does **not** replace PCB's control plane.

## Hard constraints

- PCB's `agents/pcb-orchestrator.md` remains the only external entry.
- Do not install the AsylumWarden opencode adapter in PCB.
- Do not register any tool that replaces `pcb_dispatch`, `pcb_dispatch_batch`,
  `pcb_dispatch_write`, or task91r.
- Do not launch PCB internal or board agents directly.
- The pilot is CLI-only and runs under the PCB seat's rules.
- The pilot's registry root is the shadow workspace, not the PCB repo.
- Shadow receipts are never PCB approval evidence.

## Shadow root

```text
~/.local/state/asylumwarden-shadow-pcb/workspace
```

The PCB repo root must not be registered as a line root for the shadow run.
The pilot's `forbidden_absolute` list must include the PCB control-plane files
and the PCB board/receipt directories.

## Acceptance

- The same synthetic or read-only wave produces the same ready / blocked
  decisions as the baseline.
- Planned rejections match the baseline.
- Zero writes to the PCB repo.
- Zero direct agent launches.
- Baseline diff: `git status --porcelain --ignored=matching`, `HEAD`, index
  hash, and `reports/state/dispatches` content hash are unchanged.
- Any bypass or board write is a FAIL, not a warning.

## Responsibility

The PCB seat creates and removes the shadow workspace under PCB lane rules.
The Abathur seat does not write into the PCB repo.
