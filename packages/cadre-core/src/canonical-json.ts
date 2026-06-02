/**
 * Canonical JSON serialization for signed payloads.
 *
 * Recursively sorts object keys, drops `undefined` values, emits no whitespace
 * and no trailing newline. Arrays preserve their order. This is a tiny RFC 8785
 * subset, sufficient for the fixed-shape payloads we sign (update manifests in
 * cadre-host, control-network seeds here).
 *
 * Lives in cadre-core because cadre-host depends on cadre-core (not the
 * reverse); cadre-host re-imports this rather than keeping its own copy.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('cannot serialize non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
  }
  throw new Error(`cannot serialize value of type ${typeof value}`);
}
