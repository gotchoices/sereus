import { describe, it, expect } from 'vitest';
import type { createLibp2pNode, IRawStorage } from '@optimystic/db-p2p';
import type { ConnectionGater } from '@libp2p/interface';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { CadreNode } from '../src/cadre-node.js';
import { InMemoryKeyStore } from '../src/key-store.js';
import { CONTROL_REPLICATION_BREADTH, DEFAULT_STRAND_CLUSTER_SIZE } from '../src/types.js';
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
 * The dead `NetworkConfig.announceAddrs` / `relayAddrs` fields are
 * deliberately left unasserted — nothing forwards them today, and pinning
 * "ignored" here would cement the bug. Tracked by
 * `backlog/bug-cadre-network-announce-relay-addrs-ignored`.
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

describe('CadreNode control-network node options', () => {
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
      // Left at Optimystic's default of 2: the admission gate measures declared peers
      // against this, not against clusterSize (see CONTROL_REPLICATION_BREADTH).
      expect(options.clusterPolicy?.assumedClusterSize).toBeUndefined();
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
  });

  describe('storage', () => {
    it('calls a factory provider exactly once with the literal "control" strand id', () => {
      const calls: string[] = [];
      const instance = {} as IRawStorage;
      const config = createConfig({ storage: { provider: (strandId) => { calls.push(strandId); return instance; } } });

      const options = controlOptions(new CadreNode(config));

      expect(calls).toEqual(['control']);
      expect(options.storage).toBe(instance);
    });

    it('passes an instance provider through unwrapped (same object identity)', () => {
      const instance = {} as IRawStorage;
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
