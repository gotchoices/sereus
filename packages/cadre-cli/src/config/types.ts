import type { PrivateKey } from '@libp2p/interface';
import type { NodeProfile, LatencyHint, StrandFilter, PushCredentials } from '@serfab/cadre-core';

/**
 * CLI configuration file format (YAML/JSON)
 */
export interface CliConfigFile {
  /**
   * Node identity. `keyFile` is the only accepted key — the loader rejects anything else in this
   * block (including the retired `protobufKeyFile` / `privateKeyHex`) rather than resolving to no
   * identity and silently generating a fresh keypair.
   */
  identity?: {
    /**
     * Path to the node's private key file: a **libp2p protobuf-encoded private key**
     * (`privateKeyToProtobuf` output, raw binary — no hex or base64 layer). This is the one
     * on-disk identity format in the repo; both writers emit exactly it — `cadre enroll create`
     * as `<name>.key`, and cadre-host's installer as `identity.key`. A file in any other shape
     * fails to load rather than being guessed at.
     */
    keyFile?: string;
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
    /**
     * Addresses to advertise INSTEAD OF `listenAddrs`, for a node reachable at a
     * different address than it binds. A non-empty value replaces everything the
     * node advertises — including the `/p2p-circuit` address a `relayAddrs`
     * reservation earns it, which the node warns about at start. Prefer
     * `appendAnnounceAddrs` unless you mean to discard the rest. A malformed entry
     * fails startup. See `NetworkConfig.announceAddrs` in `@serfab/cadre-core`.
     */
    announceAddrs?: string[];
    /**
     * Addresses to advertise IN ADDITION TO `listenAddrs` — the usual way to make a
     * node reachable at a public address without losing its other advertised ones.
     * Ignored while `announceAddrs` is non-empty. See
     * `NetworkConfig.appendAnnounceAddrs` in `@serfab/cadre-core`.
     */
    appendAnnounceAddrs?: string[];
    relayAddrs?: string[];
    /**
     * Enable circuit relay server - allows this node to relay connections for other peers.
     * Defaults to true for storage profile nodes, false for transaction profile.
     */
    enableRelay?: boolean;
    /**
     * Cap on concurrent circuit-relay reservations this node's relay server grants to
     * peers it cannot (yet) recognize as authorized members. Default 8; 0 refuses every
     * unauthorized reservation. Only meaningful while `enableRelay` is on. See
     * `NetworkConfig.unauthorizedRelayReservationCap` in `@serfab/cadre-core`.
     */
    unauthorizedRelayReservationCap?: number;
  };

  /** Hibernation settings */
  hibernation?: {
    enabled: boolean;
    defaultLatencyHint?: LatencyHint;
  };

  /** Polling interval for strand watcher in ms */
  strandWatchInterval?: number;

  /** Node-local state directory (bootstrap-peer store, trusted-owner anchor). */
  nodeState?: {
    /**
     * Directory for this node's durable node-local stores. Defaults to the
     * directory containing the config file itself — every launcher already
     * writes a per-node config into that node's own working directory, so
     * that default is node-specific by construction.
     */
    dir?: string;
  };

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
  CADRE_STORAGE_PATH: 'storage.path',
  CADRE_STORAGE_TYPE: 'storage.type',
  CADRE_LISTEN_ADDRS: 'network.listenAddrs',
  CADRE_ANNOUNCE_ADDRS: 'network.announceAddrs',
  CADRE_APPEND_ANNOUNCE_ADDRS: 'network.appendAnnounceAddrs',
  CADRE_RELAY_ADDRS: 'network.relayAddrs',
  CADRE_ENABLE_RELAY: 'network.enableRelay',
  CADRE_HIBERNATION_ENABLED: 'hibernation.enabled',
  CADRE_STRAND_FILTER: 'strandFilter',
  CADRE_PUSH: 'push',
  CADRE_NODE_STATE_DIR: 'nodeState.dir',
} as const;

/**
 * Resolved configuration after loading and applying environment overrides
 */
export interface ResolvedConfig {
  privateKey?: PrivateKey;
  /**
   * Directory for this node's durable node-local stores (the bootstrap-peer
   * store and the trusted-owner anchor). Always set — resolved from
   * `nodeState.dir` / `CADRE_NODE_STATE_DIR` when given, else defaults to the
   * directory containing the config file. Independent of the node's identity
   * key file (`identity.keyFile`), which may live anywhere.
   */
  nodeStateDir: string;
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
    /** Advertised INSTEAD OF `listenAddrs` — see `CadreConfig.network.announceAddrs`. */
    announceAddrs?: string[];
    /** Advertised IN ADDITION TO `listenAddrs` — see `CadreConfig.network.appendAnnounceAddrs`. */
    appendAnnounceAddrs?: string[];
    relayAddrs?: string[];
    enableRelay?: boolean;
    /** See `CadreConfig.network.unauthorizedRelayReservationCap`. */
    unauthorizedRelayReservationCap?: number;
  };
  hibernation?: {
    enabled: boolean;
    defaultLatencyHint?: LatencyHint;
  };
  strandWatchInterval?: number;
  push?: PushCredentials;
}

