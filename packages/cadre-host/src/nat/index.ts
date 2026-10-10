/**
 * NAT / DDNS substrate for cadre-host.
 *
 * See ./nat-service.ts for the top-level orchestrator and `docs/cadre-host.md`
 * for integration notes (the long-running process owner is `cadre-host start`).
 */

export {
  NatService,
  createNatHandlers,
  NAT_UNMAP_GRACE_MS,
  NAT_RECONCILE_INTERVAL_MS,
  NAT_IP_REDETECT_INTERVAL_MS,
} from './nat-service.js';
export type { NatServiceOptions, NatNodeSource, NatChangeListener } from './nat-service.js';
export { NAT_ADDRESS_RESTART_MIN_INTERVAL_MS } from './address-watch.js';
export type { NodeAddressesStaleListener } from './address-watch.js';
export { NatStore } from './nat-store.js';
export {
  NatError,
} from './types.js';
export type {
  NatStatusSnapshot,
  NatGatewayStatus,
  NatDdnsStatus,
  NatNetworkStatus,
  NetworkMode,
  NetworkSetting,
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
} from './types.js';
export {
  ExternalIpDetector,
  isPlausibleIp,
} from './external-ip.js';
export type {
  ExternalIpResult,
  RouterIpProbe,
  ExternalIpDetectorOptions,
} from './external-ip.js';
export {
  UpnpPortMapper,
  pickLanAddress,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_REFRESH_MS,
  GATEWAY_DISCOVERY_TIMEOUT_MS,
} from './port-mapper.js';
export type {
  PortMapper,
  GatewayInfo,
  PortMapRequest,
  PortMapResult,
} from './port-mapper.js';
export { evaluateNodeReachability, evaluateHostReachability } from './reachability.js';
export type { NodeVerdictInput, NodeVerdictResult } from './reachability.js';
export { buildPublicAddresses, isPublicIpv4 } from './address-resolver.js';
export { publicInterfaceAddress, effectiveNetworkMode } from './network-mode.js';
export type { PublicAddressInput } from './address-resolver.js';
export {
  BUILTIN_PROVIDERS,
  getProvider,
  listProviders,
  duckDnsProvider,
  DdnsUpdater,
} from './ddns/index.js';
export type {
  DdnsProvider,
  DdnsProviderDeps,
  DdnsUpdaterOptions,
  DdnsUpdateOutcome,
} from './ddns/index.js';
export {
  KeytarSecretsStore,
  FileSecretsStore,
  createSecretsStore,
  ddnsAccount,
  KEYTAR_SERVICE,
} from './secrets/index.js';
export type { SecretsStore, KeytarLike } from './secrets/index.js';
