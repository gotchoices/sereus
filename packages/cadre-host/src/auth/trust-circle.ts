import { randomBytes } from 'node:crypto';
import debug from 'debug';

import type { CadreInvite } from '@serfab/cadre-core';

import { OwnerNodeUnavailableError } from '../owner/owner-node-client.js';

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
  /**
   * Enumerate the cadre's *addressable* peers (over the admin channel) —
   * anyone with an address record, including devices no owner vouched for.
   * Used only for {@link removeMember}, where "the row exists" is the point.
   */
  listMembers(): Promise<Array<{ peerId: string; multiaddr: string | null }>>;
  /** Probe whether a peer is *addressable* (over the admin channel). See {@link listMembers}. */
  isMember(peerId: string): Promise<boolean>;
  /**
   * Enumerate the cadre's *authorized* membership (over the admin channel) —
   * devices an owner key vouched for. Excludes the node's own self-published
   * row. This is the real membership test the trust-circle listing shows.
   */
  listAuthorizedMembers(): Promise<Array<{ peerId: string; multiaddr: string | null }>>;
  /** Probe whether a peer is *authorized*. See {@link listAuthorizedMembers}. */
  isAuthorizedMember(peerId: string): Promise<boolean>;
}

/**
 * TrustCircleService — orchestrates invite issuance, redemption, and
 * membership management.
 *
 * Membership is canonical in the cadre control DB (`CadrePeer` table),
 * reached over the owner node's admin channel; labels and pending tokens
 * live in the host-local `TrustCircleStore`. When the node is unreachable,
 * owner operations surface `node_unavailable` (→ 503) and `list()`
 * degrades to the local labels file.
 */
export class TrustCircleService {
  private readonly cadreNode: CadreNodeLike;
  private readonly store: TrustCircleStore;
  private readonly now: () => Date;
  /**
   * In-flight redemption claims (by token). Serialises concurrent redeems
   * for the same token without burning the durable pending row before
   * `acceptPhone` succeeds. Intra-process only — the orchestrator enforces
   * single-process ownership of a given rootDir, so no file lock is needed.
   */
  private readonly inFlightRedemptions = new Set<string>();

  constructor(opts: TrustCircleServiceOptions) {
    this.cadreNode = opts.cadreNode;
    this.store = opts.store;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Issue a new invite. Generates a token, persists a pending row, and
   * delegates to cadre-core to embed the host's owner addresses.
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
   *
   * Ordering: the synchronous *claim* against `inFlightRedemptions` serialises
   * concurrent redeems for the same token (second concurrent caller rejects
   * synchronously before its first await). The durable `removePending` only
   * runs *after* `acceptPhone` succeeds — so a transient `node_unavailable`
   * leaves the token re-redeemable rather than permanently burning it.
   *
   * Crash-safety tradeoff: if the host crashes between `acceptPhone` success
   * and the durable `removePending`, a retry will dial in fine but the
   * owner node's `acceptPhone` will reject the second `CadrePeer` insert
   * with a PK constraint error (cadre-core does not upsert). That surfaces to
   * the redeemer as a non-`node_unavailable` failure; the admin can revoke
   * the lingering pending row. This is a narrower window than the prior
   * behaviour, where *any* transient node outage burned the token.
   */
  async redeemInvite(opts: { token: string; peerId: string }): Promise<{ peerId: string; label: string }> {
    const { token, peerId } = opts;
    if (!token || !peerId) {
      throw new TrustCircleError('invalid_token', 'token and peerId are required');
    }

    const pending = this.store.getPending(token);
    if (!pending) {
      throw new TrustCircleError('already_redeemed', 'Invite not found or already redeemed');
    }

    if (pending.expiresAt) {
      const expiresAt = new Date(pending.expiresAt);
      if (Number.isFinite(expiresAt.getTime()) && this.now() > expiresAt) {
        // Expiry is permanent — reap the pending row durably.
        this.store.removePending(token);
        throw new TrustCircleError('expired', 'Invite has expired');
      }
    }

    // Synchronous in-memory claim. Closes the race between two concurrent
    // redemption requests for the same token — the loser sees the token in
    // the set and rejects synchronously before its first `await`.
    if (this.inFlightRedemptions.has(token)) {
      throw new TrustCircleError('already_redeemed', 'Invite not found or already redeemed');
    }
    this.inFlightRedemptions.add(token);

    try {
      // Reconstruct the CadreInvite that was originally issued. cadre-core's
      // acceptPhone validates `issuedInvite.token === options.token` (already
      // matches by construction) and re-checks expiration.
      const reconstructed: CadreInvite = {
        partyId: '',
        ownerAddrs: [],
        token: pending.token,
        createdAt: new Date(pending.createdAt).getTime(),
        ...(pending.expiresAt ? { expiresAt: new Date(pending.expiresAt).getTime() } : {}),
      };

      await this.cadreNode
        .acceptPhone({ phonePeerId: peerId, token }, reconstructed)
        .catch((err) => this.toDomainError(err));

      // acceptPhone succeeded → durably consume the pending row. If we crash
      // between here and the next line, the token stays pending (re-redeem
      // would fail at acceptPhone with a duplicate-CadrePeer error, not
      // node_unavailable, and the admin can revoke).
      this.store.removePending(token);

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
    } finally {
      this.inFlightRedemptions.delete(token);
    }
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
   *
   * NOTE: no special case for the host's own peer ID — the local UI hides the
   * Remove button on the `self` row, but `DELETE /auth/members/<ownPeerId>`
   * (or `cadre-host trust revoke <ownPeerId>`) will delete the node's own
   * `CadrePeer` row. cadre-core re-registers self on node start, so a restart
   * heals it. If that stops being true, or the removal path grows a
   * non-loopback caller, guard `self` rows here.
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
   * UI snapshot. Joins the *authorized* membership (fetched over the admin
   * channel) with local labels; prunes any orphan labels (peer is no longer
   * authorised). Addressable-but-unauthorized peers — devices that merely
   * published an address record without an owner voucher — are deliberately
   * excluded; this is the listing an operator uses to decide who belongs.
   * The node's own self-published row is spliced back in from the local
   * label, since the authorized set excludes self by design. When the owner
   * node is unreachable, degrades to the local labels file so listing keeps
   * working while the node is down.
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
    let authorizedMembers: Array<{ peerId: string }> | null;
    try {
      authorizedMembers = await this.cadreNode.listAuthorizedMembers();
    } catch (err) {
      if (!(err instanceof OwnerNodeUnavailableError)) throw err;
      authorizedMembers = null;
    }

    if (authorizedMembers) {
      const seenPeerIds = new Set<string>();
      for (const { peerId } of authorizedMembers) {
        seenPeerIds.add(peerId);
        const label = labels.get(peerId);
        members.push({
          peerId,
          label: label?.label ?? peerId,
          addedAt: label?.addedAt ?? '',
          ...(label?.self ? { self: true } : {}),
        });
      }
      // The authorized set excludes the node's own self-published row —
      // splice it back in from the local label rather than dropping it.
      for (const [peerId, row] of labels) {
        if (row.self && !seenPeerIds.has(peerId)) {
          seenPeerIds.add(peerId);
          members.push({ peerId, ...row });
        }
      }
      // Prune labels for peers that are neither authorized nor self. Only
      // when we successfully consulted the node — otherwise a transient
      // outage would wipe labels.
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
    if (err instanceof OwnerNodeUnavailableError) {
      throw new TrustCircleError('node_unavailable', `Owner node unavailable: ${err.message}`);
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
