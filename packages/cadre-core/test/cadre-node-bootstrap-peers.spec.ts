import { describe, it, expect } from 'vitest';
import { CadreNode } from '../src/cadre-node.js';
import { MemoryBootstrapPeerStore } from '../src/bootstrap-peer-store.js';
import type { CadreNodeConfig } from '../src/types.js';

/**
 * Wiring coverage for the node-local cold-start bootstrap-peer store
 * (`CadreNodeConfig.bootstrapPeers` → `CadreNode.getBootstrapPeerStore`):
 * construction/adoption in start(), survival across stop()→start(), and the
 * fail-closed party-scope check. The store contract itself is covered in
 * bootstrap-peer-store.spec.ts, and the dial/retention behaviour in
 * cadre-node-control-cohort.spec.ts.
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
