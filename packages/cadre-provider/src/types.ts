/**
 * Type definitions for the Sereus Cadre Provider service.
 */

import type { ContainerHealthStatus } from './service/container-health.js';

// ============================================================================
// Container Types
// ============================================================================

/**
 * The party a container that waits to be claimed is started with. A claimed node takes
 * its party from the claim, so this is the placeholder cadre-host and the cadre-cli README
 * use for a node whose cadre is not known yet; `readStatus`'s fold replaces it on the
 * record once the node reports the claim.
 */
export const UNCLAIMED_PARTY_ID = 'unclaimed';

/** How the caller asks for a container to get into its cadre (`POST /containers` `join`). */
export type ContainerJoinRequest =
  | { kind: 'claim' }
  | { kind: 'invitation'; invitation: string };

/**
 * How a container gets into a cadre, with the credential the node is started with. Stored
 * on the record (a provider restart must reproduce the environment) and redacted on the
 * wire to `{ kind }`: the claim secret is handed only to `GET /containers/:id/code`, and
 * the invitation bundle carries the invitation's private key.
 */
export type ContainerJoin =
  | { kind: 'claim'; secret: string }          // CADRE_CLAIM_SECRET, minted by ContainerService
  | { kind: 'invitation'; invitation: string }; // CADRE_INVITATION, the bundle as submitted

/**
 * The join as the node last reported it on `/status`; absent on a seed-path container and
 * before the first read. Self-contained, so a reader of this field alone knows the owner
 * and party a claim named; the record's own `partyId` and `ownerKey` carry the same two
 * values so a list row names the real cadre without the node's report.
 */
export type ContainerJoinState =
  | { kind: 'claim'; state: 'awaiting' }
  | { kind: 'claim'; state: 'claimed'; ownerKey: string; partyId: string }
  | { kind: 'invitation'; state: 'pending' }
  | { kind: 'invitation'; state: 'accepted'; memberPeerId?: string }
  | { kind: 'invitation'; state: 'failed'; error: string; retryable: boolean };

/** Container status lifecycle */
export type ContainerStatus =
  | 'pending'      // Container requested, not yet created
  | 'creating'     // Container being provisioned
  | 'enrolling'    // Container started, awaiting enrollment
  | 'running'      // Container running and enrolled
  | 'stopping'     // Container shutting down
  | 'stopped'      // Container terminated
  | 'error';       // Container in error state

/** Container resource specifications */
export interface ContainerResources {
  /** Memory limit (e.g., "512M", "2G") */
  memoryLimit?: string;
  /** CPU limit (e.g., "0.5", "2") */
  cpuLimit?: string;
  /** Storage quota in bytes */
  storageQuotaBytes?: number;
}

/** Container configuration for creation */
export interface CreateContainerRequest {
  /** Customer/user ID who owns this container */
  customerId: string;
  /** Party ID for the control network */
  partyId: string;
  /** Bootstrap nodes for the control network */
  bootstrapNodes: string[];
  /** Node profile: storage or transaction */
  profile: 'storage' | 'transaction';
  /** Resource specifications */
  resources?: ContainerResources;
  /** Optional strand filter */
  strandFilter?: string;
  /** Optional tags for the container */
  tags?: Record<string, string>;
  /**
   * Base64url owner public key(s) this tenant's node should trust as seed
   * signers. A fresh node's node-local trusted-owner store is empty and nothing
   * replicated can fill it, so without at least one key here the node refuses
   * every seed the provider later delivers (`PUT /containers/:id/seed`).
   *
   * Supplied per create request by the tenant that owns the container — there is
   * deliberately no provider-level default, since a shared pin would let one
   * tenant's owner seed another tenant's node. Key *encoding* is not validated: a
   * malformed key simply never matches a real seed signer and the node refuses
   * the seed with the trust policy's reason. Entries are trimmed, blanks dropped
   * and duplicates collapsed before the container record is written, so a list of
   * only blanks is equivalent to omitting the field.
   */
  pinnedOwnerKeys?: string[];
  /**
   * How the container gets into its cadre without the provider ever holding an owner key
   * or a seed: it waits to be claimed with a one-time code (`claim`), or it redeems an
   * owner-minted cadre invitation at a member that is online (`invitation`). With `claim`,
   * `partyId` is {@link UNCLAIMED_PARTY_ID} and `bootstrapNodes` is empty; with
   * `invitation`, `partyId` is the bundle's. Neither takes `pinnedOwnerKeys`: the claim
   * names the owner, and the bundle carries the owner keys the node pins itself. Absent:
   * the seed path (`pinnedOwnerKeys` + `PUT /containers/:id/seed`).
   */
  join?: ContainerJoinRequest;
}

/** Container record in the provider database */
export interface Container {
  /** Unique container ID */
  id: string;
  /** Customer/user ID */
  customerId: string;
  /** Party ID for the control network */
  partyId: string;
  /** Node profile */
  profile: 'storage' | 'transaction';
  /** Current status */
  status: ContainerStatus;
  /** Docker container ID */
  dockerId?: string;
  /** Resource specifications */
  resources: ContainerResources;
  /** Container tags */
  tags: Record<string, string>;
  /** Creation timestamp */
  createdAt: Date;
  /** Last updated timestamp */
  updatedAt: Date;
  /** Error message if status is 'error' */
  error?: string;
  /** Health check endpoint URL */
  healthEndpoint?: string;
  /** Metrics endpoint URL */
  metricsEndpoint?: string;
  /** Seed API endpoint URL (for applying seeds) */
  seedEndpoint?: string;
  /**
   * Bearer token gating the container's `POST /seed` route (injected as
   * `CADRE_SEED_TOKEN` at provision time). `applySeed` presents it as
   * `Authorization: Bearer <seedToken>`; without it the container rejects the seed.
   */
  seedToken?: string;
  /**
   * libp2p peer id the node reported when it first came up healthy. Durable
   * across restarts (the node keeps one identity for the life of its volume),
   * so a tenant can be told which peer id is theirs without a live round-trip.
   * Multiaddrs are NOT recorded here — those genuinely change, so
   * `ContainerService.getPeerInfo` keeps reading them live.
   */
  peerId?: string;
  /**
   * Owner key(s) the node was started with pinned as seed-trust anchors — the
   * normalized create-request list, and the authority `provisionContainer` reads
   * when it hands pins to the orchestrator (so a re-provision from the record
   * alone reproduces them, and an operator debugging a refused seed sees exactly
   * what the node was told to trust). Absent means the node accepts no seed at
   * all. Not a secret — these are public keys — so it is not redacted on the API
   * boundary.
   *
   * NOTE: pins are settable only at create time; a tenant that needs different
   * anchors recreates the container. If owner-key rotation without a recreate is
   * ever required, this field needs an update path *and* a way to push the new
   * pin into the already-running node (the env var is read once at start).
   */
  pinnedOwnerKeys?: string[];
  /**
   * How the container gets into its cadre, with the credential its environment carries.
   * Absent on a seed-path container. Redacted on the wire; see {@link ContainerJoin}.
   */
  join?: ContainerJoin;
  /** The join as the node last reported it; see {@link ContainerJoinState}. */
  joinState?: ContainerJoinState;
  /**
   * The owner key (base64url) the claim named, written when a `/status` read folds the
   * claim. A public key, so not redacted. Absent before the claim and on every other
   * container.
   */
  ownerKey?: string;
}

/** A container as the API returns it: no seed token, and the join reduced to its kind. */
export type RedactedContainer = Omit<Container, 'seedToken' | 'join'> & { join?: { kind: ContainerJoin['kind'] } };

/** Container status response */
export interface ContainerStatusResponse {
  container: Container;
  /**
   * Live `/status` payload from the container's health server, or `undefined`
   * when unavailable. Strand counts live under `health.node.strands` (matching
   * the real wire shape) — read them as `health?.node?.strands?.active ?? 0`.
   */
  health?: ContainerHealthStatus;
}

// ============================================================================
// Billing Types
// ============================================================================

/** Usage metrics for billing */
export interface UsageMetrics {
  /** Container ID */
  containerId: string;
  /** Measurement period start */
  periodStart: Date;
  /** Measurement period end */
  periodEnd: Date;
  /** Uptime in seconds */
  uptimeSeconds: number;
  /** Storage used in bytes */
  storageBytes: number;
  /** Bandwidth in bytes (egress) */
  bandwidthBytes: number;
  /** Number of active strands (peak) */
  peakStrands: number;
}

/** Billing plan definition */
export interface BillingPlan {
  /** Plan ID */
  id: string;
  /** Plan name */
  name: string;
  /** Price per hour in cents */
  pricePerHourCents: number;
  /** Storage included in bytes */
  storageIncludedBytes: number;
  /** Price per GB-month for additional storage in cents */
  storageOverageCentsPerGbMonth: number;
  /** Bandwidth included in bytes */
  bandwidthIncludedBytes: number;
  /** Price per GB for additional bandwidth in cents */
  bandwidthOverageCentsPerGb: number;
  /** Maximum containers allowed */
  maxContainers: number;
}

/** Customer billing status */
export interface CustomerBilling {
  /** Customer ID */
  customerId: string;
  /** Current billing plan */
  planId: string;
  /** Current balance in cents (negative = credit) */
  balanceCents: number;
  /** Payment method on file */
  paymentMethodId?: string;
  /** Billing email */
  billingEmail?: string;
  /** Current period start */
  currentPeriodStart: Date;
  /** Current period end */
  currentPeriodEnd: Date;
}

// ============================================================================
// API Types
// ============================================================================

/** API key record */
export interface ApiKey {
  /** Hashed key (for lookup) */
  keyHash: string;
  /** Customer ID */
  customerId: string;
  /** Key name/description; `oauth:<clientId>` for an access token the built-in OAuth endpoints minted */
  name: string;
  /** Key permissions */
  permissions: string[];
  /** Creation timestamp */
  createdAt: Date;
  /** Last used timestamp */
  lastUsedAt?: Date;
  /** Expiration timestamp (optional) */
  expiresAt?: Date;
}

// ============================================================================
// OAuth records (the built-in authorize and token endpoints)
// ============================================================================
//
// Both hold the SHA-256 hex of the secret, as `ApiKey.keyHash` does: the raw code exists only
// in the redirect and the raw tokens only in the token response. Each is taken (read and
// deleted) when presented, so a code is single-use and a refresh token rotates.

/** An authorization code issued by `GET`/`POST /oauth/authorize`, pending its exchange. */
export interface AuthorizationCode {
  /** SHA-256 hex of the code (for lookup) */
  codeHash: string;
  /** The client the code was issued to; the exchange must name the same one */
  clientId: string;
  /** The customer the operator's site (or the dev page) resolved */
  customerId: string;
  /** The scopes granted, already checked against the client's allowance */
  scopes: string[];
  /** The S256 challenge the exchange's verifier must hash to */
  codeChallenge: string;
  /** The redirect URI the code was sent to; the exchange must repeat it */
  redirectUri: string;
  /** After this the code is refused (and deleted when presented) */
  expiresAt: Date;
}

/** A refresh token issued with an access token by `POST /oauth/token`. */
export interface RefreshToken {
  /** SHA-256 hex of the token (for lookup) */
  tokenHash: string;
  /** The client it was issued to; a refresh must name the same one */
  clientId: string;
  /** Customer ID */
  customerId: string;
  /** The scopes the new pair is minted with */
  scopes: string[];
  /** `ApiKey.keyHash` of the access token issued alongside, deleted on rotation */
  accessKeyHash: string;
  /** After this the token is refused (and deleted when presented) */
  expiresAt: Date;
}

