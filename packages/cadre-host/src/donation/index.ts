/**
 * Donation grant-token layer for cadre-host. See ./types.ts, ./grant-store.ts,
 * and ./grant-service.ts.
 *
 * This layer gates *who may ask this host to donate a node*. The lifecycle
 * service that consumes a validated grant to actually provision a node lands in
 * the `2-donation-service` ticket, which imports the `GrantValidator` interface
 * defined here.
 */

export { GrantStore } from './grant-store.js';
export {
  GrantService,
  createGrantAdminHandlers,
  DEFAULT_MAX_NODES,
} from './grant-service.js';
export type { GrantServiceOptions } from './grant-service.js';
export { GrantError, DonationError } from './types.js';
export type {
  Grant,
  GrantDenyReason,
  GrantValidation,
  GrantValidator,
  GrantFile,
  GrantAdminHandlers,
  GrantErrorCode,
} from './types.js';

/* ──────────────── donation lifecycle (2-donation-service) ──────────────── */

export { DonationStore } from './donation-store.js';
export {
  DonationService,
  DONATION_AWAITING_SEED_TTL_MS,
  DONATION_REAP_SWEEP_MS,
} from './donation-service.js';
export type {
  DonationProvisionRequest,
  DonationSeedResult,
  DonationPeerInfo,
  DonationServiceOptions,
} from './donation-service.js';
export type {
  Donation,
  DonationView,
  DonationStatus,
  DonationFile,
  DonationErrorCode,
} from './types.js';
