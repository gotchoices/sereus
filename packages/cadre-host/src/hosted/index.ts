/**
 * Hosted nodes: the host's "Join a cadre" action and what follows from it. See
 * ./types.ts for the record, ./hosted-node-service.ts for the lifecycle and the
 * status watcher, and ./hosted-node-supervisor.ts for the respawn invariant.
 */

export { HostedNodeStore } from './hosted-node-store.js';
export {
  HostedNodeService,
  HOSTED_NODE_SPAWNING_TTL_MS,
  HOSTED_NODE_REAP_SWEEP_MS,
} from './hosted-node-service.js';
export type {
  ClaimDetails,
  HostedNodeAddressSource,
  HostedNodeOrchestrator,
  HostedNodeServiceOptions,
  RespawnOptions,
  RespawnResult,
} from './hosted-node-service.js';
export {
  HOSTED_NODE_CLAIM_POLL_MS,
  HOSTED_NODE_CONNECTED_POLL_MS,
} from './hosted-node-watcher.js';
export {
  HostedNodeSupervisor,
  HOSTED_NODE_RESPAWN_BACKOFF_BASE_MS,
  HOSTED_NODE_RESPAWN_BACKOFF_MAX_MS,
  HOSTED_NODE_RESPAWN_MAX_ATTEMPTS,
  HOSTED_NODE_RESPAWN_HEALTHY_MS,
  HOSTED_NODE_RESPAWN_SWEEP_MS,
} from './hosted-node-supervisor.js';
export type {
  HostedNodeSupervisorOptions,
  SupervisedOrchestrator,
} from './hosted-node-supervisor.js';
export { PLACEHOLDER_PARTY } from './node-status.js';
export { HostedNodeError } from './types.js';
export type {
  HostedNode,
  HostedNodeChange,
  HostedNodeChangeKind,
  HostedNodeChangeListener,
  HostedNodeErrorCode,
  HostedNodeFile,
  HostedNodeJoin,
  HostedNodeJoinView,
  HostedNodeStatus,
  HostedNodeView,
} from './types.js';
