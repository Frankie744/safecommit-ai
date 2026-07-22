import { createHash } from "node:crypto";

import type { JsonValue } from "./types";

function normalizeJson(value: unknown, seen: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Evidence contains a non-finite number");
    }
    return value;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new TypeError("Evidence contains a circular reference");
    }
    seen.add(value);
    const normalized = value.map((item) => {
      if (item === undefined) {
        throw new TypeError("Evidence arrays cannot contain undefined");
      }
      return normalizeJson(item, seen);
    });
    seen.delete(value);
    return normalized;
  }

  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Evidence objects must be plain JSON objects");
    }
    if (seen.has(value)) {
      throw new TypeError("Evidence contains a circular reference");
    }
    seen.add(value);
    const normalized: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) {
        normalized[key] = normalizeJson(item, seen);
      }
    }
    seen.delete(value);
    return normalized;
  }

  throw new TypeError(`Evidence contains a non-JSON value: ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value, new Set<object>()));
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function computeEvidenceDigest(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function computeCommandHash(
  argv: readonly string[],
  workingDirectory: string,
): string {
  return computeEvidenceDigest({ argv, workingDirectory });
}
