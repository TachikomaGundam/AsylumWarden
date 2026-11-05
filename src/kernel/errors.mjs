// Error taxonomy — single source: docs/CONTRACT.md §8.3.
export const EXIT_OK = 0;
export const EXIT_BUSINESS = 1;
export const EXIT_FAIL_CLOSED = 2;

const BUSINESS_CODES = new Set([
  "USAGE",
  "UNKNOWN-COMMAND",
  "LEASE-HELD",
  "LEASE-EXPIRED",
  "LEASE-MAX-HOLD",
  "STEAL-DENIED",
  "EPOCH-MISMATCH",
  "ACTOR-MISMATCH",
  "CELL-STATE",
  "RESTART-REQUIRED",
  "RECEIPT-COMMANDS",
  "RECEIPT-HASH",
  "READ-OUTSIDE",
  "WAVE-EXISTS",
  "WAVE-MISSING",
  "CELL-MISSING",
]);

const FAIL_CLOSED_CODES = new Set([
  "CONFIG-MISSING",
  "CONFIG-INVALID",
  "CONFIG-DRIFT",
  "REGISTRY-MISSING",
  "REGISTRY-INVALID",
  "ROOTS-OVERLAP",
  "ROOT-MISSING",
  "FORBIDDEN-ROOT",
  "GLOB-INVALID",
  "UNKNOWN-KIND",
  "MANIFEST-INVALID",
  "DEP-UNKNOWN",
  "DEP-CYCLE",
  "DEP-DUPLICATE",
  "PATH-ESCAPE",
  "FORBIDDEN-SURFACE",
  "SCHEMA-VIOLATION",
  "STATE-CORRUPT",
  "LEDGER-BROKEN",
  "LEDGER-TORN",
  "LEDGER-BUSY",
  "ANCHOR-FAIL",
  "ANCHOR-STALE",
  "INTERNAL",
]);

export function exitClassFor(code) {
  if (BUSINESS_CODES.has(code)) return EXIT_BUSINESS;
  // Unknown codes can never widen the success path; fail closed.
  if (FAIL_CLOSED_CODES.has(code)) return EXIT_FAIL_CLOSED;
  return EXIT_FAIL_CLOSED;
}

export function isKnownCode(code) {
  return BUSINESS_CODES.has(code) || FAIL_CLOSED_CODES.has(code);
}

export class WardenError extends Error {
  constructor(code, message, violations = []) {
    super(message);
    this.name = "WardenError";
    this.code = code;
    this.violations = violations;
    this.exitClass = exitClassFor(code);
  }
}

export function violation(field, rule, detail) {
  return { field, rule, detail };
}

export function fail(code, message, violations = []) {
  throw new WardenError(code, message, violations);
}
