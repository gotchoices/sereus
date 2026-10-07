/**
 * @serfab/cadre-host — self-hosted cadre node manager.
 *
 * This package is the sibling of @serfab/cadre-provider for self-hosted
 * basement-PC deployments. It depends on @serfab/cadre-provider for the
 * orchestration interface and container lifecycle types but ships its own
 * orchestrator (host processes, not Docker), the hosted-node service behind
 * "Join a cadre", installer, NAT layer, and local management UI.
 *
 * HostProcessOrchestrator, the hosted-node layer, the NAT layer, the
 * installer, and the local UI server each live in a sibling subdirectory
 * under src/.
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
export type {
  HostProcessConfig,
  HostedSpawnRequest,
  PersistedHandle,
  ManagedNodeInfo,
  NodeStateListener,
  NodePorts,
} from './orchestrator/index.js';

/* ──────────────── hosted nodes ("Join a cadre") ──────────────── */

export {
  HostedNodeStore,
  HostedNodeService,
  HostedNodeSupervisor,
  HostedNodeError,
  HOSTED_NODE_SPAWNING_TTL_MS,
  HOSTED_NODE_REAP_SWEEP_MS,
  HOSTED_NODE_CLAIM_POLL_MS,
  HOSTED_NODE_CONNECTED_POLL_MS,
  HOSTED_NODE_RESPAWN_BACKOFF_BASE_MS,
  HOSTED_NODE_RESPAWN_BACKOFF_MAX_MS,
  HOSTED_NODE_RESPAWN_MAX_ATTEMPTS,
  HOSTED_NODE_RESPAWN_HEALTHY_MS,
  HOSTED_NODE_RESPAWN_SWEEP_MS,
  PLACEHOLDER_PARTY,
} from './hosted/index.js';
export type {
  ClaimDetails,
  HostedNode,
  HostedNodeAddressSource,
  HostedNodeChange,
  HostedNodeChangeKind,
  HostedNodeChangeListener,
  HostedNodeErrorCode,
  HostedNodeFile,
  HostedNodeJoin,
  HostedNodeJoinView,
  HostedNodeOrchestrator,
  HostedNodeServiceOptions,
  HostedNodeStatus,
  HostedNodeSupervisorOptions,
  HostedNodeView,
  RespawnOptions,
  RespawnResult,
  SupervisedOrchestrator,
} from './hosted/index.js';

export { Installer, readHostConfig, updateHostConfig, writeHostConfig } from './installer/index.js';
export type {
  InstallOptions,
  InstallResult,
  UninstallOptions,
  InstallerOptions,
  HostConfigFile,
  PushSettings,
  WizardAnswers,
  WizardDefaults,
  ServiceHost,
  ServiceHostContext,
  ServiceHostStatus,
} from './installer/index.js';

/* ──────────────── push credentials (FCM/APNs) ──────────────── */

export {
  resolvePushCredentials,
  setFcmSecret,
  setApnsSecret,
  clearPushSecret,
  pushAccount,
  pushStatus,
} from './push/index.js';
export type {
  FcmSecret,
  ApnsSecret,
  PushSecretPlatform,
  PushStatus,
} from './push/index.js';

export {
  UpdateService,
  createUpdateHandlers,
  UpdateStateStore,
  UpdateErrorException,
  applyUpdate,
  defaultNpmExecutor,
  fetchManifest,
  verifyManifest,
  canonicalJson,
  signManifest,
  validateManifestFields,
  buildManifest,
  derivePublicKeyBase64,
  signAndSelfVerify,
  compareVersions,
  parseVersion,
  getReleasePublicKey,
  getReleasePublicKeyBase64,
  ed25519FromRaw,
  isPlaceholderReleaseKey,
} from './update/index.js';
export type {
  UpdateServiceOptions,
  UpdateHandlers,
  UpdateState,
  SignedManifest,
  UpdateApplyResult,
  UpdateSettings,
  UpdateManifest,
  UpdateErrorCode,
  ManifestFields,
  NpmExecutor,
  ServiceRestarter,
} from './update/index.js';

export {
  NatService,
  NatStore,
  NatError,
  createNatHandlers,
  NAT_UNMAP_GRACE_MS,
  NAT_RECONCILE_INTERVAL_MS,
  NAT_IP_REDETECT_INTERVAL_MS,
  ExternalIpDetector,
  UpnpPortMapper,
  pickLanAddress,
  evaluateNodeReachability,
  evaluateHostReachability,
  buildPublicAddresses,
  isPublicIpv4,
  BUILTIN_PROVIDERS,
  getProvider,
  listProviders,
  duckDnsProvider,
  DdnsUpdater,
  KeytarSecretsStore,
  FileSecretsStore,
  createSecretsStore,
  ddnsAccount,
  KEYTAR_SERVICE,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_REFRESH_MS,
  GATEWAY_DISCOVERY_TIMEOUT_MS,
  isPlausibleIp,
} from './nat/index.js';
export type {
  NatServiceOptions,
  NatNodeSource,
  NatChangeListener,
  NodeAddressesStaleListener,
  NatStatusSnapshot,
  NatGatewayStatus,
  NatDdnsStatus,
  NatSettingsFile,
  NatDdnsSettings,
  NatHandlers,
  NatErrorCode,
  DirectReachability,
  NodeReachability,
  NodeVerdict,
  PortKind,
  PortRoute,
  PortRouteSource,
  ManualForward,
  ManualForwardPatch,
  DdnsProviderInfo,
  DdnsConfigField,
  ExternalIpResult,
  RouterIpProbe,
  ExternalIpDetectorOptions,
  PortMapper,
  GatewayInfo,
  PortMapRequest,
  PortMapResult,
  NodeVerdictInput,
  NodeVerdictResult,
  PublicAddressInput,
  DdnsProvider,
  DdnsProviderDeps,
  DdnsUpdaterOptions,
  DdnsUpdateOutcome,
  SecretsStore,
  KeytarLike,
} from './nat/index.js';

/* ──────────────── local UI server (6.5.1) ──────────────── */

export {
  createLocalUiServer,
  EventBus,
  HostSettingsStore,
} from './server/index.js';
export type {
  LocalUiServer,
  LocalUiServerOptions,
  LocalUiEvent,
  LocalUiEventType,
  LocalUiEventListener,
} from './server/index.js';
