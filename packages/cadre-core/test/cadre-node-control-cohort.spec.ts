import { describe, it, expect } from 'vitest';
import { multiaddr } from '@multiformats/multiaddr';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { CadreNode } from '../src/cadre-node.js';
import type { CadreNodeConfig } from '../src/types.js';

/**
 * Unit coverage for the proactive control-cohort reconcile orchestration
 * (enumerate → select → skip-connected → resolve → dial). The pure selection
 * policy is covered separately in control-cohort.spec.ts; here we stub the
 * control node / DB / address resolver and assert which siblings get dialed.
 */

function createConfig(overrides?: Partial<CadreNodeConfig>): CadreNodeConfig {
  return {
    controlNetwork: {
      partyId: 'cohort-test-' + Math.random().toString(36).slice(2),
      bootstrapNodes: []
    },
    profile: 'transaction',
    ...overrides
  };
}

interface FakeControlOpts {
  selfPeerId?: string;
  connections?: string[];
  dialCalls: Array<unknown>;
}

/** A minimal control-node fake exposing only what reconcile reads. */
function fakeControlNode(opts: FakeControlOpts): unknown {
  return {
    peerId: { toString: () => opts.selfPeerId ?? 'self-peer' },
    getConnections: () =>
      (opts.connections ?? []).map((id) => ({ remotePeer: { toString: () => id } })),
    dial: async (addrs: unknown) => { opts.dialCalls.push(addrs); },
    // Cold-start fallback target; unused when resolvePeerAddrs returns addrs.
    peerStore: { get: async () => { throw new Error('peerStore miss'); } }
  };
}

/** Wire a node with an injected control node + DB + stubbed address resolver. */
function injectCohort(
  node: CadreNode,
  opts: {
    members: Array<{ peerId: string; multiaddr: string | null }>;
    ownerKeys?: Set<string>;
    connections?: string[];
    selfPeerId?: string;
    running?: boolean;
  }
): { dialCalls: Array<unknown>; resolvedFor: string[]; queryCalls: () => number } {
  const dialCalls: Array<unknown> = [];
  const resolvedFor: string[] = [];
  let queries = 0;

  (node as unknown as { _running: boolean })._running = opts.running ?? true;
  (node as unknown as { controlNode: unknown }).controlNode = fakeControlNode({
    selfPeerId: opts.selfPeerId ?? 'self-peer',
    connections: opts.connections,
    dialCalls
  });
  (node as unknown as { controlDatabase: unknown }).controlDatabase = {
    queryCadrePeers: async () => { queries++; return opts.members; },
    // Consulted by the per-stream authz snapshot refresh that rides each pass.
    queryRevokedStamps: async () => new Set<string>(),
    getOwnerKeys: async () => opts.ownerKeys ?? new Set<string>()
  };
  (node as unknown as { resolvePeerAddrs: (id: string) => Promise<unknown[]> }).resolvePeerAddrs =
    async (id: string) => { resolvedFor.push(id); return [multiaddr('/ip4/1.2.3.4/tcp/4001')]; };

  return { dialCalls, resolvedFor, queryCalls: () => queries };
}

describe('CadreNode.reconcileControlCohort', () => {
  it('is a no-op when the node is alone (only self in membership)', async () => {
    const node = new CadreNode(createConfig());
    const { dialCalls, resolvedFor } = injectCohort(node, {
      members: [{ peerId: 'self-peer', multiaddr: null }]
    });

    await expect(node.reconcileControlCohort()).resolves.toBeUndefined();

    expect(dialCalls).toEqual([]);
    expect(resolvedFor).toEqual([]);
  });

  it('is a no-op with no membership rows at all', async () => {
    const node = new CadreNode(createConfig());
    const { dialCalls } = injectCohort(node, { members: [] });

    await expect(node.reconcileControlCohort()).resolves.toBeUndefined();
    expect(dialCalls).toEqual([]);
  });

  it('dials a not-yet-connected sibling', async () => {
    const node = new CadreNode(createConfig());
    const { dialCalls, resolvedFor } = injectCohort(node, {
      members: [
        { peerId: 'self-peer', multiaddr: null },
        { peerId: 'sibling-1', multiaddr: null }
      ],
      connections: []
    });

    await node.reconcileControlCohort();

    expect(resolvedFor).toEqual(['sibling-1']);
    expect(dialCalls).toHaveLength(1);
  });

  it('skips a sibling that is already connected (no re-dial, no resolve)', async () => {
    const node = new CadreNode(createConfig());
    const { dialCalls, resolvedFor } = injectCohort(node, {
      members: [
        { peerId: 'self-peer', multiaddr: null },
        { peerId: 'sibling-1', multiaddr: null }
      ],
      connections: ['sibling-1']
    });

    await node.reconcileControlCohort();

    expect(dialCalls).toEqual([]);
    expect(resolvedFor).toEqual([]);
  });

  it('never dials self even if self appears as a sibling row', async () => {
    const node = new CadreNode(createConfig());
    const { dialCalls, resolvedFor } = injectCohort(node, {
      selfPeerId: 'self-peer',
      members: [{ peerId: 'self-peer', multiaddr: '/ip4/1.1.1.1/tcp/1/p2p/self-peer' }]
    });

    await node.reconcileControlCohort();

    expect(dialCalls).toEqual([]);
    expect(resolvedFor).toEqual([]);
  });

  it('skips a sibling whose address does not resolve (no peerStore fallback either)', async () => {
    const node = new CadreNode(createConfig());
    const { dialCalls } = injectCohort(node, {
      members: [
        { peerId: 'self-peer', multiaddr: null },
        { peerId: 'sibling-unresolvable', multiaddr: null }
      ]
    });
    // Override the resolver to return nothing; peerStore.get throws → []._
    (node as unknown as { resolvePeerAddrs: () => Promise<unknown[]> }).resolvePeerAddrs =
      async () => [];

    await node.reconcileControlCohort();

    expect(dialCalls).toEqual([]);
  });

  it('falls back to peerStore addresses when the signed record does not resolve (cold start)', async () => {
    // This is the load-bearing cold-start path the auto-convergence integration test
    // exercises: the CadrePeer record is not yet resolvable, so resolveControlDialAddrs
    // must fall through to the libp2p peerStore entry applySeed populated and still dial.
    const node = new CadreNode(createConfig());
    const siblingPeerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
    const dialCalls: Array<unknown> = [];
    (node as unknown as { _running: boolean })._running = true;
    (node as unknown as { controlNode: unknown }).controlNode = {
      peerId: { toString: () => 'self-peer' },
      getConnections: () => [],
      dial: async (addrs: unknown) => { dialCalls.push(addrs); },
      // peerStore HAS an entry for the sibling (the cold-start seed populated it).
      peerStore: { get: async () => ({ addresses: [{ multiaddr: multiaddr('/ip4/9.9.9.9/tcp/4001') }] }) }
    };
    (node as unknown as { controlDatabase: unknown }).controlDatabase = {
      queryCadrePeers: async () => [
        { peerId: 'self-peer', multiaddr: null },
        { peerId: siblingPeerId, multiaddr: null }
      ],
      getOwnerKeys: async () => new Set<string>()
    };
    // Signed-record resolution yields nothing → must consult the peerStore fallback.
    (node as unknown as { resolvePeerAddrs: () => Promise<unknown[]> }).resolvePeerAddrs =
      async () => [];

    await node.reconcileControlCohort();

    expect(dialCalls).toHaveLength(1);
  });

  it('tolerates a dial failure and continues the pass', async () => {
    const node = new CadreNode(createConfig());
    const resolvedFor: string[] = [];
    (node as unknown as { _running: boolean })._running = true;
    (node as unknown as { controlNode: unknown }).controlNode = {
      peerId: { toString: () => 'self-peer' },
      getConnections: () => [],
      dial: async () => { throw new Error('dial boom'); },
      peerStore: { get: async () => { throw new Error('miss'); } }
    };
    (node as unknown as { controlDatabase: unknown }).controlDatabase = {
      queryCadrePeers: async () => [
        { peerId: 'self-peer', multiaddr: null },
        { peerId: 'sibling-a', multiaddr: null },
        { peerId: 'sibling-b', multiaddr: null }
      ],
      getOwnerKeys: async () => new Set<string>()
    };
    (node as unknown as { resolvePeerAddrs: (id: string) => Promise<unknown[]> }).resolvePeerAddrs =
      async (id: string) => { resolvedFor.push(id); return [multiaddr('/ip4/1.2.3.4/tcp/4001')]; };

    // A per-peer dial failure must not throw out of the pass; both siblings are attempted.
    await expect(node.reconcileControlCohort()).resolves.toBeUndefined();
    expect(resolvedFor.sort()).toEqual(['sibling-a', 'sibling-b']);
  });

  it('collapses concurrent passes into one in-flight run (single-flight)', async () => {
    const node = new CadreNode(createConfig());
    const { dialCalls, queryCalls } = injectCohort(node, {
      members: [
        { peerId: 'self-peer', multiaddr: null },
        { peerId: 'sibling-1', multiaddr: null }
      ]
    });

    await Promise.all([node.reconcileControlCohort(), node.reconcileControlCohort()]);

    // One coalesced pass. A single pass reads membership twice (the per-stream
    // authz snapshot refresh, then sibling enumeration) — so 2 here, not 4,
    // proves the second reconcile call rode the first's in-flight run.
    expect(queryCalls()).toBe(2);
    expect(dialCalls).toHaveLength(1);
  });

  it('early-returns (no dial) when the node is not running', async () => {
    const node = new CadreNode(createConfig());
    const { dialCalls, resolvedFor, queryCalls } = injectCohort(node, {
      members: [
        { peerId: 'self-peer', multiaddr: null },
        { peerId: 'sibling-1', multiaddr: null }
      ],
      running: false
    });

    await expect(node.reconcileControlCohort()).resolves.toBeUndefined();

    expect(queryCalls()).toBe(0);
    expect(dialCalls).toEqual([]);
    expect(resolvedFor).toEqual([]);
  });

  it('early-returns when there is no control node (post-teardown)', async () => {
    const node = new CadreNode(createConfig());
    (node as unknown as { _running: boolean })._running = true;
    (node as unknown as { controlNode: unknown }).controlNode = null;
    (node as unknown as { controlDatabase: unknown }).controlDatabase = {
      queryCadrePeers: async () => { throw new Error('should not query'); },
      getOwnerKeys: async () => new Set<string>()
    };

    await expect(node.reconcileControlCohort()).resolves.toBeUndefined();
  });

  it('honors the configured targetDegree cap end-to-end', async () => {
    // Self + 4 non-owner siblings, targetDegree 2 → only 2 dials. (The
    // synthetic non-Ed25519 ids never classify as backbone; the backbone-preference
    // ordering itself is covered by control-cohort.spec.ts.)
    const node = new CadreNode(createConfig({ network: { controlCohort: { targetDegree: 2 } } }));
    const { dialCalls } = injectCohort(node, {
      members: [
        { peerId: 'self-peer', multiaddr: null },
        { peerId: 'm-1', multiaddr: null },
        { peerId: 'm-2', multiaddr: null },
        { peerId: 'm-3', multiaddr: null },
        { peerId: 'm-4', multiaddr: null }
      ]
    });

    await node.reconcileControlCohort();

    expect(dialCalls).toHaveLength(2);
  });
});
