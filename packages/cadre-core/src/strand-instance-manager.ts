import debug from 'debug';
import type { Libp2p, PrivateKey } from '@libp2p/interface';
import { createLibp2pNode, type IRawStorage } from '@optimystic/db-p2p';
import type { IRepo } from '@optimystic/db-core';
import { StrandDatabase } from './strand-database.js';
import { assertSchemaSignature } from './schema-verification.js';
import type {
  StrandInstance,
  StrandRow,
  StorageConfig,
  NetworkConfig,
  LatencyHint,
  NodeProfile,
  SAppConfig,
  SAppInfo,
  RawStorageProvider,
  StrandMode
} from './types.js';

/**
 * Extended Libp2p node with coordinatedRepo attached by createLibp2pNode.
 * The db-p2p createLibp2pNode function attaches these properties after node creation.
 */
interface Libp2pNodeWithRepo extends Libp2p {
  coordinatedRepo: IRepo;
}

const log = debug('sereus:cadre:strand-manager');
const timing = debug('sereus:cadre:timing');

/**
 * Configuration for starting a strand instance
 */
export interface StartStrandConfig {
  strandRow: StrandRow;
  /** sApp configuration provided by the hosting application */
  sAppConfig: SAppConfig;
  storage?: StorageConfig;
  network?: NetworkConfig;
  profile: NodeProfile;
  defaultLatencyHint: LatencyHint;
  privateKey?: PrivateKey;
  /** Cohort-derived discovery seed (multiaddr strings). Defaults to [] when omitted. */
  bootstrapNodes?: string[];
  /**
   * Lifecycle mode for this strand; selects the default transactor used by the
   * StrandDatabase. When omitted, the StrandDatabase falls back to `'networked'`;
   * callers (CadreNode) infer it from cohort membership before reaching here.
   */
  mode?: StrandMode;
}

/**
 * Get the isolated storage path for a specific strand.
 *
 * @deprecated This function uses Node.js path module which is not available in React Native.
 * Use a storage provider factory function instead, which receives the strandId and can
 * create strand-specific storage paths using platform-appropriate methods.
 *
 * @example
 * // Instead of using getStrandStoragePath, use a storage provider factory:
 * const storage = {
 *   provider: (strandId: string) => new FileRawStorage(`./data/strands/${strandId}`)
 * };
 */
export function getStrandStoragePath(basePath: string, strandId: string): string {
  // Check if we're in a Node.js environment
  if (typeof process === 'undefined' || !process.versions?.node) {
    throw new Error(
      'getStrandStoragePath is not available in React Native. ' +
      'Use a storage provider factory function instead.'
    );
  }

  // Dynamically require path only in Node.js
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path');

  // Sanitize strandId for filesystem safety (UUIDs should be safe, but just in case)
  const safeId = strandId.replace(/[^a-zA-Z0-9-]/g, '_');
  return path.join(basePath, 'strands', safeId);
}

/**
 * Resolve a storage provider for a specific strand.
 * If the provider is a factory function, call it with the strandId.
 *
 * @param provider - Storage provider (instance or factory)
 * @param strandId - The strand ID to create storage for
 * @returns The resolved IRawStorage instance, or undefined if no provider
 */
function resolveStrandStorage(
  provider: RawStorageProvider | undefined,
  strandId: string
): IRawStorage | undefined {
  if (!provider) {
    return undefined;
  }
  return typeof provider === 'function' ? provider(strandId) : provider;
}

/**
 * Manages individual strand instances - creates and destroys isolated libp2p nodes
 * for each strand the cadre participates in.
 */
export class StrandInstanceManager {
  private instances: Map<string, StrandInstance> = new Map();
  private stopping = false;

  constructor() {
    log('StrandInstanceManager created');
  }

  /**
   * Get all current strand instances
   */
  getInstances(): Map<string, StrandInstance> {
    return new Map(this.instances);
  }

  /**
   * Get a specific strand instance
   */
  getInstance(strandId: string): StrandInstance | undefined {
    return this.instances.get(strandId);
  }

  /**
   * Check if a strand is currently running
   */
  hasStrand(strandId: string): boolean {
    return this.instances.has(strandId);
  }

  /**
   * Start a new strand instance
   */
  async startStrand(config: StartStrandConfig): Promise<StrandInstance> {
    const { strandRow, sAppConfig } = config;
    const strandId = strandRow.Id;

    if (this.stopping) {
      throw new Error('StrandInstanceManager is stopping');
    }

    if (this.instances.has(strandId)) {
      log('Strand %s already running', strandId);
      return this.instances.get(strandId)!;
    }

    log('Starting strand instance: %s (sApp: %s v%s)', strandId, sAppConfig.id, sAppConfig.version);
    const tTotal = performance.now();

    // Verify schema signature before proceeding
    assertSchemaSignature(sAppConfig);
    log('Strand %s sApp schema signature verified (author: %s)', strandId, sAppConfig.id);

    // Convert SAppConfig to SAppInfo for the instance
    const sAppInfo: SAppInfo = {
      id: sAppConfig.id,
      version: sAppConfig.version,
      schema: sAppConfig.schema,
      signature: sAppConfig.signature
    };

    // Determine latency hint: sApp config > default
    const latencyHint = sAppConfig.latencyHint ?? config.defaultLatencyHint;

    const instance: StrandInstance = {
      strandId,
      status: 'starting',
      sAppInfo,
      memberPrivateKey: strandRow.MemberPrivateKey ?? undefined,
      connectedPeers: 0,
      lastActivity: new Date(),
      latencyHint
    };

    this.instances.set(strandId, instance);

    try {
      // Resolve storage for this strand
      // If a factory function is provided, it will be called with the strandId
      // to create strand-specific storage (e.g., strand-isolated directories)
      const strandStorage = resolveStrandStorage(config.storage?.provider, strandId);
      if (strandStorage) {
        log('Strand %s using provided storage provider', strandId);
      }

      // Create isolated libp2p node for this strand
      // Note: protocolPrefix would be used by libp2p services, but createLibp2pNode
      // may not support it yet - tracked for future implementation
      const _protocolPrefix = `/sereus/strand/${strandId}`;

      // Determine relay mode: if explicitly set in config, use that;
      // otherwise default to true for storage profile nodes
      const enableRelay = config.network?.enableRelay ?? (config.profile === 'storage');

      let t0 = performance.now();
      const node = await createLibp2pNode({
        port: 0, // Random port
        bootstrapNodes: config.bootstrapNodes ?? [],
        networkName: `strand-${strandId}`,
        storage: strandStorage,
        fretProfile: config.profile === 'storage' ? 'core' : 'edge',
        relay: enableRelay,
        clusterSize: 3,
        clusterPolicy: {
          allowDownsize: true,
          sizeTolerance: 0.5
        },
        arachnode: {
          enableRingZulu: config.profile === 'storage'
        },
        ...(config.privateKey && { privateKey: config.privateKey }),
        ...(config.network?.transports && { transports: config.network.transports }),
        ...(config.network?.listenAddrs && { listenAddrs: config.network.listenAddrs })
      }) as Libp2pNodeWithRepo;
      timing('[startStrand:%s] createLibp2pNode: %dms', strandId, Math.round(performance.now() - t0));

      instance.libp2pNode = node;

      // Create and initialize the StrandDatabase. In bootstrap mode the same
      // strandStorage instance also backs the optimystic local transactor so
      // DML lands on the host's persistent storage (e.g. MMKV on RN). Sharing
      // the instance — not creating a second one over the same id+prefix —
      // avoids cache divergence between the libp2p and database paths.
      t0 = performance.now();
      const strandDb = new StrandDatabase({
        strandId,
        sAppConfig,
        libp2pNode: node,
        coordinatedRepo: node.coordinatedRepo,
        mode: config.mode ?? 'networked',
        rawStorage: strandStorage
      });
      await strandDb.initialize();
      timing('[startStrand:%s] strandDatabase.initialize: %dms', strandId, Math.round(performance.now() - t0));
      instance.database = strandDb;

      instance.status = 'active';
      instance.lastActivity = new Date();

      timing('[startStrand:%s] total: %dms', strandId, Math.round(performance.now() - tTotal));
      log('Strand %s started successfully with sApp %s', strandId, sAppConfig.id);
      return instance;

    } catch (error) {
      instance.status = 'error';
      instance.error = error instanceof Error ? error.message : String(error);
      log('Failed to start strand %s: %s', strandId, instance.error);
      throw error;
    }
  }

  /**
   * Stop a strand instance
   */
  async stopStrand(strandId: string): Promise<void> {
    const instance = this.instances.get(strandId);
    if (!instance) {
      log('Strand %s not found', strandId);
      return;
    }

    log('Stopping strand instance: %s', strandId);
    instance.status = 'stopping';

    try {
      // Close the database before stopping libp2p
      if (instance.database) {
        await instance.database.close();
        instance.database = undefined;
      }
      if (instance.libp2pNode) {
        await instance.libp2pNode.stop();
        instance.libp2pNode = undefined;
      }
      instance.status = 'stopped';
      this.instances.delete(strandId);
      log('Strand %s stopped successfully', strandId);
    } catch (error) {
      instance.status = 'error';
      instance.error = error instanceof Error ? error.message : String(error);
      log('Error stopping strand %s: %s', strandId, instance.error);
      throw error;
    }
  }

  /**
   * Stop all strand instances
   */
  async stopAll(): Promise<void> {
    this.stopping = true;
    log('Stopping all strand instances (%d)', this.instances.size);
    
    const stopPromises = Array.from(this.instances.keys()).map(id => 
      this.stopStrand(id).catch(err => {
        log('Error stopping strand %s during shutdown: %s', id, err);
      })
    );
    
    await Promise.all(stopPromises);
    this.stopping = false;
    log('All strand instances stopped');
  }
}

