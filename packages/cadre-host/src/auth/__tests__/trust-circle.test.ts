import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CadreInvite } from '@serfab/cadre-core';

import { TrustCircleService, createTrustCircleHandlers } from '../trust-circle.js';
import { TrustCircleStore } from '../trust-circle-store.js';
import { TrustCircleError } from '../types.js';
import type { CadreNodeLike } from '../trust-circle.js';

/**
 * Minimal in-memory mock of CadreNode + ControlDatabase. Records calls so
 * assertions can verify the auth + redemption flow without standing up a
 * real libp2p control network.
 */
class MockCadreNode implements CadreNodeLike {
  readonly authorizedPeers = new Set<string>();
  readonly issuedInvites: Array<{ token?: string; expiresIn?: number }> = [];
  readonly accepted: Array<{ phonePeerId: string; token?: string }> = [];
  readonly removed: string[] = [];

  /** Toggle to make acceptPhone reject. */
  acceptShouldThrow: Error | null = null;
  /** Toggle to make getControlDatabase return null (simulate offline). */
  dbAvailable = true;

  async createInvite(token?: string, expiresIn?: number) {
    this.issuedInvites.push({ token, expiresIn });
    const invite: CadreInvite = {
      partyId: 'party-test',
      authorityAddrs: ['/ip4/127.0.0.1/tcp/4001'],
      token,
      createdAt: Date.now(),
      ...(expiresIn ? { expiresAt: Date.now() + expiresIn } : {}),
    };
    return { invite, encodedInvite: 'enc:' + JSON.stringify(invite) };
  }

  async acceptPhone(options: { phonePeerId: string; token?: string }, _issuedInvite?: CadreInvite) {
    if (this.acceptShouldThrow) throw this.acceptShouldThrow;
    this.accepted.push({ ...options });
    this.authorizedPeers.add(options.phonePeerId);
  }

  async removePeer(peerId: string) {
    this.removed.push(peerId);
    this.authorizedPeers.delete(peerId);
  }

  encodeInvite(invite: CadreInvite): string {
    return 'enc:' + JSON.stringify(invite);
  }

  getControlDatabase() {
    if (!this.dbAvailable) return null;
    const peers = this.authorizedPeers;
    return {
      getDatabase: () => ({
        async *eval(_sql: string, params?: unknown[]) {
          if (params && params.length > 0) {
            const target = params[0] as string;
            if (peers.has(target)) yield { PeerId: target };
            return;
          }
          for (const p of peers) yield { PeerId: p };
        },
      }),
    } as unknown as ReturnType<CadreNodeLike['getControlDatabase']>;
  }
}

let tmpRoot: string;
let cadreNode: MockCadreNode;
let store: TrustCircleStore;
let service: TrustCircleService;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-tc-svc-'));
  cadreNode = new MockCadreNode();
  store = new TrustCircleStore(tmpRoot);
  service = new TrustCircleService({ cadreNode, store });
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('TrustCircleService.issueInvite', () => {
  it('creates a pending row, returns an encoded invite, and uses default TTL', async () => {
    const result = await service.issueInvite({ label: "Mom's phone" });

    expect(result.token).toBeTruthy();
    expect(result.encodedInvite.startsWith('enc:')).toBe(true);
    expect(result.expiresAt).toBeInstanceOf(Date);

    const pending = store.getPending(result.token);
    expect(pending).toBeDefined();
    expect(pending!.label).toBe("Mom's phone");
    expect(pending!.expiresAt).toBe(result.expiresAt!.toISOString());

    expect(cadreNode.issuedInvites).toHaveLength(1);
    expect(cadreNode.issuedInvites[0]!.token).toBe(result.token);
  });

  it('rejects empty / whitespace labels', async () => {
    await expect(service.issueInvite({ label: '   ' })).rejects.toBeInstanceOf(TrustCircleError);
    await expect(service.issueInvite({ label: '' })).rejects.toBeInstanceOf(TrustCircleError);
  });

  it('honours custom ttl', async () => {
    const start = Date.now();
    const ttlMs = 5 * 60 * 1000;
    const result = await service.issueInvite({ label: 'Carol', ttlMs });
    const expiresMs = result.expiresAt!.getTime();
    expect(expiresMs - start).toBeGreaterThanOrEqual(ttlMs - 50);
    expect(expiresMs - start).toBeLessThanOrEqual(ttlMs + 500);
  });

  it('rejects non-positive ttl', async () => {
    await expect(service.issueInvite({ label: 'X', ttlMs: 0 })).rejects.toBeInstanceOf(TrustCircleError);
    await expect(service.issueInvite({ label: 'X', ttlMs: -1 })).rejects.toBeInstanceOf(TrustCircleError);
  });
});

describe('TrustCircleService.redeemInvite', () => {
  it('happy path: authorises peer, consumes pending, writes member', async () => {
    const { token } = await service.issueInvite({ label: "Mom's phone" });

    const result = await service.redeemInvite({ token, peerId: '12D3KooWMom' });
    expect(result).toEqual({ peerId: '12D3KooWMom', label: "Mom's phone" });

    expect(cadreNode.accepted).toHaveLength(1);
    expect(cadreNode.accepted[0]).toMatchObject({ phonePeerId: '12D3KooWMom', token });
    expect(cadreNode.authorizedPeers.has('12D3KooWMom')).toBe(true);

    expect(store.getPending(token)).toBeUndefined();
    expect(store.getMember('12D3KooWMom')?.label).toBe("Mom's phone");
  });

  it('rejects unknown token', async () => {
    await expect(service.redeemInvite({ token: 'nope', peerId: 'p1' }))
      .rejects.toMatchObject({ code: 'already_redeemed' });
    expect(cadreNode.accepted).toHaveLength(0);
  });

  it('rejects expired invite and reaps the pending row', async () => {
    let clock = new Date('2025-01-01T00:00:00Z');
    const svc = new TrustCircleService({ cadreNode, store, now: () => clock });
    const { token } = await svc.issueInvite({ label: 'Dad', ttlMs: 60_000 });

    // Move clock past expiry.
    clock = new Date('2025-01-02T00:00:00Z');

    await expect(svc.redeemInvite({ token, peerId: 'p1' }))
      .rejects.toMatchObject({ code: 'expired' });
    expect(store.getPending(token)).toBeUndefined();
    expect(cadreNode.accepted).toHaveLength(0);
  });

  it('double-redeem: second attempt is rejected because pending was consumed', async () => {
    const { token } = await service.issueInvite({ label: 'Carol' });

    await service.redeemInvite({ token, peerId: 'pA' });
    await expect(service.redeemInvite({ token, peerId: 'pB' }))
      .rejects.toMatchObject({ code: 'already_redeemed' });

    // The second attempt must NOT have authorised pB.
    expect(cadreNode.authorizedPeers.has('pB')).toBe(false);
  });

  it('requires both token and peerId', async () => {
    await expect(service.redeemInvite({ token: '', peerId: 'p1' }))
      .rejects.toBeInstanceOf(TrustCircleError);
    await expect(service.redeemInvite({ token: 't', peerId: '' }))
      .rejects.toBeInstanceOf(TrustCircleError);
  });
});

describe('TrustCircleService.revokePending', () => {
  it('removes a pending row and prevents subsequent redemption', async () => {
    const { token } = await service.issueInvite({ label: 'Eve' });
    await service.revokePending(token);
    expect(store.getPending(token)).toBeUndefined();

    await expect(service.redeemInvite({ token, peerId: 'p1' }))
      .rejects.toMatchObject({ code: 'already_redeemed' });
  });

  it('throws not_found for an unknown token', async () => {
    await expect(service.revokePending('nope'))
      .rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('TrustCircleService.removeMember', () => {
  it('removes from CadrePeer and the local label store', async () => {
    const { token } = await service.issueInvite({ label: 'Frank' });
    await service.redeemInvite({ token, peerId: 'pF' });

    await service.removeMember('pF');
    expect(cadreNode.removed).toEqual(['pF']);
    expect(cadreNode.authorizedPeers.has('pF')).toBe(false);
    expect(store.getMember('pF')).toBeUndefined();
  });

  it('throws not_found for an unknown peer', async () => {
    await expect(service.removeMember('unknown'))
      .rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('TrustCircleService.isMember', () => {
  it('reads from the CadrePeer table', async () => {
    expect(await service.isMember('pX')).toBe(false);
    cadreNode.authorizedPeers.add('pX');
    expect(await service.isMember('pX')).toBe(true);
  });
});

describe('TrustCircleService.list', () => {
  it('joins CadrePeer with local labels and prunes orphan labels', async () => {
    // Pre-seed a label whose peer is NOT in CadrePeer — should be pruned.
    store.addMember({ peerId: 'orphan', label: 'ghost', addedAt: 't' });

    const r1 = await service.issueInvite({ label: 'Alice' });
    await service.redeemInvite({ token: r1.token, peerId: 'pA' });
    const r2 = await service.issueInvite({ label: 'Bob' });
    await service.redeemInvite({ token: r2.token, peerId: 'pB' });
    // A still-pending invite that should appear in `pending`.
    const r3 = await service.issueInvite({ label: 'Carol' });

    const snap = await service.list();

    expect(snap.members.map(m => m.peerId).sort()).toEqual(['pA', 'pB']);
    expect(snap.members.find(m => m.peerId === 'pA')?.label).toBe('Alice');
    expect(snap.members.find(m => m.peerId === 'pB')?.label).toBe('Bob');
    expect(snap.pending.map(p => p.token)).toContain(r3.token);

    expect(store.getMember('orphan')).toBeUndefined();
  });

  it('falls back to local labels when control DB is unavailable', async () => {
    store.addMember({ peerId: 'pZ', label: 'Zoe', addedAt: 't' });
    cadreNode.dbAvailable = false;

    const snap = await service.list();
    expect(snap.members.some(m => m.peerId === 'pZ' && m.label === 'Zoe')).toBe(true);
    // Orphan check is skipped when DB is unavailable.
    expect(store.getMember('pZ')).toBeDefined();
  });

  it('shows unlabelled CadrePeer rows with peerId as label', async () => {
    cadreNode.authorizedPeers.add('unlabeled-peer');
    const snap = await service.list();
    const entry = snap.members.find(m => m.peerId === 'unlabeled-peer');
    expect(entry?.label).toBe('unlabeled-peer');
  });
});

describe('createTrustCircleHandlers', () => {
  it('exposes the HTTP-handler surface', async () => {
    const handlers = createTrustCircleHandlers(service);

    const issued = await handlers.postInvite({ label: 'Pat' });
    expect(issued.encodedInvite.startsWith('enc:')).toBe(true);
    expect(typeof issued.token).toBe('string');
    expect(issued.expiresAt).toBeTruthy();

    let snap = await handlers.listTrustCircle();
    expect(snap.pending.map(p => p.token)).toContain(issued.token);
    expect(snap.members).toEqual([]);

    await handlers.deleteInvite(issued.token);
    snap = await handlers.listTrustCircle();
    expect(snap.pending).toEqual([]);
  });

  it('postInvite rejects missing label', async () => {
    const handlers = createTrustCircleHandlers(service);
    await expect(handlers.postInvite({ label: undefined as unknown as string }))
      .rejects.toMatchObject({ code: 'invalid_label' });
  });
});
