import { describe, it, expect } from 'vitest';
import { generatePrivateKey, getPublicKey, sign } from '@optimystic/quereus-plugin-crypto';
import { CadreNode } from '../src/cadre-node.js';
import type { CadreNodeConfig } from '../src/types.js';
import { cadrePeerVoucherDigest } from '../src/peer-authorization.js';
import { MemoryTrustedOwnerStore, type TrustedOwnerStore } from '../src/trusted-owner-store.js';

/**
 * Unit coverage for the addressable-vs-authorized membership surface split and
 * the real authorized predicate (`membership-authorized-predicate-and-gates`).
 *
 * `listMembers`/`isMember` are the ADDRESSABLE surface: "do I have a CadrePeer
 * address row" — self included, no trust judgment. `listAuthorizedMembers`/
 * `isAuthorizedMember` are the trust-facing surface: a peer counts only when a
 * complete voucher (`StampId`/`VouchOwner`/`VouchSig`) on its row verifies
 * against an owner key pinned in the NODE-LOCAL trusted-owner anchor — and self
 * is excluded. Fail-closed on every missing piece. The control-network wake and
 * strand-address gates consult the authorized surface.
 */

function createConfig(): CadreNodeConfig {
  return {
    controlNetwork: {
      partyId: 'authorized-surface-test-' + Math.random().toString(36).slice(2),
      bootstrapNodes: []
    },
    profile: 'transaction'
  };
}

/** Full `queryCadrePeers` row shape (voucher columns included). */
type PeerRow = {
  peerId: string;
  multiaddr: string | null;
  stampId: string | null;
  vouchOwner: string | null;
  vouchSig: string | null;
};

interface Owner { privateKey: string; publicKey: string }

function makeOwner(): Owner {
  const privateKey = generatePrivateKey('ed25519', 'base64url') as string;
  const publicKey = getPublicKey(privateKey, 'ed25519', 'base64url', 'base64url') as string;
  return { privateKey, publicKey };
}

/** A row carrying a REAL voucher: `owner` signs the tagged voucher digest, as insertCadrePeerRow does. */
function vouchedRow(peerId: string, owner: Owner, overrides: Partial<PeerRow> = {}): PeerRow {
  const stampId = `stamp-${peerId}`;
  const vouchSig = sign(
    cadrePeerVoucherDigest(peerId, stampId),
    owner.privateKey,
    'ed25519',
    'base64url',
    'base64url',
    'base64url'
  ) as string;
  return { peerId, multiaddr: null, stampId, vouchOwner: owner.publicKey, vouchSig, ...overrides };
}

/** A row with no voucher at all (e.g. written before the voucher columns existed). */
function bareRow(peerId: string, multiaddr: string | null = null): PeerRow {
  return { peerId, multiaddr, stampId: null, vouchOwner: null, vouchSig: null };
}

/**
 * Wire the minimal control-node + DB + anchor fakes the membership reads touch.
 * `anchor` omitted → the pre-start shape (no trusted-owner store at all).
 */
function inject(node: CadreNode, opts: { selfPeerId: string; members: PeerRow[]; anchor?: TrustedOwnerStore; revoked?: Set<string> }): void {
  (node as unknown as { controlNode: unknown }).controlNode = {
    peerId: { toString: () => opts.selfPeerId }
  };
  (node as unknown as { controlDatabase: unknown }).controlDatabase = {
    queryCadrePeers: async () => opts.members,
    queryRevokedStamps: async () => opts.revoked ?? new Set<string>()
  };
  if (opts.anchor) {
    (node as unknown as { trustedOwnerStore: TrustedOwnerStore }).trustedOwnerStore = opts.anchor;
  }
}

async function anchorWith(partyId: string, ...keys: string[]): Promise<TrustedOwnerStore> {
  const store = new MemoryTrustedOwnerStore(partyId);
  for (const key of keys) {
    await store.trust(key, 'operator');
  }
  return store;
}

describe('CadreNode addressable-vs-authorized surface', () => {
  const SELF = 'self-peer';
  const A = 'peer-A';
  const B = 'peer-B';
  const C = 'peer-C';

  it('authorizes a peer whose voucher verifies against an anchored owner; addressable surface unchanged', async () => {
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    inject(node, {
      selfPeerId: SELF,
      members: [
        vouchedRow(SELF, owner, { multiaddr: '/ip4/1.1.1.1/tcp/1' }),
        vouchedRow(A, owner, { multiaddr: '/ip4/2.2.2.2/tcp/2' }),
        vouchedRow(B, owner)
      ],
      anchor: await anchorWith('p', owner.publicKey)
    });

    expect((await node.listMembers()).map(m => m.peerId)).toEqual([SELF, A, B]);
    expect((await node.listAuthorizedMembers()).map(m => m.peerId)).toEqual([A, B]);
    expect(await node.isAuthorizedMember(A)).toBe(true);
  });

  it('excludes self even when its own row carries a valid anchored voucher', async () => {
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    inject(node, {
      selfPeerId: SELF,
      members: [vouchedRow(SELF, owner), vouchedRow(A, owner)],
      anchor: await anchorWith('p', owner.publicKey)
    });

    expect(await node.isMember(SELF)).toBe(true);
    expect(await node.isAuthorizedMember(SELF)).toBe(false);
    expect(await node.isAuthorizedMember(A)).toBe(true);
  });

  it('fails closed on a row with no voucher: addressable yes, authorized no', async () => {
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    inject(node, {
      selfPeerId: SELF,
      members: [bareRow(A, '/ip4/2.2.2.2/tcp/2')],
      anchor: await anchorWith('p', owner.publicKey)
    });

    expect(await node.isMember(A)).toBe(true);
    expect(await node.isAuthorizedMember(A)).toBe(false);
    expect(await node.listAuthorizedMembers()).toEqual([]);
  });

  it('fails closed on a partial voucher (any of StampId/VouchOwner/VouchSig missing)', async () => {
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    inject(node, {
      selfPeerId: SELF,
      members: [
        vouchedRow(A, owner, { stampId: null }),
        vouchedRow(B, owner, { vouchSig: null }),
        vouchedRow(C, owner, { vouchOwner: null })
      ],
      anchor: await anchorWith('p', owner.publicKey)
    });

    expect(await node.isAuthorizedMember(A)).toBe(false);
    expect(await node.isAuthorizedMember(B)).toBe(false);
    expect(await node.isAuthorizedMember(C)).toBe(false);
  });

  it('rejects a valid voucher whose owner key is NOT in the node-local anchor (the self-minted-owner attack)', async () => {
    const node = new CadreNode(createConfig());
    const partyOwner = makeOwner();
    const outsider = makeOwner(); // an attacker can genesis its key into the REPLICATED OwnerKey table, but never into this anchor
    inject(node, {
      selfPeerId: SELF,
      members: [
        vouchedRow(A, partyOwner),
        vouchedRow(B, outsider, { multiaddr: '/ip4/6.6.6.6/tcp/6' })
      ],
      anchor: await anchorWith('p', partyOwner.publicKey)
    });

    // B has an address row (addressable — the pre-fix hole) but its self-minted
    // voucher is unanchored, so the trust-facing surface rejects it.
    expect(await node.isMember(B)).toBe(true);
    expect(await node.isAuthorizedMember(B)).toBe(false);
    expect((await node.listAuthorizedMembers()).map(m => m.peerId)).toEqual([A]);
  });

  it('rejects a bad signature: anchored VouchOwner but VouchSig not that owner\'s signature over this row', async () => {
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    const other = makeOwner();
    const forged = vouchedRow(A, other, { vouchOwner: owner.publicKey }); // claims owner, signed by other
    const replayed = vouchedRow(B, owner, { stampId: 'different-stamp' }); // sig over another nonce
    inject(node, {
      selfPeerId: SELF,
      members: [forged, replayed],
      anchor: await anchorWith('p', owner.publicKey)
    });

    expect(await node.isAuthorizedMember(A)).toBe(false);
    expect(await node.isAuthorizedMember(B)).toBe(false);
  });

  it('rejects a voucher transplanted from another peer\'s row (the digest binds the PeerId)', async () => {
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    // A is a genuine member. B lifts A's whole voucher triple onto its own row —
    // the anchored owner really did sign it, just not for B.
    const genuine = vouchedRow(A, owner);
    const transplanted = bareRow(B, '/ip4/6.6.6.6/tcp/6');
    inject(node, {
      selfPeerId: SELF,
      members: [
        genuine,
        { ...transplanted, stampId: genuine.stampId, vouchOwner: genuine.vouchOwner, vouchSig: genuine.vouchSig }
      ],
      anchor: await anchorWith('p', owner.publicKey)
    });

    expect(await node.isAuthorizedMember(A)).toBe(true);
    expect(await node.isAuthorizedMember(B)).toBe(false);
  });

  it('drops a fully valid, anchored voucher whose StampId is retired in Revocation', async () => {
    // Mock-level is the ONLY place this state is constructible: on a real database the
    // write-time constraints themselves forbid a live row coexisting with its tombstone
    // (`Revocation.RowIsGone` blocks tombstoning a live row; the guarded table's
    // `NotRevoked` blocks re-inserting over a tombstone). The coexistence models the
    // cross-node CONVERGENCE race — a node accepts a replayed admission before the
    // tombstone arrives, then both rows merge in via replication, not local writes.
    // Readers must treat the tombstone as authoritative.
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    const resurrected = vouchedRow(A, owner, { multiaddr: '/ip4/2.2.2.2/tcp/2' });
    inject(node, {
      selfPeerId: SELF,
      members: [resurrected, vouchedRow(B, owner)],
      anchor: await anchorWith('p', owner.publicKey),
      revoked: new Set([resurrected.stampId!])
    });

    expect((await node.listAuthorizedMembers()).map(m => m.peerId)).toEqual([B]);
    expect(await node.isAuthorizedMember(A)).toBe(false);
    expect(await node.isAuthorizedMember(B)).toBe(true);
    // Still ADDRESSABLE — revocation is a trust judgment, not an address purge.
    expect(await node.isMember(A)).toBe(true);
  });

  it('authorizes no one when the anchor is empty (cold-start / not-yet-enrolled node)', async () => {
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    inject(node, {
      selfPeerId: SELF,
      members: [vouchedRow(SELF, owner, { multiaddr: '/ip4/1.1.1.1/tcp/1' }), vouchedRow(A, owner)],
      anchor: await anchorWith('p') // empty anchor
    });

    expect(await node.listAuthorizedMembers()).toEqual([]);
    expect(await node.isAuthorizedMember(A)).toBe(false);
    expect(await node.isAuthorizedMember('any-stranger')).toBe(false);
  });

  it('authorizes no one when no anchor exists at all (fail-closed pre-start shape)', async () => {
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    inject(node, { selfPeerId: SELF, members: [vouchedRow(A, owner)] }); // no anchor injected

    expect(await node.listAuthorizedMembers()).toEqual([]);
    expect(await node.isAuthorizedMember(A)).toBe(false);
  });

  it('keeps the fresh-party shape: only a self row, nobody authorized', async () => {
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    inject(node, {
      selfPeerId: SELF,
      members: [vouchedRow(SELF, owner, { multiaddr: '/ip4/1.1.1.1/tcp/1' })],
      anchor: await anchorWith('p', owner.publicKey)
    });

    expect(await node.listAuthorizedMembers()).toEqual([]);
    expect(await node.isAuthorizedMember('any-stranger')).toBe(false);
  });
});
