import { describe, it, expect, beforeAll } from 'vitest';
import type { createLibp2pNode, IRawStorage, NodeStorage } from '@optimystic/db-p2p';
import { CachedRawStorage, defaultCachePool, memoryNodeStorage, noisePureJsCrypto } from '@optimystic/db-p2p';
import type { ConnectionGater } from '@libp2p/interface';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { CircuitRelayTarget } from '../src/delegate-admission.js';
import { CadreNode } from '../src/cadre-node.js';
import { controlStorageScope } from '../src/storage-scope.js';
import { InMemoryKeyStore } from '../src/key-store.js';
import { CONTROL_CLUSTER_POLICY, CONTROL_REPLICATION_BREADTH, DEFAULT_CONNECTION_MONITOR, DEFAULT_STRAND_CLUSTER_SIZE, MIN_CLUSTER_SIZE } from '../src/types.js';
import { MemoryEnrolledMachineStore } from '../src/enrolled-machine-store.js';
import type { CadreNodeConfig, StorageConfig } from '../src/types.js';

/**
 * `buildControlNodeOptions` is the private config→options mapping
 * `createControlNode` hands to `createLibp2pNode` (see the doc comment on
 * `buildControlNodeOptions` in `cadre-node.ts`). It reads only `this.config`
 * and `this.identityKey`, so calling it on a bare `new CadreNode(config)`
 * keeps this a pure unit test — no libp2p node is started, no database is
 * opened, no filesystem is touched. `resolveIdentityKey` is likewise pure
 * (reads only `config.keyStore` / `config.privateKey`), so the identity tests
 * below stay just as cheap.
 *
 * Identity RESOLUTION semantics (keyStore-vs-privateKey precedence, first-run
 * generation, corrupt bytes, the mutually-exclusive error) are covered by
 * `cadre-node-identity.spec.ts` and are not repeated here — this file only
 * asks whether the resolved key (or its absence) reaches the node options.
 *
 * `NetworkConfig.announceAddrs` / `appendAnnounceAddrs` are asserted below like any
 * other passthrough; the narrowed operator warning that survives alongside them lives
 * in `cadre-node-announce-addrs-warning.spec.ts`.
 */

function createConfig(overrides?: Partial<CadreNodeConfig>): CadreNodeConfig {
  return {
    controlNetwork: {
      partyId: 'control-options-test-' + Math.random().toString(36).slice(2),
      bootstrapNodes: []
    },
    nodeClass: 'device',
    ...overrides
  };
}

function controlOptions(node: CadreNode): Promise<Parameters<typeof createLibp2pNode>[0]> {
  return (node as unknown as {
    buildControlNodeOptions: () => Promise<Parameters<typeof createLibp2pNode>[0]>
  }).buildControlNodeOptions();
}

/**
 * `cleanup` is the teardown `stop()` delegates to (and `start()` calls on a failed
 * launch). Reached the same private-cast way as `buildControlNodeOptions`, so the
 * storage-lifecycle tests below stay in this file's pure-unit budget.
 */
function nodeCleanup(node: CadreNode): Promise<void> {
  return (node as unknown as { cleanup(): Promise<void> }).cleanup();
}

function resolveIdentity(node: CadreNode): Promise<void> {
  return (node as unknown as { resolveIdentityKey(): Promise<void> }).resolveIdentityKey();
}

/**
 * `circuitRelayTargets` is likewise private and likewise pure on a bare node — with no
 * started control node it reads only `this.config.network`, so it costs no more than
 * `buildControlNodeOptions` above.
 */
function circuitRelayTargets(node: CadreNode): CircuitRelayTarget[] {
  return (node as unknown as { circuitRelayTargets(): CircuitRelayTarget[] }).circuitRelayTargets();
}

/** A real peerId, since the relay-addr resolution validates the one it is given. */
let RELAY_PEER_ID: string;
let RELAY_ADDR: string;

beforeAll(async () => {
  RELAY_PEER_ID = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
  RELAY_ADDR = `/dns4/relay.example.com/tcp/4001/p2p/${RELAY_PEER_ID}`;
});

describe('CadreNode control-network node options', () => {
  /**
   * The control network's breadth is what makes the write-while-alone queueing in
   * `cadre-node-control-replication.spec.ts` a *backstop* rather than the primary
   * convergence mechanism, so it gets its own guard: nothing else fails if
   * `buildControlNodeOptions` stops passing `CONTROL_REPLICATION_BREADTH`, and a
   * narrower cohort silently reintroduces the never-converging read-repair case
   * documented on the constant.
   */
  describe('cluster replication breadth', () => {
    it('replicates the control DB to the whole party, not the strand default', async () => {
      const options = await controlOptions(new CadreNode(createConfig()));

      expect(options.clusterSize).toBe(CONTROL_REPLICATION_BREADTH);
      expect(options.clusterSize).toBeGreaterThan(DEFAULT_STRAND_CLUSTER_SIZE);
    });

    it('is not configurable — strandClusterSize does not reach the control node', async () => {
      const options = await controlOptions(new CadreNode(createConfig({ strandClusterSize: 3 })));

      expect(options.clusterSize).toBe(CONTROL_REPLICATION_BREADTH);
    });

    it('lets Optimystic shrink the cohort to the party that actually exists', async () => {
      // Without `allowDownsize` a 16-wide target would never be satisfiable by a real
      // (2-7 node) party, so the two settings only make sense together.
      const options = await controlOptions(new CadreNode(createConfig()));

      expect(options.clusterPolicy?.allowDownsize).toBe(true);
      // Declared, not left to default. The admission gate would default to this same 2, but
      // the read-repair corroboration floor falls back to `clusterSize` instead — 16 for the
      // control network — which makes two distinct non-self corroborators mandatory and so
      // makes repair impossible for a two-node party. See CONTROL_CLUSTER_POLICY.
      expect(options.clusterPolicy?.assumedClusterSize).toBe(2);
    });

    it('builds a control-scoped network, keeping it distinct from any strand network', async () => {
      const config = createConfig();
      const options = await controlOptions(new CadreNode(config));

      expect(options.networkName).toBe(`control-${config.controlNetwork.partyId}`);
    });

    it('sets sizeTolerance alongside allowDownsize — a fixed 16-wide target has no other way to shrink', async () => {
      const options = await controlOptions(new CadreNode(createConfig()));

      expect(options.clusterPolicy?.sizeTolerance).toBe(0.5);
    });

    it('leaves superMajorityThreshold unset, so control writes commit at Optimystic\'s 0.75', async () => {
      const options = await controlOptions(new CadreNode(createConfig()));

      // Absence is the setting: `libp2p-node-base.ts` resolves
      // `clusterPolicy?.superMajorityThreshold ?? DEFAULT_SUPER_MAJORITY_THRESHOLD` (0.75)
      // for BOTH the cluster member and the coordinator. Naming any value here — as the
      // integration harness once did with 0.51 — makes some other deployment approve
      // control writes on fewer peers than this one. See CONTROL_CLUSTER_POLICY.
      expect(options.clusterPolicy?.superMajorityThreshold).toBeUndefined();
      expect(options.clusterPolicy).toBe(CONTROL_CLUSTER_POLICY);
    });

    it('routes network.cohortQueryTimeoutMs into the control node\'s read deadline', async () => {
      // What this file owns is the WIRING: that the host's field reaches `clusterPolicy` at all.
      // The builder's own contract — the frozen base by identity when nothing is declared, a
      // count and a deadline not shadowing each other, and that the declared deadline exceeds
      // Optimystic's 1000 ms LAN default — is pinned on the builder itself, in
      // `quereus-plugin-sereus/test/plugin.spec.ts`.
      //
      // 12000, not the 7000 default: an override equal to the declared default would also pass
      // against a node that dropped `network` on the floor.
      const options = await controlOptions(new CadreNode(createConfig({
        network: { cohortQueryTimeoutMs: 12_000 }
      })));

      expect(options.clusterPolicy?.cohortQueryTimeoutMs).toBe(12_000);
      expect(options.clusterPolicy).not.toBe(CONTROL_CLUSTER_POLICY);
    });
  });

  /**
   * The block-repair corroboration yardstick, declared from the machines this party
   * had enrolled at this node's LAST look — read out of the node-local
   * `EnrolledMachineStore` in `start()` because the control libp2p node is built
   * before the database holding the membership rows exists (see
   * `enrolled-machine-store.ts`).
   *
   * `initializeEnrolledMachineStore` is the private step of `start()` that captures
   * the count; reached the same private-cast way as `buildControlNodeOptions`, so
   * these stay pure unit tests with no libp2p node and no database.
   */
  describe('repair yardstick (repairCorroborationClusterSize)', () => {
    function captureEnrolledMachines(node: CadreNode): void {
      (node as unknown as { initializeEnrolledMachineStore(): void }).initializeEnrolledMachineStore();
    }

    /** Options built by a node whose node-local record holds `count` machines. */
    async function optionsForCount(count: number): Promise<Parameters<typeof createLibp2pNode>[0]> {
      const config = createConfig();
      const store = new MemoryEnrolledMachineStore(config.controlNetwork.partyId);
      await store.record(count);
      const node = new CadreNode({ ...config, enrolledMachines: { store } });
      captureEnrolledMachines(node);
      return await controlOptions(node);
    }

    it('declares nothing when the node has never recorded a count — the base policy, by identity', async () => {
      // The cold-start path must be byte-for-byte the behaviour that shipped before
      // this record existed, which is what object identity proves: `controlClusterPolicy`
      // returns the frozen shared constant itself rather than a copy of it.
      const config = createConfig();
      const node = new CadreNode(config);
      captureEnrolledMachines(node);

      const options = await controlOptions(node);

      expect(options.clusterPolicy).toBe(CONTROL_CLUSTER_POLICY);
      expect(options.clusterPolicy?.repairCorroborationClusterSize).toBeUndefined();
    });

    it('declares nothing when start() has not captured a count yet', async () => {
      // `buildControlNodeOptions` reads a field, not the store, so a node that never
      // reached `initializeEnrolledMachineStore` declares nothing rather than throwing.
      const options = await controlOptions(new CadreNode(createConfig()));

      expect(options.clusterPolicy).toBe(CONTROL_CLUSTER_POLICY);
    });

    it('declares a recorded count of 5 as 5', async () => {
      const options = await optionsForCount(5);

      // Structural, not identity: a known count builds a fresh frozen policy.
      expect(options.clusterPolicy?.repairCorroborationClusterSize).toBe(5);
      // The yardstick moves ALONE — the membership admission gate stays pinned at 2,
      // because a party of phones cannot promise three quarters of its machines are awake.
      expect(options.clusterPolicy?.assumedClusterSize).toBe(2);
      expect(options.clusterPolicy?.superMajorityThreshold).toBeUndefined();
      expect(options.clusterPolicy).not.toBe(CONTROL_CLUSTER_POLICY);
    });

    it('floors a recorded count of 1 at MIN_CLUSTER_SIZE, declaring 2', async () => {
      // A lone node is a genuine founder-alone party, but it is equally a freshly
      // seeded node whose membership rows have not replicated — and it cannot tell
      // those apart. 2 is also what declaring nothing resolves to, so the floor makes
      // the derivation able only to RAISE the number.
      const options = await optionsForCount(1);

      expect(options.clusterPolicy?.repairCorroborationClusterSize).toBe(MIN_CLUSTER_SIZE);
      expect(options.clusterPolicy?.repairCorroborationClusterSize).toBe(2);
    });

    it('caps a party larger than the control breadth at that breadth', async () => {
      // A block only ever lives on `min(breadth, machines serving)` machines, and the
      // control cohort caps at 16 too — declaring 20 would make the commit freshness
      // rule harder to satisfy while buying nothing on repair.
      const options = await optionsForCount(20);

      expect(options.clusterPolicy?.repairCorroborationClusterSize).toBe(CONTROL_REPLICATION_BREADTH);
      expect(options.clusterPolicy?.repairCorroborationClusterSize).toBe(16);
    });

    it('fails closed when the injected store is scoped to another party', () => {
      const config = createConfig();
      const node = new CadreNode({
        ...config,
        enrolledMachines: { store: new MemoryEnrolledMachineStore('some-other-party') }
      });

      expect(() => captureEnrolledMachines(node)).toThrow(/scoped to party some-other-party/);
    });

    it('re-reads the store on each capture, so a restart applies a count the last run learned', async () => {
      const config = createConfig();
      const store = new MemoryEnrolledMachineStore(config.controlNetwork.partyId);
      const node = new CadreNode({ ...config, enrolledMachines: { store } });

      captureEnrolledMachines(node);
      expect((await controlOptions(node)).clusterPolicy).toBe(CONTROL_CLUSTER_POLICY);

      // What `refreshAuthorizedControlPeers` does during the run...
      await store.record(4);
      // ...reaches the policy only at the next start(), never mid-process: Optimystic
      // froze the policy when the node was built and offers no runtime setter.
      captureEnrolledMachines(node);
      expect((await controlOptions(node)).clusterPolicy?.repairCorroborationClusterSize).toBe(4);
    });
  });

  describe('storage', () => {
    /** A `StorageConfig.open` that records each scope it is asked for and hands back one value. */
    function recordingOpen(storage: NodeStorage): { open: StorageConfig['open']; calls: string[] } {
      const calls: string[] = [];
      return { open: async (scope) => { calls.push(scope); return storage; }, calls };
    }

    /** Storage whose `blocks` is not in-memory, so `withReadCache` really wraps it. */
    function cacheableStorage(): NodeStorage {
      return { ...memoryNodeStorage(), blocks: {} as IRawStorage };
    }

    it("opens the scope exactly once with this party's control scope key, and hands the node the cached blocks", async () => {
      const storage = cacheableStorage();
      const { open, calls } = recordingOpen(storage);
      const config = createConfig({ storage: { open } });
      const node = new CadreNode(config);

      const options = await controlOptions(node);

      // The control scope carries the party id, so two parties on one device get two
      // stores — the property itself is pinned in `control-storage-scope.spec.ts`.
      expect(calls).toEqual([controlStorageScope(config.controlNetwork.partyId)]);
      // The node is handed the opened value with the read cache in front of its blocks, so it
      // passes that store through and takes no lease of its own — which is what keeps the cache
      // warm across every runtime rebuild.
      expect(options.storage?.blocks).toBeInstanceOf(CachedRawStorage);
      // The two stores beside `blocks` reach the node untouched, from the same opened value:
      // a `pieces` from somewhere else would be counted twice in the node's storage account.
      expect(options.storage?.kv).toBe(storage.kv);
      expect(options.storage?.pieces).toBe(storage.pieces);
      await nodeCleanup(node);
    });

    it('passes in-memory blocks through unwrapped (nothing to save caching memory)', async () => {
      const storage = memoryNodeStorage();
      const config = createConfig({ storage: { open: async () => storage } });

      const options = await controlOptions(new CadreNode(config));

      expect(options.storage?.blocks).toBe(storage.blocks);
    });

    it('leaves storage undefined when no storage config is supplied', async () => {
      // Absent rather than `memoryNodeStorage()`, so Optimystic still logs the `node-wiring`
      // warning naming what a restart then loses — passing an explicit in-memory value is how a
      // host says it meant the memory case, and would suppress it.
      const options = await controlOptions(new CadreNode(createConfig()));

      expect(options.storage).toBeUndefined();
    });

    it('passes the operator allotment through unchanged, and states none when there is none', async () => {
      // Unchanged and NOT divided by the strand count: a node's allotment is fixed when the node
      // is built while the strand count changes as it runs (`StorageConfig.allotmentBytes`).
      const withAllotment = await controlOptions(new CadreNode(createConfig({
        storage: { open: async () => memoryNodeStorage(), allotmentBytes: 7 * 2 ** 30 }
      })));
      expect(withAllotment.storageAllotment).toEqual({ bytes: 7 * 2 ** 30 });

      const without = await controlOptions(new CadreNode(createConfig({
        storage: { open: async () => memoryNodeStorage() }
      })));
      expect(without.storageAllotment).toBeUndefined();
    });

    /**
     * The control storage belongs to the NODE, not to the call that builds its options.
     * `buildControlNodeOptions` runs once per `CadreNode.start()`, and `start()` is
     * guarded only by `_running` — which `stop()` clears — so a re-open per call
     * would open a second set of stores over one location on a stop()/start() cycle, leaving
     * the first lease unreleasable in the process-wide cache pool. These two
     * pin the open-once rule `StorageConfig.open` states.
     */
    it('opens the scope once per node, not once per call', async () => {
      const { open, calls } = recordingOpen(cacheableStorage());
      const config = createConfig({ storage: { open } });
      const node = new CadreNode(config);

      const first = await controlOptions(node);
      const second = await controlOptions(node);

      expect(calls).toEqual([controlStorageScope(config.controlNetwork.partyId)]);
      expect(second.storage).toBe(first.storage);
      await nodeCleanup(node);
    });

    it('opens the scope once even when two callers ask before the first open settles', async () => {
      // `buildControlNodeOptions` and `startControlBackfill` both reach the resolver, and the
      // open is asynchronous now — so the IN-FLIGHT promise has to be memoized, not just the
      // resolved value. On LevelDB a second open over one handle throws outright.
      let opens = 0;
      const config = createConfig({
        storage: {
          open: async () => {
            opens++;
            await Promise.resolve();
            return cacheableStorage();
          }
        }
      });
      const node = new CadreNode(config);

      const [first, second] = await Promise.all([controlOptions(node), controlOptions(node)]);

      expect(opens).toBe(1);
      expect(second.storage).toBe(first.storage);
      await nodeCleanup(node);
    });

    it('holds the storage even when the opener mints a fresh value per call', async () => {
      // Nothing below the node can help here: `withReadCache` dedupes by store identity or
      // object, and a fresh object per call reports neither. Only the node's own ownership can.
      let minted = 0;
      const config = createConfig({ storage: { open: async () => { minted++; return cacheableStorage(); } } });
      const node = new CadreNode(config);

      const first = await controlOptions(node);
      const second = await controlOptions(node);

      expect(minted).toBe(1);
      expect(second.storage).toBe(first.storage);
      await nodeCleanup(node);
    });

    /**
     * The release half of the same ownership rule. `cleanup()` runs on every `stop()`
     * and on a failed `start()`; if it did not release the lease and drop the field, a
     * `stop()`/`start()` cycle would leave the cache claimed over a location the next open
     * can never release, and its registration would sit in the process-wide pool for the
     * process lifetime. `cleanup` is safe to call on a bare node — every handle it touches is
     * either null or a constructor-built object whose stop/dispose is a no-op when never started.
     */
    it('cleanup releases the control cache lease it took', async () => {
      // NOTE: measured relative to a baseline taken here, since the cache pool is
      // process-wide and the storage tests above leave registrations behind. Sound only
      // while vitest runs this file's tests sequentially (its default); marking the file
      // `concurrent` would race these baselines — pass each arm its own SharedCachePool then.
      const before = defaultCachePool().stats().stores.length;
      const node = new CadreNode(createConfig({ storage: { open: async () => cacheableStorage() } }));

      await controlOptions(node);
      expect(defaultCachePool().stats().stores.length).toBe(before + 1);

      await nodeCleanup(node);

      expect(defaultCachePool().stats().stores.length).toBe(before);
    });

    it('re-opens against a LIVE cache after cleanup, not the retired one', async () => {
      // An opener that returns a stable value per scope (the web reference app, the integration
      // harness) is the case that would otherwise regress: `withReadCache` dedupes by store
      // object here, so without `cleanup` releasing the lease the second cycle would be handed
      // the retired cache back.
      const { open, calls } = recordingOpen(cacheableStorage());
      const config = createConfig({ storage: { open } });
      const node = new CadreNode(config);

      const first = (await controlOptions(node)).storage;
      await nodeCleanup(node);
      const second = (await controlOptions(node)).storage;

      const scope = controlStorageScope(config.controlNetwork.partyId);
      expect(calls).toEqual([scope, scope]);
      expect(second?.blocks).toBeInstanceOf(CachedRawStorage);
      expect(second?.blocks).not.toBe(first?.blocks);
      await nodeCleanup(node);
    });
  });

  describe('node-class-derived options', () => {
    it('a server maps to the core fret profile and enables Ring Zulu', async () => {
      const options = await controlOptions(new CadreNode(createConfig({ nodeClass: 'server' })));

      expect(options.fretProfile).toBe('core');
      expect(options.arachnode?.enableRingZulu).toBe(true);
    });

    it('a device maps to the edge fret profile and disables Ring Zulu', async () => {
      const options = await controlOptions(new CadreNode(createConfig({ nodeClass: 'device' })));

      expect(options.fretProfile).toBe('edge');
      expect(options.arachnode?.enableRingZulu).toBe(false);
    });

    // The one role that must never reach the control node: a client control node could not read
    // its own party's state with nothing reachable, which is the promise the control network
    // exists to keep. The breach would be silent — `createControlNode` would throw on the missing
    // repo only at start() — so the mapping is pinned here, where every other option of the
    // control node is.
    it('never builds the control node as a client, whatever strandCohortMember says', async () => {
      const options = await controlOptions(new CadreNode(createConfig({ nodeClass: 'server', roles: { strandCohortMember: false } })));

      expect(options.servesBlocks).toBeUndefined();
    });
  });

  describe('relay', () => {
    it('defaults to enabled for a server node', async () => {
      const options = await controlOptions(new CadreNode(createConfig({ nodeClass: 'server' })));

      expect(options.relay).toBe(true);
    });

    it('defaults to disabled for a device', async () => {
      const options = await controlOptions(new CadreNode(createConfig({ nodeClass: 'device' })));

      expect(options.relay).toBe(false);
    });

    it('an explicit false overrides the server default (?? not ||)', async () => {
      const options = await controlOptions(new CadreNode(createConfig({ nodeClass: 'server', network: { enableRelay: false } })));

      expect(options.relay).toBe(false);
    });

    it('an explicit true overrides the device default', async () => {
      const options = await controlOptions(new CadreNode(createConfig({ nodeClass: 'device', network: { enableRelay: true } })));

      expect(options.relay).toBe(true);
    });

    it('runs the server without libp2p\'s per-connection data/duration cap, and hands a disabled one no init', async () => {
      // libp2p's default init caps every relayed connection at 128 KiB or 2 min, which
      // cut off every sync forwarded through a party's own always-on machine (#19).
      const on = await controlOptions(new CadreNode(createConfig({ nodeClass: 'server' })));
      const off = await controlOptions(new CadreNode(createConfig({ nodeClass: 'device' })));

      expect(on.relayServerInit?.reservations?.applyDefaultLimit).toBe(false);
      expect(off).not.toHaveProperty('relayServerInit');
    });
  });

  describe('network passthrough', () => {
    it('always binds an ephemeral port (0) — a fixed port would collide with strand nodes in-process', async () => {
      const options = await controlOptions(new CadreNode(createConfig()));

      expect(options.port).toBe(0);
    });

    it('builds the node without the configured bootstrapNodes — they are dialed after bring-up', async () => {
      const config = createConfig({ controlNetwork: { partyId: 'p', bootstrapNodes: ['/ip4/1.2.3.4/tcp/1/p2p/x'] } });

      const options = await controlOptions(new CadreNode(config));

      expect(options.bootstrapNodes).toEqual([]);
    });

    it('passes bootstrapNodes as [], not undefined — createLibp2pNode requires the field', async () => {
      const options = await controlOptions(new CadreNode(createConfig()));

      expect(options.bootstrapNodes).toEqual([]);
    });

    it('forwards an empty listenAddrs array — a device that names no listener of its own', async () => {
      const options = await controlOptions(new CadreNode(createConfig({ network: { listenAddrs: [] } })));

      expect('listenAddrs' in options).toBe(true);
      expect(options.listenAddrs).toEqual([]);
    });

    it('forwards a populated listenAddrs array', async () => {
      const options = await controlOptions(new CadreNode(createConfig({ network: { listenAddrs: ['/ip4/0.0.0.0/tcp/0'] } })));

      expect(options.listenAddrs).toEqual(['/ip4/0.0.0.0/tcp/0']);
    });

    it('forwards a configured transports array', async () => {
      const transports = [{ fake: 'transport' }] as unknown as NonNullable<CadreNodeConfig['network']>['transports'];
      const options = await controlOptions(new CadreNode(createConfig({ network: { transports } })));

      expect(options.transports).toBe(transports);
    });

    it('forwards a configured noiseCrypto', async () => {
      const noiseCrypto = { ...noisePureJsCrypto };
      const options = await controlOptions(new CadreNode(createConfig({ network: { noiseCrypto } })));

      expect(options.noiseCrypto).toBe(noiseCrypto);
    });

    /**
     * `connectionMonitor` is the one `NetworkConfig` field that is DEFAULTED rather
     * than passed through: libp2p's own 5s ping deadline aborts the connection to a
     * peer whose event loop is saturated by pure-JS Noise crypto, and the monitor runs
     * on both ends, so the default has to apply to every node rather than only the slow
     * one (see `DEFAULT_CONNECTION_MONITOR`). Its strand-node half is pinned in
     * `strand-instance-manager-network-addrs.spec.ts`.
     */
    it('defaults connectionMonitor when unset, and lets a configured value replace it', async () => {
      expect((await controlOptions(new CadreNode(createConfig()))).connectionMonitor).toBe(DEFAULT_CONNECTION_MONITOR);

      const connectionMonitor = { abortConnectionOnPingFailure: false };
      const options = await controlOptions(new CadreNode(createConfig({ network: { connectionMonitor } })));

      expect(options.connectionMonitor).toBe(connectionMonitor);
    });

    it('omits transports, noiseCrypto and listenAddrs (and still resolves relay) when network is entirely absent', async () => {
      const options = await controlOptions(new CadreNode(createConfig()));

      expect('transports' in options).toBe(false);
      expect('noiseCrypto' in options).toBe(false);
      expect('listenAddrs' in options).toBe(false);
      expect(options.relay).toBe(false);
      expect(options.connectionGater).toBeDefined();
      expect(options.authorizeInboundStream).toBeInstanceOf(Function);
    });

    /**
     * A listen address and the transports the node will actually have are two halves of
     * the same config, and libp2p checks them only in the all-or-nothing sense: it drops
     * every address no transport claims and raises only if that leaves none. A `/ws`
     * address paired with a TCP one therefore used to vanish in silence — the shipped
     * React Native drone config, and `cadre start --ws-port`, both bound no WebSocket
     * listener at all. `wsPort` is db-p2p's switch for adding `webSockets()`; its VALUE
     * is never bound (see `relay-addrs.ts`), which is why it is 0 rather than 4002.
     */
    it('turns db-p2p\'s WebSocket transport on when a listen address names /ws', async () => {
      const options = await controlOptions(new CadreNode(createConfig({
        network: { listenAddrs: ['/ip4/0.0.0.0/tcp/4001', '/ip4/0.0.0.0/tcp/4002/ws'] }
      })));

      expect(options.wsPort).toBe(0);
      // The operator's port lives in the ADDRESS, which is forwarded verbatim.
      expect(options.listenAddrs).toEqual(['/ip4/0.0.0.0/tcp/4001', '/ip4/0.0.0.0/tcp/4002/ws']);
    });

    it('leaves wsPort off when nothing names WebSocket', async () => {
      const options = await controlOptions(new CadreNode(createConfig({
        network: { listenAddrs: ['/ip4/0.0.0.0/tcp/4001'] }
      })));

      expect('wsPort' in options).toBe(false);
    });

    /**
     * QUIC, WebRTC and WebTransport stay unbindable by design — deriving them would pull
     * transport packages into every `cadre-core` consumer including the browser and React
     * Native bundles. Refusing to start names the address; the old behaviour named nothing.
     */
    it('refuses to build options for a listen address no default transport can bind', async () => {
      await expect(controlOptions(new CadreNode(createConfig({
        network: { listenAddrs: ['/ip4/0.0.0.0/tcp/4001', '/ip4/0.0.0.0/udp/4001/quic-v1'] }
      })))).rejects.toThrow(/needs @libp2p\/quic/);
    });

    /** An embedder supplying its own factories owns transport policy — neither arm applies. */
    it('neither derives nor refuses when network.transports is set', async () => {
      const transports = [{ fake: 'transport' }] as unknown as NonNullable<CadreNodeConfig['network']>['transports'];

      const options = await controlOptions(new CadreNode(createConfig({
        network: { transports, listenAddrs: ['/ip4/0.0.0.0/tcp/4002/ws', '/ip4/0.0.0.0/udp/4001/quic-v1'] }
      })));

      expect('wsPort' in options).toBe(false);
      expect(options.transports).toBe(transports);
    });
  });

  /**
   * `announceAddrs` was settable in `cadre.yaml`, via `CADRE_ANNOUNCE_ADDRS`, and through
   * the Docker entrypoint while being forwarded by nobody — an operator who named the
   * address their node was actually reachable at kept advertising the one it merely bound.
   * These pin the two upstream `NodeOptions` fields it now reaches, and the two rules that
   * are easy to regress: empty means unset, and a typo fails at start.
   */
  describe('announceAddrs / appendAnnounceAddrs', () => {
    it('forwards a configured announceAddrs — what the node advertises INSTEAD OF what it binds', async () => {
      const options = await controlOptions(new CadreNode(createConfig({
        network: { announceAddrs: ['/dns4/mynode.example.com/tcp/4001'] }
      })));

      expect(options.announceAddrs).toEqual(['/dns4/mynode.example.com/tcp/4001']);
      expect('appendAnnounceAddrs' in options).toBe(false);
    });

    it('forwards a configured appendAnnounceAddrs — advertised IN ADDITION TO what it binds', async () => {
      const options = await controlOptions(new CadreNode(createConfig({
        network: { appendAnnounceAddrs: ['/dns4/mynode.example.com/tcp/4001'] }
      })));

      expect(options.appendAnnounceAddrs).toEqual(['/dns4/mynode.example.com/tcp/4001']);
      expect('announceAddrs' in options).toBe(false);
    });

    /**
     * Both at once is upstream's precedence to resolve, not ours: libp2p ignores
     * `appendAnnounce` while `announce` is non-empty. This repo forwards what it was
     * given rather than merging or dropping one locally, so the operator's config and
     * the node's options stay the same document.
     */
    it('forwards both verbatim when both are configured, leaving precedence to libp2p', async () => {
      const options = await controlOptions(new CadreNode(createConfig({
        network: {
          announceAddrs: ['/dns4/replaces.example.com/tcp/4001'],
          appendAnnounceAddrs: ['/dns4/ignored.example.com/tcp/4001']
        }
      })));

      expect(options.announceAddrs).toEqual(['/dns4/replaces.example.com/tcp/4001']);
      expect(options.appendAnnounceAddrs).toEqual(['/dns4/ignored.example.com/tcp/4001']);
    });

    /**
     * Deliberately UNLIKE the `listenAddrs: []` case above, where an empty array is a
     * meaningful setting (React Native cannot listen). An empty announce array says
     * nothing an operator could mean, and libp2p reads `announce: []` as "no override"
     * anyway — so the key is dropped rather than forwarded, and cannot land as an
     * explicit empty announce set if that upstream semantic ever changes.
     */
    it('drops an empty array rather than forwarding it as an explicit empty announce set', async () => {
      const options = await controlOptions(new CadreNode(createConfig({
        network: { announceAddrs: [], appendAnnounceAddrs: [] }
      })));

      expect('announceAddrs' in options).toBe(false);
      expect('appendAnnounceAddrs' in options).toBe(false);
    });

    it('omits both keys when network carries neither', async () => {
      const options = await controlOptions(new CadreNode(createConfig({ network: { listenAddrs: [] } })));

      expect('announceAddrs' in options).toBe(false);
      expect('appendAnnounceAddrs' in options).toBe(false);
    });

    /**
     * libp2p does NOT validate announce addrs at construction — `AddressManager` keeps
     * them as raw strings and only parses on the first `getAnnounceAddrs()`. Left to it,
     * a typo yields a node that starts cleanly and then throws `InvalidMultiaddrError`
     * out of every `getMultiaddrs()` call, including an UNHANDLED one from the debounced
     * peer-store update. `announce-addrs.ts` parses up front so the typo is a loud
     * startup failure instead, matching what `relayAddrs` already does.
     */
    it('throws on a malformed entry, naming the config field and the offending value', async () => {
      const node = new CadreNode(createConfig({ network: { announceAddrs: ['not-a-multiaddr'] } }));

      await expect(controlOptions(node)).rejects.toThrow(/network\.announceAddrs entry is not a valid multiaddr: not-a-multiaddr/);
    });

    it('validates appendAnnounceAddrs on the same terms', async () => {
      const node = new CadreNode(createConfig({ network: { appendAnnounceAddrs: ['tcp/4001'] } }));

      await expect(controlOptions(node)).rejects.toThrow(/network\.appendAnnounceAddrs entry is not a valid multiaddr: tcp\/4001/);
    });
  });

  /**
   * `relayAddrs` was settable in `cadre.yaml`, via `CADRE_RELAY_ADDRS`, and through the
   * Docker entrypoint while being read by nobody — a node told to use a relay quietly
   * kept no reservation and stayed unreachable behind NAT. So the assertions here are
   * "the setting reaches the listen list" and "the setting reaches the announce
   * targets"; the resolution rules themselves are owned by `relay-addrs.spec.ts`.
   */
  describe('relayAddrs', () => {
    /**
     * The listen entry is the bare SEARCH addr, NOT `<relay>/p2p-circuit`. A
     * configured circuit listener dials the relay from inside `libp2p.start()`,
     * which put a sibling in this node's Optimystic cohort before
     * `ControlDatabase.initialize()` ran and killed bring-up against a sibling that
     * had not yet replicated this node's membership row. `CadreNode.start()` drives
     * the reservation explicitly after bring-up instead (see
     * `driveControlRelayReservation`), so this assertion is what keeps the ordering
     * from silently regressing.
     */
    it('reaches listenAddrs as the bare /p2p-circuit search entry, so start() opens no connection', async () => {
      const options = await controlOptions(new CadreNode(createConfig({
        network: { listenAddrs: ['/ip4/0.0.0.0/tcp/4001'], relayAddrs: [RELAY_ADDR] }
      })));

      expect(options.listenAddrs).toEqual(['/ip4/0.0.0.0/tcp/4001', '/p2p-circuit']);
    });

    it('contributes one search entry however many relays are named', async () => {
      const options = await controlOptions(new CadreNode(createConfig({
        network: { listenAddrs: [], relayAddrs: [RELAY_ADDR, `/ip4/9.9.9.9/tcp/4001/p2p/${RELAY_PEER_ID}`] }
      })));

      expect(options.listenAddrs).toEqual(['/p2p-circuit']);
    });

    /**
     * `requireRelay: false` only softens what `driveControlRelayReservation` does
     * with a failed first attempt (`cadre-node.ts`) — it changes nothing about the
     * listen set `buildControlNodeOptions` resolves. A tolerated start still needs
     * the bare search entry to land a later reservation on.
     */
    it('still carries the bare /p2p-circuit search entry when requireRelay is false', async () => {
      const options = await controlOptions(new CadreNode(createConfig({
        network: { listenAddrs: ['/ip4/0.0.0.0/tcp/4001'], relayAddrs: [RELAY_ADDR], requireRelay: false }
      })));

      expect(options.listenAddrs).toEqual(['/ip4/0.0.0.0/tcp/4001', '/p2p-circuit']);
    });

    it('still validates every entry at option-build time, even though the search entry discards them', async () => {
      const node = new CadreNode(createConfig({ network: { relayAddrs: ['/ip4/1.2.3.4/tcp/4001'] } }));

      await expect(controlOptions(node)).rejects.toThrow(/network\.relayAddrs entry names no relay peerId/);
    });

    it('becomes a delegate-announce target, so this node\'s strand nodes may reserve on it too', () => {
      const node = new CadreNode(createConfig({ network: { relayAddrs: [RELAY_ADDR] } }));

      // Without this, a configured relay would hold the CONTROL node's reservation but
      // deny the strand node's — the strand runs as a derived transport peerId the
      // relay's membership gate does not know (see delegate-admission.ts). The target
      // must survive the search-entry mapping above: a bare `/p2p-circuit` names no
      // relay, so `circuitRelayTargets` reads `network.relayAddrs` itself.
      expect(circuitRelayTargets(node)).toEqual([
        { relayPeerId: RELAY_PEER_ID, relayAddr: RELAY_ADDR }
      ]);
    });

    it('is not required — a node with no relayAddrs announces to no relays', () => {
      const node = new CadreNode(createConfig({ network: { listenAddrs: ['/ip4/0.0.0.0/tcp/4001'] } }));

      expect(circuitRelayTargets(node)).toEqual([]);
    });

    it('still announces to a hand-written configured circuit entry in listenAddrs', () => {
      const node = new CadreNode(createConfig({
        network: { listenAddrs: [`${RELAY_ADDR}/p2p-circuit`] }
      }));

      expect(circuitRelayTargets(node)).toEqual([
        { relayPeerId: RELAY_PEER_ID, relayAddr: RELAY_ADDR }
      ]);
    });
  });

  describe('identity', () => {
    it('omits privateKey entirely on the ephemeral path (no keyStore, no privateKey)', async () => {
      const node = new CadreNode(createConfig());
      await resolveIdentity(node);

      const options = await controlOptions(node);

      expect('privateKey' in options).toBe(false);
    });

    it('forwards config.privateKey verbatim once resolved', async () => {
      const key = await generateKeyPair('Ed25519');
      const node = new CadreNode(createConfig({ privateKey: key }));
      await resolveIdentity(node);

      const options = await controlOptions(node);

      expect(options.privateKey).toBe(key);
    });

    it('forwards the keyStore-resolved identity, stable across repeated calls', async () => {
      const node = new CadreNode(createConfig({ keyStore: new InMemoryKeyStore() }));
      await resolveIdentity(node);
      const identityKey = (node as unknown as { identityKey: unknown }).identityKey;

      const first = await controlOptions(node);
      const second = await controlOptions(node);

      expect(first.privateKey).toBe(identityKey);
      expect(second.privateKey).toBe(identityKey);
    });
  });

  describe('object freshness', () => {
    it('builds a fresh object on every call — equal scalar fields, distinct object identity', async () => {
      const node = new CadreNode(createConfig());

      const first = await controlOptions(node);
      const second = await controlOptions(node);

      expect(first).not.toBe(second);
      expect(first.clusterSize).toBe(second.clusterSize);
      expect(first.networkName).toBe(second.networkName);
      expect(first.fretProfile).toBe(second.fretProfile);
      expect(first.relay).toBe(second.relay);
    });
  });

  describe('connectionGater', () => {
    it('is always present even when no caller gater is configured', async () => {
      const options = await controlOptions(new CadreNode(createConfig()));

      expect(options.connectionGater).toBeDefined();
    });

    it('composes a caller-supplied gater rather than passing it through untouched', async () => {
      const callerGater: ConnectionGater = { denyDialMultiaddr: () => false };
      const options = await controlOptions(new CadreNode(createConfig({ network: { connectionGater: callerGater } })));

      expect(options.connectionGater).toBeDefined();
      expect(options.connectionGater).not.toBe(callerGater);
    });

    it('honors a caller-supplied non-inbound hook through the composed gater', async () => {
      let called = false;
      const callerGater: ConnectionGater = { denyDialMultiaddr: () => { called = true; return true; } };
      const options = await controlOptions(new CadreNode(createConfig({ network: { connectionGater: callerGater } })));

      const denied = await options.connectionGater?.denyDialMultiaddr?.(
        {} as Parameters<NonNullable<ConnectionGater['denyDialMultiaddr']>>[0]
      );

      expect(called).toBe(true);
      expect(denied).toBe(true);
    });
  });

  describe('authorizeInboundStream', () => {
    it('is present and bound to this node — admits on a not-yet-started node', async () => {
      const options = await controlOptions(new CadreNode(createConfig()));

      expect(options.authorizeInboundStream).toBeInstanceOf(Function);
      // admitControlPeerUnconditionally's "not running / no control DB" baseline
      // admits unconditionally; the gate's real policy is owned by
      // control-stream-authorization.spec.ts. The predicate is deliberately
      // synchronous, so `await` on its result is a no-op that still works for
      // either return shape.
      const admitted = await options.authorizeInboundStream?.('some-peer-id', 'some-protocol');
      expect(admitted).toBe(true);
    });
  });
});
