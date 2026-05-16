import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TrustCircleStore } from '../trust-circle-store.js';
import { TrustCircleError } from '../types.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-tc-store-'));
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('TrustCircleStore', () => {
  it('returns empty state when file is missing', () => {
    const store = new TrustCircleStore(tmpRoot);
    expect(store.listMembers()).toEqual([]);
    expect(store.listPending()).toEqual([]);
  });

  it('round-trips members through save/load', () => {
    const store = new TrustCircleStore(tmpRoot);
    store.addMember({
      peerId: '12D3KooWAlice',
      label: "Alice's phone",
      addedAt: '2025-01-01T00:00:00.000Z',
    });
    store.addMember({
      peerId: '12D3KooWBob',
      label: 'Bob laptop',
      addedAt: '2025-01-02T00:00:00.000Z',
      self: true,
    });

    // Fresh instance reads from disk.
    const reread = new TrustCircleStore(tmpRoot);
    const members = reread.listMembers();
    expect(members).toHaveLength(2);
    expect(reread.getMember('12D3KooWAlice')).toMatchObject({ label: "Alice's phone" });
    expect(reread.getMember('12D3KooWBob')?.self).toBe(true);
  });

  it('round-trips pending invites', () => {
    const store = new TrustCircleStore(tmpRoot);
    store.addPending({
      token: 'token-A',
      label: 'Mom',
      createdAt: '2025-01-01T00:00:00.000Z',
      expiresAt: '2025-01-02T00:00:00.000Z',
    });
    store.addPending({
      token: 'token-B',
      label: 'Dad',
      createdAt: '2025-01-02T00:00:00.000Z',
    });

    const reread = new TrustCircleStore(tmpRoot);
    expect(reread.listPending()).toHaveLength(2);
    expect(reread.getPending('token-A')?.label).toBe('Mom');
    expect(reread.getPending('token-B')?.expiresAt).toBeUndefined();
  });

  it('removes members and pending invites', () => {
    const store = new TrustCircleStore(tmpRoot);
    store.addMember({ peerId: 'p1', label: 'one', addedAt: 't' });
    store.addPending({ token: 'tok', label: 'two', createdAt: 't' });

    expect(store.removeMember('p1')).toBe(true);
    expect(store.removeMember('p1')).toBe(false);
    expect(store.removePending('tok')).toBe(true);
    expect(store.removePending('tok')).toBe(false);

    const reread = new TrustCircleStore(tmpRoot);
    expect(reread.listMembers()).toEqual([]);
    expect(reread.listPending()).toEqual([]);
  });

  it('writes through a temp file (atomic rename)', () => {
    const store = new TrustCircleStore(tmpRoot);
    store.addMember({ peerId: 'p1', label: 'one', addedAt: 't' });

    // After save, no .tmp residue should remain.
    expect(existsSync(join(tmpRoot, 'trust-circle.json'))).toBe(true);
    expect(existsSync(join(tmpRoot, 'trust-circle.json.tmp'))).toBe(false);
  });

  it('throws on malformed file rather than silently wiping', () => {
    writeFileSync(join(tmpRoot, 'trust-circle.json'), 'not json', 'utf8');
    const store = new TrustCircleStore(tmpRoot);
    expect(() => store.load()).toThrow(TrustCircleError);
  });

  it('throws on file with wrong shape', () => {
    writeFileSync(
      join(tmpRoot, 'trust-circle.json'),
      JSON.stringify({ version: 99, foo: 'bar' }),
      'utf8',
    );
    const store = new TrustCircleStore(tmpRoot);
    expect(() => store.load()).toThrow(TrustCircleError);
  });

  it('persists version field in saved JSON', () => {
    const store = new TrustCircleStore(tmpRoot);
    store.addMember({ peerId: 'p1', label: 'one', addedAt: 't' });
    const raw = JSON.parse(readFileSync(join(tmpRoot, 'trust-circle.json'), 'utf8'));
    expect(raw.version).toBe(1);
    expect(raw.members.p1.label).toBe('one');
  });
});
