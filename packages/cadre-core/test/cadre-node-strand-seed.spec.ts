import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { Libp2p } from '@libp2p/interface';
import { CadreNode } from '../src/cadre-node.js';
import type { CadreNodeConfig } from '../src/types.js';
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
    dialProtocol: async (target: unknown) => {
      const id = (target as { toString(): string }).toString();
      opts.dialed.push(id);
      const reply = opts.replies.get(id);
      if (reply === undefined) {
        throw new Error(`no route for ${id}`);
      }
      const receiver = new StrandAddrService({
        isMember: async () => true,
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

function resolveSeed(node: CadreNode, strandId: string): Promise<string[]> {
  return (node as unknown as { resolveCohortSeed(id: string): Promise<string[]> }).resolveCohortSeed(strandId);
}

/**
 * Record a formation's cross-party strand addrs on `node`, exactly as a successful
 * `formStrand` does. Driving the real private recorder (rather than writing the map
 * directly) keeps these tests honest about the empty-list and merge rules it enforces.
 */
function recordCrossParty(node: CadreNode, strandId: string, addrs: string[]): void {
  (node as unknown as {
    recordCrossPartyStrandAddrs(id: string, addrs: readonly string[]): void;
  }).recordCrossPartyStrandAddrs(strandId, addrs);
}

/** The private cross-party contact map, for asserting what a formation recorded. */
function contactMap(node: CadreNode): Map<string, string[]> {
  return (node as unknown as { crossPartyStrandAddrs: Map<string, string[]> }).crossPartyStrandAddrs;
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

// ── Cross-party seed: the addrs a formation carried back ──────────────────────

describe('CadreNode cross-party strand addrs in the cohort seed', () => {
  const CROSS_A = '/ip4/203.0.113.7/tcp/4001/ws/p2p/12D3KooWDpJ7As7BWAwRMfu1VU2WCqNjvq387JEYKDBj4kx6nXTN';
  const CROSS_B = '/ip4/203.0.113.8/tcp/4002/ws/p2p/12D3KooWDpJ7As7BWAwRMfu1VU2WCqNjvq387JEYKDBj4kx6nXTN';

  it('seeds a strand from the formation addrs alone when no sibling can answer', async () => {
    // The two-party case the whole feature exists for: the joiner has no cohort sibling
    // running this strand, so the strand-addr RPC yields nothing and the formation addrs
    // are the ONLY seed there is.
    const self = await freshPeerId();
    const node = new CadreNode(createConfig());
    injectSeed(node, {
      selfPeerId: self,
      members: [{ peerId: self, multiaddr: null }],
      connections: []
    });
    recordCrossParty(node, 'strand-x', [CROSS_A]);

    await expect(resolveSeed(node, 'strand-x')).resolves.toEqual([CROSS_A]);
  });

  it('seeds from the formation addrs even before the control DB and node exist', async () => {
    // `addStrand` can run before the control plane is up; the sibling half returns []
    // there, and the cross-party half must not be lost with it.
    const node = new CadreNode(createConfig());
    recordCrossParty(node, 'strand-x', [CROSS_A]);

    await expect(resolveSeed(node, 'strand-x')).resolves.toEqual([CROSS_A]);
  });

  it('appends formation addrs AFTER sibling answers and de-dupes against them', async () => {
    const [self, sib] = await Promise.all([freshPeerId(), freshPeerId()]);
    const siblingAddr = '/ip4/10.0.0.1/tcp/5/p2p/strand';
    const node = new CadreNode(createConfig());
    injectSeed(node, {
      selfPeerId: self,
      members: [{ peerId: self, multiaddr: null }, { peerId: sib, multiaddr: null }],
      connections: [sib],
      replies: new Map([[sib, [siblingAddr, CROSS_A]]])
    });
    recordCrossParty(node, 'strand-x', [CROSS_A, CROSS_B]);

    // Sibling answers lead (they were resolved just now); the formation addr the
    // sibling already named is not repeated.
    await expect(resolveSeed(node, 'strand-x')).resolves.toEqual([siblingAddr, CROSS_A, CROSS_B]);
  });

  it('scopes formation addrs to their own strand', async () => {
    const self = await freshPeerId();
    const node = new CadreNode(createConfig());
    injectSeed(node, {
      selfPeerId: self,
      members: [{ peerId: self, multiaddr: null }],
      connections: []
    });
    recordCrossParty(node, 'strand-x', [CROSS_A]);

    await expect(resolveSeed(node, 'strand-other')).resolves.toEqual([]);
  });

  it('records nothing for an empty disclosure, so a later one is not shadowed', async () => {
    const node = new CadreNode(createConfig());
    recordCrossParty(node, 'strand-x', []);
    expect(contactMap(node).has('strand-x')).toBe(false);

    recordCrossParty(node, 'strand-x', [CROSS_A]);
    recordCrossParty(node, 'strand-x', []);
    expect(contactMap(node).get('strand-x')).toEqual([CROSS_A]);
  });

  it('merges a second formation against the same strand, newest first', async () => {
    // Two redemptions of the same host strand (a re-invite after a relay rotation): the
    // fresher disclosure leads, the older entry stays as a fallback.
    const node = new CadreNode(createConfig());
    recordCrossParty(node, 'strand-x', [CROSS_A]);
    recordCrossParty(node, 'strand-x', [CROSS_B, CROSS_A]);
    expect(contactMap(node).get('strand-x')).toEqual([CROSS_B, CROSS_A]);
  });
});
