// Generic exclusive lock for short critical sections (per-cell lease
// mutation). Same posture as the ledger lock (CONTRACT §5.3): O_EXCL create,
// forensic body, stale recovery for dead holders, fail-closed busy.
// Not for long holds — callers run milliseconds of file work inside.

import fs from "node:fs/promises";
import os from "node:os";

import { fail, violation } from "./errors.mjs";
import { ensureDir, nowIso, pidAlive } from "./fsutil.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withExclusiveLock(
  lockPath,
  {
    staleAfterMs = 30_000,
    busyAfterMs = 60_000,
    deadlineMs = 5_000,
    pollMs = 10,
    busyCode = "LEDGER-BUSY",
    busyMessage = "critical section busy",
  } = {},
  fn,
) {
  await ensureDir(lockPath.slice(0, lockPath.lastIndexOf("/")) || "/");
  const deadline = Date.now() + deadlineMs;
  let acquired = false;
  while (!acquired) {
    let handle;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), ts: nowIso() }));
      acquired = true;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        fail("INTERNAL", `lock create failed: ${lockPath}: ${error.message}`);
      }
      const status = await inspect(lockPath);
      if (status === "stale") {
        await fs.rm(lockPath, { force: true });
        continue; // one retry loop through create
      }
      if (status === "busy") {
        fail(busyCode, `${busyMessage}: ${lockPath}`, [violation(lockPath, "lock-busy", "holder alive")]);
      }
      if (Date.now() > deadline) {
        fail(busyCode, `${busyMessage}: ${lockPath} (wait deadline exceeded)`, [
          violation(lockPath, "lock-timeout", String(deadlineMs)),
        ]);
      }
      await sleep(pollMs);
    } finally {
      await handle?.close();
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lockPath, { force: true });
  }
}

// gone|stale|busy|contended
async function inspect(lockPath) {
  let text;
  let mtimeMs;
  try {
    ;[text, mtimeMs] = await Promise.all([
      fs.readFile(lockPath, "utf8"),
      fs.stat(lockPath).then((s) => s.mtimeMs),
    ]);
  } catch (error) {
    if (error?.code === "ENOENT") return "contended"; // released mid-inspect, retry
    return "busy";
  }
  const trimmed = text.trim();
  if (trimmed === "") {
    // create-vs-write window: stale only far beyond the busy window
    return Date.now() - mtimeMs > 60_000 ? "stale" : "contended";
  }
  let body;
  try {
    body = JSON.parse(trimmed);
  } catch {
    return Date.now() - mtimeMs > 60_000 ? "stale" : "busy";
  }
  if (
    !body ||
    typeof body !== "object" ||
    !Number.isInteger(body.pid) ||
    typeof body.ts !== "string"
  ) {
    return Date.now() - mtimeMs > 60_000 ? "stale" : "busy";
  }
  if (pidAlive(body.pid, body.host)) {
    // A live holder older than the busy window is wedged: fail closed.
    return Date.now() - Date.parse(body.ts) > 60_000 ? "busy" : "contended";
  }
  // Dead holder: stale beyond the stale window; recent death still drains.
  return Date.now() - Date.parse(body.ts) > 30_000 ? "stale" : "contended";
}
