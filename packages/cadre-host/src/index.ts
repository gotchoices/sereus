/**
 * @serfab/cadre-host — self-hosted cadre node manager.
 *
 * This package is the sibling of @serfab/cadre-provider for self-hosted
 * basement-PC deployments. It depends on @serfab/cadre-provider for the
 * orchestration interface and container lifecycle types but ships its own
 * orchestrator (host processes, not Docker), auth (trust circle, not API
 * keys), installer, NAT layer, and local management UI.
 *
 * Implementations of HostProcessOrchestrator, TrustCircleAuth, the NAT
 * layer, installer scripts, and the local UI live in sibling subdirectories
 * under src/ and are added by their respective tickets:
 *
 *   - cadre-host-process-orchestrator     [DONE]
 *   - cadre-host-trust-circle             [DONE]
 *   - cadre-host-nat
 *   - cadre-host-installer
 *   - cadre-host-local-ui
 */

export type {
  Orchestrator,
  OrchestratorCreateRequest,
  OrchestratorCreateResult,
  OrchestratorStats,
  ContainerStatus,
  ContainerResources,
} from '@serfab/cadre-provider';

export { HostProcessOrchestrator } from './orchestrator/index.js';
export type { HostProcessConfig, PersistedHandle } from './orchestrator/index.js';

export {
  TrustCircleService,
  TrustCircleStore,
  TrustCircleError,
  createTrustCircleHandlers,
  parseDuration,
  DEFAULT_INVITE_TTL_MS,
} from './auth/index.js';
export type {
  TrustCircleServiceOptions,
  CadreNodeLike,
  TrustCircleMember,
  PendingInvite,
  TrustCircleFile,
  TrustCircleSnapshot,
  TrustCircleHandlers,
  TrustCircleErrorCode,
} from './auth/index.js';
