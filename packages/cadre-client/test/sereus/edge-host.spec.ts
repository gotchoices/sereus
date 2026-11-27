import { describe, expect, it } from 'vitest';
import type { EdgeNode } from '@serfab/cadre-core/edge-node';
import { edgeNodeHost } from '../../src/sereus/edge-host.js';

function fakeEdge(state: 'running' | 'stopped' = 'running') {
	const restarts: string[][] = [];
	const statusListeners = new Set<() => void>();
	const options = { partyId: 'party', bootstrapAddrs: [], relayAddrs: ['/dns4/a.example/tcp/443/wss/p2p/A'] };
	const node = {
		getControlNode: () => null,
		getMultiaddrs: () => [],
		getRelayReservationState: () => ({ status: 'reserved' }),
	};
	const edge = {
		get node() { return state === 'running' ? node : null; },
		get options() { return state === 'running' ? options : null; },
		get status() { return state === 'running' ? { state, node, owner: 'enrolled' } : { state }; },
		on: () => () => {},
		onStatus: (fn: () => void) => { statusListeners.add(fn); return () => statusListeners.delete(fn); },
		loadSavedStart: async () => ({ options, autoStart: true }),
		restart: async (o: { relayAddrs: string[] }) => { restarts.push(o.relayAddrs); options.relayAddrs = o.relayAddrs; return node; },
	} as unknown as EdgeNode;
	return { edge, restarts, fireStatus: () => statusListeners.forEach(fn => fn()) };
}

describe('edgeNodeHost', () => {
	it('reads the party, owner standing, relays and reservation from the edge node', async () => {
		const { edge } = fakeEdge();
		const host = edgeNodeHost(edge).node;
		expect(host.partyId()).toBe('party');
		expect(host.ownerEnrolled()).toBe(true);
		expect(host.relayStatus()).toBe('reserved');
		expect(await host.getRelayAddrs()).toEqual(['/dns4/a.example/tcp/443/wss/p2p/A']);
	});

	it('restarts the node for a new relay set, and not for the same one', async () => {
		const { edge, restarts } = fakeEdge();
		const host = edgeNodeHost(edge).node;
		await host.applyRelays(['/dns4/a.example/tcp/443/wss/p2p/A']);
		expect(restarts).toEqual([]);
		await host.applyRelays(['/dns4/b.example/tcp/443/wss/p2p/B']);
		expect(restarts).toEqual([['/dns4/b.example/tcp/443/wss/p2p/B']]);
	});

	it('refuses new relays on a stopped node, and still reads the saved ones', async () => {
		const { edge } = fakeEdge('stopped');
		const host = edgeNodeHost(edge).node;
		expect(await host.getRelayAddrs()).toEqual(['/dns4/a.example/tcp/443/wss/p2p/A']);
		await expect(host.applyRelays([])).rejects.toThrow(/not running/);
		expect(host.ownerEnrolled()).toBe(false);
	});

	it('signals a reachability change when the node starts, stops or is rebuilt', () => {
		const { edge, fireStatus } = fakeEdge();
		let changes = 0;
		const off = edgeNodeHost(edge).node.onReachabilityChange(() => { changes++; });
		fireStatus();
		off();
		fireStatus();
		expect(changes).toBe(1);
	});
});
