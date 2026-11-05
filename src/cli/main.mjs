// CLI — language-neutral JSON entry. Envelope + exit codes per CONTRACT §8.

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { WardenError, fail, violation } from "../kernel/errors.mjs";
import { ensureDir } from "../kernel/fsutil.mjs";
import { makeContext } from "../context.mjs";
import { planWave } from "../manifest/plan.mjs";
import { claim, renew, release, requeue } from "../lease/lease.mjs";
import { doneWithReceipt, failCell } from "../receipt/receipt.mjs";
import { readyCells, statusReport, verifyAll } from "../views/views.mjs";
import { initAnchor, maybeAnchor } from "../ledger/anchor.mjs";

const VALUE_FLAGS = new Set([
  "config", "state-home", "actor", "ttl", "epoch", "receipt", "reason", "self", "root", "wave", "registry",
]);
const BOOLEAN_FLAGS = new Set(["force", "steal", "json", "help", "version", "bootstrap-registry"]);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      if (VALUE_FLAGS.has(name)) {
        let value;
        if (eq !== -1) value = token.slice(eq + 1);
        else {
          value = argv[i + 1];
          i += 1;
        }
        if (value === undefined || (value.startsWith("--") && value.length > 2)) {
          fail("USAGE", `--${name} requires a value`, [violation(`--${name}`, "flag-value", "")]);
        }
        flags[name] = value;
        continue;
      }
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true;
        continue;
      }
      fail("USAGE", `unknown flag: --${name}`, [violation(`--${name}`, "unknown-flag", "")]);
    }
    positional.push(token);
  }
  return { positional, flags };
}

function requireFlag(flags, name) {
  if (flags[name] === undefined) {
    fail("USAGE", `--${name} is required`, [violation(`--${name}`, "required-flag", "")]);
  }
  return flags[name];
}

function envelope(code, message, extra = {}) {
  return {
    ok: code === "OK",
    code,
    message,
    wave: null,
    cell: null,
    actor: null,
    epoch: null,
    state: null,
    expires_at: null,
    receipt: null,
    violations: [],
    warnings: [],
    degraded: null,
    ...extra,
  };
}

function twoArgs(positional, command) {
  if (positional.length !== 2) {
    fail("USAGE", `${command} requires <wave> <cell>`, [violation(command, "arity", "")]);
  }
  return { wave: positional[0], cell: positional[1] };
}

function ttlOf(flags) {
  return flags.ttl === undefined ? undefined : Number(flags.ttl);
}
function epochOf(flags) {
  return Number(requireFlag(flags, "epoch"));
}

async function maybeDegraded(ctx) {
  try {
    return (await maybeAnchor(ctx)).degraded ?? null;
  } catch {
    return "ANCHOR-DEGRADED";
  }
}

async function commandInit(flags) {
  if (flags["bootstrap-registry"]) {
    // Runs BEFORE any context load: creates an absent registry file and
    // prints its sha256 for the operator to reference in asylumwarden.json.
    const { bootstrapRegistry } = await import("../config/bootstrap.mjs");
    const created = await bootstrapRegistry({
      registryPath: requireFlag(flags, "registry"),
      self: flags.self,
      root: flags.root,
      force: Boolean(flags.force),
    });
    return envelope("OK", "registry bootstrapped; set registry_sha256 in asylumwarden.json", {
      registry: created,
    });
  }
  const ctx = await makeContext({
    configPath: flags.config,
    stateHome: flags["state-home"],
  });
  await ensureDir(ctx.sl.stateHome);
  await ensureDir(ctx.sl.locks);
  const created = await ctx.ledger.appendGenesisIfAbsent(ctx);
  await initAnchor(ctx);
  const chain = await ctx.ledger.verify();
  return envelope("OK", "state home initialized", {
    state: created ? "genesis_created" : "already_initialized",
    warnings: [],
    state_home: ctx.sl.stateHome,
    ledger_head: chain.head,
  });
}

async function commandPlan(flags, positional) {
  const ctx = await makeContext({ configPath: flags.config, stateHome: flags["state-home"] });
  if (positional.length !== 1) {
    fail("USAGE", "plan requires <wave.json>", [violation("plan", "arity", "")]);
  }
  const result = await planWave(ctx, {
    manifestPath: path.resolve(positional[0]),
    force: Boolean(flags.force),
  });
  return envelope("OK", `planned wave ${result.wave}`, {
    wave: result.wave,
    cells: result.cells,
    warnings: result.warnings ?? [],
    degraded: await maybeDegraded(ctx),
  });
}

async function commandReady(flags, positional) {
  const ctx = await makeContext({ configPath: flags.config, stateHome: flags["state-home"] });
  if (positional.length !== 1) fail("USAGE", "ready requires <wave>", [violation("ready", "arity", "")]);
  const ready = await readyCells(ctx, positional[0]);
  return envelope("OK", `${ready.filter((c) => c.ready).length} ready`, {
    wave: positional[0],
    ready,
  });
}

async function commandClaim(flags, positional) {
  const ctx = await makeContext({ configPath: flags.config, stateHome: flags["state-home"] });
  const { wave, cell } = twoArgs(positional, "claim");
  const owner = await claim(ctx, {
    wave,
    cell,
    actor: requireFlag(flags, "actor"),
    ttlSeconds: ttlOf(flags),
    steal: Boolean(flags.steal),
  });
  return envelope("OK", `claimed ${cell}`, {
    wave,
    cell,
    actor: owner.actor,
    epoch: owner.epoch,
    state: "claimed",
    expires_at: owner.expires_at,
    degraded: await maybeDegraded(ctx),
  });
}

async function commandRenew(flags, positional) {
  const ctx = await makeContext({ configPath: flags.config, stateHome: flags["state-home"] });
  const { wave, cell } = twoArgs(positional, "renew");
  const owner = await renew(ctx, {
    wave,
    cell,
    actor: requireFlag(flags, "actor"),
    epoch: epochOf(flags),
    ttlSeconds: ttlOf(flags),
  });
  return envelope("OK", `renewed ${cell}`, {
    wave, cell, actor: owner.actor, epoch: owner.epoch, expires_at: owner.expires_at,
    degraded: await maybeDegraded(ctx),
  });
}

async function commandRelease(flags, positional) {
  const ctx = await makeContext({ configPath: flags.config, stateHome: flags["state-home"] });
  const { wave, cell } = twoArgs(positional, "release");
  await release(ctx, { wave, cell, actor: requireFlag(flags, "actor"), epoch: epochOf(flags) });
  return envelope("OK", `released ${cell}`, {
    wave, cell, state: "pending", degraded: await maybeDegraded(ctx),
  });
}

async function commandRequeue(flags, positional) {
  const ctx = await makeContext({ configPath: flags.config, stateHome: flags["state-home"] });
  const { wave, cell } = twoArgs(positional, "requeue");
  await requeue(ctx, { wave, cell });
  return envelope("OK", `requeued ${cell}`, { wave, cell, state: "pending" });
}

async function commandDone(flags, positional) {
  const ctx = await makeContext({ configPath: flags.config, stateHome: flags["state-home"] });
  const { wave, cell } = twoArgs(positional, "done");
  const result = await doneWithReceipt(ctx, {
    wave,
    cell,
    actor: requireFlag(flags, "actor"),
    epoch: epochOf(flags),
    receiptPath: path.resolve(requireFlag(flags, "receipt")),
  });
  return envelope("OK", `done ${cell}`, {
    wave,
    cell,
    state: "done",
    receipt: { file: result.file, sha256: result.sha256 },
    degraded: await maybeDegraded(ctx),
  });
}

async function commandFail(flags, positional) {
  const ctx = await makeContext({ configPath: flags.config, stateHome: flags["state-home"] });
  const { wave, cell } = twoArgs(positional, "fail");
  const result = await failCell(ctx, {
    wave,
    cell,
    actor: requireFlag(flags, "actor"),
    epoch: epochOf(flags),
    reason: requireFlag(flags, "reason"),
  });
  return envelope("OK", `failed ${cell}`, {
    wave, cell, state: "failed",
    receipt: { file: result.file, sha256: result.sha256 },
    degraded: await maybeDegraded(ctx),
  });
}

async function commandStatus(flags, positional) {
  const ctx = await makeContext({ configPath: flags.config, stateHome: flags["state-home"] });
  const report = await statusReport(ctx, positional[0]);
  return envelope("OK", "status", { waves: report.waves });
}

async function commandVerify(flags, positional) {
  const ctx = await makeContext({ configPath: flags.config, stateHome: flags["state-home"] });
  const result = await verifyAll(ctx, { wave: flags.wave ?? positional[0] });
  return envelope("OK", "ledger verified", { ...result });
}

async function commandRegistry(flags, positional) {
  const ctx = await makeContext({ configPath: flags.config, stateHome: flags["state-home"] });
  if (positional[0] !== "check") {
    fail("USAGE", "registry requires the check subcommand", [violation("registry", "subcommand", "")]);
  }
  return envelope("OK", "registry ok", {
    registry: {
      path: ctx.registryPath,
      sha256: ctx.registrySha256,
      lines: Object.fromEntries(
        Object.entries(ctx.registry.lines).map(([name, line]) => [name, {
          roots: line.roots,
          forbidden_surfaces: line.forbidden_surfaces,
          forbidden_absolute: line.forbidden_absolute ?? [],
          read_roots: line.read_roots ?? [],
        }]),
      ),
    },
  });
}

async function commandVersion() {
  const pkgPath = path.resolve(import.meta.dirname, "../../package.json");
  const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  return envelope("OK", "asylumwarden", { name: pkg.name, version: pkg.version, contract: 1 });
}

const COMMANDS = {
  init: (flags, positional) => commandInit(flags, positional),
  plan: commandPlan,
  ready: commandReady,
  claim: commandClaim,
  renew: commandRenew,
  release: commandRelease,
  requeue: commandRequeue,
  done: commandDone,
  fail: commandFail,
  status: commandStatus,
  verify: commandVerify,
  registry: commandRegistry,
};

export async function runCli(argv, { write = (s) => process.stdout.write(s) } = {}) {
  try {
    if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
      write(`${JSON.stringify(envelope("OK", `usage: asylumwarden <${Object.keys(COMMANDS).join("|")}> [options]`), null, 2)}\n`);
      return 0;
    }
    // Global flags may appear before or after the command: parse everything,
    // then the first positional is the command.
    const { positional, flags } = parseArgs(argv);
    if (flags.version) {
      write(`${JSON.stringify(await commandVersion(), null, 2)}\n`);
      return 0;
    }
    const command = positional.shift();
    const handler = COMMANDS[command];
    if (!handler) {
      throw new WardenError("UNKNOWN-COMMAND", `unknown command: ${command}`, [
        violation("command", "unknown", command),
      ]);
    }
    const result = await handler(flags, positional);
    write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    let out;
    if (error instanceof WardenError) {
      out = envelope(error.code, error.message, { violations: error.violations ?? [] });
    } else if (error && error.code === "ENOENT") {
      out = envelope("STATE-CORRUPT", `unexpected missing file: ${error.message}`);
    } else {
      out = envelope("INTERNAL", `unexpected error: ${error?.message ?? String(error)}`);
    }
    write(`${JSON.stringify(out, null, 2)}\n`);
    return error instanceof WardenError ? error.exitClass : 2;
  }
}
