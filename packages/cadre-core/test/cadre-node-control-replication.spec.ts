import { describe, it, expect } from 'vitest';
import { CadreNode } from '../src/cadre-node.js';
import type { CadreNodeConfig } from '../src/types.js';

/**
 * Unit coverage for write-while-alone re-replication
 * (`control-write-ensure-replicated`): the in-memory queueing of control writes
 * that committed local-only (0 connections) and the cohort-growth drain that
 * re-issues them. The live-network convergence is covered separately by the
 * integration scenarios; here we stub the control node / DB / seed-bootstrap and
 * assert which re-issues fire.
 */

function createConfig(overrides?: Partial<CadreNodeConfig>): CadreNodeConfig {
  return {
    controlNetwork: {
      partyId: 'replication-test-' + Math.random().toString(36).slice(2),
      bootstrapNodes: []
    },
    profile: 'transaction',
    ...overrides
  };
}

interface PeerRow { peerId: string; sig: string; updatedAt: number }

interface RevRow { tableName: string; rowKey: string; stampId: string; reissuedAt: number }

interface FakeSeed {
  authorize: boolean;
  reauthorizeCalls: Array<{ peerId: string; updatedAt: number }>;
  removeCalls: string[];
  authorizeCalls: string[];
  reissueRevocationsCalls: Array<{ rows: RevRow[]; reissuedAt: number }>;
  /** When set, the fake `reissueRevocations` throws instead of recording. */
  reissueRevocationsError: Error | null;
}

/** A minimal control-node fake exposing only what the re-replication paths read. */
function fakeControlNode(opts: { selfPeerId?: string; connections?: number }): unknown {
  const count = opts.connections ?? 0;
  return {
    peerId: { toString: () => opts.selfPeerId ?? 'self-peer' },
    getConnections: () => new Array(count).fill({ remotePeer: { toString: () => 'peer' } }),
    addEventListener: () => {},
    removeEventListener: () => {}
  };
}

/**
 * Wire a node with injected control node + DB + seed-bootstrap fakes. `registerSelf`
 * and `retouchSelfDeviceToken` are stubbed so the drain's self-row step is a no-op
 * and the tests isolate the peer-write / reconstruction behaviour.
 */
function inject(
  node: CadreNode,
  opts: {
    members?: PeerRow[];
    records?: Record<string, PeerRow | null>;
    connections?: number;
    selfPeerId?: string;
    canAuthorize?: boolean;
    running?: boolean;
    hasSeed?: boolean;
    revocations?: RevRow[];
  }
): { seed: FakeSeed; queryCadrePeersCalls: () => number; registerSelfCalls: () => number } {
  const seed: FakeSeed = {
    authorize: opts.canAuthorize ?? true,
    reauthorizeCalls: [],
    removeCalls: [],
    authorizeCalls: [],
    reissueRevocationsCalls: [],
    reissueRevocationsError: null
  };
  let queryCadrePeers = 0;
  let registerSelf = 0;

  (node as unknown as { _running: boolean })._running = opts.running ?? true;
  (node as unknown as { controlNode: unknown }).controlNode = fakeControlNode({
    selfPeerId: opts.selfPeerId ?? 'self-peer',
    connections: opts.connections
  });
  (node as unknown as { controlDatabase: unknown }).controlDatabase = {
    queryCadrePeers: async () => { queryCadrePeers++; return opts.members ?? []; },
    queryPeerRecord: async (peerId: string) =>
      (opts.records && peerId in opts.records) ? opts.records[peerId] : null,
    queryDeviceToken: async () => null,
    queryRevocations: async () => opts.revocations ?? []
  };
  if (opts.hasSeed ?? true) {
    (node as unknown as { seedBootstrapService: unknown }).seedBootstrapService = {
      canAuthorize: () => seed.authorize,
      reauthorizePeer: async (peerId: string, updatedAt: number) => { seed.reauthorizeCalls.push({ peerId, updatedAt }); },
      removePeer: async (peerId: string) => { seed.removeCalls.push(peerId); },
      authorizePeer: async (o: { peerId: string }) => { seed.authorizeCalls.push(o.peerId); },
      reissueRevocations: async (rows: readonly RevRow[], reissuedAt: number) => {
        if (seed.reissueRevocationsError) { throw seed.reissueRevocationsError; }
        seed.reissueRevocationsCalls.push({ rows: [...rows], reissuedAt });
        return rows.length;
      }
    };
  }
  // Stub the self-row re-touch so the drain isolates peer/reconstruction work.
  (node as unknown as { registerSelf: () => Promise<string> }).registerSelf =
    async () => { registerSelf++; return 'skipped'; };
  (node as unknown as { retouchSelfDeviceToken: () => Promise<void> }).retouchSelfDeviceToken =
    async () => {};

  return { seed, queryCadrePeersCalls: () => queryCadrePeers, registerSelfCalls: () => registerSelf };
}

/** Read the private re-replication queue for assertions. */
function pending(node: CadreNode): Map<string, 'authorize'> {
  return (node as unknown as { pendingPeerWrites: Map<string, 'authorize'> }).pendingPeerWrites;
}

/** Read the private revocation re-replication queue for assertions. */
function pendingRevs(node: CadreNode): Map<string, { tableName: string; rowKey: string; stampId: string }> {
  return (node as unknown as { pendingRevocations: Map<string, { tableName: string; rowKey: string; stampId: string }> })
    .pendingRevocations;
}

/**
 * Drive the committed-delete seam handler directly. The real listener is wired in
 * `start()` (which these tests never call), so — like the `pending(node).set(...)`
 * seeding above — the handler is exercised via cast.
 */
function noteDelete(node: CadreNode, rev: { tableName: string; rowKey: string; stampId: string }): void {
  (node as unknown as { noteGuardedDelete: (r: typeof rev) => void }).noteGuardedDelete(rev);
}

const revRow = (stampId: string, reissuedAt = 0): RevRow =>
  ({ tableName: 'CadrePeer', rowKey: `row-of-${stampId}`, stampId, reissuedAt });

describe('CadreNode write-while-alone re-replication', () => {
  describe('queueing (noteControlWrite via authorizePeer / removePeer)', () => {
    it('queues an authorize that committed while alone (0 connections)', async () => {
      const node = new CadreNode(createConfig());
      inject(node, { connections: 0 });
      await node.authorizePeer('peer-X');
      expect(pending(node).get('peer-X')).toBe('authorize');
    });

    it('does NOT queue (and clears) an authorize that committed while connected', async () => {
      const node = new CadreNode(createConfig());
      inject(node, { connections: 2 });
      // Pre-seed a stale entry to prove a connected write clears it.
      pending(node).set('peer-X', 'authorize');
      await node.authorizePeer('peer-X');
      expect(pending(node).has('peer-X')).toBe(false);
    });

    it('a remove clears a queued authorize for the same subject (row gone — re-issuing the insert would resurrect it)', async () => {
      const node = new CadreNode(createConfig());
      inject(node, { connections: 0 });
      await node.authorizePeer('peer-X');
      expect(pending(node).get('peer-X')).toBe('authorize');
      await node.removePeer('peer-X');
      expect(pending(node).has('peer-X')).toBe(false);
    });
  });

  describe('queueing (noteGuardedDelete via the committed-delete seam)', () => {
    it('queues a guarded delete that committed while alone (0 connections)', () => {
      const node = new CadreNode(createConfig());
      inject(node, { connections: 0 });
      noteDelete(node, { tableName: 'CadrePeer', rowKey: 'peer-X', stampId: 'stamp-1' });
      expect(pendingRevs(node).get('stamp-1')).toEqual({ tableName: 'CadrePeer', rowKey: 'peer-X', stampId: 'stamp-1' });
    });

    it('does NOT queue (and clears) a guarded delete that committed while connected', () => {
      const node = new CadreNode(createConfig());
      inject(node, { connections: 2 });
      pendingRevs(node).set('stamp-1', { tableName: 'CadrePeer', rowKey: 'peer-X', stampId: 'stamp-1' });
      noteDelete(node, { tableName: 'CadrePeer', rowKey: 'peer-X', stampId: 'stamp-1' });
      expect(pendingRevs(node).has('stamp-1')).toBe(false);
    });
  });

  describe('drain re-issues', () => {
    it('re-issues a pending authorize as a monotonic owner UPDATE', async () => {
      const node = new CadreNode(createConfig());
      const { seed } = inject(node, {
        members: [],
        records: { 'peer-X': { peerId: 'peer-X', sig: '', updatedAt: 100 } }
      });
      pending(node).set('peer-X', 'authorize');

      await node.drainPendingControlReplication('test');

      expect(seed.reauthorizeCalls).toHaveLength(1);
      expect(seed.reauthorizeCalls[0]!.peerId).toBe('peer-X');
      // Strictly increases past the stored stamp.
      expect(seed.reauthorizeCalls[0]!.updatedAt).toBeGreaterThan(100);
      expect(pending(node).has('peer-X')).toBe(false);
    });

    it('skips (and clears) a pending authorize whose row now carries a self-Sig', async () => {
      const node = new CadreNode(createConfig());
      const { seed } = inject(node, {
        records: { 'peer-X': { peerId: 'peer-X', sig: 'self-signature', updatedAt: 5 } }
      });
      pending(node).set('peer-X', 'authorize');

      await node.drainPendingControlReplication('test');

      expect(seed.reauthorizeCalls).toEqual([]);
      expect(pending(node).has('peer-X')).toBe(false);
    });

    it('skips (and clears) a pending authorize whose row vanished', async () => {
      const node = new CadreNode(createConfig());
      const { seed } = inject(node, { records: { 'peer-X': null } });
      pending(node).set('peer-X', 'authorize');

      await node.drainPendingControlReplication('test');

      expect(seed.reauthorizeCalls).toEqual([]);
      expect(pending(node).has('peer-X')).toBe(false);
    });

    it('never calls removePeer from the drain (removals ride the revocation queue)', async () => {
      const node = new CadreNode(createConfig());
      const { seed } = inject(node, {
        revocations: [revRow('stamp-1')]
      });
      pendingRevs(node).set('stamp-1', { tableName: 'CadrePeer', rowKey: 'peer-X', stampId: 'stamp-1' });

      await node.drainPendingControlReplication('test');

      expect(seed.removeCalls).toEqual([]);
      expect(seed.reissueRevocationsCalls).toHaveLength(1);
    });
  });

  describe('revocation drain (drainPendingRevocations)', () => {
    it('first drain sweeps EVERY held tombstone in one call, queued stamps included exactly once', async () => {
      const node = new CadreNode(createConfig());
      const held = [revRow('stamp-1', 5), revRow('stamp-2'), revRow('stamp-3')];
      const { seed } = inject(node, { revocations: held });
      // stamp-2 is also in the in-session queue — must not be re-issued twice.
      pendingRevs(node).set('stamp-2', { tableName: 'CadrePeer', rowKey: 'row-of-stamp-2', stampId: 'stamp-2' });

      await node.drainPendingControlReplication('first');

      expect(seed.reissueRevocationsCalls).toHaveLength(1);
      const call = seed.reissueRevocationsCalls[0]!;
      expect(call.rows.map((r) => r.stampId).sort()).toEqual(['stamp-1', 'stamp-2', 'stamp-3']);
      // Strictly above every held ReissuedAt.
      expect(call.reissuedAt).toBeGreaterThan(5);
      expect(pendingRevs(node).size).toBe(0);
    });

    it('second drain with an empty queue does not re-sweep', async () => {
      const node = new CadreNode(createConfig());
      const { seed } = inject(node, { revocations: [revRow('stamp-1')] });

      await node.drainPendingControlReplication('first');
      await node.drainPendingControlReplication('second');

      expect(seed.reissueRevocationsCalls).toHaveLength(1);
    });

    it('second drain re-issues exactly the queued row and clears it on success', async () => {
      const node = new CadreNode(createConfig());
      const { seed } = inject(node, { revocations: [revRow('stamp-1'), revRow('stamp-2')] });

      await node.drainPendingControlReplication('first');
      pendingRevs(node).set('stamp-2', { tableName: 'CadrePeer', rowKey: 'row-of-stamp-2', stampId: 'stamp-2' });
      await node.drainPendingControlReplication('second');

      expect(seed.reissueRevocationsCalls).toHaveLength(2);
      expect(seed.reissueRevocationsCalls[1]!.rows.map((r) => r.stampId)).toEqual(['stamp-2']);
      expect(pendingRevs(node).has('stamp-2')).toBe(false);
    });

    it('a throwing reissueRevocations leaves the queue intact and retries the sweep on the next drain', async () => {
      const node = new CadreNode(createConfig());
      const { seed } = inject(node, { revocations: [revRow('stamp-1')] });
      pendingRevs(node).set('stamp-1', { tableName: 'CadrePeer', rowKey: 'row-of-stamp-1', stampId: 'stamp-1' });
      seed.reissueRevocationsError = new Error('Failed to get super-majority');

      await node.drainPendingControlReplication('first');

      expect(pendingRevs(node).has('stamp-1')).toBe(true);

      // Failure did not consume the one-shot sweep: the next drain sweeps again.
      seed.reissueRevocationsError = null;
      await node.drainPendingControlReplication('second');

      expect(seed.reissueRevocationsCalls).toHaveLength(1);
      expect(seed.reissueRevocationsCalls[0]!.rows.map((r) => r.stampId)).toEqual(['stamp-1']);
      expect(pendingRevs(node).has('stamp-1')).toBe(false);
    });

    it('a stop() re-arms the sweep, so the next lifetime sweeps its held tombstones again', async () => {
      const node = new CadreNode(createConfig());
      const { seed } = inject(node, { revocations: [revRow('stamp-1')] });

      await node.drainPendingControlReplication('first');
      expect(seed.reissueRevocationsCalls).toHaveLength(1);

      // stop()'s teardown resets the write-while-alone state. Without the sweep
      // flag resetting with it, a second lifetime would skip the sweep — and a
      // removal committed alone in THIS lifetime is precisely a "before my start"
      // tombstone from the next one's point of view.
      (node as unknown as { stopRecordRefresh: () => void }).stopRecordRefresh();
      const { seed: restarted } = inject(node, { revocations: [revRow('stamp-1', 7)] });

      await node.drainPendingControlReplication('after restart');

      expect(seed.reissueRevocationsCalls).toHaveLength(1); // pre-stop fake, untouched
      expect(restarted.reissueRevocationsCalls).toHaveLength(1);
      expect(restarted.reissueRevocationsCalls[0]!.rows.map((r) => r.stampId)).toEqual(['stamp-1']);
      expect(restarted.reissueRevocationsCalls[0]!.reissuedAt).toBeGreaterThan(7);
    });

    it('a node with no owner key drops queued revocations without touching the database', async () => {
      const node = new CadreNode(createConfig());
      const { seed } = inject(node, { canAuthorize: false, revocations: [revRow('stamp-1')] });
      pendingRevs(node).set('stamp-1', { tableName: 'CadrePeer', rowKey: 'row-of-stamp-1', stampId: 'stamp-1' });

      await node.drainPendingControlReplication('test');

      expect(seed.reissueRevocationsCalls).toEqual([]);
      expect(pendingRevs(node).size).toBe(0);
    });
  });

  describe('first-growth reconstruction', () => {
    it('re-touches every Sig-null member row (skipping self and self-published rows)', async () => {
      const node = new CadreNode(createConfig());
      const { seed } = inject(node, {
        selfPeerId: 'self-peer',
        members: [
          { peerId: 'self-peer', sig: 'x', updatedAt: 1 },
          { peerId: 'peer-X', sig: '', updatedAt: 10 },
          { peerId: 'peer-Y', sig: 'self-sig', updatedAt: 20 }
        ],
        records: {
          'peer-X': { peerId: 'peer-X', sig: '', updatedAt: 10 },
          'peer-Y': { peerId: 'peer-Y', sig: 'self-sig', updatedAt: 20 }
        }
      });

      await node.drainPendingControlReplication('test');

      // Only peer-X (Sig null, not self) is reconstructed.
      expect(seed.reauthorizeCalls.map((c) => c.peerId)).toEqual(['peer-X']);
    });

    it('does NOT double-touch a row already tracked in the in-memory queue', async () => {
      const node = new CadreNode(createConfig());
      const { seed } = inject(node, {
        members: [{ peerId: 'peer-X', sig: '', updatedAt: 10 }],
        records: { 'peer-X': { peerId: 'peer-X', sig: '', updatedAt: 10 } }
      });
      pending(node).set('peer-X', 'authorize');

      await node.drainPendingControlReplication('test');

      // Reconstruction skips peer-X (in the queue); the queue drain handles it once.
      expect(seed.reauthorizeCalls).toHaveLength(1);
    });

    it('runs reconstruction only once (subsequent drains skip it)', async () => {
      const node = new CadreNode(createConfig());
      const { queryCadrePeersCalls } = inject(node, {
        members: [{ peerId: 'peer-X', sig: '', updatedAt: 10 }],
        records: { 'peer-X': { peerId: 'peer-X', sig: '', updatedAt: 10 } }
      });

      await node.drainPendingControlReplication('first');
      await node.drainPendingControlReplication('second');

      // queryCadrePeers (reconstruction's member scan) runs on the first drain only.
      expect(queryCadrePeersCalls()).toBe(1);
    });
  });

  describe('non-owner safety', () => {
    it('does not re-sign rows it merely holds (no owner key)', async () => {
      const node = new CadreNode(createConfig());
      const { seed } = inject(node, {
        canAuthorize: false,
        members: [{ peerId: 'peer-X', sig: '', updatedAt: 10 }],
        records: { 'peer-X': { peerId: 'peer-X', sig: '', updatedAt: 10 } }
      });
      pending(node).set('peer-X', 'authorize');

      await node.drainPendingControlReplication('test');

      expect(seed.reauthorizeCalls).toEqual([]);
      expect(seed.removeCalls).toEqual([]);
      // The stray queue entry is dropped (a non-owner cannot have authored it).
      expect(pending(node).has('peer-X')).toBe(false);
    });
  });

  describe('drain guards', () => {
    it('collapses concurrent drains into one in-flight run (single-flight)', async () => {
      const node = new CadreNode(createConfig());
      const { queryCadrePeersCalls } = inject(node, {
        members: [{ peerId: 'peer-X', sig: '', updatedAt: 10 }],
        records: { 'peer-X': { peerId: 'peer-X', sig: '', updatedAt: 10 } }
      });

      await Promise.all([
        node.drainPendingControlReplication('a'),
        node.drainPendingControlReplication('b')
      ]);

      expect(queryCadrePeersCalls()).toBe(1);
    });

    it('early-returns when the node is not running', async () => {
      const node = new CadreNode(createConfig());
      const { seed, registerSelfCalls } = inject(node, {
        running: false,
        records: { 'peer-X': { peerId: 'peer-X', sig: '', updatedAt: 10 } }
      });
      pending(node).set('peer-X', 'authorize');

      await node.drainPendingControlReplication('test');

      expect(registerSelfCalls()).toBe(0);
      expect(seed.reauthorizeCalls).toEqual([]);
      expect(pending(node).has('peer-X')).toBe(true); // untouched
    });
  });

  // The public read of the same sample the write-while-alone seam is defined on
  // (`committedAlone` calls it), exposed so an embedder — the admin channel's
  // `controlConnections` / `alone` fields — can report replication reach.
  describe('getControlConnectionCount', () => {
    it('is 0 on a node that never started (no control node)', () => {
      expect(new CadreNode(createConfig()).getControlConnectionCount()).toBe(0);
    });

    it('reports the live connection count', () => {
      const node = new CadreNode(createConfig());
      inject(node, { connections: 3 });
      expect(node.getControlConnectionCount()).toBe(3);
    });

    it('agrees with the write-while-alone seam: 0 connections queues the write', async () => {
      const node = new CadreNode(createConfig());
      inject(node, { connections: 0 });
      expect(node.getControlConnectionCount()).toBe(0);
      await node.authorizePeer('peer-X');
      expect(pending(node).has('peer-X')).toBe(true);
    });
  });

  describe('connection-growth transition', () => {
    function withTransitionFake(node: CadreNode, connections: { value: number }): { drains: () => number } {
      let drains = 0;
      (node as unknown as { _running: boolean })._running = true;
      (node as unknown as { controlNode: unknown }).controlNode = {
        getConnections: () => new Array(connections.value).fill({})
      };
      (node as unknown as { drainPendingControlReplication: (r: string) => Promise<void> })
        .drainPendingControlReplication = async () => { drains++; };
      return { drains: () => drains };
    }

    it('drains only on the 0→≥1 edge and re-arms after a full disconnect', () => {
      const node = new CadreNode(createConfig());
      const conns = { value: 1 };
      const { drains } = withTransitionFake(node, conns);

      const change = () => (node as unknown as { handleControlConnectionChange: () => void }).handleControlConnectionChange();
      const close = () => (node as unknown as { handleControlConnectionClose: () => void }).handleControlConnectionClose();

      change(); // 0 → ≥1: drains
      change(); // still ≥1: no second drain
      expect(drains()).toBe(1);

      conns.value = 0;
      close(); // back to 0: re-arm
      conns.value = 1;
      change(); // 0 → ≥1 again: drains
      expect(drains()).toBe(2);
    });
  });

  // The drain's self-device-token re-touch. The full registerDeviceToken path needs
  // a real self-signing key (covered end-to-end by the integration scenario); here
  // we isolate retouchSelfDeviceToken's guard logic by stubbing registerDeviceToken.
  describe('retouchSelfDeviceToken', () => {
    function injectDeviceToken(
      node: CadreNode,
      existing: { platform: string; token: string } | null
    ): { registerCalls: () => Array<{ platform: string; token: string }> } {
      const calls: Array<{ platform: string; token: string }> = [];
      (node as unknown as { _running: boolean })._running = true;
      (node as unknown as { controlNode: unknown }).controlNode = fakeControlNode({ selfPeerId: 'self-peer' });
      (node as unknown as { controlDatabase: unknown }).controlDatabase = {
        queryDeviceToken: async () => existing
      };
      (node as unknown as { registerDeviceToken: (p: string, t: string) => Promise<void> })
        .registerDeviceToken = async (platform: string, token: string) => { calls.push({ platform, token }); };
      return { registerCalls: () => calls };
    }

    const retouch = (node: CadreNode) =>
      (node as unknown as { retouchSelfDeviceToken: () => Promise<void> }).retouchSelfDeviceToken();

    it('re-registers an existing push-platform self token', async () => {
      const node = new CadreNode(createConfig());
      const { registerCalls } = injectDeviceToken(node, { platform: 'fcm', token: 'tok-1' });

      await retouch(node);

      expect(registerCalls()).toEqual([{ platform: 'fcm', token: 'tok-1' }]);
    });

    it('is a no-op when no self token row exists', async () => {
      const node = new CadreNode(createConfig());
      const { registerCalls } = injectDeviceToken(node, null);

      await retouch(node);

      expect(registerCalls()).toEqual([]);
    });

    it('is a no-op when the stored platform is not a known push platform', async () => {
      const node = new CadreNode(createConfig());
      const { registerCalls } = injectDeviceToken(node, { platform: 'carrier-pigeon', token: 'tok-1' });

      await retouch(node);

      expect(registerCalls()).toEqual([]);
    });
  });
});
