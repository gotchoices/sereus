import { describe, it, expect, vi } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { ConnectionGater, PeerId, MultiaddrConnection } from '@libp2p/interface';
import { CadreNode } from '../src/cadre-node.js';
import {
  createMembershipConnectionGater,
  DEFAULT_ENROLLMENT_WINDOW_MS,
  STRANGER_OPEN_PROTOCOLS,
  UnauthorizedReservationBudget,
  type InboundAdmissionPolicy,
  type InboundConnectionVerdict
} from '../src/membership-connection-gater.js';
import { StrandSolicitationService } from '../src/strand-solicitation.js';
import { SEED_PROTOCOL } from '../src/seed-bootstrap.js';
import { FORMATION_PROTOCOL } from '../src/strand-formation-protocol.js';
import { MEMBER, STRANGER, createConfig, makeOwner, vouchedRow, bareRow, inject, anchorWith } from './membership-gate-helpers.js';

/**
 * Unit coverage for the control-network inbound admission gates
 * (`membership-connection-gater`): the gater composition/fail-open contract on
 * BOTH composed hooks (`denyInboundEncryptedConnection` and
 * `denyInboundRelayReservation`), the admit-for-relay not-reserving deadline,
 * the `UnauthorizedReservationBudget`, the
 * `CadreNode.admitInboundControlConnection` decision matrix (enrollment
 * windows, anchor state, bootstrap infra, formation-responder mode, the
 * authorized-member set, the relay-enabled verdict), the
 * `CadreNode.admitControlRelayReservation` decision matrix, and the
 * `createInvite` → enrollment-window wiring. The wire-level effect (an
 * outsider's dial actually failing / an unauthorized reservation landing) is
 * proven in the integration scenarios `membership-connection-gater.integration.ts`
 * and `relay-only-control-addr.integration.ts`. The fail-closed per-stream
 * sibling gate is covered by `control-stream-authorization.spec.ts`; the row
 * builders and node injector both suites share live in
 * `membership-gate-helpers.ts`.
 */

function fakePeerId(id: string): PeerId {
  return { toString: () => id } as unknown as PeerId;
}

const MA_CONN = {} as MultiaddrConnection;

/** A MultiaddrConnection whose abort is observable — the not-reserving deadline's target. */
function abortableConn(): MultiaddrConnection & { abort: ReturnType<typeof vi.fn> } {
  return { abort: vi.fn() } as unknown as MultiaddrConnection & { abort: ReturnType<typeof vi.fn> };
}

/** Assemble a policy from its two decisions; the reservation half admits by default. */
function policyOf(
  admitInbound: InboundAdmissionPolicy['admitInbound'],
  admitRelayReservation: InboundAdmissionPolicy['admitRelayReservation'] = () => true
): InboundAdmissionPolicy {
  return { admitInbound, admitRelayReservation };
}

function denyingBase(deniedId: string): ConnectionGater {
  return {
    denyDialMultiaddr: () => false,
    denyInboundEncryptedConnection: (peerId) => peerId.toString() === deniedId
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createMembershipConnectionGater (composition + fail-open)', () => {
  it('denies when the policy refuses, admits when it accepts', async () => {
    const policy = policyOf((id) => (id === 'friend' ? 'admit' : 'deny'));
    const gater = createMembershipConnectionGater(policy);

    expect(await gater.denyInboundEncryptedConnection!(fakePeerId('friend'), MA_CONN)).toBe(false);
    expect(await gater.denyInboundEncryptedConnection!(fakePeerId('stranger'), MA_CONN)).toBe(true);
  });

  it('honors a base-gater deny even when the policy would admit', async () => {
    const gater = createMembershipConnectionGater(policyOf(() => 'admit'), denyingBase('blocked'));

    expect(await gater.denyInboundEncryptedConnection!(fakePeerId('blocked'), MA_CONN)).toBe(true);
    expect(await gater.denyInboundEncryptedConnection!(fakePeerId('anyone-else'), MA_CONN)).toBe(false);
  });

  it('still applies the policy when the base gater admits', async () => {
    const gater = createMembershipConnectionGater(policyOf(() => 'deny'), denyingBase('blocked'));

    expect(await gater.denyInboundEncryptedConnection!(fakePeerId('anyone'), MA_CONN)).toBe(true);
  });

  it('preserves the base gater\'s other hooks unchanged', async () => {
    const gater = createMembershipConnectionGater(policyOf(() => 'admit'), denyingBase('x'));
    // The permissive-dial hook browsers rely on must survive the composition.
    expect(await gater.denyDialMultiaddr!(undefined as never)).toBe(false);
  });

  it('fails open (admits) when the policy throws — the stream gates stay the fail-closed layer', async () => {
    const policy = policyOf(() => { throw new Error('control DB torn down mid-check'); });
    const gater = createMembershipConnectionGater(policy);

    expect(await gater.denyInboundEncryptedConnection!(fakePeerId('anyone'), MA_CONN)).toBe(false);
  });

  it('fails open (admits) when the decision outstays its deadline — never wedges the inbound upgrade', async () => {
    let settle: (() => void) | undefined;
    const policy = policyOf(
      // A control-DB read that pulls over the network and never comes back.
      () => new Promise<InboundConnectionVerdict>((resolve) => { settle = () => resolve('deny'); })
    );
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

// ── the relay-reservation seam (admit-for-relay + denyInboundRelayReservation) ─

describe('createMembershipConnectionGater (relay-reservation seam)', () => {
  it('admits an admit-for-relay connection, then aborts it when no reservation is admitted in time', async () => {
    const maConn = abortableConn();
    const gater = createMembershipConnectionGater(policyOf(() => 'admit-for-relay'), undefined, 2_000, 30);

    expect(await gater.denyInboundEncryptedConnection!(fakePeerId('unplaced'), maConn)).toBe(false);
    expect(maConn.abort).not.toHaveBeenCalled();
    await delay(90);
    expect(maConn.abort).toHaveBeenCalledTimes(1);
  });

  it('an admitted reservation disarms the not-reserving deadline', async () => {
    const maConn = abortableConn();
    const gater = createMembershipConnectionGater(policyOf(() => 'admit-for-relay', () => true), undefined, 2_000, 30);

    expect(await gater.denyInboundEncryptedConnection!(fakePeerId('unplaced'), maConn)).toBe(false);
    expect(await gater.denyInboundRelayReservation!(fakePeerId('unplaced'))).toBe(false);
    await delay(90);
    expect(maConn.abort).not.toHaveBeenCalled();
  });

  it('a REFUSED reservation leaves the deadline armed — the connection still gets dropped', async () => {
    const maConn = abortableConn();
    const gater = createMembershipConnectionGater(policyOf(() => 'admit-for-relay', () => false), undefined, 2_000, 30);

    expect(await gater.denyInboundEncryptedConnection!(fakePeerId('unplaced'), maConn)).toBe(false);
    expect(await gater.denyInboundRelayReservation!(fakePeerId('unplaced'))).toBe(true);
    await delay(90);
    expect(maConn.abort).toHaveBeenCalledTimes(1);
  });

  it('a plain admit arms no deadline', async () => {
    const maConn = abortableConn();
    const gater = createMembershipConnectionGater(policyOf(() => 'admit'), undefined, 2_000, 30);

    expect(await gater.denyInboundEncryptedConnection!(fakePeerId('member'), maConn)).toBe(false);
    await delay(90);
    expect(maConn.abort).not.toHaveBeenCalled();
  });

  it('honors a base-gater reservation deny even when the policy would admit', async () => {
    const base: ConnectionGater = { denyInboundRelayReservation: (peerId) => peerId.toString() === 'blocked' };
    const gater = createMembershipConnectionGater(policyOf(() => 'admit', () => true), base);

    expect(await gater.denyInboundRelayReservation!(fakePeerId('blocked'))).toBe(true);
    expect(await gater.denyInboundRelayReservation!(fakePeerId('anyone-else'))).toBe(false);
  });

  it('fails open (admits the reservation) when the reservation policy throws', async () => {
    const gater = createMembershipConnectionGater(
      policyOf(() => 'admit', () => { throw new Error('control DB torn down mid-check'); })
    );

    expect(await gater.denyInboundRelayReservation!(fakePeerId('anyone'))).toBe(false);
  });

  it('fails open via the deadline when the reservation decision never settles', async () => {
    let settle: (() => void) | undefined;
    const gater = createMembershipConnectionGater(
      policyOf(() => 'admit', () => new Promise<boolean>((resolve) => { settle = () => resolve(false); })),
      undefined,
      20
    );

    expect(await gater.denyInboundRelayReservation!(fakePeerId('anyone'))).toBe(false);
    settle?.();
  });
});

// ── UnauthorizedReservationBudget ───────────────────────────────────────────

describe('UnauthorizedReservationBudget', () => {
  it('admits up to the cap, refuses beyond it, and never double-counts a refresh', () => {
    const budget = new UnauthorizedReservationBudget(2, 1_000);

    expect(budget.tryAdmit('a', 0)).toBe(true);
    expect(budget.tryAdmit('a', 100)).toBe(true); // refresh, not a second slot
    expect(budget.tryAdmit('b', 200)).toBe(true);
    expect(budget.tryAdmit('c', 300)).toBe(false);
    expect(budget.size).toBe(2);
  });

  it('frees a slot when an entry expires, and a refresh extends the expiry', () => {
    const budget = new UnauthorizedReservationBudget(1, 1_000);

    expect(budget.tryAdmit('a', 0)).toBe(true);
    expect(budget.tryAdmit('b', 500)).toBe(false);
    expect(budget.tryAdmit('a', 900)).toBe(true); // refreshed: now expires at 1_900
    expect(budget.tryAdmit('b', 1_500)).toBe(false);
    expect(budget.tryAdmit('b', 1_900)).toBe(true); // a's refreshed entry lapsed
  });

  it('a cap of zero refuses everyone', () => {
    const budget = new UnauthorizedReservationBudget(0, 1_000);
    expect(budget.tryAdmit('a', 0)).toBe(false);
    expect(budget.size).toBe(0);
  });
});

// ── CadreNode.admitInboundControlConnection decision matrix ─────────────────

function verdictOf(node: CadreNode, remotePeerId: string): Promise<InboundConnectionVerdict> {
  return (node as unknown as {
    admitInboundControlConnection(remotePeerId: string): Promise<InboundConnectionVerdict>;
  }).admitInboundControlConnection(remotePeerId);
}

/**
 * Boolean view of the verdict for the matrix below — every config here runs
 * WITHOUT a relay server, so "not denied" and `'admit'` coincide; the
 * relay-enabled `'admit-for-relay'` verdict has its own describe further down.
 */
async function admit(node: CadreNode, remotePeerId: string): Promise<boolean> {
  return (await verdictOf(node, remotePeerId)) !== 'deny';
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

  it('denies a member whose StampId is retired in Revocation, still admitting its live sibling', async () => {
    const node = new CadreNode(createConfig());
    const owner = makeOwner();
    const revoked = vouchedRow(MEMBER, owner);
    const survivor = vouchedRow('peer-member-2', owner);
    // The gate delegates to the same authorized-membership predicate the
    // authorized-surface spec pins, so a removed peer that dials in must be refused
    // even while its (still valid, still anchored) voucher row is locally visible —
    // the cross-node convergence state the read-side revocation filter exists for.
    inject(node, {
      members: [revoked, survivor],
      anchor: await anchorWith('p', owner.publicKey),
      revoked: new Set([revoked.stampId!])
    });

    expect(await admit(node, MEMBER)).toBe(false);
    expect(await admit(node, 'peer-member-2')).toBe(true);
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
      policyOf((id) => verdictOf(node, id)),
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

// ── the relay-enabled verdict ───────────────────────────────────────────────

describe('CadreNode.admitInboundControlConnection (relay-enabled verdict)', () => {
  async function establishedNode(extra: Parameters<typeof createConfig>[1]): Promise<CadreNode> {
    const node = new CadreNode(createConfig([], extra));
    const owner = makeOwner();
    inject(node, {
      members: [vouchedRow(MEMBER, owner)],
      anchor: await anchorWith('p', owner.publicKey)
    });
    return node;
  }

  it('turns the steady-state deny into admit-for-relay when network.enableRelay is on', async () => {
    const node = await establishedNode({ network: { enableRelay: true } });

    expect(await verdictOf(node, STRANGER)).toBe('admit-for-relay');
    expect(await verdictOf(node, MEMBER)).toBe('admit');
  });

  it('storage profile implies the relay server, so it implies the relay verdict too', async () => {
    const node = await establishedNode({ profile: 'storage' });

    expect(await verdictOf(node, STRANGER)).toBe('admit-for-relay');
  });

  it('an explicit enableRelay:false wins over the storage-profile default — plain deny', async () => {
    const node = await establishedNode({ profile: 'storage', network: { enableRelay: false } });

    expect(await verdictOf(node, STRANGER)).toBe('deny');
  });
});

// ── CadreNode.admitControlRelayReservation decision matrix ──────────────────

function admitReservation(node: CadreNode, remotePeerId: string): Promise<boolean> {
  return (node as unknown as {
    admitControlRelayReservation(remotePeerId: string): Promise<boolean>;
  }).admitControlRelayReservation(remotePeerId);
}

function budgetOf(node: CadreNode): UnauthorizedReservationBudget {
  return (node as unknown as { unauthorizedRelayReservations: UnauthorizedReservationBudget }).unauthorizedRelayReservations;
}

describe('CadreNode.admitControlRelayReservation', () => {
  async function establishedNode(cap?: number): Promise<CadreNode> {
    const node = new CadreNode(createConfig([], {
      network: { enableRelay: true, ...(cap !== undefined ? { unauthorizedRelayReservationCap: cap } : {}) }
    }));
    const owner = makeOwner();
    inject(node, {
      members: [vouchedRow(MEMBER, owner)],
      anchor: await anchorWith('p', owner.publicKey)
    });
    return node;
  }

  it('admits an authorized member without spending the budget', async () => {
    const node = await establishedNode();

    expect(await admitReservation(node, MEMBER)).toBe(true);
    expect(budgetOf(node).size).toBe(0);
  });

  it('admits an announced delegate without spending the budget', async () => {
    const node = await establishedNode();
    node.grantDelegateAdmission(MEMBER, 'strand-1', STRANGER);

    expect(await admitReservation(node, STRANGER)).toBe(true);
    expect(budgetOf(node).size).toBe(0);
  });

  it('admits an unplaced peer on the budget, once — a refresh takes no second slot', async () => {
    const node = await establishedNode();

    expect(await admitReservation(node, STRANGER)).toBe(true);
    expect(await admitReservation(node, STRANGER)).toBe(true);
    expect(budgetOf(node).size).toBe(1);
  });

  it('refuses the peer past the cap while still admitting the member', async () => {
    const node = await establishedNode(2);

    expect(await admitReservation(node, 'peer-unplaced-1')).toBe(true);
    expect(await admitReservation(node, 'peer-unplaced-2')).toBe(true);
    expect(await admitReservation(node, 'peer-unplaced-3')).toBe(false);
    expect(await admitReservation(node, MEMBER)).toBe(true);
  });

  it('a cap of zero restores the strict posture — every unplaced peer refused', async () => {
    const node = await establishedNode(0);

    expect(await admitReservation(node, STRANGER)).toBe(false);
    expect(await admitReservation(node, MEMBER)).toBe(true);
  });

  it('admits everyone while the authorized set is empty (cold start), spending nothing', async () => {
    const node = new CadreNode(createConfig([], { network: { enableRelay: true } }));
    const owner = makeOwner();
    inject(node, {
      members: [bareRow(MEMBER)],
      anchor: await anchorWith('p', owner.publicKey)
    });

    expect(await admitReservation(node, STRANGER)).toBe(true);
    expect(budgetOf(node).size).toBe(0);
  });

  it('admits everyone before start / after teardown (shared baseline)', async () => {
    const stopped = new CadreNode(createConfig([], { network: { enableRelay: true } }));
    inject(stopped, { running: false, members: [], anchor: await anchorWith('p', makeOwner().publicKey) });

    expect(await admitReservation(stopped, STRANGER)).toBe(true);
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
