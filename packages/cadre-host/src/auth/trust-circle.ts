import { randomBytes } from 'node:crypto';
import debug from 'debug';

import type { CadreInvite } from '@serfab/cadre-core';

import { AuthorityNodeUnavailableError } from '../authority/authority-node-client.js';

import type { TrustCircleStore } from './trust-circle-store.js';
import type {
  PendingInvite,
  TrustCircleHandlers,
  TrustCircleMember,
  TrustCircleSnapshot,
} from './types.js';
import { TrustCircleError } from './types.js';

const log = debug('cadre:host:trust-circle');

/** Default invite lifetime: 24 hours. */
export const DEFAULT_INVITE_TTL_MS = 24 * 60 * 60 * 1000;

/** Token byte length (base64url-encoded; ~43 chars). */
const TOKEN_BYTES = 32;

/** Constructor options. */
export interface TrustCircleServiceOptions {
  /** The host's cadre node — provides createInvite / acceptPhone / removePeer. */
  cadreNode: CadreNodeLike;
  /** Local labels + pending-invites store. */
  store: TrustCircleStore;
  /** Clock override for tests. */
  now?: () => Date;
}

/**
 * Minimal slice of CadreNode that the service uses. Defined as an interface
 * (rather than reaching into CadreNode directly) so unit tests can inject
 * a mock without standing up a real libp2p node.
 */
export interface CadreNodeLike {
  createInvite(token?: string, expiresIn?: number): Promise<{ invite: CadreInvite; encodedInvite: string }>;
  acceptPhone(options: { phonePeerId: string; token?: string }, issuedInvite?: CadreInvite): Promise<void>;
  removePeer(peerId: string): Promise<void>;
  encodeInvite(invite: CadreInvite): string;
  /** Enumerate the cadre's `CadrePeer` membership (over the admin channel). */
  listMembers(): Promise<Array<{ peerId: string; multiaddr: string | null }>>;
  /** Probe whether a peer is a `CadrePeer` member (over the admin channel). */
  isMember(peerId: string): Promise<boolean>;
}

/**
 * TrustCircleService — orchestrates invite issuance, redemption, and
 * membership management.
 *
 * Membership is canonical in the cadre control DB (`CadrePeer` table),
 * reached over the authority node's admin channel; labels and pending tokens
 * live in the host-local `TrustCircleStore`. When the node is unreachable,
 * authority operations surface `node_unavailable` (→ 503) and `list()`
 * degrades to the local labels file.
 */
export class TrustCircleService {
  private readonly cadreNode: CadreNodeLike;
  private readonly store: TrustCircleStore;
  private readonly now: () => Date;

  constructor(opts: TrustCircleServiceOptions) {
    this.cadreNode = opts.cadreNode;
    this.store = opts.store;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Issue a new invite. Generates a token, persists a pending row, and
   * delegates to cadre-core to embed the host's authority addresses.
   */
  async issueInvite(opts: { label: string; ttlMs?: number }): Promise<{
    encodedInvite: string;
    invite: CadreInvite;
    token: string;
    expiresAt?: Date;
  }> {
    const label = normaliseLabel(opts.label);
    const ttlMs = opts.ttlMs ?? DEFAULT_INVITE_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new TrustCircleError('invalid_token', `Invalid ttlMs: ${ttlMs}`);
    }

    const token = generateToken();
    const created = this.now();
    const expiresAt = new Date(created.getTime() + ttlMs);

    const { invite, encodedInvite } = await this.cadreNode
      .createInvite(token, ttlMs)
      .catch((err) => this.toDomainError(err));

    const pending: PendingInvite = {
      token,
      label,
      createdAt: created.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    this.store.addPending(pending);

    log('issued invite for "%s" (token=%s, expires=%s)', label, token, expiresAt.toISOString());

    return { encodedInvite, invite, token, expiresAt };
  }

  /**
   * Redeem an invite for an incoming peer ID. On success:
   *   - cadre-core authorizes the peer (inserts CadrePeer row).
   *   - The pending row is consumed (one-time enforcement).
   *   - A labelled member row is written locally.
   */
  async redeemInvite(opts: { token: string; peerId: string }): Promise<{ peerId: string; label: string }> {
    const { token, peerId } = opts;
    if (!token || !peerId) {
      throw new TrustCircleError('invalid_token', 'token and peerId are required');
    }

    // Atomically claim the pending row before doing async work. This closes
    // the race between two concurrent redemption requests for the same token —
    // only the call that wins the synchronous removePending() proceeds; the
    // other gets `already_redeemed`. The remove is durable (write-then-rename),
    // so a crash after this point loses the token, which is the safe failure
    // mode for a one-time credential.
    const pending = this.store.getPending(token);
    if (!pending || !this.store.removePending(token)) {
      // Either never issued, or another concurrent caller just consumed it.
      throw new TrustCircleError('already_redeemed', 'Invite not found or already redeemed');
    }

    if (pending.expiresAt) {
      const expiresAt = new Date(pending.expiresAt);
      if (Number.isFinite(expiresAt.getTime()) && this.now() > expiresAt) {
        // Already removed above — just surface the expiry.
        throw new TrustCircleError('expired', 'Invite has expired');
      }
    }

    // Reconstruct the CadreInvite that was originally issued. cadre-core's
    // acceptPhone validates `issuedInvite.token === options.token` (already
    // matches by construction) and re-checks expiration.
    const reconstructed: CadreInvite = {
      partyId: '',
      authorityAddrs: [],
      token: pending.token,
      createdAt: new Date(pending.createdAt).getTime(),
      ...(pending.expiresAt ? { expiresAt: new Date(pending.expiresAt).getTime() } : {}),
    };

    await this.cadreNode
      .acceptPhone({ phonePeerId: peerId, token }, reconstructed)
      .catch((err) => this.toDomainError(err));

    // If the member write fails the peer is still authorized in CadrePeer —
    // the next call to list() will pick it up unlabeled, which is the
    // documented graceful degradation.
    const member: TrustCircleMember = {
      peerId,
      label: pending.label,
      addedAt: this.now().toISOString(),
    };
    this.store.addMember(member);

    log('redeemed invite for "%s" (peerId=%s, token=%s)', pending.label, peerId, token);

    return { peerId, label: pending.label };
  }

  /** Revoke a pending invite by token. No-op if not found. */
  async revokePending(token: string): Promise<void> {
    if (!this.store.removePending(token)) {
      throw new TrustCircleError('not_found', `Unknown pending invite: ${token}`);
    }
    log('revoked pending invite (token=%s)', token);
  }

  /**
   * Remove an authorised member. Deletes the CadrePeer row and the local
   * label. Throws not_found when the peer is in neither place.
   */
  async removeMember(peerId: string): Promise<void> {
    const inLocal = this.store.getMember(peerId);
    const inControl = await this.isMember(peerId);

    if (!inLocal && !inControl) {
      throw new TrustCircleError('not_found', `Unknown member: ${peerId}`);
    }

    if (inControl) {
      await this.cadreNode.removePeer(peerId).catch((err) => this.toDomainError(err));
    }
    if (inLocal) {
      this.store.removeMember(peerId);
    }
    log('removed member peerId=%s', peerId);
  }

  /** Whether the peer is present in the cadre's CadrePeer table. */
  async isMember(peerId: string): Promise<boolean> {
    try {
      return await this.cadreNode.isMember(peerId);
    } catch (err) {
      this.toDomainError(err);
    }
  }

  /**
   * UI snapshot. Joins the canonical CadrePeer list (fetched over the admin
   * channel) with local labels; prunes any orphan labels (peer is no longer
   * authorised). When the authority node is unreachable, degrades to the
   * local labels file so listing keeps working while the node is down.
   */
  async list(): Promise<TrustCircleSnapshot> {
    const labels = new Map<string, Omit<TrustCircleMember, 'peerId'>>();
    for (const m of this.store.listMembers()) {
      labels.set(m.peerId, { label: m.label, addedAt: m.addedAt, ...(m.self ? { self: true } : {}) });
    }

    const members: TrustCircleMember[] = [];

    // Consult the control DB over the admin channel. A node-unavailable error
    // is non-fatal — fall back to the local labels rather than 503-ing a
    // read-only listing.
    let controlMembers: Array<{ peerId: string }> | null = null;
    try {
      controlMembers = await this.cadreNode.listMembers();
    } catch (err) {
      if (!(err instanceof AuthorityNodeUnavailableError)) throw err;
      controlMembers = null;
    }

    if (controlMembers) {
      const seenPeerIds = new Set<string>();
      for (const { peerId } of controlMembers) {
        seenPeerIds.add(peerId);
        const label = labels.get(peerId);
        members.push({
          peerId,
          label: label?.label ?? peerId,
          addedAt: label?.addedAt ?? '',
          ...(label?.self ? { self: true } : {}),
        });
      }
      // Prune labels for peers that no longer exist in CadrePeer. Only when we
      // successfully consulted the node — otherwise a transient outage would
      // wipe labels.
      for (const peerId of labels.keys()) {
        if (!seenPeerIds.has(peerId)) {
          this.store.removeMember(peerId);
        }
      }
    } else {
      // Node down: return labels as-is (degradation; no pruning).
      for (const [peerId, row] of labels) {
        members.push({ peerId, ...row });
      }
    }

    const pending = this.store.listPending();

    // Sort for stable UI ordering.
    members.sort((a, b) => a.peerId.localeCompare(b.peerId));
    pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return { members, pending };
  }

  /**
   * Translate an admin-channel transport failure into a `node_unavailable`
   * TrustCircleError (→ 503). Re-throws anything else unchanged. Returns
   * `never` so callers can `.catch(err => this.toDomainError(err))`.
   */
  private toDomainError(err: unknown): never {
    if (err instanceof AuthorityNodeUnavailableError) {
      throw new TrustCircleError('node_unavailable', `Authority node unavailable: ${err.message}`);
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Wrap a TrustCircleService into the typed handler shape consumed by
 * `cadre-host-local-ui`. Errors propagate as TrustCircleError; the UI ticket
 * maps `.code` → HTTP status.
 */
export function createTrustCircleHandlers(service: TrustCircleService): TrustCircleHandlers {
  return {
    async postInvite(body) {
      if (!body || typeof body.label !== 'string') {
        throw new TrustCircleError('invalid_label', 'label is required');
      }
      const result = await service.issueInvite({ label: body.label, ttlMs: body.ttlMs });
      return {
        encodedInvite: result.encodedInvite,
        token: result.token,
        ...(result.expiresAt ? { expiresAt: result.expiresAt.toISOString() } : {}),
      };
    },
    async deleteInvite(token) {
      await service.revokePending(token);
    },
    async deleteMember(peerId) {
      await service.removeMember(peerId);
    },
    async listTrustCircle() {
      return await service.list();
    },
  };
}

function generateToken(): string {
  // base64url so it survives in URLs, QR codes, and shell arguments.
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function normaliseLabel(label: unknown): string {
  if (typeof label !== 'string') {
    throw new TrustCircleError('invalid_label', 'label must be a string');
  }
  const trimmed = label.trim();
  if (trimmed.length === 0) {
    throw new TrustCircleError('invalid_label', 'label must not be empty');
  }
  if (trimmed.length > 200) {
    throw new TrustCircleError('invalid_label', 'label must be 200 characters or fewer');
  }
  return trimmed;
}
