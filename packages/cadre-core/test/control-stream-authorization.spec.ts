import { describe, it, expect, vi } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { CadreNode } from '../src/cadre-node.js';
import {
  MEMBER, STRANGER, createConfig, makeOwner, vouchedRow, bareRow, inject, anchorWith,
  type Owner, type PeerRow
} from './membership-gate-helpers.js';

/**
 * Unit coverage for the fail-closed per-stream control-DB gate:
 * `CadreNode.authorizeInboundControlStream` (the SYNCHRONOUS predicate wired as
 * `authorizeInboundStream` on the control node, gating the four Optimystic
 * control-DB protocols) and `refreshAuthorizedControlPeers` (the out-of-band
 * snapshot refresh that keeps its materialized authorized set current without
 * a live control-DB read on the stream path), plus its public face
 * `refreshMembershipGate` — the obligation a caller that writes a `CadrePeer`
 * row below the membership wrappers takes on. The fail-open connection layer
 * is covered by `membership-connection-gater.spec.ts`; the row builders and
 * node injector both suites share live in `membership-gate-helpers.ts`. The
 * wire-level effect (a HELD connection whose repo stream is refused) is proven
 * in the integration scenario `control-stream-authz.integration.ts`.
 */

const REPO_PROTOCOL = '/optimystic/control-p/repo/1.0.0';

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

describe('CadreNode.refreshMembershipGate (the below-the-wrapper obligation)', () => {
  /** Anchored node holding one member, snapshot materialized; `members` stays writable. */
  async function nodeWithMutableRows(): Promise<{ node: CadreNode; owner: Owner; members: PeerRow[] }> {
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    const members = [vouchedRow(MEMBER, owner)];
    inject(node, { members, anchor: await anchorWith('p', owner.publicKey) });
    await refresh(node);
    return { node, owner, members };
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

    (node as unknown as {
      seedEventCallbacks(): { onSeedApplied?: (partyId: string, peersAdded: number) => void };
    }).seedEventCallbacks().onSeedApplied?.('p', 1);

    await vi.waitFor(() => expect(authorize(node, SEEDED)).toBe(true));
    expect(authorize(node, STRANGER)).toBe(false);
  });

  it('addPhoneWithRelay refreshes the gate for the phone it just authorized', async () => {
    // The service inserts the phone's `CadrePeer` row inside its own call, so the
    // node wrapper — not the caller — owes the refresh.
    const { node, owner, members } = await nodeWithMutableRows();
    const PHONE = 'peer-phone';
    (node as unknown as { seedBootstrapService: unknown }).seedBootstrapService = {
      addPhoneWithRelay: async (phonePeerId: string) => {
        members.push(vouchedRow(phonePeerId, owner));
        return { seed: {}, encodedSeed: '' };
      }
    };

    await node.addPhoneWithRelay(PHONE);

    expect(authorize(node, PHONE)).toBe(true);
    expect(authorize(node, STRANGER)).toBe(false);
  });
});
