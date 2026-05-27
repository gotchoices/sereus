/**
 * NAT / DDNS substrate for cadre-host.
 *
 * See ./nat-service.ts for the top-level orchestrator and `docs/cadre-host.md`
 * for integration notes (the long-running process owner is `cadre-host-local-ui`).
 */

export { NatService, createNatHandlers } from './nat-service.js';
export type { NatServiceOptions, CadreNodeLike, AddressesChangedListener } from './nat-service.js';
export { NatStore } from './nat-store.js';
export {
  NatError,
} from './types.js';
export type {
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
  PortMapperService,
  createDefaultPortMapper,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_REFRESH_MS,
} from './port-mapper.js';
export type {
  PortMapper,
  PortMappingResult,
  PortMapOptions,
  PortMapperState,
  PortMapperServiceOptions,
} from './port-mapper.js';
export { evaluateReachability } from './reachability.js';
export { buildInviteAddresses } from './address-resolver.js';
export type { BuildInviteAddressesInput } from './address-resolver.js';
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
