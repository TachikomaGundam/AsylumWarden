// schemalite — the zero-dependency JSON Schema subset used by core.
// SUPPORTED keywords ONLY; a schema using anything else fails the build with
// INTERNAL (drift guard). Semantics follow draft 2020-12 for the subset.

import { fail, violation } from "./errors.mjs";
import { canon } from "./canon.mjs";

const SUPPORTED = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "type",
  "const",
  "enum",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "pattern",
  "format",
  "minimum",
  "maxItems",
  "minItems",
  "maxProperties",
  "minProperties",
  "maxLength",
  "minLength",
  "allOf",
  "anyOf",
]);

const DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value; // string | number | boolean | object
}

function typeMatches(value, type) {
  const actual = typeOf(value);
  if (type === actual) return true;
  if (type === "number" && actual === "integer") return true;
  return false;
}

function push(violations, pathLabel, rule, detail) {
  violations.push(violation(pathLabel, rule, detail));
}

export function validateSchema(schema, value, pathLabel = "$") {
  const violations = [];
  check(schema, value, pathLabel, violations);
  return violations;
}

function check(schema, value, pathLabel, violations) {
  for (const keyword of Object.getOwnPropertyNames(schema)) {
    if (!SUPPORTED.has(keyword)) {
      fail("INTERNAL", `schemalite: unsupported keyword "${keyword}" in schema`);
    }
  }
  const { type, const: konst, enum: enumList, required, properties, additionalProperties,
    items, pattern, format, minimum, minItems, maxItems, minProperties, maxProperties,
    maxLength, minLength, allOf, anyOf } = schema;

  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    if (!types.some((t) => typeMatches(value, t))) {
      push(violations, pathLabel, "type", `expected ${types.join("|")}, got ${typeOf(value)}`);
      return; // further keyword checks would cascade
    }
  }
  if (konst !== undefined && canon(value) !== canon(konst)) {
    push(violations, pathLabel, "const", `expected ${JSON.stringify(konst)}`);
  }
  if (enumList !== undefined && !enumList.some((alt) => canon(value) === canon(alt))) {
    push(violations, pathLabel, "enum", `got ${JSON.stringify(value)}`);
  }
  if (typeof value === "string") {
    if (minLength !== undefined && value.length < minLength) {
      push(violations, pathLabel, "minLength", String(value.length));
    }
    if (maxLength !== undefined && value.length > maxLength) {
      push(violations, pathLabel, "maxLength", String(value.length));
    }
    if (pattern !== undefined && !new RegExp(pattern).test(value)) {
      push(violations, pathLabel, "pattern", `got ${JSON.stringify(value)}`);
    }
    if (format === "date-time" && !DATE_TIME_RE.test(value)) {
      push(violations, pathLabel, "format", `not RFC3339 date-time: ${value}`);
    }
  }
  if (typeof value === "number" && minimum !== undefined && value < minimum) {
    push(violations, pathLabel, "minimum", `got ${value}, min ${minimum}`);
  }
  if (Array.isArray(value)) {
    if (minItems !== undefined && value.length < minItems) {
      push(violations, pathLabel, "minItems", String(value.length));
    }
    if (maxItems !== undefined && value.length > maxItems) {
      push(violations, pathLabel, "maxItems", String(value.length));
    }
    if (items !== undefined) {
      for (let i = 0; i < value.length; i += 1) {
        check(items, value[i], `${pathLabel}[${i}]`, violations);
      }
    }
  }
  if (typeOf(value) === "object") {
    const own = Object.getOwnPropertyNames(value);
    if (minProperties !== undefined && own.length < minProperties) {
      push(violations, pathLabel, "minProperties", String(own.length));
    }
    if (maxProperties !== undefined && own.length > maxProperties) {
      push(violations, pathLabel, "maxProperties", String(own.length));
    }
    if (Array.isArray(required)) {
      for (const key of required) {
        if (!Object.hasOwn(value, key)) {
          push(violations, pathLabel, "required", `missing ${key}`);
        }
      }
    }
    for (const key of own) {
      const childLabel = `${pathLabel}.${key}`;
      if (properties !== undefined && Object.hasOwn(properties, key)) {
        check(properties[key], value[key], childLabel, violations);
      } else if (additionalProperties === false) {
        push(violations, pathLabel, "additionalProperties", `unknown key ${key}`);
      } else if (additionalProperties !== undefined && typeof additionalProperties === "object") {
        check(additionalProperties, value[key], childLabel, violations);
      }
    }
  }
  if (Array.isArray(allOf)) {
    for (const sub of allOf) check(sub, value, pathLabel, violations);
  }
  if (Array.isArray(anyOf)) {
    const branches = anyOf.map((sub) => {
      const local = [];
      check(sub, value, pathLabel, local);
      return local;
    });
    if (branches.every((local) => local.length > 0)) {
      push(violations, pathLabel, "anyOf", "no variant matched");
      for (const local of branches) violations.push(...local.map((v) => ({ ...v, rule: `anyOf:${v.rule}` })));
    }
  }
}
