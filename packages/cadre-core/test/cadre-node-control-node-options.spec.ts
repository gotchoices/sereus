import { describe, it, expect, beforeAll } from 'vitest';
import type { createLibp2pNode, IRawStorage } from '@optimystic/db-p2p';
import { CachedRawStorage, MemoryRawStorage } from '@optimystic/db-p2p';
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
 * `NetworkConfig.announceAddrs` is still forwarded by nobody and is left
 * unasserted here — pinning "ignored" would cement the bug. Blocked on the
 * `announce-addrs-option` request filed against `@optimystic/db-p2p`;
 * `cadre-node-announce-addrs-warning.spec.ts` pins the interim warning.
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
   * `relayAddrs` was settable in `cadre.yaml`, via `CADRE_RELAY_ADDRS`, and through the
   * Docker entrypoint while being read by nobody — a node told to use a relay quietly
   * kept no reservation and stayed unreachable behind NAT. The listen addr IS the
   * reservation, so these two assertions are the ones that would have caught it; the
   * resolution rules themselves are owned by `relay-addrs.spec.ts`.
   */
  describe('relayAddrs', () => {
    it('reaches listenAddrs as a circuit addr, alongside the configured listen addrs', () => {
      const options = controlOptions(new CadreNode(createConfig({
        network: { listenAddrs: ['/ip4/0.0.0.0/tcp/4001'], relayAddrs: [RELAY_ADDR] }
      })));

      expect(options.listenAddrs).toEqual(['/ip4/0.0.0.0/tcp/4001', `${RELAY_ADDR}/p2p-circuit`]);
    });

    it('becomes a delegate-announce target, so this node\'s strand nodes may reserve on it too', () => {
      const node = new CadreNode(createConfig({ network: { relayAddrs: [RELAY_ADDR] } }));

      // Without this, a configured relay would hold the CONTROL node's reservation but
      // deny the strand node's — the strand runs as a derived transport peerId the
      // relay's membership gate does not know (see delegate-admission.ts).
      expect(circuitRelayTargets(node)).toEqual([
        { relayPeerId: RELAY_PEER_ID, relayAddr: RELAY_ADDR }
      ]);
    });

    it('is not required — a node with no relayAddrs announces to no relays', () => {
      const node = new CadreNode(createConfig({ network: { listenAddrs: ['/ip4/0.0.0.0/tcp/4001'] } }));

      expect(circuitRelayTargets(node)).toEqual([]);
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
