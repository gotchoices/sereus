import debug from 'debug';
import type { PrivateKey } from '@libp2p/interface';
import { createLibp2pNode, type IRawStorage } from '@optimystic/db-p2p';
import { wrapStorageWithCache } from '@serfab/quereus-plugin-sereus';
import { StrandDatabase } from './strand-database.js';
import { StrandBackfill, type StrandBackfillConfig } from './strand-backfill.js';
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
  Libp2pNodeWithRepo
} from './types.js';
import { resolveStrandClusterSize, STRAND_CLUSTER_POLICY } from './types.js';
import { resolveListenAddrs } from './relay-addrs.js';

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
   * Require a valid author signature on the sApp schema before bring-up.
   * Defaults to true (fail closed) when omitted; set false only for dev/test
   * with unsigned demo schemas. Mirrors {@link CadreNodeConfig.requireSignedSchemas}.
   */
  requireSignedSchemas?: boolean;
  /**
   * Whether this node founds the strand (vs. joins it). Forwarded to the
   * StrandDatabase so the founder bootstrap (Header, founding Member/Manager)
   * runs once at bring-up. Joiners leave this unset and write nothing. See
   * {@link StrandConfig.founder}.
   */
  founder?: boolean;
  /**
   * Number of nodes Optimystic is told this strand's replication cluster should
   * have. Same rule as {@link CadreNodeConfig.strandClusterSize}, which CadreNode
   * forwards here: every node on the strand should use the same value, and it is
   * frozen when the strand's libp2p node is created. Defaults to
   * `DEFAULT_STRAND_CLUSTER_SIZE` (4); values below `MIN_CLUSTER_SIZE` (2) are
   * rejected by `resolveStrandClusterSize`. Strand-only — the
   * control network's breadth is the fixed `CONTROL_REPLICATION_BREADTH`.
   */
  clusterSize?: number;
  /**
   * Tuning for the strand peer-join block catch-up ({@link StrandBackfill}),
   * forwarded from {@link CadreNodeConfig.strandBackfill}. When the strand's
   * libp2p node connects to a peer this runtime has not yet caught up, every
   * block in the strand's own raw store is pushed to it. Runs only on strands
   * with per-strand storage; `{ enabled: false }` restores the pre-existing
   * no-backfill behaviour.
   */
  backfill?: StrandBackfillConfig;
}

/**
 * Volatile inputs re-resolved when resuming a quiesced strand. The cohort
 * discovery seed is the only one — it grows as peers are learned since the
 * strand first launched.
 */
export interface ResumeStrandOverrides {
  /** Freshly-resolved cohort discovery seed (multiaddr strings). */
  bootstrapNodes?: string[];
}

/**
 * Get the isolated storage path for a specific strand.
 *
 * @deprecated This helper is Node-only and throws in React Native (it assumes a
 * filesystem layout). Use a storage provider factory function instead, which
 * receives the strandId and can create strand-specific storage paths using
 * platform-appropriate methods.
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

  // Sanitize strandId for filesystem safety (UUIDs should be safe, but just in case)
  const safeId = strandId.replace(/[^a-zA-Z0-9-]/g, '_');

  // Build the path with plain string joins rather than the Node `path` module.
  // A static `require('path')` forces RN bundlers (e.g. Metro) to *resolve* the
  // module at bundle time even though this Node-only helper throws above before
  // ever reaching here — joining by hand keeps the module free of any Node
  // built-in reference, so RN bundles need no `path` shim.
  const trimmedBase = basePath.replace(/[\\/]+$/, '');
  return `${trimmedBase}/strands/${safeId}`;
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
  const storage = typeof provider === 'function' ? provider(strandId) : provider;
  // Wrapped in the write-through raw-storage cache (quereus-plugin-sereus's cached-storage.ts).
  // The memo there dedupes the seams that share ONE instance (node wiring + backfill); it does
  // NOT span a runtime rebuild, because `buildStrandRuntime` calls the provider again and most
  // providers mint a fresh instance per call — see
  // tickets/fix/strand-runtime-rebuild-remints-raw-storage.md.
  return wrapStorageWithCache(storage, strandId);
}

/**
 * Manages individual strand instances - creates and destroys isolated libp2p nodes
 * for each strand the cadre participates in.
 */
export class StrandInstanceManager {
  private instances: Map<string, StrandInstance> = new Map();
  /**
   * Retained launch config per strand, captured in `startStrand` and cleared in
   * `stopStrand`. `resumeStrand` reuses it to rebuild a quiesced strand's runtime
   * without the caller re-threading storage/network/profile/key/sApp config.
   */
  private launchConfigs: Map<string, StartStrandConfig> = new Map();
  /**
   * The per-strand peer-join block catch-up, keyed by strand id. Private (not on
   * the public {@link StrandInstance}) because it is runtime plumbing with the
   * same lifetime as the strand's libp2p node: created in `buildStrandRuntime`,
   * stopped and dropped in `releaseRuntime` — so quiesce → resume rebuilds it
   * with a fresh caught-up-peer memo, which is intended (a resumed node may have
   * missed writes).
   */
  private backfills: Map<string, StrandBackfill> = new Map();
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
   * Start a new strand instance.
   *
   * A failed launch leaves NOTHING tracked: the instance and its retained launch
   * config are both dropped before the error is rethrown, so the strand id is
   * free for a genuine retry. This matches the pre-registration failure path
   * (a rejected schema signature, which throws before anything is recorded) —
   * both failure modes of this call leave the same residue: none. Callers learn
   * of the failure from the rejected promise (and, on the control-discovered
   * path, from CadreNode's `strand:error` event), not from an error record left
   * behind in `instances`.
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

    // Verify schema signature before proceeding (fail-closed by default)
    const requireSignature = config.requireSignedSchemas ?? true;
    assertSchemaSignature(sAppConfig, { requireSignature });
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
    this.launchConfigs.set(strandId, config);

    try {
      await this.buildStrandRuntime(instance, config);
      timing('[startStrand:%s] total: %dms', strandId, Math.round(performance.now() - tTotal));
      log('Strand %s started successfully with sApp %s', strandId, sAppConfig.id);
      return instance;
    } catch (error) {
      // Status/error first — the (now discarded) record is still what `log` reports on.
      instance.status = 'error';
      instance.error = error instanceof Error ? error.message : String(error);
      log('Failed to start strand %s: %s', strandId, instance.error);
      // Drop the dead record so this strand id can be launched again. Keep the
      // `launchConfigs` has an entry iff `instances` does invariant — resumeStrand
      // reads both, and a config without an instance would strand the config.
      this.instances.delete(strandId);
      this.launchConfigs.delete(strandId);
      throw error;
    }
  }

  /**
   * Build (or rebuild) the libp2p node + StrandDatabase for an instance and
   * attach them, transitioning it to `active`. Shared by `startStrand` (fresh
   * launch) and `resumeStrand` (rehydrating a quiesced instance). Reads all
   * volatile inputs (bootstrapNodes, storage, network, profile, privateKey,
   * sApp config) from `config`, so the caller controls the cohort-derived
   * values.
   */
  private async buildStrandRuntime(instance: StrandInstance, config: StartStrandConfig): Promise<void> {
    const strandId = instance.strandId;
    const { sAppConfig } = config;

    // Resolve storage for this strand. If a factory function is provided, it is
    // called with the strandId to create strand-specific storage (e.g.,
    // strand-isolated directories).
    const strandStorage = resolveStrandStorage(config.storage?.provider, strandId);
    if (strandStorage) {
      log('Strand %s using provided storage provider', strandId);
    }

    // db-p2p namespaces every one of the node's protocol ids by network name
    // (`/optimystic/<networkName>/...`), so anything dialing this node's own
    // services must derive its prefix from the SAME string the node was built
    // with — hence one binding for both, not two literals that can drift.
    const networkName = `strand-${strandId}`;
    const protocolPrefix = `/optimystic/${networkName}`;

    // Determine relay mode: if explicitly set in config, use that;
    // otherwise default to true for storage profile nodes.
    const enableRelay = config.network?.enableRelay ?? (config.profile === 'storage');
    const listenAddrs = resolveListenAddrs(config.network);

    try {
      let t0 = performance.now();
      const node = await createLibp2pNode({
        port: 0, // Random port
        bootstrapNodes: config.bootstrapNodes ?? [],
        networkName,
        storage: strandStorage,
        fretProfile: config.profile === 'storage' ? 'core' : 'edge',
        relay: enableRelay,
        clusterSize: resolveStrandClusterSize(config.clusterSize),
        // Deliberately NOT CONTROL_CLUSTER_POLICY: a strand is application data with its own
        // breadth reasoning, and the shape match with the control policy is a coincidence.
        clusterPolicy: STRAND_CLUSTER_POLICY,
        arachnode: {
          enableRingZulu: config.profile === 'storage'
        },
        ...(config.privateKey && { privateKey: config.privateKey }),
        ...(config.network?.transports && { transports: config.network.transports }),
        // NOTE: strand nodes receive the same RESOLVED listen addrs as the
        // control node. A fixed-port listen addr (e.g. cadre-cli's example
        // `/ip4/0.0.0.0/tcp/4001`) would have control + strand nodes racing to
        // bind one port — EADDRINUSE. Unverified; if a deployment configures a
        // fixed port and strands fail to start, rewrite the port per node here.
        // An inherited `/p2p-circuit` addr, by contrast, is deliberate — it is
        // what gives a NAT'd strand node a reachable relay slot — and works
        // because the launch path announces this strand's derived peerId to
        // the relay first (delegate admission; see cadre-node.ts). Those circuit
        // entries come either from a hand-written `network.listenAddrs` or from
        // `network.relayAddrs`, which `resolveListenAddrs` folds into the same list.
        ...(listenAddrs && { listenAddrs }),
        ...(config.network?.connectionGater && { connectionGater: config.network.connectionGater })
      }) as Libp2pNodeWithRepo;
      timing('[buildStrandRuntime:%s] createLibp2pNode: %dms', strandId, Math.round(performance.now() - t0));

      instance.libp2pNode = node;

      // Create and initialize the StrandDatabase.
      //
      // Attach before initialize so a failed init is cleaned up by
      // releaseRuntime below (close() is safe on a partially-initialized db).
      t0 = performance.now();
      const strandDb = new StrandDatabase({
        strandId,
        sAppConfig,
        libp2pNode: node,
        coordinatedRepo: node.coordinatedRepo,
        // Founder bootstrap inputs: the strand's type drives which membership rows
        // are written, and the closed-strand MemberPrivateKey derives the founding
        // Member/Manager key. Both come off the control-network strand row.
        strandType: config.strandRow.Type,
        memberPrivateKey: config.strandRow.MemberPrivateKey ?? undefined,
        founder: config.founder
      });
      instance.database = strandDb;
      await strandDb.initialize();
      timing('[buildStrandRuntime:%s] strandDatabase.initialize: %dms', strandId, Math.round(performance.now() - t0));

      // Peer-join block catch-up: push this strand's own blocks to each newly
      // connected peer, so a machine that joined after blocks were committed
      // still ends up physically holding them (without per-strand storage there
      // is nothing to copy). Armed for EVERY stored strand: `StrandBackfill`
      // only does work when the strand's libp2p node reports a peer connection,
      // so on a device that is genuinely alone it is inert, and arming it at
      // launch is what closes the "founded alone, never replicates" hole — a
      // peer that joins later gets the founder's blocks without any relaunch.
      //
      // NOTE: cost is one StrandBackfill object + one `connection:open` listener
      // per running strand — linear in strand count, negligible at the handful a
      // device or host runs today. If a node ever hosts strands by the hundred,
      // move to one shared listener that dispatches by strand id.
      if (strandStorage && config.backfill?.enabled !== false) {
        if (node.keyNetwork) {
          const backfill = new StrandBackfill({
            strandId,
            libp2p: node,
            peerNetwork: node.keyNetwork,
            storage: strandStorage,
            // The same prefix the receiver registered its block-transfer handler
            // under — derived from networkName above, never re-spelled here.
            protocolPrefix
          }, config.backfill);
          backfill.start();
          this.backfills.set(strandId, backfill);
        } else {
          log('Strand %s: libp2p node exposes no keyNetwork; peer-join block catch-up is inert', strandId);
        }
      }

      instance.status = 'active';
      instance.lastActivity = new Date();
    } catch (error) {
      // Roll back any partially-attached runtime so the instance is left with
      // NEITHER handle. Otherwise the `libp2pNode || database` "already live"
      // guard in resumeStrand/handleStrandWake would treat a half-built strand
      // as healthy — leaking the libp2p node and never retrying the rebuild.
      await this.releaseRuntime(instance).catch((cleanupErr) => {
        log('buildStrandRuntime cleanup for strand %s also failed: %o', strandId, cleanupErr);
      });
      throw error;
    }
  }

  /**
   * Release an instance's strand-network runtime: close the StrandDatabase, then
   * stop the libp2p node (construction order in reverse), clearing both fields
   * and zeroing connectedPeers. Tolerant of partially-built state — either handle
   * may be absent — so it doubles as rollback for a failed `buildStrandRuntime`.
   * Shared by `quiesceStrand`, `stopStrand`, and that rollback path.
   */
  private async releaseRuntime(instance: StrandInstance): Promise<void> {
    // Backfill first — before the database closes and the libp2p node stops — so
    // no NEW catch-up push is issued against a torn-down transport. A push already
    // in flight is not awaited; it fails into the module's own per-chunk catch.
    const backfill = this.backfills.get(instance.strandId);
    if (backfill) {
      backfill.stop();
      this.backfills.delete(instance.strandId);
    }
    if (instance.database) {
      await instance.database.close();
      instance.database = undefined;
    }
    if (instance.libp2pNode) {
      await instance.libp2pNode.stop();
      instance.libp2pNode = undefined;
    }
    instance.connectedPeers = 0;
  }

  /**
   * Quiesce a strand: release its strand-network resources (stop the libp2p node,
   * close the StrandDatabase) while RETAINING the instance record — identity,
   * sAppInfo, keys, latency hint, metadata — and its launch config so it can be
   * resumed later. Mechanically this is `stopStrand` minus the instance/config
   * deletion. The caller sets the post-quiesce status (e.g. `hibernating`).
   * No-ops when the strand is missing or already quiesced.
   */
  async quiesceStrand(strandId: string): Promise<void> {
    const instance = this.instances.get(strandId);
    if (!instance) {
      log('quiesceStrand: strand %s not found', strandId);
      return;
    }
    if (!instance.libp2pNode && !instance.database) {
      log('quiesceStrand: strand %s already quiesced', strandId);
      return;
    }

    log('Quiescing strand instance: %s', strandId);
    await this.releaseRuntime(instance);
    log('Strand %s quiesced (resources released, instance retained)', strandId);
  }

  /**
   * Resume a previously-quiesced strand: rebuild its libp2p node + StrandDatabase
   * from the retained launch config and re-attach them, transitioning it back to
   * `active`. `overrides` re-applies volatile inputs that may have changed since
   * launch (the cohort `bootstrapNodes` seed) and updates the retained config so
   * a later resume reuses the latest values. Returns the live instance unchanged
   * if it is already running.
   */
  async resumeStrand(strandId: string, overrides?: ResumeStrandOverrides): Promise<StrandInstance> {
    if (this.stopping) {
      throw new Error('StrandInstanceManager is stopping');
    }
    const instance = this.instances.get(strandId);
    if (!instance) {
      throw new Error(`Cannot resume strand ${strandId}: not tracked`);
    }
    const launchConfig = this.launchConfigs.get(strandId);
    if (!launchConfig) {
      throw new Error(`Cannot resume strand ${strandId}: no retained launch config`);
    }
    if (instance.libp2pNode || instance.database) {
      log('resumeStrand: strand %s already live', strandId);
      return instance;
    }

    log('Resuming strand instance: %s', strandId);
    const tTotal = performance.now();

    // Re-apply volatile inputs and persist them so a subsequent resume reuses them.
    const resumeConfig: StartStrandConfig = {
      ...launchConfig,
      bootstrapNodes: overrides?.bootstrapNodes ?? launchConfig.bootstrapNodes
    };
    this.launchConfigs.set(strandId, resumeConfig);

    instance.status = 'starting';
    try {
      await this.buildStrandRuntime(instance, resumeConfig);
      timing('[resumeStrand:%s] total: %dms', strandId, Math.round(performance.now() - tTotal));
      log('Strand %s resumed successfully', strandId);
      return instance;
    } catch (error) {
      instance.status = 'error';
      instance.error = error instanceof Error ? error.message : String(error);
      log('Failed to resume strand %s: %s', strandId, instance.error);
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
      await this.releaseRuntime(instance);
      instance.status = 'stopped';
      this.instances.delete(strandId);
      this.launchConfigs.delete(strandId);
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

