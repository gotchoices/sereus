/**
 * Donation grant-token types for cadre-host.
 *
 * A **grant token** is a high-entropy base64url secret the host admin issues,
 * out-of-band (QR / copy-paste), to one *grantee* — a friend or family member
 * whose cadre authority (their phone) may then ask this host to spawn donated
 * nodes. The grantee presents the token as `Authorization: Bearer <grant-token>`
 * on every donation request (the grantee-facing surface lands in the
 * `2-donation-service` ticket).
 *
 * This module owns the grant's identity, expiry, and per-grantee quota. The
 * *live-node tally* it checks the quota against is owned by the donation
 * service, not by the grant layer — see `GrantValidator.validateForProvision`.
 *
 * **Grant ≠ trust-circle membership.** A trust-circle invite (`auth/`)
 * authorises a device to join *the host's own* cadre. A donation grant
 * authorises an external cadre authority to ask the host to spawn a node that
 * joins *the grantee's* cadre. The two token flows are deliberately separate
 * modules; this one reuses the *shape* of the trust-circle store (atomic
 * write-then-rename JSON, token-keyed rows) but with grant — not invite —
 * semantics: a grant is long-lived and reusable up to a quota, never
 * one-time-redeemed.
 */

/** A grant the host admin issued to one grantee (friend/family). */
export interface Grant {
  /** base64url secret; also the bearer credential. The store key. */
  token: string;
  /** Human label chosen by the admin, e.g. "Alice's cadre". Display-only. */
  label: string;
  /** Max concurrently-live donated nodes this grant may hold. */
  maxNodes: number;
  /** ISO timestamp when the grant was issued. */
  createdAt: string;
  /** ISO expiry; absent = no expiry. */
  expiresAt?: string;
  /** Set when the admin revokes; a revoked grant validates as denied. */
  revokedAt?: string;
}

/** Why a presented grant token was denied. */
export type GrantDenyReason =
  | 'unknown_token'     // no such grant
  | 'expired'
  | 'revoked'
  | 'quota_exceeded';   // live node count already at maxNodes

/** Result of validating a presented bearer token. */
export interface GrantValidation {
  ok: boolean;
  /** The matched grant, when the token names one (present even on some denials). */
  grant?: Grant;
  /** Set when `ok` is false. */
  reason?: GrantDenyReason;
}

/**
 * The slice `2-donation-service` depends on. Keeps that ticket decoupled from
 * the store implementation: it holds a `GrantValidator`, not a `GrantStore`.
 *
 * Both methods are pure functions of the store state (and, for provision, the
 * caller-supplied count) — they never throw for a bad token, they return a
 * denial. Issuance/revocation (which mutate) live on `GrantService`.
 */
export interface GrantValidator {
  /**
   * Validate a presented bearer token for a *new* provision request.
   *
   * `liveNodeCount(token)` is supplied by the donation service — the grant
   * layer owns identity/expiry/revocation; the donation service owns the
   * authoritative live-node tally (it holds the grant→node records). The count
   * is only consulted once identity/expiry/revocation have passed, so an
   * unknown or dead token never invokes it.
   */
  validateForProvision(
    token: string,
    liveNodeCount: (token: string) => number,
  ): GrantValidation;
  /**
   * Validate for a non-provisioning op (peer/seed/terminate): identity + not
   * expired/revoked. No quota check.
   */
  validate(token: string): GrantValidation;
}

/** On-disk shape of `grants.json`. */
export interface GrantFile {
  version: 1;
  /** keyed by token. */
  grants: Record<string, Omit<Grant, 'token'>>;
}

/**
 * Typed handlers exposed to the loopback management server for the **admin**
 * grant surface (`/grants-admin`). Distinct from the grantee-facing `/grants`
 * provisioning surface (`2-donation-service`): the admin surface is loopback,
 * no bearer — same-machine admin, matching cadre-host's local-UI "no login"
 * posture.
 *
 * Handlers throw a `GrantError` whose `.code` the server maps to an HTTP
 * status (see `server/error-handler.ts`).
 */
export interface GrantAdminHandlers {
  postGrant(body: { label: string; maxNodes?: number; ttlMs?: number }): Promise<{ grant: Grant }>;
  listGrants(): Promise<{ grants: Grant[] }>;
  deleteGrant(token: string): Promise<void>;
}

/** Error codes thrown by GrantStore / GrantService. */
export type GrantErrorCode =
  | 'not_found'          // unknown token on revoke
  | 'invalid_label'
  | 'invalid_max_nodes'
  | 'invalid_ttl'
  | 'storage_error';

/** Typed error carrying a stable `code` for HTTP mapping. */
export class GrantError extends Error {
  readonly code: GrantErrorCode;

  constructor(code: GrantErrorCode, message: string) {
    super(message);
    this.name = 'GrantError';
    this.code = code;
  }
}
