import debug from 'debug';
import type { PrivateKey } from '@libp2p/interface';
import { createLibp2pNode, type IRawStorage } from '@optimystic/db-p2p';
import { wrapStorageWithCache, disposeStorageCache } from '@serfab/quereus-plugin-sereus';
import { StrandDatabase } from './strand-database.js';
import { PeerJoinBackfill, type PeerJoinBackfillConfig } from './peer-join-backfill.js';
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
import { resolveStrandClusterSize, strandClusterPolicy } from './types.js';
import { strandNodeAddrs } from './strand-network-config.js';

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
   * runs once at bring-up. Joiners leave this unset and write nothing. Callers
   * resolve it BEFORE calling `startStrand` (`CadreNode.launchStrand` derives it
   * from the row's `FounderOwnerKey` when no explicit flag is given — see
   * {@link StrandConfig.founder}); a founder request that arrives while the
   * instance is already tracked goes through {@link StrandInstanceManager.foundExistingStrand},
   * never through a repeat `startStrand`.
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
   * Machines that SERVE THIS STRAND (this node included), for the strand node's
   * block-repair corroboration yardstick — see `resolveRepairYardstick`. It must be
   * an authenticated per-strand count: the machines that actually run a node for this
   * strand, not the machines that exist.
   *
   * **The party's enrolled-machine count is NOT this number and must never be passed
   * here.** A strand launches only on machines whose embedding app registered its sApp
   * config (`CadreNode.addStrand`), so a closed strand shared by two machines of a
   * three-machine party is served by two. Passing three over-declares, and
   * over-declaring is the unsafe direction: at a declaration of 3 or more Optimystic
   * pins the repair corroboration floor at two corroborating peers, which a cohort
   * that can only ever field one peer can never reach — so the strand can never repair
   * a block (`cluster-fetch:no-quorum`, surfacing as reads failing with `Missing
   * block`). That regression is why this field was renamed off "enrolledMachines":
   * `bug-strand-yardstick-counts-party-machines`.
   *
   * **Nothing feeds it in production today.** No authenticated per-strand serving count
   * exists yet, so `CadreNode` passes nothing and the strand node runs the frozen
   * `STRAND_CLUSTER_POLICY` — declaring no yardstick, which leaves the known,
   * upstream-tracked single-voter exposure
   * (`backlog/debt-read-repair-single-voter-corroboration`). Building the count is
   * `backlog/feat-strand-yardstick-from-serving-machines`; this field and its
   * threading are the seam it plugs into.
   *
   * Volatile when a source does exist: re-resolve it on every resume beside the cohort
   * seed, since machines join and leave a strand while it hibernates. Omitting it means
   * "this node does not know", which declares nothing.
   */
  servingMachines?: number;
  /**
   * Tuning for the strand peer-join block catch-up ({@link PeerJoinBackfill}),
   * forwarded from {@link CadreNodeConfig.strandBackfill}. When the strand's
   * libp2p node connects to a peer this runtime has not yet caught up, every
   * block in the strand's own raw store is pushed to it. Runs only on strands
   * with per-strand storage; `{ enabled: false }` restores the pre-existing
   * no-backfill behaviour.
   */
  backfill?: PeerJoinBackfillConfig;
}

/**
 * Volatile inputs re-resolved when resuming a quiesced strand — the ones that can
 * have moved since it last ran, and that the rebuilt libp2p node freezes again. Each
 * one omitted keeps the value the retained launch config already holds, so a resume
 * that passes nothing rebuilds the strand exactly as it last ran.
 */
export interface ResumeStrandOverrides {
  /**
   * Freshly-resolved cohort discovery seed (multiaddr strings). Grows as peers are
   * learned since the strand first launched.
   */
  bootstrapNodes?: string[];
  /**
   * Freshly-read count of the machines serving this strand, for the repair yardstick
   * (see {@link StartStrandConfig.servingMachines} — including why the party's
   * enrolled-machine count is not it). Moves whenever a machine starts or stops
   * serving the strand, which a hibernating strand does not otherwise notice. Nothing
   * passes it today. Omitting it here does NOT mean "unknown" the way omitting it from
   * {@link StartStrandConfig} does — it retains the last value; see `resumeStrand`.
   */
  servingMachines?: number;
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
 * Called only from {@link StrandInstanceManager.startStrand}, which owns the result
 * for the instance's lifetime — see `strandStorages`.
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
  // Called ONCE per strand launch — `startStrand` keeps the result for the instance's
  // lifetime — so the wrap survives every runtime rebuild the instance goes through.
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
  private backfills: Map<string, PeerJoinBackfill> = new Map();
  /**
   * The resolved (cache-wrapped) raw storage per strand id — the instance's OWN
   * store, resolved once in `startStrand` and held until `stopStrand` disposes it.
   * Private for the same reason `backfills` is: runtime plumbing, not part of the
   * public {@link StrandInstance}.
   *
   * Deliberately NOT touched by `releaseRuntime`: that is what lets a quiesce →
   * resume cycle rebuild the libp2p node over the SAME store, keeping its
   * write-through cache warm (and, on an in-memory backend, keeping the strand's
   * blocks at all). An entry exists iff `instances` does AND the launch config
   * supplied a storage provider.
   *
   * NOTE: a hibernating strand therefore keeps its store — and its share of the
   * process-wide cache pool — resident for as long as the instance is tracked. That
   * is the point (a warm wake), and the pool evicts under pressure, so the cost is
   * one map entry per hibernating strand today. If a device ever hibernates strands
   * by the hundred, revisit: dropping the store at quiesce and paying for a cold
   * wake becomes the better trade.
   */
  private strandStorages: Map<string, IRawStorage> = new Map();
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
   *
   * The strand's raw storage is resolved HERE, once, and held for the instance's
   * lifetime (see `strandStorages`) — `buildStrandRuntime` only reads it, so a
   * hibernation wake never re-enters the embedder's provider.
   */
  async startStrand(config: StartStrandConfig): Promise<StrandInstance> {
    const { strandRow, sAppConfig } = config;
    const strandId = strandRow.Id;

    if (this.stopping) {
      throw new Error('StrandInstanceManager is stopping');
    }

    if (this.instances.has(strandId)) {
      // Callers resolve founder-ness BEFORE reaching here (CadreNode.launchStrand) and
      // honor a founder request on a tracked instance via foundExistingStrand — so a
      // founder flag arriving at this early return against a non-founder retained
      // config is a dropped bootstrap, and must never again be silent.
      if (config.founder === true && this.launchConfigs.get(strandId)?.founder !== true) {
        log('startStrand: strand %s is already running but was NOT launched as founder — ' +
          'this early return DROPS the founder request; use foundExistingStrand', strandId);
      }
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

    // Resolve this strand's storage ONCE, before anything is recorded. If a factory
    // function is provided, it is called with the strandId to create strand-specific
    // storage (e.g. strand-isolated directories). A provider that throws therefore
    // fails the launch alongside the schema-signature check, leaving nothing tracked.
    const strandStorage = resolveStrandStorage(config.storage?.provider, strandId);
    if (strandStorage) {
      log('Strand %s using provided storage provider', strandId);
    }

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
    if (strandStorage) {
      this.strandStorages.set(strandId, strandStorage);
    }

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
      // The store this launch resolved goes with it: nothing owns it any more, and a
      // retained cache wrapper would be handed back (already retired) on a retry.
      await this.disposeStrandStorage(strandId);
      throw error;
    }
  }

  /**
   * Build (or rebuild) the libp2p node + StrandDatabase for an instance and
   * attach them, transitioning it to `active`. Shared by `startStrand` (fresh
   * launch) and `resumeStrand` (rehydrating a quiesced instance). Reads all
   * volatile inputs (bootstrapNodes, servingMachines, network, profile,
   * privateKey, sApp config) from `config`, so the caller controls the
   * cohort-derived values. Storage is the
   * one input it does NOT re-read from `config`: that belongs to the instance and
   * comes from `strandStorages`.
   */
  private async buildStrandRuntime(instance: StrandInstance, config: StartStrandConfig): Promise<void> {
    const strandId = instance.strandId;
    const { sAppConfig } = config;

    // The store the instance OWNS (resolved once in `startStrand`), not a fresh
    // resolution: a rebuild must reach the same backend through the same warm cache.
    const strandStorage = this.strandStorages.get(strandId);

    // db-p2p namespaces every one of the node's protocol ids by network name
    // (`/optimystic/<networkName>/...`), so anything dialing this node's own
    // services must derive its prefix from the SAME string the node was built
    // with — hence one binding for both, not two literals that can drift.
    const networkName = `strand-${strandId}`;
    const protocolPrefix = `/optimystic/${networkName}`;

    // Determine relay mode: if explicitly set in config, use that;
    // otherwise default to true for storage profile nodes.
    const enableRelay = config.network?.enableRelay ?? (config.profile === 'storage');
    // The CONFIGURED relay route (the default), deliberately NOT the control node's
    // `'search'` route: nothing drives an explicit reservation for a strand node, so
    // a bare `/p2p-circuit` search entry would register a pending reservation that
    // never gets filled and leave the strand node undialable. The ordering hazard
    // that pushed the control node onto the search route does not exist here — a
    // strand node's protocol ids are namespaced `/optimystic/strand-<id>/…`, so a
    // relay dialed from inside `libp2p.start()` is never in the strand's cohort and
    // cannot refuse its database bring-up. See `relay-addrs.ts`.
    //
    // The strand-node VIEW of the machine's one `NetworkConfig`, not the control
    // node's resolution: fixed direct listen ports become ephemeral (two nodes cannot
    // bind one port) and the announce config is dropped (it names the control node's
    // address). See `strand-network-config.ts` for both, and for the tradeoff.
    const addrOptions = strandNodeAddrs(config.network);

    try {
      // Bound once: the breadth is also the ceiling on the repair yardstick below, and the
      // two must be derived from the same resolution. Inside the `try` deliberately — a
      // rejected clusterSize is a build failure that runs the same cleanup as any other.
      const strandClusterSize = resolveStrandClusterSize(config.clusterSize);

      let t0 = performance.now();
      const node = await createLibp2pNode({
        port: 0, // Random port
        bootstrapNodes: config.bootstrapNodes ?? [],
        networkName,
        storage: strandStorage,
        fretProfile: config.profile === 'storage' ? 'core' : 'edge',
        relay: enableRelay,
        clusterSize: strandClusterSize,
        // Deliberately NOT CONTROL_CLUSTER_POLICY: a strand is application data with its own
        // breadth reasoning, and the shape match with the control policy is a coincidence.
        //
        // The builder declares this node's block-repair corroboration yardstick from the
        // count of machines SERVING this strand, capped at the breadth above (a block
        // never lives on more machines than the cohort is wide). Given no count — the
        // production path today, since no per-strand serving count exists yet — it
        // returns the frozen STRAND_CLUSTER_POLICY itself, declaring nothing. Resolved
        // HERE rather than at `startStrand`, so a wake from hibernation would pick up a
        // serving set that changed while the strand slept.
        clusterPolicy: strandClusterPolicy(strandClusterSize, config.servingMachines),
        arachnode: {
          enableRingZulu: config.profile === 'storage'
        },
        ...(config.privateKey && { privateKey: config.privateKey }),
        ...(config.network?.transports && { transports: config.network.transports }),
        // Listen entries only — a strand node announces nothing the operator configured
        // (`strand-network-config.ts`). An inherited configured `/p2p-circuit` entry is
        // deliberate and survives the derivation untouched: it is what gives a NAT'd
        // strand node a reachable relay slot, and it works because the launch path
        // announces this strand's derived peerId to the relay first (delegate admission;
        // see cadre-node.ts). Those circuit entries come either from a hand-written
        // `network.listenAddrs` or from `network.relayAddrs`, which the resolution folds
        // into the same list on the configured route this call takes (see above).
        ...addrOptions,
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
      // is nothing to copy). Armed for EVERY stored strand: `PeerJoinBackfill`
      // only does work when the strand's libp2p node reports a peer connection,
      // so on a device that is genuinely alone it is inert, and arming it at
      // launch is what closes the "founded alone, never replicates" hole — a
      // peer that joins later gets the founder's blocks without any relaunch.
      // No `authorizePeer` gate, deliberately — see the module comment in
      // peer-join-backfill.ts for the strand-side argument (and why the control
      // network, which DOES gate, is different).
      //
      // NOTE: cost is one PeerJoinBackfill object + one `connection:open` listener
      // per running strand — linear in strand count, negligible at the handful a
      // device or host runs today. If a node ever hosts strands by the hundred,
      // move to one shared listener that dispatches by strand id.
      if (strandStorage && config.backfill?.enabled !== false) {
        if (node.keyNetwork) {
          const backfill = new PeerJoinBackfill({
            label: strandId,
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
   *
   * Leaves `strandStorages` untouched by design — the store outlives the runtime it
   * was built into, which is what makes a resume warm. Only `stopStrand` disposes it.
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
   * Drop the strand's owned store and release this strand's claim on its cache. The
   * wrapper counts holders, so the cache is emptied and unregistered from the shared
   * pool only if no other scope still holds it. Called only where the strand's whole
   * lifetime ends (`stopStrand`, and the failed-launch rollback) — never on a quiesce.
   *
   * A dispose failure is logged, not thrown: the store is already unreferenced here,
   * and failing the stop over a cache-bookkeeping error would leave the caller unable
   * to tear the strand down. `disposeStorageCache` no-ops for an unwrapped store
   * (e.g. `MemoryRawStorage`), so no instanceof test is needed.
   */
  private async disposeStrandStorage(strandId: string): Promise<void> {
    const storage = this.strandStorages.get(strandId);
    if (!storage) {
      return;
    }
    this.strandStorages.delete(strandId);
    try {
      await disposeStorageCache(storage);
    } catch (error) {
      log('Failed to dispose storage cache for strand %s: %o', strandId, error);
    }
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
   * launch (the cohort `bootstrapNodes` seed and the strand's `servingMachines`
   * count) and updates the retained config so a later resume reuses the latest
   * values. Returns the live instance unchanged if it is already running.
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
    // Each `??` matters: a resume that passes no override must keep the retained value,
    // and a resume that passes one must leave it retained for the next resume — otherwise
    // a later no-override wake silently reverts to whatever launch time saw.
    const resumeConfig: StartStrandConfig = {
      ...launchConfig,
      bootstrapNodes: overrides?.bootstrapNodes ?? launchConfig.bootstrapNodes,
      // NOTE: `??` retains, so an override can raise or lower the count but cannot CLEAR it
      // back to "this node no longer knows" — the direction that would declare nothing. Moot
      // while nothing feeds `servingMachines` at all; if a source lands
      // (`backlog/feat-strand-yardstick-from-serving-machines`) that can legitimately lose the
      // count — a strand whose member rows became unreadable — this merge must gain an explicit
      // clear rather than silently declaring a stale number over a serving set it can no longer
      // see. Same applies to `bootstrapNodes` above, where a stale seed is harmless.
      servingMachines: overrides?.servingMachines ?? launchConfig.servingMachines
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
   * Honor a founder request against an ALREADY-TRACKED strand — the seam that
   * closes the "whoever launches first decides whether the bootstrap runs" gap:
   * an instance first launched as a joiner (an app's own attach, or a watcher
   * poll winning the launch race) used to swallow a later founder request
   * silently, leaving the strand active with no `Strand.Header`.
   *
   * Flips the RETAINED launch config's `founder` to true, so every later
   * quiesce → resume rebuild founds as well (the bootstrap is insert-if-absent —
   * {@link StrandDatabase.ensureFounderBootstrap} — so re-running it per rebuild
   * writes nothing twice), and runs the bootstrap against the live database now.
   *
   * @returns how the request resolved:
   * - `'already-founder'` — the retained config already founds; nothing to do.
   * - `'bootstrapped'` — config flipped and the live database ran the bootstrap.
   * - `'needs-resume'` — config flipped, but the instance is quiesced (no live
   *   database), so the bootstrap could not run here: the CALLER must wake the
   *   strand (`CadreNode.wakeStrand`, which owns the hibernation bookkeeping this
   *   manager does not) so the rebuild — which now founds — runs it.
   * @throws when the strand is not tracked — this seam exists only for the
   *   tracked-instance launch path; an untracked id is a caller bug.
   */
  async foundExistingStrand(strandId: string): Promise<'already-founder' | 'bootstrapped' | 'needs-resume'> {
    const instance = this.instances.get(strandId);
    const config = this.launchConfigs.get(strandId);
    if (!instance || !config) {
      throw new Error(`Cannot found strand ${strandId}: not tracked`);
    }
    if (config.founder === true) {
      return 'already-founder';
    }
    // A fresh object rather than mutating in place: startStrand retains the CALLER'S
    // config object, which is not ours to rewrite.
    this.launchConfigs.set(strandId, { ...config, founder: true });
    if (!instance.database) {
      return 'needs-resume';
    }
    await this.ensureFounderBootstrap(strandId);
    return 'bootstrapped';
  }

  /**
   * Run the (idempotent) founder bootstrap against a tracked strand's LIVE
   * database, independently of what the retained launch config says.
   *
   * Separate from {@link foundExistingStrand} because a caller that resolved
   * `'needs-resume'` and woke the strand must not assume the wake's own rebuild
   * founded it: `HibernationManager` COALESCES wakes, so a wake already in flight
   * when the config flipped had already read the PRE-flip config and rebuilt as a
   * joiner. Re-running the bootstrap costs one insert-if-absent probe per table
   * and is the only thing that makes "founding resolves once the Header is
   * written" true on that path.
   *
   * @throws when the strand is not tracked, or is still quiesced (no live
   *   database) — both mean the bootstrap did NOT run, which a founder request
   *   must never swallow.
   */
  async ensureFounderBootstrap(strandId: string): Promise<void> {
    const instance = this.instances.get(strandId);
    if (!instance) {
      throw new Error(`Cannot run the founder bootstrap for strand ${strandId}: not tracked`);
    }
    if (!instance.database) {
      throw new Error(
        `Cannot run the founder bootstrap for strand ${strandId}: it is quiesced, so there ` +
        'is no live database to write to — resume it first.'
      );
    }
    await instance.database.ensureFounderBootstrap();
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
      // Storage is released only here — NOT in releaseRuntime, which a quiesce shares.
      await this.disposeStrandStorage(strandId);
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

