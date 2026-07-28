import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { ConnectionGater, PeerId, MultiaddrConnection } from '@libp2p/interface';
import { generatePrivateKey, getPublicKey, sign } from '@optimystic/quereus-plugin-crypto';
import { CadreNode } from '../src/cadre-node.js';
import type { CadreNodeConfig } from '../src/types.js';
import { cadrePeerVoucherDigest } from '../src/peer-authorization.js';
import { MemoryTrustedOwnerStore, type TrustedOwnerStore } from '../src/trusted-owner-store.js';
import {
  createMembershipConnectionGater,
  DEFAULT_ENROLLMENT_WINDOW_MS,
  STRANGER_OPEN_PROTOCOLS,
  type InboundAdmissionPolicy
} from '../src/membership-connection-gater.js';
import { SEED_PROTOCOL } from '../src/seed-bootstrap.js';
import { FORMATION_PROTOCOL } from '../src/strand-formation-protocol.js';

/**
 * Unit coverage for the control-network inbound connection gate
 * (`membership-connection-gater`): the gater composition/fail-open contract,
 * and the `CadreNode.admitInboundControlConnection` decision matrix (enrollment
 * windows, anchor state, bootstrap infra, formation-responder mode, the
 * authorized-member set). The wire-level effect (an outsider's dial actually
 * failing) is proven in the integration scenario
 * `membership-connection-gater.integration.ts`.
 */

function fakePeerId(id: string): PeerId {
  return { toString: () => id } as unknown as PeerId;
}

const MA_CONN = {} as MultiaddrConnection;

function denyingBase(deniedId: string): ConnectionGater {
  return {
    denyDialMultiaddr: () => false,
    denyInboundEncryptedConnection: (peerId) => peerId.toString() === deniedId
  };
}

describe('createMembershipConnectionGater (composition + fail-open)', () => {
  it('denies when the policy refuses, admits when it accepts', async () => {
    const policy: InboundAdmissionPolicy = { admitInbound: (id) => id === 'friend' };
    const gater = createMembershipConnectionGater(policy);

    expect(await gater.denyInboundEncryptedConnection!(fakePeerId('friend'), MA_CONN)).toBe(false);
    expect(await gater.denyInboundEncryptedConnection!(fakePeerId('stranger'), MA_CONN)).toBe(true);
  });

  it('honors a base-gater deny even when the policy would admit', async () => {
    const policy: InboundAdmissionPolicy = { admitInbound: () => true };
    const gater = createMembershipConnectionGater(policy, denyingBase('blocked'));

    expect(await gater.denyInboundEncryptedConnection!(fakePeerId('blocked'), MA_CONN)).toBe(true);
    expect(await gater.denyInboundEncryptedConnection!(fakePeerId('anyone-else'), MA_CONN)).toBe(false);
  });

  it('still applies the policy when the base gater admits', async () => {
    const policy: InboundAdmissionPolicy = { admitInbound: () => false };
    const gater = createMembershipConnectionGater(policy, denyingBase('blocked'));

    expect(await gater.denyInboundEncryptedConnection!(fakePeerId('anyone'), MA_CONN)).toBe(true);
  });

  it('preserves the base gater\'s other hooks unchanged', async () => {
    const gater = createMembershipConnectionGater({ admitInbound: () => true }, denyingBase('x'));
    // The permissive-dial hook browsers rely on must survive the composition.
    expect(await gater.denyDialMultiaddr!(undefined as never)).toBe(false);
  });

  it('fails open (admits) when the policy throws — the stream gates stay the fail-closed layer', async () => {
    const policy: InboundAdmissionPolicy = {
      admitInbound: () => { throw new Error('control DB torn down mid-check'); }
    };
    const gater = createMembershipConnectionGater(policy);

    expect(await gater.denyInboundEncryptedConnection!(fakePeerId('anyone'), MA_CONN)).toBe(false);
  });

  it('documents exactly the seed + formation protocols as stranger-open', () => {
    expect(STRANGER_OPEN_PROTOCOLS).toEqual([SEED_PROTOCOL, FORMATION_PROTOCOL]);
  });
});

// ── CadreNode.admitInboundControlConnection decision matrix ─────────────────

function createConfig(bootstrapNodes: string[] = []): CadreNodeConfig {
  return {
    controlNetwork: {
      partyId: 'connection-gater-test-' + Math.random().toString(36).slice(2),
      bootstrapNodes
    },
    profile: 'transaction'
  };
}

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

/** A row carrying a REAL voucher: `owner` signs digest(peerId, stampId), as insertCadrePeerRow does. */
function vouchedRow(peerId: string, owner: Owner): PeerRow {
  const stampId = `stamp-${peerId}`;
  const vouchSig = sign(
    cadrePeerVoucherDigest(peerId, stampId),
    owner.privateKey,
    'ed25519',
    'base64url',
    'base64url',
    'base64url'
  ) as string;
  return { peerId, multiaddr: null, stampId, vouchOwner: owner.publicKey, vouchSig };
}

/** A row with no voucher (addressable but never authorizable). */
function bareRow(peerId: string): PeerRow {
  return { peerId, multiaddr: null, stampId: null, vouchOwner: null, vouchSig: null };
}

/** Wire the minimal node internals the admission policy touches. */
function inject(node: CadreNode, opts: {
  running?: boolean;
  selfPeerId?: string;
  members?: PeerRow[];
  anchor?: TrustedOwnerStore;
  solicitation?: boolean;
}): void {
  (node as unknown as { _running: boolean })._running = opts.running ?? true;
  (node as unknown as { controlNode: unknown }).controlNode = {
    peerId: { toString: () => opts.selfPeerId ?? 'self-peer' }
  };
  if (opts.members) {
    (node as unknown as { controlDatabase: unknown }).controlDatabase = {
      queryCadrePeers: async () => opts.members
    };
  }
  if (opts.anchor) {
    (node as unknown as { trustedOwnerStore: TrustedOwnerStore }).trustedOwnerStore = opts.anchor;
  }
  if (opts.solicitation) {
    (node as unknown as { strandSolicitationService: unknown }).strandSolicitationService = {};
  }
}

async function anchorWith(partyId: string, ...keys: string[]): Promise<TrustedOwnerStore> {
  const store = new MemoryTrustedOwnerStore(partyId);
  for (const key of keys) {
    await store.trust(key, 'operator');
  }
  return store;
}

function admit(node: CadreNode, remotePeerId: string): Promise<boolean> {
  return (node as unknown as {
    admitInboundControlConnection(remotePeerId: string): Promise<boolean>;
  }).admitInboundControlConnection(remotePeerId);
}

describe('CadreNode.admitInboundControlConnection', () => {
  const MEMBER = 'peer-member';
  const STRANGER = 'peer-stranger';

  it('denies a stranger only in the fully-established steady state; admits the authorized member', async () => {
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    inject(node, {
      members: [vouchedRow(MEMBER, owner)],
      anchor: await anchorWith('p', owner.publicKey)
    });

    expect(await admit(node, MEMBER)).toBe(true);
    expect(await admit(node, STRANGER)).toBe(false);
  });

  it('admits everyone before start / after teardown (not running, or no control DB)', async () => {
    const stopped = new CadreNode(createConfig());
    inject(stopped, { running: false, members: [], anchor: await anchorWith('p', makeOwner().publicKey) });
    expect(await admit(stopped, STRANGER)).toBe(true);

    const noDb = new CadreNode(createConfig());
    inject(noDb, { anchor: await anchorWith('p', makeOwner().publicKey) }); // no controlDatabase injected
    expect(await admit(noDb, STRANGER)).toBe(true);
  });

  it('admits everyone while the anchor is absent or empty (un-enrolled node must accept its seed)', async () => {
    const noAnchor = new CadreNode(createConfig());
    inject(noAnchor, { members: [bareRow(MEMBER)] });
    expect(await admit(noAnchor, STRANGER)).toBe(true);

    const emptyAnchor = new CadreNode(createConfig());
    inject(emptyAnchor, { members: [bareRow(MEMBER)], anchor: await anchorWith('p') });
    expect(await admit(emptyAnchor, STRANGER)).toBe(true);
  });

  it('admits everyone while the authorized set is empty (cold start: authorization arrives by replication)', async () => {
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    // Anchored, rows present, but none authorizable (bare rows) — the rows that
    // would authorize a sibling ride the very connections being gated.
    inject(node, {
      members: [bareRow(MEMBER)],
      anchor: await anchorWith('p', owner.publicKey)
    });

    expect(await admit(node, STRANGER)).toBe(true);
  });

  it('admits a stranger while an enrollment window is open, denies again once it lapses', async () => {
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    inject(node, {
      members: [vouchedRow(MEMBER, owner)],
      anchor: await anchorWith('p', owner.publicKey)
    });

    expect(await admit(node, STRANGER)).toBe(false);
    node.openEnrollmentWindow(Date.now() + 60_000);
    expect(await admit(node, STRANGER)).toBe(true);

    // A window in the past never re-opens (and cannot shrink an open one).
    const fresh = new CadreNode(createConfig());
    inject(fresh, {
      members: [vouchedRow(MEMBER, owner)],
      anchor: await anchorWith('p', owner.publicKey)
    });
    fresh.openEnrollmentWindow(Date.now() - 1);
    expect(await admit(fresh, STRANGER)).toBe(false);
  });

  it('admits everyone while the strand-formation responder is registered (stranger-serving by design)', async () => {
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    inject(node, {
      members: [vouchedRow(MEMBER, owner)],
      anchor: await anchorWith('p', owner.publicKey),
      solicitation: true
    });

    expect(await admit(node, STRANGER)).toBe(true);
  });

  it('always admits the configured bootstrap/relay infrastructure peers', async () => {
    const infraKey = await generateKeyPair('Ed25519');
    const infraId = peerIdFromPrivateKey(infraKey).toString();
    const node = new CadreNode(createConfig([`/ip4/10.0.0.1/tcp/4001/p2p/${infraId}`]));
    const owner = makeOwner();
    inject(node, {
      members: [vouchedRow(MEMBER, owner)],
      anchor: await anchorWith('p', owner.publicKey)
    });

    expect(await admit(node, infraId)).toBe(true);
    expect(await admit(node, STRANGER)).toBe(false);
  });

  it('exposes the default window used when an invite has no expiry', () => {
    expect(DEFAULT_ENROLLMENT_WINDOW_MS).toBeGreaterThan(0);
  });
});
