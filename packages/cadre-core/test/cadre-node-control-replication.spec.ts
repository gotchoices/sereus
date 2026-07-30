import { describe, it, expect } from 'vitest';
import type { createLibp2pNode } from '@optimystic/db-p2p';
import { CadreNode } from '../src/cadre-node.js';
import { CONTROL_REPLICATION_BREADTH, DEFAULT_STRAND_CLUSTER_SIZE } from '../src/types.js';
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

interface FakeSeed {
  authorize: boolean;
  reauthorizeCalls: Array<{ peerId: string; updatedAt: number }>;
  removeCalls: string[];
  authorizeCalls: string[];
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
  }
): { seed: FakeSeed; queryCadrePeersCalls: () => number; registerSelfCalls: () => number } {
  const seed: FakeSeed = { authorize: opts.canAuthorize ?? true, reauthorizeCalls: [], removeCalls: [], authorizeCalls: [] };
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
    queryDeviceToken: async () => null
  };
  if (opts.hasSeed ?? true) {
    (node as unknown as { seedBootstrapService: unknown }).seedBootstrapService = {
      canAuthorize: () => seed.authorize,
      reauthorizePeer: async (peerId: string, updatedAt: number) => { seed.reauthorizeCalls.push({ peerId, updatedAt }); },
      removePeer: async (peerId: string) => { seed.removeCalls.push(peerId); },
      authorizePeer: async (o: { peerId: string }) => { seed.authorizeCalls.push(o.peerId); }
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
function pending(node: CadreNode): Map<string, 'authorize' | 'remove'> {
  return (node as unknown as { pendingPeerWrites: Map<string, 'authorize' | 'remove'> }).pendingPeerWrites;
}

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

    it('queues a remove that committed while alone (security-relevant)', async () => {
      const node = new CadreNode(createConfig());
      inject(node, { connections: 0 });
      await node.removePeer('peer-X');
      expect(pending(node).get('peer-X')).toBe('remove');
    });

    it('remove-after-authorize while alone: remove wins (last op for the subject)', async () => {
      const node = new CadreNode(createConfig());
      inject(node, { connections: 0 });
      await node.authorizePeer('peer-X');
      await node.removePeer('peer-X');
      expect(pending(node).get('peer-X')).toBe('remove');
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

    it('re-issues a pending remove (best-effort delete) and clears it', async () => {
      const node = new CadreNode(createConfig());
      const { seed } = inject(node, {});
      pending(node).set('peer-X', 'remove');

      await node.drainPendingControlReplication('test');

      expect(seed.removeCalls).toEqual(['peer-X']);
      expect(pending(node).has('peer-X')).toBe(false);
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

/**
 * The control network's replication breadth is the whole point of the queueing above
 * being a *backstop* rather than the primary convergence mechanism, so it gets its own
 * guard: nothing else fails if `createControlNode` stops passing
 * `CONTROL_REPLICATION_BREADTH`, and a narrower cohort silently reintroduces the
 * never-converging read-repair case documented on the constant.
 *
 * `buildControlNodeOptions` is the private config→options mapping `createControlNode`
 * hands to `createLibp2pNode`; calling it directly keeps this a pure unit test with no
 * libp2p node started. Partial coverage on purpose — the remaining control-network
 * options are still unasserted, tracked by
 * `backlog/debt-cadre-node-control-network-wiring-test`.
 */
describe('CadreNode control-network node options', () => {
  function controlOptions(node: CadreNode): Parameters<typeof createLibp2pNode>[0] {
    return (node as unknown as {
      buildControlNodeOptions: () => Parameters<typeof createLibp2pNode>[0]
    }).buildControlNodeOptions();
  }

  it('replicates the control DB to the whole party, not the strand default', () => {
    const options = controlOptions(new CadreNode(createConfig()));

    expect(options.clusterSize).toBe(CONTROL_REPLICATION_BREADTH);
    expect(options.clusterSize).toBeGreaterThan(DEFAULT_STRAND_CLUSTER_SIZE);
  });

  it('is not configurable — strandClusterSize does not reach the control node', () => {
    const options = controlOptions(new CadreNode(createConfig({ strandClusterSize: 3 })));

    expect(options.clusterSize).toBe(CONTROL_REPLICATION_BREADTH);
  });

  it('lets Optimystic shrink the cohort to the party that actually exists', () => {
    // Without `allowDownsize` a 16-wide target would never be satisfiable by a real
    // (2-7 node) party, so the two settings only make sense together.
    const options = controlOptions(new CadreNode(createConfig()));

    expect(options.clusterPolicy?.allowDownsize).toBe(true);
    // Left at Optimystic's default of 2: the admission gate measures declared peers
    // against this, not against clusterSize (see CONTROL_REPLICATION_BREADTH).
    expect(options.clusterPolicy?.assumedClusterSize).toBeUndefined();
  });

  it('builds a control-scoped network, keeping it distinct from any strand network', () => {
    const config = createConfig();
    const options = controlOptions(new CadreNode(config));

    expect(options.networkName).toBe(`control-${config.controlNetwork.partyId}`);
  });
});
