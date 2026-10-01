import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import type { Libp2p, PeerId } from '@libp2p/interface';
import { CadreNode, STRAND_PEER_ADDR_REFRESH_MS, STRAND_PEER_ADDR_RETRY_MS } from '../src/cadre-node.js';
import { MemoryBootstrapPeerStore } from '../src/bootstrap-peer-store.js';
import type { CadreNodeConfig, SAppConfig, StrandInstance, StrandRow } from '../src/types.js';
import { StrandAddrService } from '../src/strand-addr-protocol.js';
import { peerStrandKey } from '../src/delegate-admission.js';
import { duplexPair } from './wake-stream-helpers.js';
import { fretEntry, fretService, type FretEntryFake } from './fret-record-helpers.js';

/**
 * Unit coverage for the periodic strand address-book refresh
 * (`CadreNode.refreshStrandPeerAddrs`) and for the launch/resume seed merge that
 * shares its `mergeStrandPeerAddrs` helper.
 *
 * What the pass is for: a strand's bootstrap addresses used to be resolved once,
 * at launch/resume, and never again — so a sibling that restarted its strand node
 * or rotated its relay reservation stayed unreachable, and even the original
 * addresses fell off the peerStore's one-hour expiry. Everything under cadre-core
 * dials strand peers by bare peer id, so an empty strand address book is a failed
 * dial, not a slower one.
 *
 * The doubles here stub the control node / DB / strand manager exactly as
 * `cadre-node-strand-seed.spec.ts` does (the RPC union itself is covered in
 * `strand-addr-protocol.spec.ts`, the merge in `peer-addr-book.spec.ts`); what is
 * asserted here is WHICH siblings get RPC'd, WHEN each (sibling, strand) is due
 * again, and WHOSE address book the answers land in.
 */

function createConfig(): CadreNodeConfig {
  return {
    controlNetwork: {
      partyId: 'strand-addr-refresh-' + Math.random().toString(36).slice(2),
      bootstrapNodes: []
    },
    profile: 'transaction'
  };
}

/** A valid Ed25519 libp2p peer id string (so `peerIdFromString` round-trips downstream). */
async function freshPeerId(): Promise<string> {
  return peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
}

/** Invoke a receiver service's private read→decide→respond stream handler. */
function runHandleStream(service: StrandAddrService, stream: unknown, remotePeerId: string): Promise<void> {
  return (service as unknown as { handleStream(s: unknown, p: string): Promise<void> }).handleStream(stream, remotePeerId);
}

/** One strand-addr RPC that actually reached a sibling's receiver. */
interface AskRecord {
  peerId: string;
  strandId: string;
}

interface ControlFakeOpts {
  selfPeerId: string;
  /** Live control connections — read on every call, so a test can mutate it between passes. */
  connections: string[];
  /** peerId → strandId → the strand addrs that sibling answers with; peer absent = dial throws. */
  replies: Map<string, Record<string, string[]>>;
  /** Siblings whose receiver's own lookup throws after recording the ask, so they reply `unavailable`. */
  unavailable?: ReadonlySet<string>;
  /** Every (sibling, strand) pair whose receiver the request actually reached. */
  asked: AskRecord[];
  /** Called from inside a receiver, just before it answers — the "stopped mid-RPC" hook. */
  onAsk?(record: AskRecord): void;
}

/**
 * Control-node fake exposing only what the refresh pass reads: `peerId`,
 * `getConnections()`, and `dialProtocol()` routed to a per-sibling loopback
 * `StrandAddrService` receiver (mirrors the seed spec's harness).
 */
function fakeControlNode(opts: ControlFakeOpts): Libp2p {
  return {
    peerId: { toString: () => opts.selfPeerId },
    getConnections: () => opts.connections.map((id) => ({ remotePeer: { toString: () => id } })),
    // Read by `circuitRelayTargets` (no relays configured) and by the control
    // node's own address-book warming, both only on the full reconcile path.
    getMultiaddrs: () => [],
    dial: async () => {},
    peerStore: {
      get: async () => { throw new Error('peerStore miss'); },
      merge: async (_id: PeerId, data: { multiaddrs: Array<{ toString(): string }> }) => ({
        addresses: data.multiaddrs.map((multiaddr) => ({ multiaddr, isCertified: false })),
        protocols: [],
        metadata: new Map(),
        tags: new Map()
      })
    },
    dialProtocol: async (target: unknown) => {
      const id = (target as { toString(): string }).toString();
      const reply = opts.replies.get(id);
      if (reply === undefined) {
        throw new Error(`no route for ${id}`);
      }
      const receiver = new StrandAddrService({
        isMember: async () => true,
        getStrandMultiaddrs: (strandId: string) => {
          const record = { peerId: id, strandId };
          opts.asked.push(record);
          opts.onAsk?.(record);
          if (opts.unavailable?.has(id)) {
            throw new Error('control read failed');
          }
          return reply[strandId] ?? [];
        }
      });
      const { clientStream, serverStream } = duplexPair();
      void runHandleStream(receiver, serverStream, opts.selfPeerId);
      return clientStream;
    }
  } as unknown as Libp2p;
}

interface StrandNodeFake {
  node: Libp2p;
  /** Every `peerStore.merge` this strand node received. */
  merges: Array<{ peerId: string; addrs: string[] }>;
}

/**
 * Strand-node fake with just a peerId, a recording peerStore and — when `fretEntries`
 * is given — the FRET service whose table the pass reads. `merge` echoes the addresses
 * back as the stored (expiry-filtered) set, which is what makes `mergePeerAddrs` report
 * `'merged'` and skip its restamp `save`.
 */
function fakeStrandNode(
  peerId: string,
  opts: { mergeRejects?: boolean; peerIdThrows?: boolean; fretEntries?: FretEntryFake[] } = {}
): StrandNodeFake {
  const merges: Array<{ peerId: string; addrs: string[] }> = [];
  const node = {
    get peerId(): { toString(): string } {
      if (opts.peerIdThrows) {
        throw new Error('node torn down');
      }
      return { toString: () => peerId };
    },
    ...(opts.fretEntries && { services: fretService(opts.fretEntries) }),
    peerStore: {
      merge: async (id: PeerId, data: { multiaddrs: Array<{ toString(): string }> }) => {
        if (opts.mergeRejects) {
          throw new Error('datastore boom');
        }
        merges.push({ peerId: id.toString(), addrs: data.multiaddrs.map((ma) => ma.toString()) });
        return { addresses: data.multiaddrs.map((multiaddr) => ({ multiaddr, isCertified: false })) };
      }
    }
  } as unknown as Libp2p;
  return { node, merges };
}

/** A strand instance carrying only what the refresh pass reads off it. */
function strandInstance(strandId: string, libp2pNode?: Libp2p): StrandInstance {
  return { strandId, status: 'active', libp2pNode } as unknown as StrandInstance;
}

interface Harness {
  node: CadreNode;
  /** Mutable: live control connections, re-read on every pass. */
  connections: string[];
  /** Mutable: the tracked strand instances, re-read on every pass. */
  instances: Map<string, StrandInstance>;
  asked: AskRecord[];
}

function injectRefresh(opts: {
  selfPeerId: string;
  members: Array<{ peerId: string; multiaddr: string | null }>;
  connections: string[];
  replies?: Map<string, Record<string, string[]>>;
  unavailable?: ReadonlySet<string>;
  instances?: Map<string, StrandInstance>;
  onAsk?(record: AskRecord): void;
}): Harness {
  const node = new CadreNode(createConfig());
  const asked: AskRecord[] = [];
  const connections = [...opts.connections];
  const instances = opts.instances ?? new Map<string, StrandInstance>();
  const privates = node as unknown as Record<string, unknown>;
  privates._running = true;
  privates.controlNode = fakeControlNode({
    selfPeerId: opts.selfPeerId,
    connections,
    replies: opts.replies ?? new Map(),
    unavailable: opts.unavailable,
    asked,
    onAsk: opts.onAsk
  });
  privates.controlDatabase = {
    queryCadrePeers: async () => opts.members,
    // Only the full `reconcileControlCohort` path reads past `queryCadrePeers`;
    // the direct-call tests never reach these.
    queryRevokedStamps: async () => new Set<string>(),
    getOwnerKeys: async () => new Set<string>(),
    reapRevokedRows: async () => 0
  };
  privates.strandManager = {
    getInstances: () => instances,
    getInstance: (strandId: string) => instances.get(strandId)
  };
  return { node, connections, instances, asked };
}

function refresh(node: CadreNode, now: number): Promise<void> {
  return (node as unknown as { refreshStrandPeerAddrs(now: number): Promise<void> }).refreshStrandPeerAddrs(now);
}

/** The private per-(sibling, strand) due-time map, for asserting what a pass did (or did not) stamp. */
function askDueMap(node: CadreNode): Map<string, number> {
  return (node as unknown as { strandAddrAskDueAt: Map<string, number> }).strandAddrAskDueAt;
}

/**
 * Another party's strand peer as the strand node's FRET table holds it: a fresh key, its
 * signed record at one direct address, and that address as the pass merges it (bound to
 * the peer).
 */
async function crossPartyPeer(): Promise<{ peerId: string; entry: FretEntryFake; merged: string }> {
  const key = await generateKeyPair('Ed25519');
  const peerId = peerIdFromPrivateKey(key).toString();
  const addr = '/ip4/203.0.113.7/tcp/4001/ws';
  return { peerId, entry: await fretEntry(key, [addr]), merged: `${addr}/p2p/${peerId}` };
}

const T0 = 1_700_000_000_000;

describe('CadreNode.refreshStrandPeerAddrs', () => {
  it('merges each sibling\'s strand addresses into the strand node, keyed by the STRAND transport peer id', async () => {
    const [self, sib1, sib2, sib1Strand, sib2Strand, relay, ownStrand] = await Promise.all(
      Array.from({ length: 7 }, () => freshPeerId())
    );
    const sib1Addr = `/ip4/10.0.0.1/tcp/1/p2p/${sib1Strand}`;
    // Relayed: its FIRST /p2p/ names the relay, its LAST names the strand node.
    const sib2Addr = `/ip4/9.9.9.9/tcp/4001/p2p/${relay}/p2p-circuit/p2p/${sib2Strand}`;
    const strand = fakeStrandNode(ownStrand);
    const harness = injectRefresh({
      selfPeerId: self,
      members: [
        { peerId: self, multiaddr: null },
        { peerId: sib1, multiaddr: null },
        { peerId: sib2, multiaddr: null }
      ],
      connections: [sib1, sib2],
      replies: new Map([
        [sib1, { 's1': [sib1Addr] }],
        [sib2, { 's1': [sib2Addr] }]
      ]),
      instances: new Map([['s1', strandInstance('s1', strand.node)]])
    });

    await refresh(harness.node, T0);

    expect(harness.asked).toEqual([
      { peerId: sib1, strandId: 's1' },
      { peerId: sib2, strandId: 's1' }
    ]);
    // Keyed by each sibling's STRAND transport peer id — never its control one,
    // which names a different libp2p node entirely. Group order follows the RPC
    // union, which `collectStrandAddrs` puts signaling-first — so sib2's relayed
    // address leads even though sib1 was asked first.
    expect(strand.merges).toEqual([
      { peerId: sib2Strand, addrs: [sib2Addr] },
      { peerId: sib1Strand, addrs: [sib1Addr] }
    ]);
    expect(strand.merges.map((m) => m.peerId)).not.toContain(sib1);
    expect(strand.merges.map((m) => m.peerId)).not.toContain(sib2);
  });

  it('re-asks a sibling once its own interval has elapsed, and on the next tick after it reconnects', async () => {
    const [self, sib, sibStrand, ownStrand] = await Promise.all(
      Array.from({ length: 4 }, () => freshPeerId())
    );
    const addr = `/ip4/10.0.0.1/tcp/1/p2p/${sibStrand}`;
    const strand = fakeStrandNode(ownStrand);
    const harness = injectRefresh({
      selfPeerId: self,
      members: [{ peerId: self, multiaddr: null }, { peerId: sib, multiaddr: null }],
      connections: [sib],
      replies: new Map([[sib, { 's1': [addr] }]]),
      instances: new Map([['s1', strandInstance('s1', strand.node)]])
    });

    await refresh(harness.node, T0);
    expect(harness.asked).toHaveLength(1);
    expect(askDueMap(harness.node).get(peerStrandKey(sib, 's1'))).toBe(T0 + STRAND_PEER_ADDR_REFRESH_MS);

    // Immediately after, and one millisecond short of the interval: not due.
    await refresh(harness.node, T0);
    await refresh(harness.node, T0 + STRAND_PEER_ADDR_REFRESH_MS - 1);
    expect(harness.asked).toHaveLength(1);

    await refresh(harness.node, T0 + STRAND_PEER_ADDR_REFRESH_MS);
    expect(harness.asked).toHaveLength(2);
    expect(strand.merges).toHaveLength(2);

    // A pass without the sibling forgets its due time, so reconnecting — a phone
    // restart, a new relay reservation — gets it asked on the very next tick.
    const t1 = T0 + STRAND_PEER_ADDR_REFRESH_MS + 15_000;
    harness.connections.splice(0);
    await refresh(harness.node, t1);
    harness.connections.push(sib);
    await refresh(harness.node, t1 + 15_000);
    expect(harness.asked).toHaveLength(3);
  });

  it('asks a sibling that connects after a pass on the next tick', async () => {
    // gotchoices/sereus#21: a phone connecting after the party's always-on machines used
    // to wait out a stamp keyed by strand alone — set by the pass that asked the others,
    // or (1.7.0) by a pass that merged another party's addresses and asked nobody.
    const [self, sibA, sibB, aStrand, bStrand, ownStrand] = await Promise.all(
      Array.from({ length: 6 }, () => freshPeerId())
    );
    const members = [self, sibA, sibB].map((peerId) => ({ peerId, multiaddr: null }));
    const replies = new Map([
      [sibA, { 's1': [`/ip4/10.0.0.1/tcp/1/p2p/${aStrand}`] }],
      [sibB, { 's1': [`/ip4/10.0.0.2/tcp/1/p2p/${bStrand}`] }]
    ]);

    // After another sibling was asked: B is asked, A is not re-asked.
    const afterSibling = injectRefresh({
      selfPeerId: self,
      members,
      connections: [sibA],
      replies,
      instances: new Map([['s1', strandInstance('s1', fakeStrandNode(ownStrand).node)]])
    });
    await refresh(afterSibling.node, T0);
    afterSibling.connections.push(sibB);
    await refresh(afterSibling.node, T0 + 15_000);
    expect(afterSibling.asked).toEqual([
      { peerId: sibA, strandId: 's1' },
      { peerId: sibB, strandId: 's1' }
    ]);

    // After a pass that only re-merged FRET's address records — also the first tick
    // after a restart, before any control connection exists.
    const cross = await crossPartyPeer();
    const recordsStrand = fakeStrandNode(ownStrand, { fretEntries: [cross.entry] });
    const afterRecords = injectRefresh({
      selfPeerId: self,
      members,
      connections: [],
      replies,
      instances: new Map([['s1', strandInstance('s1', recordsStrand.node)]])
    });
    await refresh(afterRecords.node, T0);
    expect(recordsStrand.merges.map((m) => m.peerId)).toEqual([cross.peerId]);
    afterRecords.connections.push(sibB);
    await refresh(afterRecords.node, T0 + 15_000);
    expect(afterRecords.asked).toEqual([{ peerId: sibB, strandId: 's1' }]);
  });

  it('retries a sibling that could not answer within STRAND_PEER_ADDR_RETRY_MS, a healthy one only after the full interval', async () => {
    const [self, sick, healthy, healthyStrand, ownStrand] = await Promise.all(
      Array.from({ length: 5 }, () => freshPeerId())
    );
    const harness = injectRefresh({
      selfPeerId: self,
      members: [self, sick, healthy].map((peerId) => ({ peerId, multiaddr: null })),
      connections: [sick, healthy],
      replies: new Map([
        [sick, { 's1': [] }],
        [healthy, { 's1': [`/ip4/10.0.0.1/tcp/1/p2p/${healthyStrand}`] }]
      ]),
      unavailable: new Set([sick]),
      instances: new Map([['s1', strandInstance('s1', fakeStrandNode(ownStrand).node)]])
    });
    const askedOf = (peerId: string): number => harness.asked.filter((a) => a.peerId === peerId).length;

    await refresh(harness.node, T0);
    await refresh(harness.node, T0 + STRAND_PEER_ADDR_RETRY_MS - 1);
    expect([askedOf(sick), askedOf(healthy)]).toEqual([1, 1]);

    await refresh(harness.node, T0 + STRAND_PEER_ADDR_RETRY_MS);
    expect([askedOf(sick), askedOf(healthy)]).toEqual([2, 1]);

    await refresh(harness.node, T0 + STRAND_PEER_ADDR_REFRESH_MS);
    expect(askedOf(healthy)).toBe(2);
  });

  it('skips a hibernating strand and prunes its due times, so a resume refreshes at once', async () => {
    const [self, sib, sibStrand, ownStrand] = await Promise.all(
      Array.from({ length: 4 }, () => freshPeerId())
    );
    const addr = `/ip4/10.0.0.1/tcp/1/p2p/${sibStrand}`;
    const strand = fakeStrandNode(ownStrand);
    const harness = injectRefresh({
      selfPeerId: self,
      members: [{ peerId: self, multiaddr: null }, { peerId: sib, multiaddr: null }],
      connections: [sib],
      replies: new Map([[sib, { 's1': [addr] }]]),
      instances: new Map([['s1', strandInstance('s1', strand.node)]])
    });

    await refresh(harness.node, T0);
    expect(askDueMap(harness.node).has(peerStrandKey(sib, 's1'))).toBe(true);

    // Hibernated: the instance is still tracked, but it has no node to seed.
    harness.instances.set('s1', strandInstance('s1', undefined));
    await refresh(harness.node, T0 + 1);

    expect(harness.asked).toHaveLength(1);
    expect(askDueMap(harness.node).size).toBe(0);

    // Resumed within the refresh interval: asks immediately rather than
    // inheriting the due time its previous incarnation left.
    harness.instances.set('s1', strandInstance('s1', strand.node));
    await refresh(harness.node, T0 + 2);

    expect(harness.asked).toHaveLength(2);
  });

  it('writes nothing when the strand stops between the RPC and the merge', async () => {
    const [self, sib, sibStrand, ownStrand] = await Promise.all(
      Array.from({ length: 4 }, () => freshPeerId())
    );
    const strand = fakeStrandNode(ownStrand);
    const instances = new Map([['s1', strandInstance('s1', strand.node)]]);
    const harness = injectRefresh({
      selfPeerId: self,
      members: [{ peerId: self, multiaddr: null }, { peerId: sib, multiaddr: null }],
      connections: [sib],
      replies: new Map([[sib, { 's1': [`/ip4/10.0.0.1/tcp/1/p2p/${sibStrand}`] }]]),
      instances,
      // The strand stops while its RPC is in flight — a torn-down node's store
      // must never be written to.
      onAsk: () => instances.delete('s1')
    });

    await refresh(harness.node, T0);

    expect(harness.asked).toHaveLength(1);
    expect(strand.merges).toEqual([]);
  });

  it('completes the pass when one strand\'s RPC and another\'s address book both fail', async () => {
    const [self, sib, sibStrand, deadStrand, sickStrand, goodStrand] = await Promise.all(
      Array.from({ length: 6 }, () => freshPeerId())
    );
    const addr = `/ip4/10.0.0.1/tcp/1/p2p/${sibStrand}`;
    // `dead` throws before it can even build its RPC; `sick` RPCs fine but its
    // peerStore rejects; `good` must still come through refreshed.
    const dead = fakeStrandNode(deadStrand, { peerIdThrows: true });
    const sick = fakeStrandNode(sickStrand, { mergeRejects: true });
    const good = fakeStrandNode(goodStrand);
    const harness = injectRefresh({
      selfPeerId: self,
      members: [{ peerId: self, multiaddr: null }, { peerId: sib, multiaddr: null }],
      connections: [sib],
      replies: new Map([[sib, { 'dead': [addr], 'sick': [addr], 'good': [addr] }]]),
      instances: new Map([
        ['dead', strandInstance('dead', dead.node)],
        ['sick', strandInstance('sick', sick.node)],
        ['good', strandInstance('good', good.node)]
      ])
    });

    await expect(refresh(harness.node, T0)).resolves.toBeUndefined();

    expect(harness.asked.map((a) => a.strandId).sort()).toEqual(['good', 'sick']);
    expect(good.merges).toEqual([{ peerId: sibStrand, addrs: [addr] }]);
    expect(sick.merges).toEqual([]);
  });

  it('drops an unattributable address rather than writing it under a wrong peer', async () => {
    const [self, sib, sibStrand, ownStrand] = await Promise.all(
      Array.from({ length: 4 }, () => freshPeerId())
    );
    const good = `/ip4/10.0.0.1/tcp/1/p2p/${sibStrand}`;
    const strand = fakeStrandNode(ownStrand);
    const harness = injectRefresh({
      selfPeerId: self,
      members: [{ peerId: self, multiaddr: null }, { peerId: sib, multiaddr: null }],
      connections: [sib],
      // A sibling advertising a bare listen addr alongside a proper one.
      replies: new Map([[sib, { 's1': ['/ip4/10.0.0.1/tcp/2', good] }]]),
      instances: new Map([['s1', strandInstance('s1', strand.node)]])
    });

    await refresh(harness.node, T0);

    expect(strand.merges).toEqual([{ peerId: sibStrand, addrs: [good] }]);
  });

  it('never writes the strand node\'s own addresses into its own address book', async () => {
    const [self, sib, ownStrand] = await Promise.all(Array.from({ length: 3 }, () => freshPeerId()));
    const strand = fakeStrandNode(ownStrand);
    const harness = injectRefresh({
      selfPeerId: self,
      members: [{ peerId: self, multiaddr: null }, { peerId: sib, multiaddr: null }],
      connections: [sib],
      // A buggy sibling echoing OUR strand address back at us.
      replies: new Map([[sib, { 's1': [`/ip4/10.0.0.9/tcp/9/p2p/${ownStrand}`] }]]),
      instances: new Map([['s1', strandInstance('s1', strand.node)]])
    });

    await refresh(harness.node, T0);

    expect(strand.merges).toEqual([]);
  });

  it('does nothing at all once the node has stopped', async () => {
    const [self, sib, ownStrand] = await Promise.all(Array.from({ length: 3 }, () => freshPeerId()));
    const strand = fakeStrandNode(ownStrand);
    const harness = injectRefresh({
      selfPeerId: self,
      members: [{ peerId: self, multiaddr: null }, { peerId: sib, multiaddr: null }],
      connections: [sib],
      replies: new Map([[sib, { 's1': ['/ip4/10.0.0.1/tcp/1'] }]]),
      instances: new Map([['s1', strandInstance('s1', strand.node)]])
    });
    (harness.node as unknown as { _running: boolean })._running = false;

    await refresh(harness.node, T0);

    expect(harness.asked).toEqual([]);
    expect(askDueMap(harness.node).size).toBe(0);
  });

  it('runs as a step of the public reconcile pass, not only when called directly', async () => {
    const [self, sib, sibStrand, ownStrand] = await Promise.all(
      Array.from({ length: 4 }, () => freshPeerId())
    );
    const addr = `/ip4/10.0.0.1/tcp/1/p2p/${sibStrand}`;
    const strand = fakeStrandNode(ownStrand);
    const harness = injectRefresh({
      selfPeerId: self,
      members: [{ peerId: self, multiaddr: null }, { peerId: sib, multiaddr: null }],
      connections: [sib],
      replies: new Map([[sib, { 's1': [addr] }]]),
      instances: new Map([['s1', strandInstance('s1', strand.node)]])
    });
    // The rest of the pass needs a bootstrap store and a sibling address
    // resolver; neither is what this test asserts, it just has to get past them.
    const privates = harness.node as unknown as Record<string, unknown>;
    privates.bootstrapPeerStore = new MemoryBootstrapPeerStore('p');
    privates.resolvePeerAddrs = async () => [multiaddr('/ip4/1.2.3.4/tcp/4001')];

    await harness.node.reconcileControlCohort();

    // Proves the wiring — placement inside `runReconcileControlCohort` and the
    // guards around it — not merely the helper the other tests call directly.
    expect(harness.asked).toEqual([{ peerId: sib, strandId: 's1' }]);
    expect(strand.merges).toEqual([{ peerId: sibStrand, addrs: [addr] }]);
    expect(askDueMap(harness.node).get(peerStrandKey(sib, 's1'))).toBeTypeOf('number');
  });

  it('reads no CadrePeer row when the node holds no control connection', async () => {
    const [self, sib, ownStrand] = await Promise.all(Array.from({ length: 3 }, () => freshPeerId()));
    const strand = fakeStrandNode(ownStrand);
    let queries = 0;
    const harness = injectRefresh({
      selfPeerId: self,
      members: [{ peerId: self, multiaddr: null }, { peerId: sib, multiaddr: null }],
      connections: [],
      instances: new Map([['s1', strandInstance('s1', strand.node)]])
    });
    const db = (harness.node as unknown as { controlDatabase: { queryCadrePeers(): Promise<unknown> } }).controlDatabase;
    const inner = db.queryCadrePeers.bind(db);
    db.queryCadrePeers = async () => { queries++; return inner(); };

    // The pass runs on every 15 s tick to re-merge FRET's address records — the
    // unbounded membership read must not ride along when nobody could answer it.
    await refresh(harness.node, T0);
    await refresh(harness.node, T0 + 1);

    expect(queries).toBe(0);
    expect(harness.asked).toEqual([]);
  });

  // ── FRET's address records: re-merged on every pass, with or without a sibling ──

  it("keeps another party's addrs alive, re-merging FRET's records on every tick without stamping", async () => {
    // Nothing can RE-RESOLVE a cross-party address — the strand-addr RPC is
    // membership-gated and answers own-party callers only — and FRET hands a record to
    // the peerStore once, so this periodic re-merge is the only thing standing between
    // the other party's addresses and the peerStore's one-hour expiry. A two-party joiner
    // has no cohort sibling at all, which is exactly the case that must still merge.
    const [self, ownStrand] = await Promise.all([freshPeerId(), freshPeerId()]);
    const cross = await crossPartyPeer();
    const strand = fakeStrandNode(ownStrand, { fretEntries: [cross.entry] });
    const harness = injectRefresh({
      selfPeerId: self,
      members: [{ peerId: self, multiaddr: null }],
      connections: [],
      instances: new Map([['s1', strandInstance('s1', strand.node)]])
    });

    await refresh(harness.node, T0);

    expect(harness.asked).toEqual([]);
    expect(strand.merges).toEqual([{ peerId: cross.peerId, addrs: [cross.merged] }]);

    // A local merge costs no RPC, so the next tick merges again, and nothing is stamped
    // that could hold back a sibling connecting later.
    await refresh(harness.node, T0 + 15_000);
    expect(strand.merges).toHaveLength(2);
    expect(askDueMap(harness.node).size).toBe(0);
  });

  it("merges FRET's records alongside the sibling answers, each under its own peer", async () => {
    const [self, sib, sibStrand, ownStrand] = await Promise.all(
      Array.from({ length: 4 }, () => freshPeerId())
    );
    const sibAddr = `/ip4/10.0.0.1/tcp/1/p2p/${sibStrand}`;
    const cross = await crossPartyPeer();
    const strand = fakeStrandNode(ownStrand, { fretEntries: [cross.entry] });
    const harness = injectRefresh({
      selfPeerId: self,
      members: [{ peerId: self, multiaddr: null }, { peerId: sib, multiaddr: null }],
      connections: [sib],
      replies: new Map([[sib, { 's1': [sibAddr] }]]),
      instances: new Map([['s1', strandInstance('s1', strand.node)]])
    });

    await refresh(harness.node, T0);

    expect(harness.asked).toEqual([{ peerId: sib, strandId: 's1' }]);
    // Two peers, one from each source — the cross-party record is filed under the OTHER
    // party's strand transport id, never merged into the sibling's group.
    expect(strand.merges).toEqual([
      { peerId: sibStrand, addrs: [sibAddr] },
      { peerId: cross.peerId, addrs: [cross.merged] }
    ]);
  });

  it('honours a configured strandAddrRefreshMs override, never retrying a failed sibling later than it', async () => {
    const [self, sib, sick, ownStrand] = await Promise.all(Array.from({ length: 4 }, () => freshPeerId()));
    const strand = fakeStrandNode(ownStrand);
    const harness = injectRefresh({
      selfPeerId: self,
      members: [self, sib, sick].map((peerId) => ({ peerId, multiaddr: null })),
      connections: [sib, sick],
      replies: new Map([[sib, { 's1': [] }], [sick, { 's1': [] }]]),
      unavailable: new Set([sick]),
      instances: new Map([['s1', strandInstance('s1', strand.node)]])
    });
    (harness.node as unknown as { config: CadreNodeConfig }).config.network = {
      controlCohort: { strandAddrRefreshMs: 1000 }
    };

    await refresh(harness.node, T0);
    await refresh(harness.node, T0 + 999);
    expect(harness.asked).toHaveLength(2);

    await refresh(harness.node, T0 + 1000);
    expect(harness.asked.map((a) => a.peerId).sort()).toEqual([sib, sib, sick, sick].sort());
  });
});

/**
 * The other half of the same helper: the launch/resume seed is handed to the new
 * strand node as `bootstrapNodes`, which reaches the address book only through
 * `@libp2p/bootstrap` discovery. Both paths merge it directly as well, so a
 * sibling is dialable by bare peer id from the first moment.
 */
describe('CadreNode strand launch/resume seed merge', () => {
  it('merges the resolved cohort seed into the launched strand node, grouped by peer id', async () => {
    const [self, sib, sibStrand, ownStrand] = await Promise.all(
      Array.from({ length: 4 }, () => freshPeerId())
    );
    const addr = `/ip4/10.0.0.1/tcp/1/p2p/${sibStrand}`;
    const strand = fakeStrandNode(ownStrand);
    const harness = injectRefresh({
      selfPeerId: self,
      members: [{ peerId: self, multiaddr: null }, { peerId: sib, multiaddr: null }],
      connections: [sib],
      replies: new Map([[sib, { 's1': [addr] }]])
    });
    const privates = harness.node as unknown as Record<string, unknown>;
    let seeded: string[] = [];
    privates.strandManager = {
      getInstance: () => undefined,
      startStrand: async (config: { bootstrapNodes: string[] }) => {
        seeded = config.bootstrapNodes;
        return strandInstance('s1', strand.node);
      }
    };
    privates.hibernationManager = { trackStrand: () => {} };

    await (harness.node as unknown as {
      launchStrand(row: StrandRow, sApp: SAppConfig): Promise<StrandInstance>;
    }).launchStrand({ Id: 's1' } as StrandRow, {} as SAppConfig);

    expect(seeded).toEqual([addr]);
    expect(strand.merges).toEqual([{ peerId: sibStrand, addrs: [addr] }]);
  });

  it('merges the re-resolved seed into a resumed strand node', async () => {
    const [self, sib, sibStrand, relay, ownStrand] = await Promise.all(
      Array.from({ length: 5 }, () => freshPeerId())
    );
    const direct = `/ip4/10.0.0.1/tcp/1/p2p/${sibStrand}`;
    const relayed = `/ip4/9.9.9.9/tcp/4001/p2p/${relay}/p2p-circuit/p2p/${sibStrand}`;
    const strand = fakeStrandNode(ownStrand);
    const harness = injectRefresh({
      selfPeerId: self,
      members: [{ peerId: self, multiaddr: null }, { peerId: sib, multiaddr: null }],
      connections: [sib],
      replies: new Map([[sib, { 's1': [direct, relayed] }]])
    });
    (harness.node as unknown as Record<string, unknown>).strandManager = {
      getInstance: () => undefined,
      resumeStrand: async () => strandInstance('s1', strand.node)
    };

    await (harness.node as unknown as {
      resumeStrandRuntime(strandId: string): Promise<void>;
    }).resumeStrandRuntime('s1');

    // Both of the sibling's addresses land under its one strand peer id, with the
    // relay's peer id nowhere in sight.
    expect(strand.merges).toEqual([{ peerId: sibStrand, addrs: [relayed, direct] }]);
  });
});

/**
 * A re-formation is the recovery path for a dead cross-party address, and the seed it
 * feeds is read only at launch and resume — so a strand already running gets the freshly
 * carried addresses written into its address book by `formStrand` itself.
 */
describe('CadreNode re-formation of a running strand', () => {
  it('merges the carried addresses straight into the running strand node', async () => {
    const [self, cross, ownStrand] = await Promise.all(Array.from({ length: 3 }, () => freshPeerId()));
    const carried = `/ip4/203.0.113.7/tcp/4100/ws/p2p/${cross}`;
    const strand = fakeStrandNode(ownStrand);
    const harness = injectRefresh({
      selfPeerId: self,
      members: [{ peerId: self, multiaddr: null }],
      connections: [],
      instances: new Map([['s1', strandInstance('s1', strand.node)]])
    });

    await (harness.node as unknown as {
      recordFormationStrandAddrs(id: string, addrs: readonly string[]): Promise<void>;
    }).recordFormationStrandAddrs('s1', [carried]);

    expect(strand.merges).toEqual([{ peerId: cross, addrs: [carried] }]);
  });
});
