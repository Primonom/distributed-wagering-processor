/**
 * @file canonical-json.ts
 * @author Pablo Reis Rebonato
 * @description Deterministic JSON serialisation and SHA-256 hashing used for payload fingerprints.
 */

import { createHash } from 'node:crypto';

/**
 * Canonical JSON: objects have their keys sorted (by UTF-16 code unit order,
 * recursively), arrays keep their order, `undefined` properties are omitted, no
 * whitespace. Only JSON-safe primitives are accepted (strings, booleans, null, and
 * integers) — monetary values are always strings, so float formatting never matters.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new TypeError('canonicalJson only accepts safe integers as numbers');
      }
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson cannot serialise ${typeof value}`);
  }
}

/** Lowercase hex SHA-256 of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
