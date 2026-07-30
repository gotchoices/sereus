/**
 * Trust-circle auth for cadre-host. See ./trust-circle.ts and ./types.ts.
 */

export { TrustCircleService, createTrustCircleHandlers, DEFAULT_INVITE_TTL_MS } from './trust-circle.js';
export type { TrustCircleServiceOptions, CadreNodeLike } from './trust-circle.js';
export { TrustCircleStore } from './trust-circle-store.js';
export { ensureSelfLabel, SELF_LABEL } from './self-label.js';
export type { EnsureSelfLabelOptions } from './self-label.js';
export { parseDuration } from './duration.js';
export {
  TrustCircleError,
} from './types.js';
export type {
  TrustCircleMember,
  PendingInvite,
  TrustCircleFile,
  TrustCircleSnapshot,
  TrustCircleHandlers,
  TrustCircleErrorCode,
} from './types.js';
