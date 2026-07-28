import { describe, it, expect, vi } from 'vitest';
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
import { StrandSolicitationService } from '../src/strand-solicitation.js';
import { SEED_PROTOCOL } from '../src/seed-bootstrap.js';
import { FORMATION_PROTOCOL } from '../src/strand-formation-protocol.js';

/**
 * Unit coverage for the control-network inbound connection gate
 * (`membership-connection-gater`): the gater composition/fail-open contract,
 * and the `CadreNode.admitInboundControlConnection` decision matrix (enrollment
 * windows, anchor state, bootstrap infra, formation-responder mode, the
 * authorized-member set), and the `createInvite` → enrollment-window wiring.
 * The wire-level effect (an outsider's dial actually failing) is proven in the
 * integration scenario `membership-connection-gater.integration.ts`.
 */

/** A peer with a real anchored voucher in the receiver's rows. */
const MEMBER = 'peer-member';
/** A peer with no row at all — the outsider the gate exists to refuse. */
const STRANGER = 'peer-stranger';

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

  it('fails open (admits) when the decision outstays its deadline — never wedges the inbound upgrade', async () => {
    let settle: (() => void) | undefined;
    const policy: InboundAdmissionPolicy = {
      // A control-DB read that pulls over the network and never comes back.
      admitInbound: () => new Promise<boolean>((resolve) => { settle = () => resolve(false); })
    };
    const gater = createMembershipConnectionGater(policy, undefined, 20);

    expect(await gater.denyInboundEncryptedConnection!(fakePeerId('anyone'), MA_CONN)).toBe(false);
    settle?.(); // release the pending policy promise so the test leaves nothing dangling
  });

  it('documents exactly the seed + formation protocols as stranger-open', () => {
    // Literal wire ids, not the imported constants — this locks the allowlist's
    // CONTENT, so widening it (or renaming a protocol) cannot pass silently.
    expect(STRANGER_OPEN_PROTOCOLS).toEqual(['/sereus/seed/1.0.0', '/sereus/formation/1.0.0']);
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

/**
 * How the injected solicitation service answers `hasOutstandingInvitation` —
 * the SOLE input to the formation exemption. `undefined` leaves the node with no
 * service at all (the initiator/never-registered case).
 */
type Outstanding = boolean | 'throws' | 'hangs';

/** Wire the minimal node internals the admission policy touches. */
function inject(node: CadreNode, opts: {
  running?: boolean;
  selfPeerId?: string;
  members?: PeerRow[];
  anchor?: TrustedOwnerStore;
  solicitation?: Outstanding;
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
  if (opts.solicitation !== undefined) {
    (node as unknown as { strandSolicitationService: unknown }).strandSolicitationService = {
      hasOutstandingInvitation: async (): Promise<boolean> => {
        if (opts.solicitation === 'throws') {
          throw new Error('control DB torn down mid-invitation-check');
        }
        if (opts.solicitation === 'hangs') {
          return await new Promise<boolean>(() => { /* never settles */ });
        }
        return opts.solicitation === true;
      }
    };
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

  it('admits a stranger while an open invitation is outstanding (expectation of a stranger)', async () => {
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    inject(node, {
      members: [vouchedRow(MEMBER, owner)],
      anchor: await anchorWith('p', owner.publicKey),
      solicitation: true
    });

    expect(await admit(node, STRANGER)).toBe(true);
  });

  it('denies a stranger when the responder is registered but NO invitation is outstanding', async () => {
    // The whole point of the narrowed carve-out: registering the formation
    // responder (as reference-app-rn does at bring-up) must NOT disarm the gate.
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    inject(node, {
      members: [vouchedRow(MEMBER, owner)],
      anchor: await anchorWith('p', owner.publicKey),
      solicitation: false
    });

    expect(await admit(node, STRANGER)).toBe(false);
  });

  it('admits an authorized member without consulting the invitation check (member check precedes it)', async () => {
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    inject(node, {
      members: [vouchedRow(MEMBER, owner)],
      anchor: await anchorWith('p', owner.publicKey),
      // Would throw if reached — proves the member path never pays for it.
      solicitation: 'throws'
    });

    expect(await admit(node, MEMBER)).toBe(true);
  });

  it('fails open when the invitation check throws', async () => {
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    inject(node, {
      members: [vouchedRow(MEMBER, owner)],
      anchor: await anchorWith('p', owner.publicKey),
      solicitation: 'throws'
    });

    expect(await admit(node, STRANGER)).toBe(true);
  });

  it('fails open via the gater deadline when the invitation check never settles', async () => {
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    inject(node, {
      members: [vouchedRow(MEMBER, owner)],
      anchor: await anchorWith('p', owner.publicKey),
      solicitation: 'hangs'
    });

    // The decision itself never resolves; the gater's deadline is what admits.
    const gater = createMembershipConnectionGater(
      { admitInbound: (id) => admit(node, id) },
      undefined,
      20
    );
    expect(await gater.denyInboundEncryptedConnection!(fakePeerId(STRANGER), MA_CONN)).toBe(false);
  });

  it('mint → admit → lapse → deny, driven through a REAL solicitation service', async () => {
    // Acceptance shape of the narrowed carve-out, end to end through the actual
    // predicate rather than a stub: the node denies until it mints an invitation,
    // admits while that invitation lives, and denies again once it expires.
    vi.useFakeTimers();
    try {
      const node = new CadreNode(createConfig());
      const owner = makeOwner();
      inject(node, {
        members: [vouchedRow(MEMBER, owner)],
        anchor: await anchorWith('p', owner.publicKey)
      });
      const service = new StrandSolicitationService();
      (node as unknown as { strandSolicitationService: unknown }).strandSolicitationService = service;

      expect(await admit(node, STRANGER)).toBe(false);

      await service.createOpenInvitation('sapp-acceptance', 60_000, []);
      expect(await admit(node, STRANGER)).toBe(true);

      vi.advanceTimersByTime(60_000);
      expect(await admit(node, STRANGER)).toBe(false);
      // The member is unaffected by the invitation lifecycle.
      expect(await admit(node, MEMBER)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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

  it('denies a peer whose row is addressable but unvouched, alongside a real member', async () => {
    // The step-4 distinction at the connection layer: having a `CadrePeer` row
    // (so `isMember` is true) is NOT membership — only an anchored voucher is.
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    const IMPOSTOR = 'peer-impostor';
    inject(node, {
      members: [vouchedRow(MEMBER, owner), bareRow(IMPOSTOR)],
      anchor: await anchorWith('p', owner.publicKey)
    });

    expect(await admit(node, MEMBER)).toBe(true);
    expect(await admit(node, IMPOSTOR)).toBe(false);
  });

  it('denies a peer vouched by a key that is NOT in this node\'s anchor', async () => {
    const node = new CadreNode(createConfig());
    const anchored = makeOwner();
    const selfMinted = makeOwner();
    inject(node, {
      members: [vouchedRow(MEMBER, anchored), vouchedRow('peer-self-minted', selfMinted)],
      anchor: await anchorWith('p', anchored.publicKey)
    });

    expect(await admit(node, MEMBER)).toBe(true);
    expect(await admit(node, 'peer-self-minted')).toBe(false);
  });
});

// ── createInvite → enrollment window wiring ─────────────────────────────────

/** Stub the seed-bootstrap service so `createInvite` runs without a real node. */
function injectInviteIssuer(node: CadreNode, expiresAt: number | undefined): void {
  (node as unknown as { seedBootstrapService: unknown }).seedBootstrapService = {
    createInvite: async (token?: string) => ({
      invite: { token: token ?? 'tok', ...(expiresAt === undefined ? {} : { expiresAt }) },
      encodedInvite: 'encoded'
    })
  };
}

function windowUntil(node: CadreNode): number {
  return (node as unknown as { enrollmentWindowUntil: number }).enrollmentWindowUntil;
}

describe('CadreNode.createInvite enrollment window', () => {
  async function establishedNode(): Promise<CadreNode> {
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    inject(node, {
      members: [vouchedRow(MEMBER, owner)],
      anchor: await anchorWith('p', owner.publicKey)
    });
    return node;
  }

  it('opens the window to the invite\'s own expiry, admitting the invitee that dials in', async () => {
    const node = await establishedNode();
    const expiresAt = Date.now() + 120_000;
    injectInviteIssuer(node, expiresAt);

    expect(await admit(node, STRANGER)).toBe(false);
    await node.createInvite('tok', 120_000);
    expect(windowUntil(node)).toBe(expiresAt);
    expect(await admit(node, STRANGER)).toBe(true);
  });

  it('falls back to DEFAULT_ENROLLMENT_WINDOW_MS for an invite with no expiry', async () => {
    const node = await establishedNode();
    injectInviteIssuer(node, undefined);

    const before = Date.now();
    await node.createInvite('tok');
    expect(windowUntil(node)).toBeGreaterThanOrEqual(before + DEFAULT_ENROLLMENT_WINDOW_MS);
    expect(windowUntil(node)).toBeLessThanOrEqual(Date.now() + DEFAULT_ENROLLMENT_WINDOW_MS);
    expect(await admit(node, STRANGER)).toBe(true);
  });

  it('opens nothing for an already-expired invite, and never shrinks an open window', async () => {
    const expired = await establishedNode();
    injectInviteIssuer(expired, Date.now() - 1);
    await expired.createInvite('stale');
    expect(await admit(expired, STRANGER)).toBe(false);

    const node = await establishedNode();
    const far = Date.now() + 600_000;
    node.openEnrollmentWindow(far);
    injectInviteIssuer(node, Date.now() + 1_000);
    await node.createInvite('shorter');
    expect(windowUntil(node)).toBe(far);
  });
});
