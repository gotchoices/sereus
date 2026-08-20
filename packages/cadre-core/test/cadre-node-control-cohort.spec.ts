import { describe, it, expect } from 'vitest';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { CadreNode } from '../src/cadre-node.js';
import { MemoryBootstrapPeerStore, type BootstrapPeerEntry, type BootstrapPeerStore } from '../src/bootstrap-peer-store.js';
import { ed25519KeyPairFromLibp2p } from '../src/ed25519-key.js';
import { signPeerRecord } from '../src/peer-record.js';
import type { CadreNodeConfig, ControlNetworkSeed, PeerAddressRecord, SeedPeer } from '../src/types.js';

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

/** One address-book write the pass made: who it was for, and what went in. */
interface MergeCall { peerId: string; addrs: string[] }

interface FakeControlOpts {
  selfPeerId?: string;
  connections?: string[];
  dialCalls: Array<unknown>;
  mergeCalls: MergeCall[];
  /** Make every address-book write reject, to prove the pass survives it. */
  mergeThrows?: boolean;
  /** Cold-start fallback source; the default misses (no entry). */
  peerStoreGet?: () => Promise<unknown>;
}

/**
 * libp2p's own precondition on a multi-address dial, reproduced from
 * `libp2p/dist/src/get-peer.js` (`getPeerAddress`): the addresses handed to ONE
 * `dial()` must either all name the same peer id or none may name one, judged by
 * each address's LAST `/p2p/` component. A mixed list throws before any
 * transport is touched.
 *
 * The fake enforces it so these tests fail the way production does: a sibling
 * whose record mixed a `…/p2p-circuit/p2p/<sibling>` address with a bare direct
 * one was skipped on every reconcile pass, forever, with the pass reporting
 * `dialed=0` and only a debug line to show for it.
 */
function assertDialableTogether(addrs: unknown): void {
  if (!Array.isArray(addrs)) {
    return;
  }
  const ids = (addrs as Multiaddr[]).map((addr) => {
    const p2p = multiaddr(addr.toString()).getComponents().filter((c) => c.name === 'p2p');
    return p2p.length > 0 ? (p2p[p2p.length - 1].value ?? null) : null;
  });
  if (new Set(ids).size > 1) {
    throw new Error('Multiaddrs must all have the same peer id or have no peer id');
  }
}

/** A stand-in relay peer id, for the circuit addresses these tests build. */
const RELAY_ID = '12D3KooWRelayAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** A minimal control-node fake exposing only what reconcile reads. */
function fakeControlNode(opts: FakeControlOpts): unknown {
  return {
    peerId: { toString: () => opts.selfPeerId ?? 'self-peer' },
    getConnections: () =>
      (opts.connections ?? []).map((id) => ({ remotePeer: { toString: () => id } })),
    dial: async (addrs: unknown) => { assertDialableTogether(addrs); opts.dialCalls.push(addrs); },
    peerStore: {
      // Cold-start fallback target; unused when resolvePeerAddrs returns addrs.
      get: opts.peerStoreGet ?? (async () => { throw new Error('peerStore miss'); }),
      merge: async (peerId: { toString(): string }, data: { multiaddrs: Array<{ toString(): string }> }) => {
        if (opts.mergeThrows) {
          throw new Error('merge boom');
        }
        opts.mergeCalls.push({
          peerId: peerId.toString(),
          addrs: data.multiaddrs.map((a) => a.toString())
        });
        // Echo the merged addresses back as the stored, expiry-filtered set —
        // what `mergePeerAddrs` reads to decide the write is visible and no
        // restamp is needed (peer-addr-book.spec.ts covers the restamp itself).
        return {
          addresses: data.multiaddrs.map((ma) => ({ multiaddr: ma, isCertified: false })),
          protocols: [],
          metadata: new Map(),
          tags: new Map()
        };
      }
    }
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
    /**
     * Stands in for what `start()` → `initializeBootstrapPeerStore` would build.
     * Pass the SAME instance to two nodes to model a store that outlived the
     * process (what the file backend gives a restarted node).
     */
    bootstrapStore?: BootstrapPeerStore;
    /** Make the revoked-row reap sweep reject, to prove the pass survives it. */
    reapThrows?: boolean;
    /** Make every address-book write reject, to prove the pass survives it. */
    mergeThrows?: boolean;
    /** Cold-start fallback source; the default misses (no entry). */
    peerStoreGet?: () => Promise<unknown>;
    /**
     * Signed `CadrePeer` records keyed by peerId. When given, the pass runs the
     * REAL `resolvePeerAddrs` against them (binding + self-signature + freshness
     * + trust gates, and the `/p2p/<peerId>` normalization) instead of the fixed
     * one-address stub — the only way to assert on the addresses a dial actually
     * receives.
     */
    records?: Map<string, PeerAddressRecord>;
  }
): {
  dialCalls: Array<unknown>;
  resolvedFor: string[];
  queryCalls: () => number;
  reapCalls: string[];
  mergeCalls: MergeCall[];
} {
  const dialCalls: Array<unknown> = [];
  const resolvedFor: string[] = [];
  const reapCalls: string[] = [];
  const mergeCalls: MergeCall[] = [];
  let queries = 0;

  (node as unknown as { _running: boolean })._running = opts.running ?? true;
  (node as unknown as { bootstrapPeerStore: BootstrapPeerStore }).bootstrapPeerStore =
    opts.bootstrapStore ?? new MemoryBootstrapPeerStore('p');
  (node as unknown as { controlNode: unknown }).controlNode = fakeControlNode({
    selfPeerId: opts.selfPeerId ?? 'self-peer',
    connections: opts.connections,
    dialCalls,
    mergeCalls,
    mergeThrows: opts.mergeThrows,
    peerStoreGet: opts.peerStoreGet
  });
  (node as unknown as { controlDatabase: unknown }).controlDatabase = {
    queryCadrePeers: async () => { queries++; return opts.members; },
    // Consulted by the per-stream authz snapshot refresh that rides each pass.
    queryRevokedStamps: async () => new Set<string>(),
    getOwnerKeys: async () => opts.ownerKeys ?? new Set<string>(),
    // The connectivity-gated reap sweep the pass runs before the sibling enumeration.
    reapRevokedRows: async (selfPeerId: string) => {
      reapCalls.push(selfPeerId);
      if (opts.reapThrows) {
        throw new Error('reap boom');
      }
      return 0;
    },
    queryPeerRecord: async (id: string) => opts.records?.get(id) ?? null
  };
  if (opts.records) {
    const real = (node as unknown as { resolvePeerAddrs(id: string): Promise<Multiaddr[]> })
      .resolvePeerAddrs.bind(node);
    (node as unknown as { resolvePeerAddrs: (id: string) => Promise<Multiaddr[]> }).resolvePeerAddrs =
      async (id: string) => { resolvedFor.push(id); return real(id); };
  } else {
    (node as unknown as { resolvePeerAddrs: (id: string) => Promise<unknown[]> }).resolvePeerAddrs =
      async (id: string) => { resolvedFor.push(id); return [multiaddr('/ip4/1.2.3.4/tcp/4001')]; };
  }

  return { dialCalls, resolvedFor, queryCalls: () => queries, reapCalls, mergeCalls };
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

  it('does not re-dial a sibling that is already connected (but still resolves it)', async () => {
    // The resolve is NOT wasted work: its addresses go into the address book, and
    // a live connection is exactly the case where that book must already be warm
    // when the connection drops (see the address-book describe block below).
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
    expect(resolvedFor).toEqual(['sibling-1']);
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

  it('normalizes the peerStore fallback list, which the address book hands back MIXED', async () => {
    // The address book is not a tidier source than the record — it is a messier
    // one. `@libp2p/peer-store` strips a trailing `/p2p/<peerId>` only when that
    // id is the address's FIRST `/p2p/` component, so a direct address comes back
    // bare while a relayed one keeps its suffix. Handing both to one `dial()` is
    // the same InvalidParametersError that skipped the whole sibling — on the
    // cold-start path, where the signed record is not resolvable yet and this
    // fallback is the ONLY way in.
    const node = new CadreNode(createConfig());
    const sibling = await realPeerId();
    const { dialCalls } = injectCohort(node, {
      members: [{ peerId: 'self-peer', multiaddr: null }, { peerId: sibling, multiaddr: null }],
      peerStoreGet: async () => ({
        addresses: [
          { multiaddr: multiaddr(`/dns4/r.example.org/tcp/4001/p2p/${RELAY_ID}/p2p-circuit/p2p/${sibling}`) },
          { multiaddr: multiaddr('/ip4/9.9.9.9/tcp/4001/ws') }
        ]
      })
    });
    (node as unknown as { resolvePeerAddrs: () => Promise<unknown[]> }).resolvePeerAddrs =
      async () => [];

    await node.reconcileControlCohort();

    expect(dialCalls).toHaveLength(1);
    expect((dialCalls[0] as Multiaddr[]).map(String)).toEqual([
      `/dns4/r.example.org/tcp/4001/p2p/${RELAY_ID}/p2p-circuit/p2p/${sibling}`,
      `/ip4/9.9.9.9/tcp/4001/ws/p2p/${sibling}`,
    ]);
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

  it('abandons a dial that never answers at controlCohort.dialTimeoutMs and dials the next sibling', async () => {
    // The offline-sibling shape, which is what the budget exists for: `dial()`
    // against an unroutable address never settles on its own, so without a
    // deadline of the pass's own the sequential loop is held for as long as the
    // addresses' libp2p attempt timeouts happen to take. The fake here settles
    // ONLY on abort, so a pass that resolves at all is proof the deadline's
    // signal reached `dial()` — and the second sibling is proof one dead peer
    // does not end the loop.
    const node = new CadreNode(createConfig({
      network: { controlCohort: { dialTimeoutMs: 50 } }
    }));
    const dialedPeers: string[] = [];
    const dialSignals: AbortSignal[] = [];
    (node as unknown as { _running: boolean })._running = true;
    (node as unknown as { controlNode: unknown }).controlNode = {
      peerId: { toString: () => 'self-peer' },
      getConnections: () => [],
      dial: (_addrs: unknown, options?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
        if (options?.signal) {
          dialSignals.push(options.signal);
          options.signal.addEventListener('abort', () => reject(new Error('dial aborted')));
        }
      }),
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
      async (id: string) => { dialedPeers.push(id); return [multiaddr('/ip4/1.2.3.4/tcp/4001')]; };

    await expect(node.reconcileControlCohort()).resolves.toBeUndefined();
    expect(dialedPeers.sort()).toEqual(['sibling-a', 'sibling-b']);
    // One deadline per sibling, and each one cancelled its dial rather than
    // leaking it — the whole point of `withDeadline` over a bare `withTimeout`.
    expect(dialSignals.map((s) => s.aborted)).toEqual([true, true]);
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

// ══════════════════════════════════════════════════════════════════════════════
// Address-book warming
//
// Each pass copies every sibling's VERIFIED addresses into the control node's
// libp2p peerStore, so the layers below cadre-core that dial by bare peer id
// (Optimystic's cluster/repo clients, FRET ping/announce) have an address for a
// sibling whose connection has dropped. The merge helper's own semantics — the
// expiry restamp, the empty-input skip, error folding — are covered by
// peer-addr-book.spec.ts; these cover WHICH siblings the pass feeds it.
//
// The peer ids here are real Ed25519 ids because the merge path parses them
// (`peerIdFromString`); the synthetic `sibling-1` ids the dial tests use would
// be dropped before any write.
// ══════════════════════════════════════════════════════════════════════════════

describe('CadreNode.reconcileControlCohort — inconsistently-suffixed sibling record', () => {
  /** A signed record for a fresh Ed25519 peer carrying exactly `addrs`. */
  async function signedSibling(addrs: (peerId: string) => string[]): Promise<{
    peerId: string;
    record: PeerAddressRecord;
  }> {
    const key = await generateKeyPair('Ed25519');
    const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(key);
    const peerId = peerIdFromPrivateKey(key).toString();
    const record = signPeerRecord(
      { peerId, publicKey: publicKeyB64, addrs: addrs(peerId), updatedAt: Date.now() },
      privateKeyB64
    );
    return { peerId, record };
  }

  it('dials a sibling whose record mixes a suffixed circuit addr with a bare direct one', async () => {
    // The exact record shape push-wake-e2e seeds, and the one that made every
    // reconcile pass skip this sibling: `libp2p.dial([suffixed, unsuffixed])`
    // throws InvalidParametersError before touching a transport.
    const { peerId, record } = await signedSibling((self) => [
      `/dns4/r.example.org/tcp/4001/p2p/${RELAY_ID}/p2p-circuit/p2p/${self}`,
      '/ip4/10.255.0.1/tcp/4001/ws',
    ]);

    const node = new CadreNode(createConfig());
    const { dialCalls } = injectCohort(node, {
      members: [{ peerId: 'self-peer', multiaddr: null }, { peerId, multiaddr: null }],
      records: new Map([[peerId, record]]),
    });

    await node.reconcileControlCohort();

    // dialed=1, not merely "the pass did not throw": the fake dial applies
    // libp2p's all-or-none peer-id precondition, so a mixed list records nothing.
    expect(dialCalls).toHaveLength(1);
    expect((dialCalls[0] as Multiaddr[]).map(String)).toEqual([
      `/dns4/r.example.org/tcp/4001/p2p/${RELAY_ID}/p2p-circuit/p2p/${peerId}`,
      `/ip4/10.255.0.1/tcp/4001/ws/p2p/${peerId}`,
    ]);
  });

  it('normalizes a relay hop whose destination is missing, keeping signaling first', async () => {
    // `…/p2p/<relay>/p2p-circuit` names the RELAY, not the sibling — the shape
    // `groupAddrsByPeerId` drops rather than misattribute. Resolution completes
    // it to the sibling instead of leaving a third handling of the same input.
    const { peerId, record } = await signedSibling(() => [
      '/ip4/9.9.9.9/tcp/4001/ws',
      `/dns4/r.example.org/tcp/4001/p2p/${RELAY_ID}/p2p-circuit`,
    ]);

    const node = new CadreNode(createConfig());
    const { dialCalls } = injectCohort(node, {
      members: [{ peerId: 'self-peer', multiaddr: null }, { peerId, multiaddr: null }],
      records: new Map([[peerId, record]]),
    });

    await node.reconcileControlCohort();

    expect(dialCalls).toHaveLength(1);
    expect((dialCalls[0] as Multiaddr[]).map(String)).toEqual([
      `/dns4/r.example.org/tcp/4001/p2p/${RELAY_ID}/p2p-circuit/p2p/${peerId}`,
      `/ip4/9.9.9.9/tcp/4001/ws/p2p/${peerId}`,
    ]);
  });

  it('collapses two record entries that normalization makes identical', async () => {
    // Suffixed and unsuffixed forms of the SAME address are distinct strings on
    // the record and the same address after normalization. A surviving duplicate
    // costs a real dial attempt — for `dialWake`, a whole slice of its budget.
    const { peerId, record } = await signedSibling((self) => [
      '/ip4/9.9.9.9/tcp/4001/ws',
      `/ip4/9.9.9.9/tcp/4001/ws/p2p/${self}`,
    ]);

    const node = new CadreNode(createConfig());
    const { dialCalls } = injectCohort(node, {
      members: [{ peerId: 'self-peer', multiaddr: null }, { peerId, multiaddr: null }],
      records: new Map([[peerId, record]]),
    });

    await node.reconcileControlCohort();

    expect(dialCalls).toHaveLength(1);
    expect((dialCalls[0] as Multiaddr[]).map(String)).toEqual([
      `/ip4/9.9.9.9/tcp/4001/ws/p2p/${peerId}`,
    ]);
  });

  it('drops an addr naming a different peer rather than poisoning the whole list', async () => {
    const other = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
    const { peerId, record } = await signedSibling(() => [
      '/ip4/9.9.9.9/tcp/4001/ws',
      `/ip4/8.8.8.8/tcp/4001/ws/p2p/${other}`,
    ]);

    const node = new CadreNode(createConfig());
    const { dialCalls } = injectCohort(node, {
      members: [{ peerId: 'self-peer', multiaddr: null }, { peerId, multiaddr: null }],
      records: new Map([[peerId, record]]),
    });

    await node.reconcileControlCohort();

    expect(dialCalls).toHaveLength(1);
    expect((dialCalls[0] as Multiaddr[]).map(String)).toEqual([
      `/ip4/9.9.9.9/tcp/4001/ws/p2p/${peerId}`,
    ]);
  });
});

describe('CadreNode.reconcileControlCohort — address-book warming', () => {
  it('merges every sibling, including already-connected ones and ones the dial cap dropped', async () => {
    // targetDegree 1 with three non-owner siblings, one of them connected: one
    // dial, but all three must reach the address book.
    const node = new CadreNode(createConfig({ network: { controlCohort: { targetDegree: 1 } } }));
    const [a, b, c] = [await realPeerId(), await realPeerId(), await realPeerId()];
    const connected = [a, b, c].sort()[0];
    const { dialCalls, mergeCalls } = injectCohort(node, {
      members: [
        { peerId: 'self-peer', multiaddr: null },
        { peerId: a, multiaddr: null },
        { peerId: b, multiaddr: null },
        { peerId: c, multiaddr: null }
      ],
      connections: [connected]
    });

    await node.reconcileControlCohort();

    expect(mergeCalls.map((m) => m.peerId).sort()).toEqual([a, b, c].sort());
    expect(mergeCalls.every((m) => m.addrs.includes('/ip4/1.2.3.4/tcp/4001'))).toBe(true);
    // The cap still bounds dialing: one selected sibling, and it is connected.
    expect(dialCalls).toEqual([]);
  });

  it('resolves each sibling exactly once per pass (the dial reuses the resolved addrs)', async () => {
    const node = new CadreNode(createConfig());
    const [a, b] = [await realPeerId(), await realPeerId()];
    const { dialCalls, resolvedFor } = injectCohort(node, {
      members: [
        { peerId: 'self-peer', multiaddr: null },
        { peerId: a, multiaddr: null },
        { peerId: b, multiaddr: null }
      ]
    });

    await node.reconcileControlCohort();

    // Two siblings, two resolutions — not four. Each `resolvePeerAddrs` is a
    // `queryPeerRecord` against the control DB, and both are dialed, so a dial
    // path that re-resolved would show up here as duplicates.
    expect(resolvedFor.sort()).toEqual([a, b].sort());
    expect(dialCalls).toHaveLength(2);
  });

  it('never merges a sibling whose record fails to resolve, even when the peerStore can still dial it', async () => {
    // Revoked / stale / untrusted: `resolvePeerAddrs` returns []. The cold-start
    // peerStore address is good enough to DIAL, but it came out of the address
    // book — echoing it back would restamp an unverified seed address forever,
    // and the entry must be allowed to age out on its own instead.
    const node = new CadreNode(createConfig());
    const sibling = await realPeerId();
    const { dialCalls, mergeCalls } = injectCohort(node, {
      members: [
        { peerId: 'self-peer', multiaddr: null },
        { peerId: sibling, multiaddr: null }
      ],
      peerStoreGet: async () => ({ addresses: [{ multiaddr: multiaddr('/ip4/9.9.9.9/tcp/4001') }] })
    });
    (node as unknown as { resolvePeerAddrs: () => Promise<unknown[]> }).resolvePeerAddrs =
      async () => [];

    await node.reconcileControlCohort();

    expect(mergeCalls).toEqual([]);
    expect(dialCalls).toHaveLength(1);
  });

  it('stops merging a sibling from the pass after the one that revoked it', async () => {
    // The single-pass case above proves the `[]` branch; this drives the actual
    // production sequence — warm, then revoke — so the entry provably stops being
    // refreshed and is left to age out rather than being restamped forever.
    const node = new CadreNode(createConfig());
    const sibling = await realPeerId();
    const { mergeCalls } = injectCohort(node, {
      members: [
        { peerId: 'self-peer', multiaddr: null },
        { peerId: sibling, multiaddr: null }
      ]
    });

    await node.reconcileControlCohort();
    expect(mergeCalls.map((m) => m.peerId)).toEqual([sibling]);

    (node as unknown as { resolvePeerAddrs: () => Promise<unknown[]> }).resolvePeerAddrs =
      async () => [];
    await node.reconcileControlCohort();

    expect(mergeCalls.map((m) => m.peerId)).toEqual([sibling]);
  });

  it('still dials its selected siblings when the address-book write rejects', async () => {
    // Best-effort by contract, like the reap sweep: reconnecting siblings
    // outranks keeping the address book warm.
    const node = new CadreNode(createConfig());
    const sibling = await realPeerId();
    const { dialCalls, resolvedFor } = injectCohort(node, {
      members: [
        { peerId: 'self-peer', multiaddr: null },
        { peerId: sibling, multiaddr: null }
      ],
      mergeThrows: true
    });

    await expect(node.reconcileControlCohort()).resolves.toBeUndefined();

    expect(resolvedFor).toEqual([sibling]);
    expect(dialCalls).toHaveLength(1);
  });

  it('abandons the warming loop mid-way when the node stops', async () => {
    const node = new CadreNode(createConfig());
    const [a, b] = [await realPeerId(), await realPeerId()];
    const { mergeCalls, dialCalls } = injectCohort(node, {
      members: [
        { peerId: 'self-peer', multiaddr: null },
        { peerId: a, multiaddr: null },
        { peerId: b, multiaddr: null }
      ]
    });
    // Stop the node during the first sibling's resolve. The write is guarded on
    // both sides of that await, so a torn-down node is never written to at all.
    const resolvedFor: string[] = [];
    (node as unknown as { resolvePeerAddrs: (id: string) => Promise<unknown[]> }).resolvePeerAddrs =
      async (id: string) => {
        resolvedFor.push(id);
        (node as unknown as { _running: boolean })._running = false;
        return [multiaddr('/ip4/1.2.3.4/tcp/4001')];
      };

    await node.reconcileControlCohort();

    expect(resolvedFor).toHaveLength(1);
    expect(mergeCalls).toEqual([]);
    expect(dialCalls).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Revoked-row reap sweep
//
// The pass drops guarded rows a committed Revocation tombstone retires, before
// the sibling enumeration and only while the node holds a control connection.
// The per-row delete and its authorization live in control-revocation-reap.spec.ts;
// these cover the scheduling decisions the sweep itself cannot express.
// ══════════════════════════════════════════════════════════════════════════════

describe('CadreNode.reconcileControlCohort — revoked-row reap sweep', () => {
  it('does NOT reap while alone (zero control connections)', async () => {
    // The gate, and the reason it is load-bearing: a reap is a write, and a write
    // committed alone is local-only and forks this node's own revision history —
    // the exact condition this line of work exists to stop creating. A regression
    // here is silent, so it gets its own test.
    const node = new CadreNode(createConfig());
    const { reapCalls } = injectCohort(node, {
      members: [
        { peerId: 'self-peer', multiaddr: null },
        { peerId: 'sibling-1', multiaddr: null }
      ],
      connections: []
    });

    await node.reconcileControlCohort();

    expect(reapCalls).toEqual([]);
  });

  it('reaps once per pass, naming this node\'s own control peer id', async () => {
    const node = new CadreNode(createConfig());
    const { reapCalls } = injectCohort(node, {
      selfPeerId: 'self-peer',
      members: [
        { peerId: 'self-peer', multiaddr: null },
        { peerId: 'sibling-1', multiaddr: null }
      ],
      connections: ['sibling-1']
    });

    await node.reconcileControlCohort();

    // The peer id is what the sweep's skip-self rule keys on — passing the wrong one
    // would silently reap this node's own row.
    expect(reapCalls).toEqual(['self-peer']);
  });

  it('runs even when the only sibling row is tombstoned (the cold-start early-return branch)', async () => {
    // listMembers() filters retired stamps, so a cadre whose one sibling has been
    // revoked reads as zero siblings and the pass early-returns into
    // dialColdStartBootstrap. Placed after the enumeration the reap would never run
    // for the smallest and most likely case — this pins the before-step-1 position.
    const node = new CadreNode(createConfig());
    const { reapCalls, dialCalls } = injectCohort(node, {
      members: [],
      connections: ['some-connected-peer']
    });

    await node.reconcileControlCohort();

    expect(reapCalls).toEqual(['self-peer']);
    expect(dialCalls).toEqual([]);
  });

  it('a throwing reap does not abort the pass — enumeration and dial still run', async () => {
    // Best-effort by contract: reconnecting siblings outranks garbage collection.
    const node = new CadreNode(createConfig());
    const { reapCalls, dialCalls, resolvedFor } = injectCohort(node, {
      members: [
        { peerId: 'self-peer', multiaddr: null },
        { peerId: 'sibling-1', multiaddr: null }
      ],
      connections: ['some-other-peer'],
      reapThrows: true
    });

    await expect(node.reconcileControlCohort()).resolves.toBeUndefined();

    expect(reapCalls).toEqual(['self-peer']);
    expect(resolvedFor).toEqual(['sibling-1']);
    expect(dialCalls).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Cold-start bootstrap retry
//
// The branch reconcileControlCohort takes when the CadrePeer table holds no
// siblings: re-dial the owner peers of the seeds this node applied. The
// end-to-end proof is control-cohort-cold-start-retry.integration.ts; these
// cover the pieces that scenario cannot isolate (skip-connected, peer-id
// binding, mid-loop shutdown, what a seed does and does not retain).
// ══════════════════════════════════════════════════════════════════════════════

/** A real Ed25519 peer id — the dial path binds addresses to it, so it must parse. */
async function realPeerId(): Promise<string> {
  return peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
}

function seedWith(peers: SeedPeer[]): ControlNetworkSeed {
  return { partyId: 'p', peers, signature: '', signerKey: '' };
}

/** Feed a seed through the retention step both intake paths share. */
function recordSeed(node: CadreNode, seed: ControlNetworkSeed): void {
  (node as unknown as { recordSeedBootstrapPeers(s: ControlNetworkSeed): void })
    .recordSeedBootstrapPeers(seed);
}

function bootstrapPeers(node: CadreNode): ReadonlyMap<string, BootstrapPeerEntry> {
  return (node as unknown as { bootstrapPeerStore: BootstrapPeerStore }).bootstrapPeerStore.all();
}

/** Flatten the multiaddrs handed to the fake control node's dial() into strings. */
function dialedAddrs(dialCalls: Array<unknown>): string[] {
  return dialCalls.flatMap((call) => (call as Array<{ toString(): string }>).map((a) => a.toString()));
}

describe('CadreNode.reconcileControlCohort — cold-start bootstrap branch', () => {
  it('dials a retained bootstrap peer when the control DB has no siblings', async () => {
    const node = new CadreNode(createConfig());
    const owner = await realPeerId();
    const addr = `/ip4/1.2.3.4/tcp/4001/ws/p2p/${owner}`;
    const { dialCalls } = injectCohort(node, { members: [] });
    recordSeed(node, seedWith([{ peerId: owner, multiaddrs: [addr], isOwner: true }]));

    await node.reconcileControlCohort();

    expect(dialedAddrs(dialCalls)).toEqual([addr]);
  });

  it('skips a bootstrap peer that is already connected', async () => {
    const node = new CadreNode(createConfig());
    const owner = await realPeerId();
    const { dialCalls } = injectCohort(node, { members: [], connections: [owner] });
    recordSeed(node, seedWith([
      { peerId: owner, multiaddrs: [`/ip4/1.2.3.4/tcp/4001/ws/p2p/${owner}`], isOwner: true }
    ]));

    await node.reconcileControlCohort();

    expect(dialCalls).toEqual([]);
  });

  it('leaves bootstrap peers alone once the table has a sibling to dial', async () => {
    const node = new CadreNode(createConfig());
    const owner = await realPeerId();
    const bootstrapAddr = `/ip4/1.2.3.4/tcp/4001/ws/p2p/${owner}`;
    const { dialCalls } = injectCohort(node, {
      members: [{ peerId: 'self-peer', multiaddr: null }, { peerId: 'sibling-1', multiaddr: null }]
    });
    recordSeed(node, seedWith([{ peerId: owner, multiaddrs: [bootstrapAddr], isOwner: true }]));

    await node.reconcileControlCohort();

    // The stubbed resolver's sibling address, and nothing from the seed.
    expect(dialedAddrs(dialCalls)).toEqual(['/ip4/1.2.3.4/tcp/4001']);
  });

  it('binds a bootstrap address that names no peer to the peer it was retained under', async () => {
    // A record published through `addressOverrides` can lack the /p2p/ suffix;
    // dialing it bare would accept whoever answers.
    const node = new CadreNode(createConfig());
    const owner = await realPeerId();
    const { dialCalls } = injectCohort(node, { members: [] });
    recordSeed(node, seedWith([
      { peerId: owner, multiaddrs: ['/ip4/1.2.3.4/tcp/4001/ws'], isOwner: true }
    ]));

    await node.reconcileControlCohort();

    expect(dialedAddrs(dialCalls)).toEqual([`/ip4/1.2.3.4/tcp/4001/ws/p2p/${owner}`]);
  });

  it('completes a bootstrap relay hop whose destination is missing', async () => {
    // `…/p2p/<relay>/p2p-circuit` terminates in the RELAY's id, not the owner's.
    // Binding by "does the LAST component name a peer" — libp2p's own rule —
    // completes the circuit to the owner; the older "does any /p2p/ match" rule
    // read the relay's id as a mismatch and dropped the only way in.
    const node = new CadreNode(createConfig());
    const owner = await realPeerId();
    const { dialCalls } = injectCohort(node, { members: [] });
    recordSeed(node, seedWith([
      { peerId: owner, multiaddrs: [`/dns4/r.example.org/tcp/4001/p2p/${RELAY_ID}/p2p-circuit`], isOwner: true }
    ]));

    await node.reconcileControlCohort();

    expect(dialedAddrs(dialCalls)).toEqual([
      `/dns4/r.example.org/tcp/4001/p2p/${RELAY_ID}/p2p-circuit/p2p/${owner}`
    ]);
  });

  it('drops a bootstrap address that names a different peer, and skips the dial', async () => {
    const node = new CadreNode(createConfig());
    const [owner, other] = [await realPeerId(), await realPeerId()];
    const { dialCalls } = injectCohort(node, { members: [] });
    recordSeed(node, seedWith([
      { peerId: owner, multiaddrs: [`/ip4/1.2.3.4/tcp/4001/ws/p2p/${other}`], isOwner: true }
    ]));

    await node.reconcileControlCohort();

    expect(dialCalls).toEqual([]);
  });

  it('continues to the next bootstrap peer after a dial throws', async () => {
    const node = new CadreNode(createConfig());
    const [first, second] = [await realPeerId(), await realPeerId()];
    injectCohort(node, { members: [] });
    const attempted: string[] = [];
    (node as unknown as { controlNode: { dial(a: unknown): Promise<void> } }).controlNode.dial =
      async (addrs: unknown) => {
        attempted.push((addrs as Array<{ toString(): string }>)[0].toString());
        throw new Error('dial boom');
      };
    recordSeed(node, seedWith([
      { peerId: first, multiaddrs: [`/ip4/1.1.1.1/tcp/1/ws/p2p/${first}`], isOwner: true },
      { peerId: second, multiaddrs: [`/ip4/2.2.2.2/tcp/2/ws/p2p/${second}`], isOwner: true }
    ]));

    await expect(node.reconcileControlCohort()).resolves.toBeUndefined();
    expect(attempted).toHaveLength(2);
  });

  it('abandons the pass mid-loop when the node stops', async () => {
    const node = new CadreNode(createConfig());
    const [first, second] = [await realPeerId(), await realPeerId()];
    injectCohort(node, { members: [] });
    const attempted: string[] = [];
    (node as unknown as { controlNode: { dial(a: unknown): Promise<void> } }).controlNode.dial =
      async (addrs: unknown) => {
        attempted.push((addrs as Array<{ toString(): string }>)[0].toString());
        (node as unknown as { _running: boolean })._running = false;
      };
    recordSeed(node, seedWith([
      { peerId: first, multiaddrs: [`/ip4/1.1.1.1/tcp/1/ws/p2p/${first}`], isOwner: true },
      { peerId: second, multiaddrs: [`/ip4/2.2.2.2/tcp/2/ws/p2p/${second}`], isOwner: true }
    ]));

    await node.reconcileControlCohort();

    expect(attempted).toHaveLength(1);
  });

  it('a restarted node re-dials the seed it applied in a previous process', async () => {
    // The regression this store exists for. Nothing else on disk records that a
    // seed was applied (applySeed writes no control row; CadrePeer fills in only
    // after a connection succeeds), so an in-memory-only retry set stranded a
    // seeded-but-unconnected node permanently across a restart. A shared
    // BootstrapPeerStore instance stands in for the file surviving the process.
    const owner = await realPeerId();
    const addr = `/ip4/1.2.3.4/tcp/4001/ws/p2p/${owner}`;
    const shared = new MemoryBootstrapPeerStore('p');

    const first = new CadreNode(createConfig());
    injectCohort(first, { members: [], bootstrapStore: shared });
    recordSeed(first, seedWith([{ peerId: owner, multiaddrs: [addr], isOwner: true }]));

    // A fresh node — no second seed — hydrating the same store.
    const restarted = new CadreNode(createConfig());
    const { dialCalls } = injectCohort(restarted, { members: [], bootstrapStore: shared });

    await restarted.reconcileControlCohort();

    expect(dialedAddrs(dialCalls)).toEqual([addr]);
  });
});

describe('CadreNode seed bootstrap-peer retention', () => {
  it('retains only owner peers that carry an address', async () => {
    const node = new CadreNode(createConfig());
    const [owner, plain, addressless] = [await realPeerId(), await realPeerId(), await realPeerId()];
    injectCohort(node, { members: [] });
    recordSeed(node, seedWith([
      { peerId: owner, multiaddrs: [`/ip4/1.1.1.1/tcp/1/ws/p2p/${owner}`], isOwner: true },
      { peerId: plain, multiaddrs: [`/ip4/2.2.2.2/tcp/2/ws/p2p/${plain}`], isOwner: false },
      { peerId: addressless, multiaddrs: [], isOwner: true }
    ]));

    expect([...bootstrapPeers(node).keys()]).toEqual([owner]);
  });

  it('never retains self (createSeed projects every row, including this node)', async () => {
    const node = new CadreNode(createConfig());
    const self = await realPeerId();
    injectCohort(node, { members: [], selfPeerId: self });
    recordSeed(node, seedWith([
      { peerId: self, multiaddrs: [`/ip4/1.1.1.1/tcp/1/ws/p2p/${self}`], isOwner: true }
    ]));

    expect(bootstrapPeers(node).size).toBe(0);
  });

  it('replaces a peer\'s addresses on re-seed rather than accumulating stale ones', async () => {
    const node = new CadreNode(createConfig());
    const owner = await realPeerId();
    injectCohort(node, { members: [] });
    recordSeed(node, seedWith([
      { peerId: owner, multiaddrs: [`/ip4/1.1.1.1/tcp/1/ws/p2p/${owner}`], isOwner: true }
    ]));
    recordSeed(node, seedWith([
      { peerId: owner, multiaddrs: [`/ip4/9.9.9.9/tcp/9/ws/p2p/${owner}`], isOwner: true }
    ]));

    expect(bootstrapPeers(node).get(owner)?.addrs).toEqual([`/ip4/9.9.9.9/tcp/9/ws/p2p/${owner}`]);
  });

  it('retains from the inbound /sereus/seed/1.0.0 path too (onSeedApplied)', async () => {
    // A wire-delivered seed is applied INSIDE SeedBootstrapService, below the
    // CadreNode.applySeed wrapper, so the callback is its only retention seam.
    const node = new CadreNode(createConfig());
    const owner = await realPeerId();
    injectCohort(node, { members: [] });
    const seed = seedWith([
      { peerId: owner, multiaddrs: [`/ip4/1.1.1.1/tcp/1/ws/p2p/${owner}`], isOwner: true }
    ]);

    (node as unknown as {
      seedEventCallbacks(): {
        onSeedApplied?: (partyId: string, peersAdded: number, seed: ControlNetworkSeed) => void;
      };
    }).seedEventCallbacks().onSeedApplied?.('p', 1, seed);

    expect([...bootstrapPeers(node).keys()]).toEqual([owner]);
  });
});
