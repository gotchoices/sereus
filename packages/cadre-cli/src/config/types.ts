import type { PrivateKey } from '@libp2p/interface';
import type { NodeProfile, LatencyHint, StrandFilter, PushCredentials } from '@serfab/cadre-core';

/**
 * CLI configuration file format (YAML/JSON)
 */
export interface CliConfigFile {
  /** Node identity - path to key file or inline key */
  identity?: {
    /** Path to file containing the private key (hex or raw bytes) */
    keyFile?: string;
    /**
     * Path to a libp2p protobuf-encoded private key (the format written by
     * cadre-host's installer to `identity.key` via `privateKeyToProtobuf`).
     * Loaded with `privateKeyFromProtobuf`. Takes precedence over `keyFile`.
     */
    protobufKeyFile?: string;
    /** Inline private key as hex string (not recommended for production) */
    privateKeyHex?: string;
  };

  /** Control network configuration */
  controlNetwork: {
    /** UUID of the party/control network */
    partyId: string;
    /** Multiaddrs of bootstrap nodes */
    bootstrapNodes: string[];
  };

  /** Node profile: transaction or storage */
  profile: NodeProfile;

  /** Strand filter configuration */
  strandFilter?:
    | 'all'
    | 'none'
    | { sAppId: string }
    | { strandId: string };

  /** Storage configuration (required for storage profile) */
  storage?: {
    type: 'memory' | 'file';
    path?: string;
    quotaBytes?: number;
  };

  /** Network configuration */
  network?: {
    listenAddrs?: string[];
    announceAddrs?: string[];
    relayAddrs?: string[];
    /**
     * Enable circuit relay server - allows this node to relay connections for other peers.
     * Defaults to true for storage profile nodes, false for transaction profile.
     */
    enableRelay?: boolean;
  };

  /** Hibernation settings */
  hibernation?: {
    enabled: boolean;
    defaultLatencyHint?: LatencyHint;
  };

  /** Polling interval for strand watcher in ms */
  strandWatchInterval?: number;

  /**
   * Platform push-delivery credentials (FCM and/or APNs). Provisioned per node by
   * an orchestrator — `cadre-host` writes this block into `cadre.json`, and
   * `cadre-provider` injects it via the `CADRE_PUSH` env var (JSON). Absent ⇒ the
   * node constructs no push fan-out (control-network push-wake only). `privateKey`
   * fields are secrets and are never logged. See `@serfab/cadre-core`'s
   * `PushCredentials`.
   */
  push?: PushCredentials;
}

/**
 * Environment variable mappings for config overrides
 */
export const ENV_MAPPINGS = {
  CADRE_PARTY_ID: 'controlNetwork.partyId',
  CADRE_BOOTSTRAP_NODES: 'controlNetwork.bootstrapNodes',
  CADRE_PROFILE: 'profile',
  CADRE_KEY_FILE: 'identity.keyFile',
  CADRE_IDENTITY_PROTOBUF: 'identity.protobufKeyFile',
  CADRE_STORAGE_PATH: 'storage.path',
  CADRE_STORAGE_TYPE: 'storage.type',
  CADRE_LISTEN_ADDRS: 'network.listenAddrs',
  CADRE_ANNOUNCE_ADDRS: 'network.announceAddrs',
  CADRE_RELAY_ADDRS: 'network.relayAddrs',
  CADRE_ENABLE_RELAY: 'network.enableRelay',
  CADRE_HIBERNATION_ENABLED: 'hibernation.enabled',
  CADRE_STRAND_FILTER: 'strandFilter',
  CADRE_PUSH: 'push',
} as const;

/**
 * Resolved configuration after loading and applying environment overrides
 */
export interface ResolvedConfig {
  privateKey?: PrivateKey;
  /**
   * The `identity.protobufKeyFile` path the private key was loaded from, when
   * that source won. Surfaced so node-local persistent state (the trusted-owner
   * anchor) can live in the same directory as the identity key.
   */
  identityProtobufKeyFile?: string;
  controlNetwork: {
    partyId: string;
    bootstrapNodes: string[];
  };
  profile: NodeProfile;
  strandFilter: StrandFilter;
  storage?: {
    type: 'memory' | 'file';
    path?: string;
    quotaBytes?: number;
  };
  network?: {
    listenAddrs?: string[];
    announceAddrs?: string[];
    relayAddrs?: string[];
    enableRelay?: boolean;
  };
  hibernation?: {
    enabled: boolean;
    defaultLatencyHint?: LatencyHint;
  };
  strandWatchInterval?: number;
  push?: PushCredentials;
}

