import { describe, it, expect } from 'vitest';
import { CadreNode } from '../src/cadre-node.js';
import { MemoryBootstrapPeerStore, type BootstrapPeerStore } from '../src/bootstrap-peer-store.js';
import type { CadreNodeConfig } from '../src/types.js';

/**
 * Wiring coverage for the node-local bootstrap-peer store
 * (`CadreNodeConfig.bootstrapPeers` → `CadreNode.getBootstrapPeerStore`):
 * construction/adoption in start(), survival across stop()→start(), the
 * fail-closed party-scope check, and the entries `addDrone` / `removePeer` keep.
 * The store contract itself is covered in bootstrap-peer-store.spec.ts, and the
 * dial/seed-retention behaviour in cadre-node-control-cohort.spec.ts.
 */
describe('CadreNode bootstrap-peer store wiring', () => {
	function makeNode(partyId: string, bootstrapPeers?: CadreNodeConfig['bootstrapPeers']): CadreNode {
		return new CadreNode({
			controlNetwork: { partyId, bootstrapNodes: [] },
			profile: 'transaction',
			bootstrapPeers,
		});
	}

	/** Start a node and neutralize the background self-registration timer. */
	async function startClean(node: CadreNode): Promise<void> {
		await node.start();
		clearTimeout((node as unknown as { selfRegistrationTimer: ReturnType<typeof setTimeout> }).selfRegistrationTimer);
		(node as unknown as { selfRegistrationTimer: null }).selfRegistrationTimer = null;
	}

	it('exposes no store before start, a party-scoped in-memory default after', async () => {
		const partyId = 'bootpeers-' + Math.random().toString(36).slice(2);
		const node = makeNode(partyId);
		expect(node.getBootstrapPeerStore()).toBeNull();
		try {
			await startClean(node);
			const store = node.getBootstrapPeerStore();
			expect(store).not.toBeNull();
			expect(store!.partyId).toBe(partyId);
			expect(store!.all().size).toBe(0);
		} finally {
			await node.stop();
		}
	}, 60_000);

	it('adopts an injected store and keeps its targets across stop()→start()', async () => {
		const partyId = 'bootpeers-' + Math.random().toString(36).slice(2);
		const injected = new MemoryBootstrapPeerStore(partyId);
		const node = makeNode(partyId, { store: injected });
		try {
			await startClean(node);
			expect(node.getBootstrapPeerStore()).toBe(injected);

			await injected.record('12D3KooWFakeOwner', ['/ip4/1.2.3.4/tcp/4001/ws']);

			// Restart cycle: the retry targets survive (same store, nothing dropped).
			await node.stop();
			await startClean(node);
			expect(node.getBootstrapPeerStore()).toBe(injected);
			expect([...node.getBootstrapPeerStore()!.all().keys()]).toEqual(['12D3KooWFakeOwner']);
		} finally {
			await node.stop();
		}
	}, 120_000);

	it('an injected store scoped to a different party fails start() closed', async () => {
		const node = makeNode('bootpeers-' + Math.random().toString(36).slice(2), {
			store: new MemoryBootstrapPeerStore('some-other-party'),
		});
		await expect(node.start()).rejects.toThrow(/refusing to mix cold-start dial targets/i);
	}, 60_000);
});

/**
 * An owner that adds a node keeps the addresses it was handed, because that is all
 * it has to dial until the added node publishes a signed record — and a node that
 * cannot listen is never dialed by it. The seed-bootstrap service is a stub here:
 * the row and seed it writes are seed-bootstrap.spec.ts's, and the dial that
 * consumes the entry is cadre-node-control-cohort.spec.ts's.
 */
describe('CadreNode dial targets for the nodes it adds and removes', () => {
	const SELF = '12D3KooWSelf';
	const DRONE = '12D3KooWDrone';
	const DRONE_ADDRS = ['/ip4/127.0.0.1/tcp/4001', '/ip4/192.168.1.20/tcp/4002/ws'];
	const DRONE_RESULT = { seed: { partyId: 'p', peers: [], signature: '', signerKey: '' }, encodedSeed: 'seed' };

	interface ServiceStub {
		addDrone?: () => Promise<unknown>;
		removePeer?: () => Promise<void>;
	}

	/** A started-looking node: a store, a control node naming `SELF`, and a stub service. */
	function wire(service: ServiceStub = {}, store: BootstrapPeerStore = new MemoryBootstrapPeerStore('p')): {
		node: CadreNode;
		store: BootstrapPeerStore;
	} {
		const node = new CadreNode({ controlNetwork: { partyId: 'p', bootstrapNodes: [] }, profile: 'transaction' });
		const internals = node as unknown as Record<string, unknown>;
		internals.bootstrapPeerStore = store;
		internals.controlNode = { peerId: { toString: () => SELF }, getConnections: () => [] };
		internals.seedBootstrapService = {
			addDrone: service.addDrone ?? (async () => DRONE_RESULT),
			removePeer: service.removePeer ?? (async () => {}),
		};
		return { node, store };
	}

	it('addDrone retains the drone\'s handed-over addresses and returns the seed', async () => {
		const { node, store } = wire();

		const result = await node.addDrone({ dronePeerId: DRONE, droneMultiaddrs: DRONE_ADDRS });

		expect(result).toBe(DRONE_RESULT);
		expect(store.all().get(DRONE)?.addrs).toEqual(DRONE_ADDRS);
	});

	it('addDrone with no addresses retains nothing', async () => {
		const { node, store } = wire();

		await node.addDrone({ dronePeerId: DRONE, droneMultiaddrs: [] });

		expect(store.all().size).toBe(0);
	});

	it('a failing addDrone retains nothing', async () => {
		const { node, store } = wire({ addDrone: async () => { throw new Error('not an owner'); } });

		await expect(node.addDrone({ dronePeerId: DRONE, droneMultiaddrs: DRONE_ADDRS })).rejects.toThrow('not an owner');

		expect(store.all().size).toBe(0);
	});

	it('addDrone of this node\'s own id retains nothing (the cold-start pass would dial itself)', async () => {
		const { node, store } = wire();

		await node.addDrone({ dronePeerId: SELF, droneMultiaddrs: DRONE_ADDRS });

		expect(store.all().size).toBe(0);
	});

	it('addDrone still resolves when persisting the dial target fails, keeping it in memory', async () => {
		class FailingPersistStore extends MemoryBootstrapPeerStore {
			override async record(peerId: string, addrs: readonly string[]): Promise<void> {
				await super.record(peerId, addrs);
				throw new Error('disk full');
			}
		}
		const { node, store } = wire({}, new FailingPersistStore('p'));

		await expect(node.addDrone({ dronePeerId: DRONE, droneMultiaddrs: DRONE_ADDRS })).resolves.toBe(DRONE_RESULT);

		expect(store.all().get(DRONE)?.addrs).toEqual(DRONE_ADDRS);
	});

	it('removePeer forgets the removed peer\'s dial target and no other', async () => {
		const { node, store } = wire();
		await store.record(DRONE, DRONE_ADDRS);
		await store.record('12D3KooWOwner', ['/ip4/9.9.9.9/tcp/9/ws']);

		await node.removePeer(DRONE);

		expect([...store.all().keys()]).toEqual(['12D3KooWOwner']);
	});

	it('a failing removePeer keeps the dial target', async () => {
		const { node, store } = wire({ removePeer: async () => { throw new Error('delete refused'); } });
		await store.record(DRONE, DRONE_ADDRS);

		await expect(node.removePeer(DRONE)).rejects.toThrow('delete refused');

		expect(store.all().has(DRONE)).toBe(true);
	});
});
