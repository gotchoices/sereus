import { describe, it, expect, beforeAll } from 'vitest';
import type { createLibp2pNode, IRawStorage } from '@optimystic/db-p2p';
import { CachedRawStorage, MemoryRawStorage, defaultCachePool } from '@optimystic/db-p2p';
import { wrapStorageWithCache } from '@serfab/quereus-plugin-sereus';
import type { ConnectionGater, MultiaddrConnection, PeerId } from '@libp2p/interface';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { CircuitRelayTarget } from '../src/delegate-admission.js';
import { CadreNode } from '../src/cadre-node.js';
import { InMemoryKeyStore } from '../src/key-store.js';
import { CONTROL_CLUSTER_POLICY, CONTROL_REPLICATION_BREADTH, DEFAULT_STRAND_CLUSTER_SIZE } from '../src/types.js';
import type { CadreNodeConfig } from '../src/types.js';

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
    profile: 'transaction',
    ...overrides
  };
}

function controlOptions(node: CadreNode): Parameters<typeof createLibp2pNode>[0] {
  return (node as unknown as {
    buildControlNodeOptions: () => Parameters<typeof createLibp2pNode>[0]
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
    it('replicates the control DB to the whole party, not the strand default', () => {
      const options = controlOptions(new CadreNode(createConfig()));

      expect(options.clusterSize).toBe(CONTROL_REPLICATION_BREADTH);
      expect(options.clusterSize).toBeGreaterThan(DEFAULT_STRAND_CLUSTER_SIZE);
    });

    it('is not configurable — strandClusterSize does not reach the control node', () => {
      const options = controlOptions(new CadreNode(createConfig({ strandClusterSize: 3 })));

      expect(options.clusterSize).toBe(CONTROL_REPLICATION_BREADTH);
    });

    it('lets Optimystic shrink the cohort to the party that actually exists', () => {
      // Without `allowDownsize` a 16-wide target would never be satisfiable by a real
      // (2-7 node) party, so the two settings only make sense together.
      const options = controlOptions(new CadreNode(createConfig()));

      expect(options.clusterPolicy?.allowDownsize).toBe(true);
      // Declared, not left to default. The admission gate would default to this same 2, but
      // the read-repair corroboration floor falls back to `clusterSize` instead — 16 for the
      // control network — which makes two distinct non-self corroborators mandatory and so
      // makes repair impossible for a two-node party. See CONTROL_CLUSTER_POLICY.
      expect(options.clusterPolicy?.assumedClusterSize).toBe(2);
    });

    it('builds a control-scoped network, keeping it distinct from any strand network', () => {
      const config = createConfig();
      const options = controlOptions(new CadreNode(config));

      expect(options.networkName).toBe(`control-${config.controlNetwork.partyId}`);
    });

    it('sets sizeTolerance alongside allowDownsize — a fixed 16-wide target has no other way to shrink', () => {
      const options = controlOptions(new CadreNode(createConfig()));

      expect(options.clusterPolicy?.sizeTolerance).toBe(0.5);
    });

    it('leaves superMajorityThreshold unset, so control writes commit at Optimystic\'s 0.75', () => {
      const options = controlOptions(new CadreNode(createConfig()));

      // Absence is the setting: `libp2p-node-base.ts` resolves
      // `clusterPolicy?.superMajorityThreshold ?? DEFAULT_SUPER_MAJORITY_THRESHOLD` (0.75)
      // for BOTH the cluster member and the coordinator. Naming any value here — as the
      // integration harness once did with 0.51 — makes some other deployment approve
      // control writes on fewer peers than this one. See CONTROL_CLUSTER_POLICY.
      expect(options.clusterPolicy?.superMajorityThreshold).toBeUndefined();
      expect(options.clusterPolicy).toBe(CONTROL_CLUSTER_POLICY);
    });
  });

  describe('storage', () => {
    it('calls a factory provider exactly once with the literal "control" strand id, and hands the node the cached wrap', () => {
      const calls: string[] = [];
      const instance = {} as IRawStorage;
      const config = createConfig({ storage: { provider: (strandId) => { calls.push(strandId); return instance; } } });

      const options = controlOptions(new CadreNode(config));

      expect(calls).toEqual(['control']);
      // The node gets the write-through cached view of the provided storage, and the
      // wrap is memoized per inner instance — a second resolution of the same instance
      // must reuse the same cache, never stack a second one over the same backend.
      expect(options.storage).toBeInstanceOf(CachedRawStorage);
      expect(options.storage).toBe(wrapStorageWithCache(instance, 'control'));
    });

    it('passes an instance provider through the same memoized cached wrap', () => {
      const instance = {} as IRawStorage;
      const config = createConfig({ storage: { provider: instance } });

      const options = controlOptions(new CadreNode(config));

      expect(options.storage).toBeInstanceOf(CachedRawStorage);
      expect(options.storage).toBe(wrapStorageWithCache(instance, 'control'));
    });

    it('passes a MemoryRawStorage instance through unwrapped (nothing to save caching memory)', () => {
      const instance = new MemoryRawStorage();
      const config = createConfig({ storage: { provider: instance } });

      const options = controlOptions(new CadreNode(config));

      expect(options.storage).toBe(instance);
    });

    it('leaves storage undefined when no storage config is supplied', () => {
      const options = controlOptions(new CadreNode(createConfig()));

      expect(options.storage).toBeUndefined();
    });

    /**
     * The control store belongs to the NODE, not to the call that builds its options.
     * `buildControlNodeOptions` runs once per `CadreNode.start()`, and `start()` is
     * guarded only by `_running` — which `stop()` clears — so a re-resolution per call
     * would mint a second store over one backend on a stop()/start() cycle, leaving the
     * first wrapper's registration orphaned in the process-wide cache pool. These two
     * pin the resolve-once rule `RawStorageProvider` states.
     */
    it('resolves the provider once per node, not once per call', () => {
      const calls: string[] = [];
      const instance = {} as IRawStorage;
      const config = createConfig({ storage: { provider: (strandId) => { calls.push(strandId); return instance; } } });
      const node = new CadreNode(config);

      const first = controlOptions(node);
      const second = controlOptions(node);

      expect(calls).toEqual(['control']);
      expect(second.storage).toBe(first.storage);
    });

    it('holds the store even when the factory mints a fresh instance per call', () => {
      // The memo in `wrapStorageWithCache` is keyed on the inner instance, so it cannot
      // help here — only the node's own ownership can.
      let minted = 0;
      const config = createConfig({ storage: { provider: () => { minted++; return {} as IRawStorage; } } });
      const node = new CadreNode(config);

      const first = controlOptions(node);
      const second = controlOptions(node);

      expect(minted).toBe(1);
      expect(second.storage).toBe(first.storage);
    });

    /**
     * The release half of the same ownership rule. `cleanup()` runs on every `stop()`
     * and on a failed `start()`; if it did not drop the field, a `stop()`/`start()`
     * cycle would hand the restarted control node the RETIRED wrapper (its pool store
     * id is unregistered and never reused), and the wrapper's registration would sit
     * in the process-wide pool for the process lifetime. `cleanup` is safe to call on
     * a bare node — every handle it touches is either null or a constructor-built
     * object whose stop/dispose is a no-op when never started.
     */
    it('cleanup retires the control store registration it created', async () => {
      // NOTE: measured relative to a baseline taken here, since the cache pool is
      // process-wide and the storage tests above leave registrations behind. Sound only
      // while vitest runs this file's tests sequentially (its default); marking the file
      // `concurrent` would race these baselines — pass each arm its own SharedCachePool then.
      const before = defaultCachePool().stats().stores.length;
      const node = new CadreNode(createConfig({ storage: { provider: () => ({}) as IRawStorage } }));

      controlOptions(node);
      expect(defaultCachePool().stats().stores.length).toBe(before + 1);

      await nodeCleanup(node);

      expect(defaultCachePool().stats().stores.length).toBe(before);
    });

    it('re-resolves against a LIVE cache after cleanup, not the retired wrapper', async () => {
      // A provider that returns a stable instance per scope (the web reference app,
      // the integration harness) is the case that would otherwise regress: the memo in
      // `wrapStorageWithCache` is keyed on that inner instance, so without the memo
      // eviction `disposeStorageCache` performs, the second cycle would be handed the
      // disposed wrapper back.
      const calls: string[] = [];
      const instance = {} as IRawStorage;
      const node = new CadreNode(createConfig({
        storage: { provider: (scope) => { calls.push(scope); return instance; } }
      }));

      const first = controlOptions(node).storage;
      await nodeCleanup(node);
      const second = controlOptions(node).storage;

      expect(calls).toEqual(['control', 'control']);
      expect(second).toBeInstanceOf(CachedRawStorage);
      expect(second).not.toBe(first);
      await nodeCleanup(node);
    });
  });

  describe('profile-derived options', () => {
    it('storage profile maps to the core fret profile and enables Ring Zulu', () => {
      const options = controlOptions(new CadreNode(createConfig({ profile: 'storage' })));

      expect(options.fretProfile).toBe('core');
      expect(options.arachnode?.enableRingZulu).toBe(true);
    });

    it('transaction profile maps to the edge fret profile and disables Ring Zulu', () => {
      const options = controlOptions(new CadreNode(createConfig({ profile: 'transaction' })));

      expect(options.fretProfile).toBe('edge');
      expect(options.arachnode?.enableRingZulu).toBe(false);
    });
  });

  describe('relay', () => {
    it('defaults to enabled for a storage-profile node', () => {
      const options = controlOptions(new CadreNode(createConfig({ profile: 'storage' })));

      expect(options.relay).toBe(true);
    });

    it('defaults to disabled for a transaction-profile node', () => {
      const options = controlOptions(new CadreNode(createConfig({ profile: 'transaction' })));

      expect(options.relay).toBe(false);
    });

    it('an explicit false overrides the storage-profile default (?? not ||)', () => {
      const options = controlOptions(new CadreNode(createConfig({ profile: 'storage', network: { enableRelay: false } })));

      expect(options.relay).toBe(false);
    });

    it('an explicit true overrides the transaction-profile default', () => {
      const options = controlOptions(new CadreNode(createConfig({ profile: 'transaction', network: { enableRelay: true } })));

      expect(options.relay).toBe(true);
    });
  });

  describe('network passthrough', () => {
    it('always binds an ephemeral port (0) — a fixed port would collide with strand nodes in-process', () => {
      const options = controlOptions(new CadreNode(createConfig()));

      expect(options.port).toBe(0);
    });

    it('forwards configured bootstrapNodes element-for-element', () => {
      const config = createConfig({ controlNetwork: { partyId: 'p', bootstrapNodes: ['/ip4/1.2.3.4/tcp/1/p2p/x'] } });

      const options = controlOptions(new CadreNode(config));

      expect(options.bootstrapNodes).toEqual(['/ip4/1.2.3.4/tcp/1/p2p/x']);
    });

    it('forwards an empty bootstrapNodes as [], not undefined — createLibp2pNode requires the field', () => {
      const options = controlOptions(new CadreNode(createConfig()));

      expect(options.bootstrapNodes).toEqual([]);
    });

    it('forwards an empty listenAddrs array — the React Native "cannot listen" case', () => {
      const options = controlOptions(new CadreNode(createConfig({ network: { listenAddrs: [] } })));

      expect('listenAddrs' in options).toBe(true);
      expect(options.listenAddrs).toEqual([]);
    });

    it('forwards a populated listenAddrs array', () => {
      const options = controlOptions(new CadreNode(createConfig({ network: { listenAddrs: ['/ip4/0.0.0.0/tcp/0'] } })));

      expect(options.listenAddrs).toEqual(['/ip4/0.0.0.0/tcp/0']);
    });

    it('forwards a configured transports array', () => {
      const transports = [{ fake: 'transport' }] as unknown as NonNullable<CadreNodeConfig['network']>['transports'];
      const options = controlOptions(new CadreNode(createConfig({ network: { transports } })));

      expect(options.transports).toBe(transports);
    });

    it('omits transports and listenAddrs (and still resolves relay) when network is entirely absent', () => {
      const options = controlOptions(new CadreNode(createConfig()));

      expect('transports' in options).toBe(false);
      expect('listenAddrs' in options).toBe(false);
      expect(options.relay).toBe(false);
      expect(options.connectionGater).toBeDefined();
      expect(options.authorizeInboundStream).toBeInstanceOf(Function);
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
    it('forwards a configured announceAddrs — what the node advertises INSTEAD OF what it binds', () => {
      const options = controlOptions(new CadreNode(createConfig({
        network: { announceAddrs: ['/dns4/mynode.example.com/tcp/4001'] }
      })));

      expect(options.announceAddrs).toEqual(['/dns4/mynode.example.com/tcp/4001']);
      expect('appendAnnounceAddrs' in options).toBe(false);
    });

    it('forwards a configured appendAnnounceAddrs — advertised IN ADDITION TO what it binds', () => {
      const options = controlOptions(new CadreNode(createConfig({
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
    it('forwards both verbatim when both are configured, leaving precedence to libp2p', () => {
      const options = controlOptions(new CadreNode(createConfig({
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
    it('drops an empty array rather than forwarding it as an explicit empty announce set', () => {
      const options = controlOptions(new CadreNode(createConfig({
        network: { announceAddrs: [], appendAnnounceAddrs: [] }
      })));

      expect('announceAddrs' in options).toBe(false);
      expect('appendAnnounceAddrs' in options).toBe(false);
    });

    it('omits both keys when network carries neither', () => {
      const options = controlOptions(new CadreNode(createConfig({ network: { listenAddrs: [] } })));

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
    it('throws on a malformed entry, naming the config field and the offending value', () => {
      const node = new CadreNode(createConfig({ network: { announceAddrs: ['not-a-multiaddr'] } }));

      expect(() => controlOptions(node)).toThrow(/network\.announceAddrs entry is not a valid multiaddr: not-a-multiaddr/);
    });

    it('validates appendAnnounceAddrs on the same terms', () => {
      const node = new CadreNode(createConfig({ network: { appendAnnounceAddrs: ['tcp/4001'] } }));

      expect(() => controlOptions(node)).toThrow(/network\.appendAnnounceAddrs entry is not a valid multiaddr: tcp\/4001/);
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
    it('reaches listenAddrs as the bare /p2p-circuit search entry, so start() opens no connection', () => {
      const options = controlOptions(new CadreNode(createConfig({
        network: { listenAddrs: ['/ip4/0.0.0.0/tcp/4001'], relayAddrs: [RELAY_ADDR] }
      })));

      expect(options.listenAddrs).toEqual(['/ip4/0.0.0.0/tcp/4001', '/p2p-circuit']);
    });

    it('contributes one search entry however many relays are named', () => {
      const options = controlOptions(new CadreNode(createConfig({
        network: { listenAddrs: [], relayAddrs: [RELAY_ADDR, `/ip4/9.9.9.9/tcp/4001/p2p/${RELAY_PEER_ID}`] }
      })));

      expect(options.listenAddrs).toEqual(['/p2p-circuit']);
    });

    it('still validates every entry at option-build time, even though the search entry discards them', () => {
      const node = new CadreNode(createConfig({ network: { relayAddrs: ['/ip4/1.2.3.4/tcp/4001'] } }));

      expect(() => controlOptions(node)).toThrow(/network\.relayAddrs entry names no relay peerId/);
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

      const options = controlOptions(node);

      expect('privateKey' in options).toBe(false);
    });

    it('forwards config.privateKey verbatim once resolved', async () => {
      const key = await generateKeyPair('Ed25519');
      const node = new CadreNode(createConfig({ privateKey: key }));
      await resolveIdentity(node);

      const options = controlOptions(node);

      expect(options.privateKey).toBe(key);
    });

    it('forwards the keyStore-resolved identity, stable across repeated calls', async () => {
      const node = new CadreNode(createConfig({ keyStore: new InMemoryKeyStore() }));
      await resolveIdentity(node);
      const identityKey = (node as unknown as { identityKey: unknown }).identityKey;

      const first = controlOptions(node);
      const second = controlOptions(node);

      expect(first.privateKey).toBe(identityKey);
      expect(second.privateKey).toBe(identityKey);
    });
  });

  describe('object freshness', () => {
    it('builds a fresh object on every call — equal scalar fields, distinct object identity', () => {
      const node = new CadreNode(createConfig());

      const first = controlOptions(node);
      const second = controlOptions(node);

      expect(first).not.toBe(second);
      expect(first.clusterSize).toBe(second.clusterSize);
      expect(first.networkName).toBe(second.networkName);
      expect(first.fretProfile).toBe(second.fretProfile);
      expect(first.relay).toBe(second.relay);
    });
  });

  describe('connectionGater', () => {
    it('is always present even when no caller gater is configured', () => {
      const options = controlOptions(new CadreNode(createConfig()));

      expect(options.connectionGater).toBeDefined();
    });

    it('composes a caller-supplied gater rather than passing it through untouched', () => {
      const callerGater: ConnectionGater = { denyDialMultiaddr: () => false };
      const options = controlOptions(new CadreNode(createConfig({ network: { connectionGater: callerGater } })));

      expect(options.connectionGater).toBeDefined();
      expect(options.connectionGater).not.toBe(callerGater);
    });

    it('honors a caller-supplied non-inbound hook through the composed gater', async () => {
      let called = false;
      const callerGater: ConnectionGater = { denyDialMultiaddr: () => { called = true; return true; } };
      const options = controlOptions(new CadreNode(createConfig({ network: { connectionGater: callerGater } })));

      const denied = await options.connectionGater?.denyDialMultiaddr?.(
        {} as Parameters<NonNullable<ConnectionGater['denyDialMultiaddr']>>[0]
      );

      expect(called).toBe(true);
      expect(denied).toBe(true);
    });

    it('routes the composed inbound-encrypted hook back into this node', async () => {
      const options = controlOptions(new CadreNode(createConfig()));

      // The membership admission policy the gater is built around is
      // `this.admitInboundControlConnection`; on a bare, not-yet-started node its
      // `admitControlPeerUnconditionally` baseline admits, so the composed hook must
      // resolve to "not denied". A hook wired to the wrong method (or to no node at
      // all) denies or throws here. The gater's own composition/fail-open semantics
      // are owned by membership-connection-gater.spec.ts.
      const denied = await options.connectionGater?.denyInboundEncryptedConnection?.(
        { toString: () => 'some-peer-id' } as PeerId,
        {} as MultiaddrConnection
      );

      expect(denied).toBe(false);
    });
  });

  describe('authorizeInboundStream', () => {
    it('is present and bound to this node — admits on a not-yet-started node', async () => {
      const options = controlOptions(new CadreNode(createConfig()));

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
