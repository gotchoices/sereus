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

export function createConfig(bootstrapNodes: string[] = []): CadreNodeConfig {
  return {
    controlNetwork: {
      partyId: 'membership-gate-test-' + Math.random().toString(36).slice(2),
      bootstrapNodes
    },
    profile: 'transaction'
  };
}

export type PeerRow = {
  peerId: string;
  multiaddr: string | null;
  stampId: string | null;
  vouchOwner: string | null;
  vouchSig: string | null;
};

export interface Owner { privateKey: string; publicKey: string }

export function makeOwner(): Owner {
  const privateKey = generatePrivateKey('ed25519', 'base64url') as string;
  const publicKey = getPublicKey(privateKey, 'ed25519', 'base64url', 'base64url') as string;
  return { privateKey, publicKey };
}

/** A row carrying a REAL voucher: `owner` signs the tagged voucher digest, as insertCadrePeerRow does. */
export function vouchedRow(peerId: string, owner: Owner): PeerRow {
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
export function bareRow(peerId: string): PeerRow {
  return { peerId, multiaddr: null, stampId: null, vouchOwner: null, vouchSig: null };
}

/**
 * How the injected solicitation service answers `hasOutstandingInvitation` —
 * the SOLE input to the formation exemption. `undefined` leaves the node with no
 * service at all (the initiator/never-registered case).
 */
export type Outstanding = boolean | 'throws' | 'hangs';

/** Wire the minimal node internals the admission policies touch. */
export function inject(node: CadreNode, opts: {
  running?: boolean;
  selfPeerId?: string;
  members?: PeerRow[];
  anchor?: TrustedOwnerStore;
  solicitation?: Outstanding;
  revoked?: Set<string>;
}): void {
  (node as unknown as { _running: boolean })._running = opts.running ?? true;
  (node as unknown as { controlNode: unknown }).controlNode = {
    peerId: { toString: () => opts.selfPeerId ?? 'self-peer' }
  };
  if (opts.members) {
    (node as unknown as { controlDatabase: unknown }).controlDatabase = {
      queryCadrePeers: async () => opts.members,
      queryRevokedStamps: async () => opts.revoked ?? new Set<string>()
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

export async function anchorWith(partyId: string, ...keys: string[]): Promise<TrustedOwnerStore> {
  const store = new MemoryTrustedOwnerStore(partyId);
  for (const key of keys) {
    await store.trust(key, 'operator');
  }
  return store;
}
