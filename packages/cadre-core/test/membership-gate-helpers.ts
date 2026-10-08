/**
 * Shared harness for the two membership-gate unit suites —
 * `membership-connection-gater.spec.ts` (the fail-open connection gate) and
 * `control-stream-authorization.spec.ts` (the fail-closed per-stream gate).
 * Both exercise private `CadreNode` decision paths against the same injected
 * internals (stubbed control DB rows, node-local trusted-owner anchor,
 * solicitation service), so the row builders and the injector live here once.
 *
 * Not a `*.spec.ts` file, so vitest's `test/**\/*.spec.ts` glob never runs it
 * as a suite (same pattern as `wake-stream-helpers.ts`).
 */

import { generatePrivateKey, getPublicKey, sign } from '@optimystic/quereus-plugin-crypto';
import type { CadreNode } from '../src/cadre-node.js';
import type { CadreNodeConfig } from '../src/types.js';
import { cadrePeerVoucherDigest } from '../src/peer-authorization.js';
import { MemoryTrustedOwnerStore, type TrustedOwnerStore } from '../src/trusted-owner-store.js';

/** A peer with a real anchored voucher in the receiver's rows. */
export const MEMBER = 'peer-member';
/** A peer with no row at all — the outsider the gates exist to refuse. */
export const STRANGER = 'peer-stranger';

export function createConfig(bootstrapNodes: string[] = [], extra: Partial<CadreNodeConfig> = {}): CadreNodeConfig {
  return {
    controlNetwork: {
      partyId: 'membership-gate-test-' + Math.random().toString(36).slice(2),
      bootstrapNodes
    },
    profile: 'transaction',
    ...extra
  };
}

export type PeerRow = {
  peerId: string;
  multiaddr: string | null;
  stampId: string | null;
  vouchOwner: string | null;
  vouchSig: string | null;
  vouchUsage: string | null;
};

export interface Owner { privateKey: string; publicKey: string }

export function makeOwner(): Owner {
  const privateKey = generatePrivateKey('ed25519', 'base64url') as string;
  const publicKey = getPublicKey(privateKey, 'ed25519', 'base64url', 'base64url') as string;
  return { privateKey, publicKey };
}

/** A row carrying a REAL voucher: `owner` signs the tagged, party-bound voucher digest for `partyId` (the receiving node's `CadreNode.partyId`), as insertCadrePeerRow does. */
export function vouchedRow(partyId: string, peerId: string, owner: Owner): PeerRow {
  const stampId = `stamp-${peerId}`;
  const vouchSig = sign(
    cadrePeerVoucherDigest(partyId, peerId, stampId),
    owner.privateKey,
    'ed25519',
    'base64url',
    'base64url',
    'base64url'
  ) as string;
  return { peerId, multiaddr: null, stampId, vouchOwner: owner.publicKey, vouchSig, vouchUsage: null };
}

/** A row with no voucher (addressable but never authorizable). */
export function bareRow(peerId: string): PeerRow {
  return { peerId, multiaddr: null, stampId: null, vouchOwner: null, vouchSig: null, vouchUsage: null };
}

/**
 * How the injected solicitation service answers `hasOutstandingInvitation` —
 * the SOLE input to the formation exemption — and how the fake control DB
 * answers `hasLiveCadreInvite`, the cadre-invitation exemption's. For the
 * solicitation, `undefined` leaves the node with no service at all (the
 * initiator/never-registered case).
 */
export type Outstanding = boolean | 'throws' | 'hangs';

/**
 * The subset of `ControlDatabase` the gate paths touch, as {@link inject} fakes it:
 * the two reads the snapshot is built from, the two the trusted-owner anchor sync at the
 * head of every refresh reads (`CadreNode.syncOwnerAnchor`; empty here, so the sync finds
 * nothing to derive and leaves the injected anchor alone), plus the `CadrePeer` membership
 * hub the node attaches its automatic gate refresh to.
 *
 * `queryCadrePeers` is a field (not a method) so a test can swap in a throwing read;
 * `peerQueries` counts calls, which is how the coalescing assertions prove that N
 * writes shared fewer than N reads.
 */
export interface FakeControlDatabase {
  queryCadrePeers: () => Promise<PeerRow[]>;
  queryRevokedStamps: () => Promise<Set<string>>;
  queryOwnerKeyRows: () => Promise<never[]>;
  queryRevocations: () => Promise<never[]>;
  /**
   * The cadre-invitation exemption's sole input ("does this node hold a live
   * `CadreInvite` row?"); a field so a test can flip it between calls.
   */
  hasLiveCadreInvite: () => Promise<boolean>;
  setMembershipChangeListener: (listener: ((reason: string) => Promise<void>) | null) => void;
  mutateCadrePeer: <T>(reason: string, body: () => Promise<T>) => Promise<T>;
  /** How many times the snapshot read has been issued. */
  peerQueries: number;
  /** The listener the node wired, or null before `inject`-ed nodes are "started". */
  listener: ((reason: string) => Promise<void>) | null;
}

/** The node's private control-DB slot, as the fake fills it. */
export function fakeDb(node: CadreNode): FakeControlDatabase {
  return (node as unknown as { controlDatabase: FakeControlDatabase }).controlDatabase;
}

/**
 * Stand-in for the `CadrePeer` write path: run `body`, then notify the wired
 * listener exactly as `ControlDatabase.mutateCadrePeer` does after a commit — so a
 * throwing body notifies nothing.
 */
function buildFakeDb(members: PeerRow[], revoked: Set<string>, liveInvite: Outstanding): FakeControlDatabase {
  const db: FakeControlDatabase = {
    peerQueries: 0,
    listener: null,
    hasLiveCadreInvite: async () => {
      if (liveInvite === 'throws') {
        throw new Error('control DB torn down mid-invitation-check');
      }
      if (liveInvite === 'hangs') {
        return await new Promise<boolean>(() => { /* never settles */ });
      }
      return liveInvite;
    },
    // The real `ControlDatabase.queryCadrePeers` drops every row whose StampId is
    // retired in `CadreControl.Revocation` BEFORE any reader sees it, so both gates
    // inherit the exclusion without asking for it. The fake has to mirror that or it
    // hands the gates rows the database would never have returned.
    queryCadrePeers: async () => {
      db.peerQueries++;
      return members.filter(row => row.stampId === null || !revoked.has(row.stampId));
    },
    queryRevokedStamps: async () => revoked,
    queryOwnerKeyRows: async () => [],
    queryRevocations: async () => [],
    setMembershipChangeListener: (listener) => { db.listener = listener; },
    mutateCadrePeer: async (reason, body) => {
      const result = await body();
      await db.listener?.(reason);
      return result;
    }
  };
  return db;
}

/** Wire the minimal node internals the admission policies touch. */
export function inject(node: CadreNode, opts: {
  running?: boolean;
  selfPeerId?: string;
  members?: PeerRow[];
  anchor?: TrustedOwnerStore;
  solicitation?: Outstanding;
  /** How the fake control DB answers `hasLiveCadreInvite`; default none live. */
  liveInvite?: Outstanding;
  revoked?: Set<string>;
}): void {
  (node as unknown as { _running: boolean })._running = opts.running ?? true;
  (node as unknown as { controlNode: unknown }).controlNode = {
    peerId: { toString: () => opts.selfPeerId ?? 'self-peer' }
  };
  if (opts.members) {
    const db = buildFakeDb(opts.members, opts.revoked ?? new Set<string>(), opts.liveInvite ?? false);
    (node as unknown as { controlDatabase: unknown }).controlDatabase = db;
    // Same wiring `CadreNode.start()` performs right after the control DB comes up:
    // every committed `CadrePeer` write re-materializes the gate snapshot itself.
    db.setMembershipChangeListener((reason) => node.refreshMembershipGate(reason));
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

export async function anchorWith(partyId: string, ...keys: string[]): Promise<TrustedOwnerStore> {
  const store = new MemoryTrustedOwnerStore(partyId);
  for (const key of keys) {
    await store.trust(key, 'operator');
  }
  return store;
}
