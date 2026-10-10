/**
 * NAT/DDNS types for cadre-host.
 *
 * cadre-host runs on home/SMB machines that are typically behind NAT. For the
 * nodes it runs to be dialable from the open internet the host must:
 *   1. Map every hosted node's two libp2p ports (TCP, and the WebSocket port a
 *      phone dials) through the upstream router, or let the user forward them
 *      by hand.
 *   2. Detect its external IP (and whether it's behind CGNAT).
 *   3. Optionally publish a stable hostname via dynamic DNS.
 *
 * State for these concerns lives in `<rootDir>/nat.json` (user settings) and is
 * exposed as a single `NatStatusSnapshot` to the management UI, with one
 * `NodeReachability` entry per hosted node.
 *
 * Credentials for DDNS providers are NOT stored in `nat.json`. They go through
 * the SecretsStore (keytar, with a 0600 file fallback).
 */

/** Reachability roll-up across the host's running nodes — see `reachability.ts`. */
export type DirectReachability = 'reachable' | 'unreachable' | 'unknown' | 'cgnat';

/** The two ports of a hosted node that are mapped: libp2p TCP and libp2p WebSocket. */
export type PortKind = 'tcp' | 'ws';

/**
 * How this machine meets the internet. `lan`: behind a router (home or office), so node ports need
 * UPnP or a forward on the router. `public`: an interface holds a public IPv4 (a VPS, a server with a
 * routed address), so node ports are reachable at their own numbers unless a firewall blocks them.
 */
export type NetworkMode = 'lan' | 'public';

/** The `network` setting: `auto` picks the mode from this machine's interfaces. */
export type NetworkSetting = 'auto' | NetworkMode;

/** The network section of the status snapshot. */
export interface NatNetworkStatus {
  setting: NetworkSetting;
  /** The mode in effect: the setting, or what `auto` found. */
  mode: NetworkMode;
  /** The public IPv4 an interface holds, when one does; what `auto` decides on. */
  publicInterfaceIp: string | null;
}

/** Where a port's external route came from. `direct`: public mode, the port as-is. */
export type PortRouteSource = 'upnp' | 'manual' | 'direct';

/** How one of a node's ports is reached from outside the home network. */
export interface PortRoute {
  internalPort: number;
  /** Port reachable from outside; null when there is no route. */
  externalPort: number | null;
  source: PortRouteSource | null;
  /** ISO timestamp when the router lease expires; UPnP routes only. */
  leaseExpiresAt: string | null;
  /** Last mapping failure, in plain language; null when the last attempt succeeded. */
  error: string | null;
}

/** Per-node verdict. `direct`: reachable at this machine's public address, firewall permitting. */
export type NodeVerdict = 'mapped' | 'manual' | 'direct' | 'unreachable';

/** Reachability of one hosted node, as reported in the status snapshot. */
export interface NodeReachability {
  nodeId: string;
  /** Whether the node's process is running; a stopped node keeps its last routes until the unmap grace elapses. */
  running: boolean;
  verdict: NodeVerdict;
  /**
   * Plain-language reason and remedy when unreachable, e.g. "Router refused
   * the WebSocket port mapping. Forward port 10004 to 192.168.1.20 on your
   * router, then tell cadre-host the external port." For `direct`, the
   * firewall reminder: which ports to allow.
   */
  reason: string | null;
  tcp: PortRoute;
  /** Null for a handle persisted by an older build without a WebSocket port. */
  ws: PortRoute | null;
  /** Multiaddrs (no `/p2p/` suffix) through which the node is reachable from outside. */
  publicAddrs: string[];
}

/** The UPnP gateway as the host last saw it. */
export interface NatGatewayStatus {
  found: boolean;
  /** This machine's address on the router's subnet — the address a user forwards to. */
  lanAddress: string | null;
  /** The WAN address the router reports for itself. */
  routerExternalIp: string | null;
  /** Why discovery or the last gateway operation failed; null when it did not. */
  lastError: string | null;
}

/** Snapshot returned to the management UI / CLI. */
export interface NatStatusSnapshot {
  network: NatNetworkStatus;
  upnpEnabled: boolean;
  gateway: NatGatewayStatus;

  // External IP (from the public probe, falling back to the router's report).
  externalIp: string | null;
  externalIpDetectedAt: string | null;
  cgnatDetected: boolean;

  /** Roll-up across running nodes; see `reachability.ts`. */
  directReachability: DirectReachability;
  lastTestedAt: string | null;

  ddns: NatDdnsStatus;
  nodes: NodeReachability[];
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

/** The external ports a user forwarded on their router for one node, per port kind. */
export interface ManualForward {
  tcp?: number;
  ws?: number;
}

/** Patch applied by `PUT /nat/nodes/:nodeId/forward`: `null` clears that port. */
export interface ManualForwardPatch {
  tcp?: number | null;
  ws?: number | null;
}

/**
 * On-disk shape of `nat.json`. NEVER contains DDNS credentials — those live
 * in the SecretsStore.
 */
export interface NatSettingsFile {
  version: 1;
  /** LAN or public-IP mode; `auto` (default) decides from the interfaces. Absent in older files. */
  network: NetworkSetting;
  /** Whether to ask the router for port mappings at all. Ignored in public mode. */
  upnpEnabled: boolean;
  /** Per node id: the external port the user forwarded on their router, per port kind. */
  forwards: Record<string, ManualForward>;
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
  /** A manual forward named a node id the host does not run. */
  | 'unknown_node';

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
 * Typed HTTP handlers exposed to the local UI server for Fastify wiring.
 *
 * These take typed objects and either return typed results or throw a
 * `NatError` whose `.code` the error handler maps to an HTTP status code.
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
  putSettings(body: Partial<Omit<NatSettingsFile, 'version' | 'forwards'>>): Promise<NatStatusSnapshot>;
  putForward(nodeId: string, patch: ManualForwardPatch): Promise<NatStatusSnapshot>;
}
