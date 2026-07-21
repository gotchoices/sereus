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

/* ──────────────── donation lifecycle (2-donation-service) ──────────────── */

/**
 * Lifecycle of one donated node:
 *   provisioning  → the child process is being spawned.
 *   awaiting_seed → spawned + reachable; waiting for the requester to present
 *                   its phone-signed seed (`PUT /grants/:id/seed`).
 *   seeded        → the seed was applied; the node has joined the requester's cadre.
 *   error         → provisioning failed (orchestrator resources reclaimed).
 *   terminated    → stopped + removed (kept in the store for audit).
 *
 * A donation is "live" (counts against a grant's `maxNodes` quota) while it is
 * `provisioning`, `awaiting_seed`, or `seeded` — see `DonationStore.liveNodeCount`.
 */
export type DonationStatus =
  | 'provisioning'
  | 'awaiting_seed'
  | 'seeded'
  | 'error'
  | 'terminated';

/**
 * One donated node, tracked host-side and persisted to `donations.json`.
 *
 * The host contributes capacity only: `partyId` is the REQUESTER's cadre (a
 * foreign party), and `seedToken` gates the node's own `POST /seed` — it is
 * minted host-side, persisted here (so a host restart in the request→seed gap
 * can still present the seed), and NEVER returned to the grantee.
 */
export interface Donation {
  /** "grn_<nanoid>" — also the donated node's orchestrator containerId. */
  id: string;
  /** The grant token that authorized this donation (the quota key). */
  grantToken: string;
  /** The REQUESTER's cadre (a foreign party this host merely hosts a node for). */
  partyId: string;
  /** Node profile. Defaults to `storage` so the node participates and is dialable. */
  profile: 'storage' | 'transaction';
  status: DonationStatus;
  /** Orchestrator handle (opaque `pid:token`), set once the child is spawned. */
  dockerId?: string;
  /**
   * Reserved: a donation's live peer identity is read fresh from the node's
   * `/status` on each `getPeer` call and is NOT persisted here — this field is
   * currently never written. Kept for a future cache if `/status` fan-out ever
   * shows up as hot.
   */
  peerId?: string;
  /** The node's loopback `POST /seed` URL. Host-internal — stripped from the wire view. */
  seedEndpoint?: string;
  /** Host↔node bearer gating `POST /seed`. Persisted; NEVER leaves the host. */
  seedToken?: string;
  createdAt: string;
  updatedAt: string;
  /** Failure detail when `status === 'error'`. */
  error?: string;
}

/**
 * Redacted wire shape returned to the grantee: the host-only secrets
 * (`seedToken`) and host-internal loopback URL (`seedEndpoint`) are stripped.
 */
export type DonationView = Omit<Donation, 'seedToken' | 'seedEndpoint'>;

/** On-disk shape of `donations.json`. Keyed by donation id. */
export interface DonationFile {
  version: 1;
  donations: Record<string, Omit<Donation, 'id'>>;
}

/** Error codes thrown by the donation service / grantee-facing routes. */
export type DonationErrorCode =
  | 'unauthorized'        // 401 — missing / unknown grant bearer
  | 'forbidden'           // 403 — revoked or expired grant
  | 'quota_exceeded'      // 429 — grant already at its maxNodes cap
  | 'invalid_request'     // 400 — malformed body
  | 'not_found'           // 404 — no such donation (or not owned by this grant)
  | 'invalid_state'       // 409 — op invalid for the donation's current status
  | 'seed_failed'         // 502 — the node rejected the presented seed
  | 'peer_unavailable'    // 503 — the node has no peer identity yet
  | 'orchestrator_error'  // 500 — spawn / stop failure
  | 'storage_error';      // 500 — donations.json read/write failure

/** Typed donation error carrying a stable `code` for HTTP mapping. */
export class DonationError extends Error {
  readonly code: DonationErrorCode;

  constructor(code: DonationErrorCode, message: string) {
    super(message);
    this.name = 'DonationError';
    this.code = code;
  }
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
