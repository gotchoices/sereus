import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { Libp2p } from '@libp2p/interface';
import { CadreNode } from '../src/cadre-node.js';
import type { CadreNodeConfig } from '../src/types.js';
import { multiaddr } from '@multiformats/multiaddr';
import { groupAddrsByPeerId } from '../src/peer-addr-book.js';
import { StrandAddrService } from '../src/strand-addr-protocol.js';
import { duplexPair } from './wake-stream-helpers.js';

/**
 * Unit coverage for `CadreNode.resolveCohortSeed(strandId)`: the seed-derivation
 * path that resolves a strand's bootstrap addresses on demand from CONNECTED
 * co-cadre siblings via the strand-addr RPC, rather than (wrongly) reusing each
 * sibling's *control*-network address from its CadrePeer row. The pure membership
 * split is covered in strand-cohort.spec.ts and the RPC union in
 * strand-addr-protocol.spec.ts; here we stub the control node / DB and assert
 * which siblings are RPC'd and how their answers become the seed.
 */

function createConfig(): CadreNodeConfig {
  return {
    controlNetwork: {
      partyId: 'seed-test-' + Math.random().toString(36).slice(2),
      bootstrapNodes: []
    },
    profile: 'transaction'
  };
}

/** A valid Ed25519 libp2p peer id string (so `peerIdFromString` round-trips in collectStrandAddrs). */
async function freshPeerId(): Promise<string> {
  return peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
}

/** Invoke a receiver service's private read→decide→respond stream handler. */
function runHandleStream(service: StrandAddrService, stream: unknown, remotePeerId: string): Promise<void> {
  return (service as unknown as { handleStream(s: unknown, p: string): Promise<void> }).handleStream(stream, remotePeerId);
}

interface ControlFakeOpts {
  selfPeerId: string;
  connections: string[];
  /** peerId → strand addrs that sibling answers with; absent = no route (dial throws). */
  replies: Map<string, string[]>;
  /** Records every peerId actually dialed for a strand addr. */
  dialed: string[];
}

/**
 * Control-node fake exposing only what resolveCohortSeed reads: `peerId`,
 * `getConnections()` (for the connected filter), and `dialProtocol()` routed to a
 * per-sibling loopback `StrandAddrService` receiver (mirrors the protocol spec).
 */
function fakeControlNode(opts: ControlFakeOpts): Libp2p {
  return {
    peerId: { toString: () => opts.selfPeerId },
    getConnections: () => opts.connections.map((id) => ({ remotePeer: { toString: () => id } })),
    // Read by `circuitRelayTargets` when a delegate peer id is announced (no relays here).
    getMultiaddrs: () => [],
    dialProtocol: async (target: unknown) => {
      const id = (target as { toString(): string }).toString();
      opts.dialed.push(id);
      const reply = opts.replies.get(id);
      if (reply === undefined) {
        throw new Error(`no route for ${id}`);
      }
      const receiver = new StrandAddrService({
        getStrandMultiaddrs: () => reply
      });
      const { clientStream, serverStream } = duplexPair();
      void runHandleStream(receiver, serverStream, opts.selfPeerId);
      return clientStream;
    }
  } as unknown as Libp2p;
}

function injectSeed(
  node: CadreNode,
  opts: {
    selfPeerId: string;
    members: Array<{ peerId: string; multiaddr: string | null }>;
    connections: string[];
    replies?: Map<string, string[]>;
  }
): { dialed: string[] } {
  const dialed: string[] = [];
  (node as unknown as { controlNode: unknown }).controlNode = fakeControlNode({
    selfPeerId: opts.selfPeerId,
    connections: opts.connections,
    replies: opts.replies ?? new Map(),
    dialed
  });
  (node as unknown as { controlDatabase: unknown }).controlDatabase = {
    queryCadrePeers: async () => opts.members
  };
  return { dialed };
}

function resolveSeed(node: CadreNode, strandId: string, delegatePeerId?: string): Promise<string[]> {
  return (node as unknown as {
    resolveCohortSeed(id: string, delegatePeerId?: string): Promise<string[]>;
  }).resolveCohortSeed(strandId, delegatePeerId);
}

/**
 * Record a formation's carried strand addrs on `node`, exactly as a successful
 * `formStrand` does. Driving the real private recorder (rather than writing the map
 * directly) keeps these tests honest about the empty-list, attribution and replacement
 * rules it enforces.
 */
function recordFormation(node: CadreNode, strandId: string, addrs: string[]): Promise<void> {
  return (node as unknown as {
    recordFormationStrandAddrs(id: string, addrs: readonly string[]): Promise<void>;
  }).recordFormationStrandAddrs(strandId, addrs);
}

describe('CadreNode.resolveCohortSeed', () => {
  it('returns an empty seed when there is no control DB / node', async () => {
    const node = new CadreNode(createConfig());
    await expect(resolveSeed(node, 'strand-x')).resolves.toEqual([]);
  });

  it('returns an empty seed when alone (only self in membership)', async () => {
    const self = await freshPeerId();
    const node = new CadreNode(createConfig());
    const { dialed } = injectSeed(node, {
      selfPeerId: self,
      members: [{ peerId: self, multiaddr: null }],
      connections: []
    });

    await expect(resolveSeed(node, 'strand-x')).resolves.toEqual([]);
    expect(dialed).toEqual([]);
  });

  it('unions strand addrs from connected, running siblings (signaling-first) and ignores control addrs', async () => {
    const [self, sib1, sib2] = await Promise.all([freshPeerId(), freshPeerId(), freshPeerId()]);
    const node = new CadreNode(createConfig());
    injectSeed(node, {
      selfPeerId: self,
      members: [
        // CadrePeer rows carry CONTROL addrs — these must never reach the strand seed.
        { peerId: self, multiaddr: '/ip4/127.0.0.1/tcp/1/p2p/self-control' },
        { peerId: sib1, multiaddr: '/ip4/5.5.5.5/tcp/1/p2p/sib1-control' },
        { peerId: sib2, multiaddr: '/ip4/6.6.6.6/tcp/2/p2p/sib2-control' }
      ],
      connections: [sib1, sib2],
      replies: new Map([
        [sib1, ['/ip4/10.0.0.1/tcp/5/p2p/strand', '/ip4/9.9.9.9/tcp/9/p2p-circuit']],
        [sib2, ['/ip4/9.9.9.9/tcp/9/p2p-circuit', '/ip4/10.0.0.2/tcp/6/p2p/strand']]
      ])
    });

    const seed = await resolveSeed(node, 'strand-x');

    // Deduped union, /p2p-circuit signaling addr ordered first.
    expect(seed).toEqual([
      '/ip4/9.9.9.9/tcp/9/p2p-circuit',
      '/ip4/10.0.0.1/tcp/5/p2p/strand',
      '/ip4/10.0.0.2/tcp/6/p2p/strand'
    ]);
    // None of the control addrs leaked into the strand seed.
    expect(seed.some((a) => a.includes('control'))).toBe(false);
  });

  it('yields an empty seed when no connected sibling runs the strand, after asking each', async () => {
    const [self, sib] = await Promise.all([freshPeerId(), freshPeerId()]);
    const node = new CadreNode(createConfig());
    const { dialed } = injectSeed(node, {
      selfPeerId: self,
      members: [{ peerId: self, multiaddr: null }, { peerId: sib, multiaddr: null }],
      connections: [sib],
      replies: new Map([[sib, []]]) // connected, but not running the strand → empty answer
    });

    const seed = await resolveSeed(node, 'strand-x');

    expect(seed).toEqual([]);
    expect(dialed).toEqual([sib]); // the connected sibling WAS asked
  });

  it('does not RPC a member with no open control connection', async () => {
    const [self, sib] = await Promise.all([freshPeerId(), freshPeerId()]);
    const node = new CadreNode(createConfig());
    const { dialed } = injectSeed(node, {
      selfPeerId: self,
      members: [{ peerId: self, multiaddr: null }, { peerId: sib, multiaddr: null }],
      connections: [], // sib is a member but not connected on the control network
      replies: new Map([[sib, ['/ip4/10.0.0.1/tcp/5/p2p/strand']]]) // would answer IF dialed
    });

    const seed = await resolveSeed(node, 'strand-x');

    expect(seed).toEqual([]); // not dialed because not connected
    expect(dialed).toEqual([]);
  });

  it('never RPCs self even if self holds a (self-)connection', async () => {
    const [self, sib] = await Promise.all([freshPeerId(), freshPeerId()]);
    const node = new CadreNode(createConfig());
    const { dialed } = injectSeed(node, {
      selfPeerId: self,
      members: [{ peerId: self, multiaddr: null }, { peerId: sib, multiaddr: null }],
      connections: [self, sib],
      replies: new Map([[sib, ['/ip4/10.0.0.1/tcp/5/p2p/strand']]])
    });

    const seed = await resolveSeed(node, 'strand-x');

    expect(seed).toEqual(['/ip4/10.0.0.1/tcp/5/p2p/strand']);
    // collectStrandAddrs filters self out of the candidate set before dialing.
    expect(dialed).toEqual([sib]);
    expect(dialed).not.toContain(self);
  });

  it('tolerates a sibling whose dial throws and still seeds from the rest', async () => {
    const [self, sib1, sib2] = await Promise.all([freshPeerId(), freshPeerId(), freshPeerId()]);
    const node = new CadreNode(createConfig());
    injectSeed(node, {
      selfPeerId: self,
      members: [
        { peerId: self, multiaddr: null },
        { peerId: sib1, multiaddr: null },
        { peerId: sib2, multiaddr: null }
      ],
      connections: [sib1, sib2],
      // sib1 has no route (dial throws); sib2 answers.
      replies: new Map([[sib2, ['/ip4/2.2.2.2/tcp/2/p2p/strand']]])
    });

    const seed = await resolveSeed(node, 'strand-x');

    expect(seed).toEqual(['/ip4/2.2.2.2/tcp/2/p2p/strand']);
  });
});

// ── Cross-party seed: the addresses a formation carried ───────────────────────

describe('CadreNode formation-carried addresses in the cohort seed', () => {
  it('seeds a strand from the addresses its formation carried, grouped by the peer each names', async () => {
    // The joiner's first attach: no cohort sibling runs a strand another party founded,
    // so the strand-addr RPC yields nothing and the responder's carried addresses are the
    // only seed there is — before the control DB and node exist, too (`addStrand` can run
    // before the control plane is up).
    const [peerA, peerB] = await Promise.all([freshPeerId(), freshPeerId()]);
    const a1 = `/ip4/203.0.113.7/tcp/4001/ws/p2p/${peerA}`;
    const a2 = `/ip4/203.0.113.7/tcp/4002/ws/p2p/${peerA}`;
    const b1 = `/ip4/203.0.113.8/tcp/4001/ws/p2p/${peerB}`;
    const node = new CadreNode(createConfig());

    // The last entry names no destination peer, so nothing could attribute it.
    await recordFormation(node, 'strand-x', [a1, b1, a2, '/ip4/203.0.113.9/tcp/1/ws']);

    await expect(resolveSeed(node, 'strand-x')).resolves.toEqual([a1, a2, b1]);
  });

  it('appends formation addrs AFTER sibling answers and de-dupes against them', async () => {
    const [self, sib, cross] = await Promise.all([freshPeerId(), freshPeerId(), freshPeerId()]);
    const siblingAddr = '/ip4/10.0.0.1/tcp/5/p2p/strand';
    const crossA = `/ip4/203.0.113.7/tcp/4001/ws/p2p/${cross}`;
    const crossB = `/ip4/203.0.113.8/tcp/4002/ws/p2p/${cross}`;
    const node = new CadreNode(createConfig());
    injectSeed(node, {
      selfPeerId: self,
      members: [{ peerId: self, multiaddr: null }, { peerId: sib, multiaddr: null }],
      connections: [sib],
      replies: new Map([[sib, [siblingAddr, crossA]]])
    });
    await recordFormation(node, 'strand-x', [crossA, crossB]);

    // Sibling answers lead (they were resolved just now); the formation addr the sibling
    // already named is not repeated.
    await expect(resolveSeed(node, 'strand-x')).resolves.toEqual([siblingAddr, crossA, crossB]);
  });

  it('scopes formation addrs to their own strand', async () => {
    const [self, cross] = await Promise.all([freshPeerId(), freshPeerId()]);
    const node = new CadreNode(createConfig());
    injectSeed(node, {
      selfPeerId: self,
      members: [{ peerId: self, multiaddr: null }],
      connections: []
    });
    await recordFormation(node, 'strand-x', [`/ip4/203.0.113.7/tcp/4001/ws/p2p/${cross}`]);

    await expect(resolveSeed(node, 'strand-other')).resolves.toEqual([]);
  });

  it('records nothing for an empty disclosure, so it cannot wipe an earlier one', async () => {
    const cross = await freshPeerId();
    const crossAddr = `/ip4/203.0.113.7/tcp/4001/ws/p2p/${cross}`;
    const node = new CadreNode(createConfig());
    await recordFormation(node, 'strand-x', []);
    await expect(resolveSeed(node, 'strand-x')).resolves.toEqual([]);

    await recordFormation(node, 'strand-x', [crossAddr]);
    await recordFormation(node, 'strand-x', []);
    // Nor can a disclosure naming no peer at all.
    await recordFormation(node, 'strand-x', ['/ip4/203.0.113.9/tcp/1/ws']);
    await expect(resolveSeed(node, 'strand-x')).resolves.toEqual([crossAddr]);
  });

  it("a re-formation replaces the strand's addresses rather than accumulating them", async () => {
    // Two redemptions of the same host strand (a re-invite after a relay rotation): the
    // responder disclosed its CURRENT addresses, so the older list is stale by
    // definition and is replaced, not kept as a fallback that would be re-dialed on
    // every launch for the node's lifetime.
    const [cross, other] = await Promise.all([freshPeerId(), freshPeerId()]);
    const stale = `/ip4/203.0.113.7/tcp/4001/ws/p2p/${cross}`;
    const staleOther = `/ip4/203.0.113.8/tcp/4001/ws/p2p/${other}`;
    const current = `/ip4/203.0.113.7/tcp/4100/ws/p2p/${cross}`;
    const node = new CadreNode(createConfig());
    await recordFormation(node, 'strand-x', [stale, staleOther]);
    await recordFormation(node, 'strand-x', [current]);

    // The whole list goes, the peer the second disclosure did not name included.
    await expect(resolveSeed(node, 'strand-x')).resolves.toEqual([current]);
  });
});

// ── What this node ANSWERS with: getStrandMultiaddrs ──────────────────────────

describe('CadreNode.getStrandMultiaddrs', () => {
  /** Drive the private answer path against a strand node announcing `announced`. */
  function answers(announced: string[], strandPeerId: string): string[] {
    const node = new CadreNode(createConfig());
    const instance = {
      strandId: 's1',
      status: 'active',
      libp2pNode: {
        peerId: { toString: () => strandPeerId },
        getMultiaddrs: () => announced.map((a) => multiaddr(a))
      }
    };
    (node as unknown as { strandManager: unknown }).strandManager = {
      getInstance: (id: string) => (id === 's1' ? instance : undefined)
    };
    return (node as unknown as { getStrandMultiaddrs(id: string): string[] }).getStrandMultiaddrs('s1');
  }

  it('returns [] for a strand with no live node', () => {
    const node = new CadreNode(createConfig());
    (node as unknown as { strandManager: unknown }).strandManager = { getInstance: () => undefined };
    expect((node as unknown as { getStrandMultiaddrs(id: string): string[] }).getStrandMultiaddrs('s1')).toEqual([]);
  });

  it('binds every announced addr to this strand node, so the receiver can attribute it', async () => {
    // Both consumers — the strand-addr RPC answer and the formation result's
    // `strandAddrs` — run the list through `groupAddrsByPeerId` on arrival, which DROPS
    // an entry naming no destination. libp2p normally appends the id itself; these are
    // the two shapes where it would not.
    const [self, relay] = await Promise.all([freshPeerId(), freshPeerId()]);
    const bare = '/ip4/10.0.0.1/tcp/4001/ws';
    const hop = `/ip4/9.9.9.9/tcp/4001/p2p/${relay}/p2p-circuit`;
    const already = `/ip4/10.0.0.2/tcp/4002/p2p/${self}`;

    const out = answers([bare, hop, already], self);

    // Signaling (circuit) first, then the direct addrs in their announced order.
    expect(out).toEqual([`${hop}/p2p/${self}`, `${bare}/p2p/${self}`, already]);
    // ...and every entry survives attribution, filed under THIS node.
    expect([...groupAddrsByPeerId(out).keys()]).toEqual([self]);
  });

  it('drops an announced addr that terminates in a DIFFERENT peer id', async () => {
    // It does not reach this node, and announcing it would file our address under
    // someone else's id in the receiver's address book.
    const [self, other] = await Promise.all([freshPeerId(), freshPeerId()]);
    const mine = `/ip4/10.0.0.1/tcp/4001/p2p/${self}`;
    expect(answers([mine, `/ip4/10.0.0.9/tcp/4001/p2p/${other}`], self)).toEqual([mine]);
  });
});
