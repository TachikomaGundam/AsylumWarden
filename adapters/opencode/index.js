// THIN ADAPTER (M3). No business rules here; all validation is core's (fail-closed).
// Every warden_* handler does exactly one thing: map tool args -> CLI argv, run the
// core in-process via runCli(), return { output, exit }. No retries, no state
// access, no defaults, no interpretation of the envelope.
//
// PCB pilot boundary (docs/PILOT-PCB.md): this adapter must NEVER be installed into
// PCB sessions. The PCB pilot is CLI-only and shadow-only; the plugin path is out
// of bounds for that line.
//
// Plugin shape: verified against a real installed plugin on this machine,
// opencode-wiki-historian@0.6.3 (dist/index.js + dist/tools.js), 2026-11-05:
//
//   // dist/index.js (historian):
//   async function server(input, options) { ... return { tool: buildTools(opts) }; }
//   const plugin = { id: 'opencode-historian', server };
//   export default plugin;
//   // dist/tools/read.js (historian):
//   import { tool } from '@opencode-ai/plugin';
//   const s = tool.schema;                       // zod
//   tool({ description, args: { key: s.string() }, execute: async (raw) => string })
//
// The real plugin builds each tool with the SDK's `tool()` helper and zod schemas.
// This adapter must not import any host SDK (AGENTS.md: adapters never create a
// path back into core; the zero-dep promise; task constraint), so tool definitions
// are the same plain objects the helper returns — { description, args, execute } —
// with `args` declared as JSON Schema instead of zod. If the host-side loader ever
// needs zod args, that wrapping belongs at install time, not in core and not here.
// Everything host-facing is duck-typed: no @opencode-ai/* import anywhere, static
// or dynamic. If the host shape is missing/unexpected we register nothing and log
// once — never throw at load.
//
// Core is imported through the public library entry only (src/index.mjs exports
// runCli); zero subprocess. Import direction: adapters -> core, never the reverse
// (enforced by tools/import-gate.mjs).

import { runCli } from "../../src/index.mjs";

// CLI surface per docs/CONTRACT.md §8. `command` = fixed leading argv tokens;
// positional/value/bool entries map 1:1 onto CLI flags (camelCase tool param ->
// kebab-case flag, e.g. stateHome -> --state-home). Required-ness is NOT checked
// here — core fails closed (USAGE, exit 1) on a missing --actor/--epoch/etc.
const TOOL_SPECS = [
  {
    tool: "warden_init",
    command: ["init"],
    description: "Initialize the state home (genesis ledger entry + anchor push). " +
      "With bootstrapRegistry=true, create an absent registry file instead (needs registry, self, root).",
    positional: [],
    valueFlags: [
      { key: "config", flag: "config", desc: "Path to asylumwarden.json" },
      { key: "stateHome", flag: "state-home", desc: "State home override (test/shadow)" },
      { key: "registry", flag: "registry", desc: "Registry path (with bootstrapRegistry)" },
      { key: "self", flag: "self", desc: "Own line name (with bootstrapRegistry)" },
      { key: "root", flag: "root", desc: "Own writable root (with bootstrapRegistry)" },
    ],
    boolFlags: [
      { key: "force", flag: "force", desc: "Overwrite an existing registry file" },
      { key: "bootstrapRegistry", flag: "bootstrap-registry", desc: "Bootstrap the registry file" },
    ],
  },
  {
    tool: "warden_plan",
    command: ["plan"],
    description: "Validate a wave manifest and materialize the wave.",
    positional: [{ key: "manifest", desc: "Path to wave.json" }],
    valueFlags: [
      { key: "config", flag: "config", desc: "Path to asylumwarden.json" },
      { key: "stateHome", flag: "state-home", desc: "State home override" },
    ],
    boolFlags: [{ key: "force", flag: "force", desc: "Force re-plan" }],
  },
  {
    tool: "warden_ready",
    command: ["ready"],
    description: "List claimable cells of a wave (pending, dependencies done).",
    positional: [{ key: "wave", desc: "Wave id" }],
    valueFlags: [
      { key: "config", flag: "config", desc: "Path to asylumwarden.json" },
      { key: "stateHome", flag: "state-home", desc: "State home override" },
    ],
    boolFlags: [],
  },
  {
    tool: "warden_claim",
    command: ["claim"],
    description: "Acquire the lease on a cell (owner, epoch, TTL).",
    positional: [
      { key: "wave", desc: "Wave id" },
      { key: "cell", desc: "Cell id" },
    ],
    valueFlags: [
      { key: "actor", flag: "actor", desc: "Actor name (required by core)" },
      { key: "ttl", flag: "ttl", desc: "Lease TTL in seconds", type: "number" },
      { key: "config", flag: "config", desc: "Path to asylumwarden.json" },
      { key: "stateHome", flag: "state-home", desc: "State home override" },
    ],
    boolFlags: [{ key: "steal", flag: "steal", desc: "Steal a live lease (audited)" }],
  },
  {
    tool: "warden_renew",
    command: ["renew"],
    description: "Heartbeat: extend the lease of the current epoch.",
    positional: [
      { key: "wave", desc: "Wave id" },
      { key: "cell", desc: "Cell id" },
    ],
    valueFlags: [
      { key: "actor", flag: "actor", desc: "Actor name (required by core)" },
      { key: "epoch", flag: "epoch", desc: "Lease epoch (required by core)", type: "number" },
      { key: "ttl", flag: "ttl", desc: "New TTL in seconds", type: "number" },
      { key: "config", flag: "config", desc: "Path to asylumwarden.json" },
      { key: "stateHome", flag: "state-home", desc: "State home override" },
    ],
    boolFlags: [],
  },
  {
    tool: "warden_release",
    command: ["release"],
    description: "Voluntarily release a held lease.",
    positional: [
      { key: "wave", desc: "Wave id" },
      { key: "cell", desc: "Cell id" },
    ],
    valueFlags: [
      { key: "actor", flag: "actor", desc: "Actor name (required by core)" },
      { key: "epoch", flag: "epoch", desc: "Lease epoch (required by core)", type: "number" },
      { key: "config", flag: "config", desc: "Path to asylumwarden.json" },
      { key: "stateHome", flag: "state-home", desc: "State home override" },
    ],
    boolFlags: [],
  },
  {
    tool: "warden_requeue",
    command: ["requeue"],
    description: "Move a failed cell back to pending.",
    positional: [
      { key: "wave", desc: "Wave id" },
      { key: "cell", desc: "Cell id" },
    ],
    valueFlags: [
      { key: "config", flag: "config", desc: "Path to asylumwarden.json" },
      { key: "stateHome", flag: "state-home", desc: "State home override" },
    ],
    boolFlags: [],
  },
  {
    tool: "warden_done",
    command: ["done"],
    description: "Finish a cell as done with a receipt (core validates the receipt).",
    positional: [
      { key: "wave", desc: "Wave id" },
      { key: "cell", desc: "Cell id" },
    ],
    valueFlags: [
      { key: "actor", flag: "actor", desc: "Actor name (required by core)" },
      { key: "epoch", flag: "epoch", desc: "Lease epoch (required by core)", type: "number" },
      { key: "receipt", flag: "receipt", desc: "Receipt file path (required by core)" },
      { key: "config", flag: "config", desc: "Path to asylumwarden.json" },
      { key: "stateHome", flag: "state-home", desc: "State home override" },
    ],
    boolFlags: [],
  },
  {
    tool: "warden_fail",
    command: ["fail"],
    description: "Finish a cell as failed with a reason.",
    positional: [
      { key: "wave", desc: "Wave id" },
      { key: "cell", desc: "Cell id" },
    ],
    valueFlags: [
      { key: "actor", flag: "actor", desc: "Actor name (required by core)" },
      { key: "epoch", flag: "epoch", desc: "Lease epoch (required by core)", type: "number" },
      { key: "reason", flag: "reason", desc: "Failure reason (required by core)" },
      { key: "config", flag: "config", desc: "Path to asylumwarden.json" },
      { key: "stateHome", flag: "state-home", desc: "State home override" },
    ],
    boolFlags: [],
  },
  {
    tool: "warden_status",
    command: ["status"],
    description: "Status report for one wave or all waves.",
    positional: [{ key: "wave", desc: "Wave id (omit for all waves)" }],
    valueFlags: [
      { key: "config", flag: "config", desc: "Path to asylumwarden.json" },
      { key: "stateHome", flag: "state-home", desc: "State home override" },
    ],
    boolFlags: [],
  },
  {
    tool: "warden_verify",
    command: ["verify"],
    description: "Verify the ledger hash chain + anchor + receipt spot-check.",
    positional: [],
    valueFlags: [
      { key: "wave", flag: "wave", desc: "Restrict verification to one wave" },
      { key: "config", flag: "config", desc: "Path to asylumwarden.json" },
      { key: "stateHome", flag: "state-home", desc: "State home override" },
    ],
    boolFlags: [],
  },
  {
    tool: "warden_registry_check",
    command: ["registry", "check"],
    description: "Validate the registry, print its digest and the line table.",
    positional: [],
    valueFlags: [
      { key: "config", flag: "config", desc: "Path to asylumwarden.json" },
      { key: "stateHome", flag: "state-home", desc: "State home override" },
    ],
    boolFlags: [],
  },
];

// Pure arg -> argv mapping. Undefined/null params are omitted so core sees
// exactly what the caller passed (core decides required-ness, fail-closed).
export function buildArgv(spec, args) {
  const argv = [...spec.command];
  for (const p of spec.positional) {
    if (args[p.key] !== undefined && args[p.key] !== null) argv.push(String(args[p.key]));
  }
  for (const f of spec.valueFlags) {
    if (args[f.key] !== undefined && args[f.key] !== null) argv.push(`--${f.flag}`, String(args[f.key]));
  }
  for (const b of spec.boolFlags) {
    if (args[b.key] === true) argv.push(`--${b.flag}`);
  }
  return argv;
}

function jsonSchemaArgs(spec) {
  const args = {};
  for (const p of spec.positional) args[p.key] = { type: "string", description: p.desc };
  for (const f of spec.valueFlags) args[f.key] = { type: f.type ?? "string", description: f.desc };
  for (const b of spec.boolFlags) args[b.key] = { type: "boolean", description: b.desc };
  return args;
}

function buildTools() {
  const tools = {};
  for (const spec of TOOL_SPECS) {
    tools[spec.tool] = {
      description: spec.description,
      args: jsonSchemaArgs(spec),
      execute: async (rawArgs) => {
        const argv = buildArgv(spec, rawArgs ?? {});
        let output = "";
        const exit = await runCli(argv, { write: (chunk) => { output += chunk; } });
        return { output, exit };
      },
    };
  }
  return tools;
}

let logged = false;
function logOnce(reason) {
  if (logged) return;
  logged = true;
  console.error(`[asylumwarden-adapter] ${reason} — no warden_* tools registered (the CLI still works).`);
}

// Same hooks contract the historian plugin ships: server(input, options) resolves
// hooks whose `tool` field maps tool name -> definition. Degrades to a no-op
// (empty hooks, one console.error) when the host passes a missing/unexpected
// shape — registration must never crash host startup.
async function server(input, _options) {
  try {
    if (input === null || typeof input !== "object") {
      logOnce(`unexpected host API shape: server(input) received ${input === null ? "null" : typeof input}`);
      return {};
    }
    return { tool: buildTools() };
  } catch (err) {
    logOnce(`tool registration failed: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

const plugin = { id: "asylumwarden", server };
export default plugin;
