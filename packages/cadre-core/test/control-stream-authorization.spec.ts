import { describe, it, expect, vi } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { CadreNode } from '../src/cadre-node.js';
import type { ControlNetworkSeed } from '../src/types.js';
import {
  MEMBER, STRANGER, createConfig, makeOwner, vouchedRow, bareRow, inject, anchorWith, fakeDb,
  type Owner, type PeerRow
} from './membership-gate-helpers.js';

/**
 * Unit coverage for the fail-closed per-stream control-DB gate:
 * `CadreNode.authorizeInboundControlStream` (the SYNCHRONOUS predicate wired as
 * `authorizeInboundStream` on the control node, gating the four Optimystic
 * control-DB protocols) and `refreshAuthorizedControlPeers` (the out-of-band
 * snapshot refresh that keeps its materialized authorized set current without
 * a live control-DB read on the stream path), plus the coalescing refresh in
 * front of it — `refreshMembershipGate`, which the control DB's membership hub
 * drives after every committed `CadrePeer` write, so no writer owes the gate
 * anything. The fail-open connection layer
 * is covered by `membership-connection-gater.spec.ts`; the row builders and
 * node injector both suites share live in `membership-gate-helpers.ts`. The
 * wire-level effect (a HELD connection whose repo stream is refused) is proven
 * in the integration scenario `control-stream-authz.integration.ts`.
 */

const REPO_PROTOCOL = '/optimystic/control-p/repo/1.0.0';

/** The injected node's own peerId (the `inject` default) — never its own authorized member. */
const SELF = 'self-peer';

function authorize(node: CadreNode, remotePeerId: string): boolean {
  return (node as unknown as {
    authorizeInboundControlStream(remotePeerId: string, protocol: string): boolean;
  }).authorizeInboundControlStream(remotePeerId, REPO_PROTOCOL);
}

function refresh(node: CadreNode): Promise<void> {
  return (node as unknown as {
    refreshAuthorizedControlPeers(reason: string): Promise<void>;
  }).refreshAuthorizedControlPeers('test');
}

function admitConnection(node: CadreNode, remotePeerId: string): Promise<boolean> {
  return (node as unknown as {
    admitInboundControlConnection(remotePeerId: string): Promise<boolean>;
  }).admitInboundControlConnection(remotePeerId);
}

function snapshot(node: CadreNode): Set<string> {
  return (node as unknown as { authorizedControlPeers: Set<string> }).authorizedControlPeers;
}

/** Anchored receiver with one vouched member row, snapshot already refreshed. */
async function establishedNode(): Promise<CadreNode> {
  const node = new CadreNode(createConfig());
  const owner = makeOwner();
  inject(node, {
    members: [vouchedRow(MEMBER, owner)],
    anchor: await anchorWith('p', owner.publicKey)
  });
  await refresh(node);
  return node;
}

describe('CadreNode.authorizeInboundControlStream', () => {
  it('admits the member in the snapshot and denies a stranger (steady state)', async () => {
    const node = await establishedNode();

    expect(authorize(node, MEMBER)).toBe(true);
    expect(authorize(node, STRANGER)).toBe(false);
  });

  it('admits everyone before start / after teardown (not running, or no control DB)', async () => {
    const stopped = new CadreNode(createConfig());
    inject(stopped, { running: false, members: [], anchor: await anchorWith('p', makeOwner().publicKey) });
    expect(authorize(stopped, STRANGER)).toBe(true);

    const noDb = new CadreNode(createConfig());
    inject(noDb, { anchor: await anchorWith('p', makeOwner().publicKey) }); // no controlDatabase injected
    expect(authorize(noDb, STRANGER)).toBe(true);
  });

  it('admits everyone while the anchor is absent or empty (un-enrolled node must accept its seed)', async () => {
    const noAnchor = new CadreNode(createConfig());
    inject(noAnchor, { members: [bareRow(MEMBER)] });
    await refresh(noAnchor);
    expect(authorize(noAnchor, STRANGER)).toBe(true);

    const emptyAnchor = new CadreNode(createConfig());
    inject(emptyAnchor, { members: [bareRow(MEMBER)], anchor: await anchorWith('p') });
    await refresh(emptyAnchor);
    expect(authorize(emptyAnchor, STRANGER)).toBe(true);
  });

  it('admits everyone while the materialized set is empty (cold start: authorization arrives by replication)', async () => {
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    // Anchored, rows present, but none authorizable (bare rows) — the rows that
    // would populate the snapshot ride the very streams being gated.
    inject(node, {
      members: [bareRow(MEMBER)],
      anchor: await anchorWith('p', owner.publicKey)
    });
    await refresh(node);

    expect(authorize(node, STRANGER)).toBe(true);
  });

  it('always admits the configured bootstrap/relay infrastructure, still denying a stranger alongside', async () => {
    const infraKey = await generateKeyPair('Ed25519');
    const infraId = peerIdFromPrivateKey(infraKey).toString();
    const node = new CadreNode(createConfig([`/ip4/10.0.0.1/tcp/4001/p2p/${infraId}`]));
    const owner = makeOwner();
    inject(node, {
      members: [vouchedRow(MEMBER, owner)],
      anchor: await anchorWith('p', owner.publicKey)
    });
    await refresh(node);

    expect(authorize(node, infraId)).toBe(true);
    expect(authorize(node, MEMBER)).toBe(true);
    expect(authorize(node, STRANGER)).toBe(false);
  });

  it('an open enrollment window admits the CONNECTION but not the STREAM — the divergence this gate exists for', async () => {
    // `createInvite` must let a stranger dial in (it redeems over the ungated
    // /sereus/seed/1.0.0), but that same window must NOT open the control-DB
    // repo/cluster/sync/block-transfer streams to it.
    const node = await establishedNode();
    node.openEnrollmentWindow(Date.now() + 60_000);

    expect(await admitConnection(node, STRANGER)).toBe(true);
    expect(authorize(node, STRANGER)).toBe(false);
    expect(authorize(node, MEMBER)).toBe(true);
  });

  it('a delegate grant admits the CONNECTION but not the STREAM', async () => {
    // Same divergence for the delegate carve-out: a member-announced strand
    // transport peerId needs the connection (a circuit-relay `hop` reservation
    // is connection-level), never the control-DB streams.
    const node = await establishedNode();
    node.grantDelegateAdmission(MEMBER, 'strand-1', STRANGER);

    expect(await admitConnection(node, STRANGER)).toBe(true);
    expect(authorize(node, STRANGER)).toBe(false);
    expect(authorize(node, MEMBER)).toBe(true);
  });

  it('an outstanding open invitation admits the CONNECTION but not the STREAM', async () => {
    // Same divergence for the formation carve-out: a cross-party initiator may
    // ride the connection to /sereus/formation/1.0.0, never to the control DB.
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    inject(node, {
      members: [vouchedRow(MEMBER, owner)],
      anchor: await anchorWith('p', owner.publicKey),
      solicitation: true
    });
    await refresh(node);

    expect(await admitConnection(node, STRANGER)).toBe(true);
    expect(authorize(node, STRANGER)).toBe(false);
  });

  it('denies a member whose StampId is retired in Revocation, still admitting its live sibling', async () => {
    // Parity with the connection layer: the snapshot is built from the same
    // revocation-filtered predicate, so a removed peer stays out of it.
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    const revoked = vouchedRow(MEMBER, owner);
    const survivor = vouchedRow('peer-member-2', owner);
    inject(node, {
      members: [revoked, survivor],
      anchor: await anchorWith('p', owner.publicKey),
      revoked: new Set([revoked.stampId!])
    });
    await refresh(node);

    expect(authorize(node, MEMBER)).toBe(false);
    expect(authorize(node, 'peer-member-2')).toBe(true);
  });
});

describe('CadreNode.refreshAuthorizedControlPeers', () => {
  it('materializes only vouched rows — an addressable-but-unvouched row never enters the snapshot', async () => {
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    const IMPOSTOR = 'peer-impostor';
    inject(node, {
      members: [vouchedRow(MEMBER, owner), bareRow(IMPOSTOR)],
      anchor: await anchorWith('p', owner.publicKey)
    });
    await refresh(node);

    expect([...snapshot(node)]).toEqual([MEMBER]);
    expect(authorize(node, MEMBER)).toBe(true);
    expect(authorize(node, IMPOSTOR)).toBe(false);
  });

  it('keeps the previous snapshot when the read fails (never clears, never rejects)', async () => {
    const node = await establishedNode();
    expect(authorize(node, STRANGER)).toBe(false);

    // A refresh whose control-DB read blows up must neither reject nor flip
    // the gate back to the cold-start admit-all (empty-snapshot) state.
    const db = (node as unknown as { controlDatabase: { queryCadrePeers: () => Promise<PeerRow[]> } }).controlDatabase;
    db.queryCadrePeers = async () => { throw new Error('control DB read failed'); };
    await expect(refresh(node)).resolves.toBeUndefined();

    expect(authorize(node, MEMBER)).toBe(true);
    expect(authorize(node, STRANGER)).toBe(false);
  });

  it('is a no-op when the node is not running', async () => {
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    inject(node, {
      running: false,
      members: [vouchedRow(MEMBER, owner)],
      anchor: await anchorWith('p', owner.publicKey)
    });
    await refresh(node);

    expect(snapshot(node).size).toBe(0);
  });
});

describe('CadreNode.refreshMembershipGate (write-driven, coalescing)', () => {
  /** Anchored node holding one member, snapshot materialized; `members` stays writable. */
  async function nodeWithMutableRows(): Promise<{ node: CadreNode; owner: Owner; members: PeerRow[] }> {
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    const members = [vouchedRow(MEMBER, owner)];
    inject(node, { members, anchor: await anchorWith('p', owner.publicKey) });
    await refresh(node);
    return { node, owner, members };
  }

  /**
   * One committed `CadrePeer` write, as every writer performs it: the row change
   * runs inside `mutateCadrePeer`, which notifies the membership hub afterwards.
   * `body` is synchronous because the fake's "commit" is just an array edit.
   */
  function write(node: CadreNode, body: () => void, reason = 'peer-insert'): Promise<void> {
    return fakeDb(node).mutateCadrePeer(reason, async () => { body(); });
  }

  it('admits a peer whose row was written BELOW the membership wrappers — denied until it is called', async () => {
    const { node, owner, members } = await nodeWithMutableRows();
    const LATE = 'peer-late';

    // A write straight through `getSeedBootstrapService().insertSelfPeerRecord`:
    // the row is in the control DB, but no wrapper re-materialized the snapshot.
    members.push(vouchedRow(LATE, owner));
    expect(authorize(node, LATE)).toBe(false);

    await node.refreshMembershipGate();

    expect(authorize(node, LATE)).toBe(true);
    expect(authorize(node, MEMBER)).toBe(true);
    expect(authorize(node, STRANGER)).toBe(false);
  });

  it('is idempotent and never rejects, even when the control-DB read blows up', async () => {
    const { node, owner, members } = await nodeWithMutableRows();
    members.push(vouchedRow('peer-late', owner));

    await node.refreshMembershipGate();
    await node.refreshMembershipGate();
    expect([...snapshot(node)].sort()).toEqual([MEMBER, 'peer-late'].sort());

    const db = (node as unknown as { controlDatabase: { queryCadrePeers: () => Promise<PeerRow[]> } }).controlDatabase;
    db.queryCadrePeers = async () => { throw new Error('control DB read failed'); };
    await expect(node.refreshMembershipGate()).resolves.toBeUndefined();
    expect(authorize(node, 'peer-late')).toBe(true);
    expect(authorize(node, STRANGER)).toBe(false);
  });

  it('an inbound seed application refreshes the gate for the peers it just wrote', async () => {
    // The seed protocol handler applies rows inside SeedBootstrapService, below
    // every wrapper; the shared `onSeedApplied` callback owes the refresh.
    const { node, owner, members } = await nodeWithMutableRows();
    const SEEDED = 'peer-seeded';
    members.push(vouchedRow(SEEDED, owner));
    expect(authorize(node, SEEDED)).toBe(false);

    const seed: ControlNetworkSeed = { partyId: 'p', peers: [], signature: '', signerKey: '' };
    (node as unknown as {
      seedEventCallbacks(): {
        onSeedApplied?: (partyId: string, peersAdded: number, seed: ControlNetworkSeed) => void;
      };
    }).seedEventCallbacks().onSeedApplied?.('p', 1, seed);

    await vi.waitFor(() => expect(authorize(node, SEEDED)).toBe(true));
    expect(authorize(node, STRANGER)).toBe(false);
  });

  it('addPhoneWithRelay refreshes the gate for the phone it just authorized', async () => {
    // The service inserts the phone's `CadrePeer` row inside its own call — through
    // `mutateCadrePeer`, so the control DB's membership hub owes the refresh and
    // neither the wrapper nor the caller has to remember.
    const { node, owner, members } = await nodeWithMutableRows();
    const PHONE = 'peer-phone';
    (node as unknown as { seedBootstrapService: unknown }).seedBootstrapService = {
      addPhoneWithRelay: async (phonePeerId: string) =>
        fakeDb(node).mutateCadrePeer('peer-insert', async () => {
          members.push(vouchedRow(phonePeerId, owner));
          return { seed: {}, encodedSeed: '' };
        })
    };

    await node.addPhoneWithRelay(PHONE);

    expect(authorize(node, PHONE)).toBe(true);
    expect(authorize(node, STRANGER)).toBe(false);
  });

  it('admits a peer written by a service built OUTSIDE CadreNode, with no explicit refresh', async () => {
    // The historically-missed shape, and the reason the hub (not the event
    // callbacks) is the seam: a `SeedBootstrapService` a CALLER constructed never
    // gets CadreNode's seed callbacks wired, but it still writes through the
    // ControlDatabase it was handed — so the notify still fires.
    const { node, owner, members } = await nodeWithMutableRows();
    const LATE = 'peer-outside';
    expect(authorize(node, LATE)).toBe(false);

    const externalService = {
      insertPeer: (peerId: string) => write(node, () => { members.push(vouchedRow(peerId, owner)); })
    };
    await externalService.insertPeer(LATE);

    expect(authorize(node, LATE)).toBe(true);
    expect(authorize(node, STRANGER)).toBe(false);
  });

  it('drops a removed peer from the snapshot by the time the write resolves', async () => {
    const { node, owner, members } = await nodeWithMutableRows();
    const SURVIVOR = 'peer-survivor';
    members.push(vouchedRow(SURVIVOR, owner));
    await node.refreshMembershipGate();
    expect(authorize(node, MEMBER)).toBe(true);

    // The notify sits AFTER the commit, so the caller's `await` already sees the
    // post-removal snapshot. (The hub's own post-commit ordering against a real
    // control DB is `control-membership-hub.spec.ts`' job, not this suite's.)
    await write(node, () => { members.splice(members.findIndex((r) => r.peerId === MEMBER), 1); }, 'peer-remove');

    expect(snapshot(node).has(MEMBER)).toBe(false);
    expect(authorize(node, MEMBER)).toBe(false);
    expect(authorize(node, SURVIVOR)).toBe(true);
  });

  it('fires no refresh when the mutation body throws', async () => {
    const { node, owner, members } = await nodeWithMutableRows();
    const db = fakeDb(node);
    const before = db.peerQueries;

    // The fake deliberately leaves the row behind after the throw (a real control
    // DB would roll it back) so "no membership read was issued" is provable from
    // the gate as well as from the counter.
    await expect(db.mutateCadrePeer('peer-insert', async () => {
      members.push(vouchedRow('peer-doomed', owner));
      throw new Error('AuthorizedInsert rejected the row');
    })).rejects.toThrow('AuthorizedInsert rejected the row');

    expect(db.peerQueries).toBe(before);
    expect([...snapshot(node)]).toEqual([MEMBER]);
    expect(authorize(node, 'peer-doomed')).toBe(false);
  });

  it('a failing refresh does not make the write reject, and keeps the previous snapshot', async () => {
    const { node, owner, members } = await nodeWithMutableRows();
    const db = fakeDb(node);
    db.queryCadrePeers = async () => { db.peerQueries++; throw new Error('control DB read failed'); };

    await expect(write(node, () => { members.push(vouchedRow('peer-late', owner)); })).resolves.toBeUndefined();

    expect(db.peerQueries).toBeGreaterThan(0);
    expect([...snapshot(node)]).toEqual([MEMBER]);
    expect(authorize(node, 'peer-late')).toBe(false);
  });

  it('coalesces a burst of concurrent writes, and still admits every writer own peer', async () => {
    const { node, owner, members } = await nodeWithMutableRows();
    const db = fakeDb(node);
    const before = db.peerQueries;
    const ids = ['peer-a', 'peer-b', 'peer-c', 'peer-d'];

    // Hold every membership read open until the test releases it, so the burst is
    // deterministic rather than dependent on microtask ordering.
    const blocked: Array<() => void> = [];
    const read = db.queryCadrePeers;
    db.queryCadrePeers = async () => {
      await new Promise<void>((resolve) => blocked.push(resolve));
      return read();
    };

    // Count listener entries so the test can release the first read only once ALL
    // four writes have marked the snapshot stale.
    let notified = 0;
    const listener = db.listener!;
    db.setMembershipChangeListener(async (reason) => { notified++; return listener(reason); });

    const observed = new Map<string, boolean>();
    const writes = ids.map((id) =>
      write(node, () => { members.push(vouchedRow(id, owner)); })
        .then(() => { observed.set(id, snapshot(node).has(id)); }));

    await vi.waitFor(() => expect(notified).toBe(ids.length));
    expect(blocked.length).toBe(1);       // one drain, not one per writer
    blocked.shift()!();

    // The drain re-reads once because the flag went stale again mid-read; after
    // that pass nothing is dirty, so the burst costs two reads, not four.
    await vi.waitFor(() => expect(blocked.length).toBe(1));
    blocked.shift()!();
    await Promise.all(writes);

    expect(db.peerQueries - before).toBe(2);
    expect(db.peerQueries - before).toBeLessThan(ids.length);
    // Each writer sees its OWN peer admitted when its promise resolves — the
    // property that makes the automatic refresh usable without an explicit await.
    expect([...observed.entries()].sort()).toEqual(ids.map((id) => [id, true]));
  });

  it('collapses a whole write-while-alone drain into ONE refresh', async () => {
    const { node, owner, members } = await nodeWithMutableRows();
    const db = fakeDb(node);
    const queued = ['peer-q1', 'peer-q2', 'peer-q3'];

    // Each re-issue is a notifying `CadrePeer` write; without the defer scope the
    // drain would cost one full membership read per queued entry.
    (db as unknown as {
      queryPeerRecord: (peerId: string) => Promise<{ updatedAt: number; sig: string | null } | null>;
    }).queryPeerRecord = async () => ({ updatedAt: 1, sig: null });
    (node as unknown as { seedBootstrapService: unknown }).seedBootstrapService = {
      canAuthorize: () => true,
      reauthorizePeer: async (peerId: string) =>
        db.mutateCadrePeer('peer-reauthorize', async () => { members.push(vouchedRow(peerId, owner)); })
    };
    (node as unknown as { pendingPeerWrites: Map<string, 'authorize' | 'remove'> }).pendingPeerWrites =
      new Map(queued.map((id) => [id, 'authorize' as const]));

    const before = db.peerQueries;
    await (node as unknown as { drainPendingPeerWrites(): Promise<void> }).drainPendingPeerWrites();

    expect(db.peerQueries - before).toBe(1);
    for (const id of queued) {
      expect(authorize(node, id)).toBe(true);
    }
  });

  it('raises no refresh once the membership listener is detached', async () => {
    const { node, owner, members } = await nodeWithMutableRows();
    const db = fakeDb(node);
    // What `cleanup()` does before closing the control DB, so a teardown-time write
    // cannot drive a gate refresh against a database the node no longer owns.
    db.setMembershipChangeListener(null);
    const before = db.peerQueries;

    await write(node, () => { members.push(vouchedRow('peer-after-detach', owner)); });

    expect(db.peerQueries).toBe(before);
    expect(authorize(node, 'peer-after-detach')).toBe(false);
  });

  it('a self-row insert leaves the cold-start snapshot empty (self is never authorized)', async () => {
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    const members: PeerRow[] = [];
    inject(node, { selfPeerId: SELF, members, anchor: await anchorWith('p', owner.publicKey) });
    await refresh(node);
    expect(snapshot(node).size).toBe(0);

    // `registerSelf`'s self-insert notifies like any other `CadrePeer` write, but the
    // authorized predicate filters self out — so the automatic refresh must NOT turn
    // an empty snapshot non-empty and close the cold-start admit-all carve-out.
    await write(node, () => { members.push(vouchedRow(SELF, owner)); });

    expect(snapshot(node).size).toBe(0);
    expect(authorize(node, STRANGER)).toBe(true);
  });
});
