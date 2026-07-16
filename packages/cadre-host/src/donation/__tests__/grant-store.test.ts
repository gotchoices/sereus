import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GrantStore } from '../grant-store.js';
import { GrantError } from '../types.js';
import type { Grant } from '../types.js';

let tmpRoot: string;

function grant(over: Partial<Grant> = {}): Grant {
  return {
    token: 'tok-A',
    label: "Alice's cadre",
    maxNodes: 2,
    createdAt: '2025-01-01T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-grant-store-'));
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('GrantStore', () => {
  it('returns empty state when file is missing', () => {
    const store = new GrantStore(tmpRoot);
    expect(store.list()).toEqual([]);
    expect(store.get('anything')).toBeUndefined();
  });

  it('round-trips grants through save/load', () => {
    const store = new GrantStore(tmpRoot);
    store.add(grant({ token: 'tok-A', label: 'Alice' }));
    store.add(grant({ token: 'tok-B', label: 'Bob', maxNodes: 1, expiresAt: '2025-06-01T00:00:00.000Z' }));

    const reread = new GrantStore(tmpRoot);
    expect(reread.list()).toHaveLength(2);
    expect(reread.get('tok-A')).toMatchObject({ token: 'tok-A', label: 'Alice', maxNodes: 2 });
    expect(reread.get('tok-B')?.expiresAt).toBe('2025-06-01T00:00:00.000Z');
    expect(reread.get('tok-A')?.expiresAt).toBeUndefined();
  });

  it('removes grants', () => {
    const store = new GrantStore(tmpRoot);
    store.add(grant({ token: 'tok-A' }));
    expect(store.remove('tok-A')).toBe(true);
    expect(store.remove('tok-A')).toBe(false);

    const reread = new GrantStore(tmpRoot);
    expect(reread.list()).toEqual([]);
  });

  it('marks a grant revoked, idempotently', () => {
    const store = new GrantStore(tmpRoot);
    store.add(grant({ token: 'tok-A' }));

    expect(store.markRevoked('tok-A', '2025-02-01T00:00:00.000Z')).toBe(true);
    expect(store.get('tok-A')?.revokedAt).toBe('2025-02-01T00:00:00.000Z');

    // Second revoke keeps the original timestamp.
    expect(store.markRevoked('tok-A', '2025-03-01T00:00:00.000Z')).toBe(true);
    expect(store.get('tok-A')?.revokedAt).toBe('2025-02-01T00:00:00.000Z');

    // Unknown token.
    expect(store.markRevoked('nope', '2025-02-01T00:00:00.000Z')).toBe(false);
  });

  it('writes through a temp file (atomic rename, no residue)', () => {
    const store = new GrantStore(tmpRoot);
    store.add(grant());
    expect(existsSync(join(tmpRoot, 'grants.json'))).toBe(true);
    expect(existsSync(join(tmpRoot, 'grants.json.tmp'))).toBe(false);
  });

  it('persists the version field in saved JSON', () => {
    const store = new GrantStore(tmpRoot);
    store.add(grant({ token: 'tok-A', label: 'one' }));
    const raw = JSON.parse(readFileSync(join(tmpRoot, 'grants.json'), 'utf8'));
    expect(raw.version).toBe(1);
    expect(raw.grants['tok-A'].label).toBe('one');
    // token is the map key, not duplicated inside the row.
    expect(raw.grants['tok-A'].token).toBeUndefined();
  });

  it('throws on malformed JSON rather than silently wiping (would revoke everyone)', () => {
    writeFileSync(join(tmpRoot, 'grants.json'), 'not json', 'utf8');
    const store = new GrantStore(tmpRoot);
    expect(() => store.load()).toThrow(GrantError);
  });

  it('throws on a file with the wrong shape', () => {
    writeFileSync(join(tmpRoot, 'grants.json'), JSON.stringify({ version: 99, foo: 'bar' }), 'utf8');
    const store = new GrantStore(tmpRoot);
    expect(() => store.load()).toThrow(GrantError);
  });
});
