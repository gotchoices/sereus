/**
 * NAT/DDNS types for cadre-host.
 *
 * cadre-host runs on home/SMB machines that are typically behind NAT. To be
 * dialable from the open internet the host must:
 *   1. Punch a port forward on the upstream router (UPnP/NAT-PMP).
 *   2. Detect its external IP (and whether it's behind CGNAT).
 *   3. Optionally publish a stable hostname via dynamic DNS.
 *
 * State for these three concerns lives in `<rootDir>/nat.json` (user settings)
 * and is exposed as a single `NatStatusSnapshot` to the management UI.
 *
 * Credentials for DDNS providers are NOT stored in `nat.json`. They go through
 * the SecretsStore (keytar, with a 0600 file fallback).
 */

/** Port-forwarding mode currently in effect. */
export type PortForwardMode =
  | 'auto-upnp'
  | 'auto-natpmp'
  | 'manual'
  | 'failed'
  | 'disabled';

/** Reachability verdict — best-effort heuristic until AutoNAT lands. */
export type DirectReachability = 'reachable' | 'unreachable' | 'unknown' | 'cgnat';

/** Snapshot returned to the management UI / CLI. */
export interface NatStatusSnapshot {
  // Port forwarding
  portMode: PortForwardMode;
  externalPort: number;
  internalPort: number;
  /** IP the router reports as its WAN address. Null when not auto-mapped. */
  routerExternalIp: string | null;
  /** ISO timestamp when the current mapping lease expires. */
  mappingLeaseExpiresAt: string | null;

  // External IP (from public probe; may differ from routerExternalIp under CGNAT)
  externalIp: string | null;
  externalIpDetectedAt: string | null;
  cgnatDetected: boolean;

  // Reachability verdict
  directReachability: DirectReachability;
  lastTestedAt: string | null;

  // DDNS
  ddns: NatDdnsStatus;
}

/** DDNS sub-section of the status snapshot. */
export interface NatDdnsStatus {
  /** Provider ID (e.g. "duckdns"), null when no DDNS is configured. */
  providerId: string | null;
  /** Configured hostname (e.g. "foo.duckdns.org"), null when unconfigured. */
  hostname: string | null;
  /** True when the user opted out of cadre-host updating the record. */
  externallyManaged: boolean;
  /** Last attempt timestamp (ISO), null until first attempt. */
  lastUpdateAt: string | null;
  /** Whether the most recent attempt succeeded. */
  lastUpdateOk: boolean | null;
  /** Most recent error message, null when last attempt succeeded. */
  lastError: string | null;
}

/**
 * On-disk shape of `nat.json`. NEVER contains DDNS credentials — those live
 * in the SecretsStore.
 */
export interface NatSettingsFile {
  version: 1;
  /** External port to map (and announce). Default 4001. */
  externalPort: number;
  /** Internal libp2p port. Default 4001. */
  internalPort: number;
  /** Whether to attempt UPnP/NAT-PMP at all. */
  upnpEnabled: boolean;
  ddns: NatDdnsSettings;
}

/** DDNS sub-section of `nat.json`. */
export interface NatDdnsSettings {
  /** Provider ID (e.g. "duckdns"). Null = unconfigured. */
  providerId: string | null;
  /** Hostname to publish. Null = unconfigured. */
  hostname: string | null;
  /**
   * True means the user maintains the DNS record themselves (e.g. via the
   * provider's own auto-update agent on the router). cadre-host shows the
   * hostname but never tries to update it.
   */
  externallyManaged: boolean;
  /** DDNS update interval in milliseconds. Default 5 min. */
  intervalMs: number;
}

/** Typed error codes for NatError. */
export type NatErrorCode =
  | 'mapping_failed'
  | 'router_unreachable'
  | 'ip_detection_failed'
  | 'ddns_provider_unknown'
  | 'ddns_credentials_missing'
  | 'ddns_update_failed'
  | 'secrets_unavailable'
  | 'storage_error'
  | 'invalid_config'
  /** The owner node's admin channel is unreachable / not ready. */
  | 'node_unavailable';

/** Typed error carrying a stable `code` for HTTP mapping in the local-ui. */
export class NatError extends Error {
  readonly code: NatErrorCode;

  constructor(code: NatErrorCode, message: string) {
    super(message);
    this.name = 'NatError';
    this.code = code;
  }
}

/** Description of a configurable field on a DDNS provider. */
export interface DdnsConfigField {
  /** Field key (e.g. "token"). */
  key: string;
  /** Human-readable label (e.g. "DuckDNS token"). */
  label: string;
  /** True if the value is a credential that must be stored in the SecretsStore. */
  secret: boolean;
}

/** Summary of a DDNS provider for UI / CLI listing. */
export interface DdnsProviderInfo {
  id: string;
  displayName: string;
  configFields: ReadonlyArray<DdnsConfigField>;
}

/**
 * Typed HTTP handlers exposed to `cadre-host-local-ui` for Fastify wiring.
 *
 * Like TrustCircleHandlers, these take typed objects and either return typed
 * results or throw a `NatError` whose `.code` the UI ticket maps to an HTTP
 * status code.
 */
export interface NatHandlers {
  getStatus(): Promise<NatStatusSnapshot>;
  testReachability(): Promise<NatStatusSnapshot>;
  listDdnsProviders(): Promise<DdnsProviderInfo[]>;
  putDdns(body: {
    providerId: string;
    hostname: string;
    config: Record<string, string>;
    externallyManaged?: boolean;
  }): Promise<NatStatusSnapshot>;
  putSettings(body: Partial<Omit<NatSettingsFile, 'version'>>): Promise<NatStatusSnapshot>;
}
