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

export { Installer } from './installer/index.js';
export type {
  InstallOptions,
  InstallResult,
  UninstallOptions,
  InstallerOptions,
  HostConfigFile,
  WizardAnswers,
  WizardDefaults,
  ServiceHost,
  ServiceHostContext,
  ServiceHostStatus,
} from './installer/index.js';

export {
  NatService,
  NatStore,
  NatError,
  createNatHandlers,
  ExternalIpDetector,
  PortMapperService,
  createDefaultPortMapper,
  evaluateReachability,
  buildInviteAddresses,
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
  isPlausibleIp,
} from './nat/index.js';
export type {
  NatServiceOptions,
  CadreNodeLike as NatCadreNodeLike,
  NatStatusSnapshot,
  NatDdnsStatus,
  NatSettingsFile,
  NatDdnsSettings,
  NatHandlers,
  NatErrorCode,
  PortForwardMode,
  DirectReachability,
  DdnsProviderInfo,
  DdnsConfigField,
  ExternalIpResult,
  RouterIpProbe,
  ExternalIpDetectorOptions,
  PortMapper,
  PortMappingResult,
  PortMapOptions,
  PortMapperState,
  PortMapperServiceOptions,
  BuildInviteAddressesInput,
  DdnsProvider,
  DdnsProviderDeps,
  DdnsUpdaterOptions,
  DdnsUpdateOutcome,
  SecretsStore,
  KeytarLike,
} from './nat/index.js';
