import { randomBytes } from 'node:crypto';
import debug from 'debug';

import type { CadreNode } from '@serfab/cadre-core';
import type { CadreInvite, ControlDatabase } from '@serfab/cadre-core';

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
  getControlDatabase(): ControlDatabase | null;
}

/**
 * TrustCircleService — orchestrates invite issuance, redemption, and
 * membership management.
 *
 * Membership is canonical in the cadre control DB (`CadrePeer` table);
 * labels and pending tokens live in the host-local `TrustCircleStore`.
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

    const { invite, encodedInvite } = await this.cadreNode.createInvite(token, ttlMs);

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

    await this.cadreNode.acceptPhone({ phonePeerId: peerId, token }, reconstructed);

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
      await this.cadreNode.removePeer(peerId);
    }
    if (inLocal) {
      this.store.removeMember(peerId);
    }
    log('removed member peerId=%s', peerId);
  }

  /** Whether the peer is present in the cadre's CadrePeer table. */
  async isMember(peerId: string): Promise<boolean> {
    const db = this.cadreNode.getControlDatabase();
    if (!db) return false;
    const inner = db.getDatabase();
    for await (const row of inner.eval(
      'select PeerId from CadreControl.CadrePeer where PeerId = ?',
      [peerId],
    )) {
      if (row.PeerId === peerId) return true;
    }
    return false;
  }

  /**
   * UI snapshot. Joins the canonical CadrePeer list with local labels;
   * prunes any orphan labels (peer is no longer authorised).
   */
  async list(): Promise<TrustCircleSnapshot> {
    const labels = new Map<string, Omit<TrustCircleMember, 'peerId'>>();
    for (const m of this.store.listMembers()) {
      labels.set(m.peerId, { label: m.label, addedAt: m.addedAt, ...(m.self ? { self: true } : {}) });
    }

    const members: TrustCircleMember[] = [];
    const seenPeerIds = new Set<string>();
    const db = this.cadreNode.getControlDatabase();
    if (db) {
      const inner = db.getDatabase();
      for await (const row of inner.eval('select PeerId from CadreControl.CadrePeer')) {
        const peerId = row.PeerId as string;
        seenPeerIds.add(peerId);
        const label = labels.get(peerId);
        members.push({
          peerId,
          label: label?.label ?? peerId,
          addedAt: label?.addedAt ?? '',
          ...(label?.self ? { self: true } : {}),
        });
      }
    }

    // Prune labels for peers that no longer exist in CadrePeer.
    // Only prune when we successfully consulted the control DB, otherwise
    // we'd wipe labels for a transient connectivity issue.
    if (db) {
      for (const peerId of labels.keys()) {
        if (!seenPeerIds.has(peerId)) {
          this.store.removeMember(peerId);
        }
      }
    } else {
      // Fallback: return labels as-is.
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
