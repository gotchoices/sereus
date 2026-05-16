/**
 * Trust-circle types for cadre-host.
 *
 * The trust circle is the set of devices (peers) authorised to participate
 * in the host's cadre. Membership is stored canonically in the cadre control
 * network's `CadrePeer` table (via cadre-core). This module layers two pieces
 * of *host-local* state on top:
 *
 *   - **Labels**: human-readable names ("Mom's phone") assigned by the host
 *     admin. Display-only; loss just shows the bare peer ID.
 *   - **Pending invites**: tokens that have been issued but not yet redeemed.
 *     Operational state — lives on the issuing node, doesn't replicate.
 *
 * Both live in `<rootDir>/trust-circle.json`, written atomically.
 */

/** An authorised member of the trust circle (matches a `CadrePeer` row). */
export interface TrustCircleMember {
  /** libp2p peer ID. */
  peerId: string;
  /** Display label assigned by the host admin. */
  label: string;
  /** ISO timestamp when the peer was added. */
  addedAt: string;
  /** True if this row represents the host's own cadre node (self-enrolment). */
  self?: boolean;
}

/** An invite that has been issued but not yet redeemed. */
export interface PendingInvite {
  /** Random token (base64url) used to match the redemption. */
  token: string;
  /** Display label that will be assigned to the redeemer on success. */
  label: string;
  /** ISO timestamp when the invite was issued. */
  createdAt: string;
  /** Optional ISO expiration timestamp. */
  expiresAt?: string;
}

/** On-disk shape of `trust-circle.json`. */
export interface TrustCircleFile {
  version: 1;
  /** keyed by peer ID. */
  members: Record<string, Omit<TrustCircleMember, 'peerId'>>;
  /** keyed by token. */
  pendingInvites: Record<string, Omit<PendingInvite, 'token'>>;
}

/** Snapshot returned to the management UI. */
export interface TrustCircleSnapshot {
  members: TrustCircleMember[];
  pending: PendingInvite[];
}

/**
 * Typed HTTP handlers exposed to `cadre-host-local-ui` for Fastify wiring.
 *
 * Handlers take typed objects and either return typed results or throw a
 * `TrustCircleError` whose `.code` the UI ticket maps to an HTTP status:
 *
 *   - `not_found`   → 404 (unknown token / unknown peer)
 *   - `expired`     → 410 (invite past expiresAt)
 *   - `already_redeemed` → 409 (token was used and is gone)
 *   - default       → 500
 */
export interface TrustCircleHandlers {
  postInvite(body: { label: string; ttlMs?: number }): Promise<{
    encodedInvite: string;
    token: string;
    expiresAt?: string;
  }>;
  deleteInvite(token: string): Promise<void>;
  deleteMember(peerId: string): Promise<void>;
  listTrustCircle(): Promise<TrustCircleSnapshot>;
}

/** Error codes thrown by TrustCircleService. */
export type TrustCircleErrorCode =
  | 'not_found'
  | 'expired'
  | 'already_redeemed'
  | 'invalid_label'
  | 'invalid_token'
  | 'storage_error';

/** Typed error carrying a stable `code` for HTTP mapping. */
export class TrustCircleError extends Error {
  readonly code: TrustCircleErrorCode;

  constructor(code: TrustCircleErrorCode, message: string) {
    super(message);
    this.name = 'TrustCircleError';
    this.code = code;
  }
}
