/**
 * Strand management for cadre-host. See ./strand-service.ts and ./types.ts.
 */

export { StrandService, createStrandHandlers } from './strand-service.js';
export type { StrandServiceOptions, CadreNodeLike } from './strand-service.js';
export { StrandError } from './types.js';
export type {
  StrandSummary,
  StrandListSnapshot,
  StrandRemovalResult,
  StrandHandlers,
  StrandErrorCode,
} from './types.js';
