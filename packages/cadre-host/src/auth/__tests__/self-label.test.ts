import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SELF_LABEL, ensureSelfLabel } from '../self-label.js';
import { TrustCircleStore } from '../trust-circle-store.js';

let tmpRoot: string;
let store: TrustCircleStore;

const NOW = new Date('2025-06-01T12:00:00.000Z');
const now = (): Date => NOW;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-self-label-'));
  store = new TrustCircleStore(tmpRoot);
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('ensureSelfLabel', () => {
  it('writes a self-flagged label for the owner peer ID', async () => {
    const peerId = await ensureSelfLabel({ store, getPeerId: async () => '12D3KooWOwner', now });

    expect(peerId).toBe('12D3KooWOwner');
    expect(store.getMember('12D3KooWOwner')).toEqual({
      peerId: '12D3KooWOwner',
      label: SELF_LABEL,
      addedAt: NOW.toISOString(),
      self: true,
    });
  });

  it('keeps an admin-renamed label on a second run', async () => {
    store.addMember({ peerId: '12D3KooWOwner', label: 'Basement PC', addedAt: 't0', self: true });

    await ensureSelfLabel({ store, getPeerId: async () => '12D3KooWOwner', now });

    expect(store.getMember('12D3KooWOwner')).toMatchObject({ label: 'Basement PC', addedAt: 't0', self: true });
  });

  it('stamps the self flag onto a pre-existing unflagged row', async () => {
    store.addMember({ peerId: '12D3KooWOwner', label: 'Basement PC', addedAt: 't0' });

    await ensureSelfLabel({ store, getPeerId: async () => '12D3KooWOwner', now });

    expect(store.getMember('12D3KooWOwner')).toEqual({
      peerId: '12D3KooWOwner',
      label: 'Basement PC',
      addedAt: 't0',
      self: true,
    });
  });

  it('drops a stale self label after the node identity changes', async () => {
    store.addMember({ peerId: '12D3KooWOld', label: SELF_LABEL, addedAt: 't0', self: true });
    store.addMember({ peerId: '12D3KooWPhone', label: "Mom's phone", addedAt: 't1' });

    await ensureSelfLabel({ store, getPeerId: async () => '12D3KooWNew', now });

    expect(store.getMember('12D3KooWOld')).toBeUndefined();
    expect(store.getMember('12D3KooWNew')).toMatchObject({ label: SELF_LABEL, self: true });
    // Non-self labels are untouched.
    expect(store.getMember('12D3KooWPhone')).toMatchObject({ label: "Mom's phone" });
  });

  it('writes nothing when the node is not ready yet (empty peer ID)', async () => {
    const peerId = await ensureSelfLabel({ store, getPeerId: async () => '', now });

    expect(peerId).toBeUndefined();
    expect(store.listMembers()).toEqual([]);
  });

  it('propagates a getPeerId failure to the caller', async () => {
    await expect(ensureSelfLabel({
      store,
      getPeerId: async () => { throw new Error('owner node unavailable'); },
      now,
    })).rejects.toThrow('owner node unavailable');
    expect(store.listMembers()).toEqual([]);
  });
});
