/**
 * Reachability over a stand-in node: who answers an invitation from this device.
 */
import { describe, expect, it } from 'vitest';
import type { CadreNode } from '@serfab/cadre-core';
import { createCadreClient } from '../../src/sereus/client.js';
import type { CadreHost } from '../../src/sereus/host.js';

type Machine = { peerId: string; isSelf: boolean; trusted: boolean; alwaysOn: boolean | null; lastPublishedAt: number | null };

function fakeHost(opts: {
	ownAddrs?: string[];
	reach?: 'anywhere' | 'local-network' | 'issuer-only';
	machines?: Machine[];
	relays?: string[];
	hang?: boolean;
}): CadreHost {
	const never = new Promise<never>(() => {});
	const node = {
		peerId: { toString: () => 'self' },
		getMultiaddrs: () => opts.ownAddrs ?? [],
		invitationReach: () => (opts.hang ? never : Promise.resolve(opts.reach ?? 'issuer-only')),
		listMachines: () => (opts.hang ? never : Promise.resolve(opts.machines ?? [])),
		listMembers: () => Promise.resolve([]),
		getOwnerSigner: () => null,
	} as unknown as CadreNode;
	return {
		node: {
			node,
			on: () => () => {},
			getRelayAddrs: async () => opts.relays ?? [],
			applyRelays: async () => {},
			partyId: () => 'party',
			ownerEnrolled: () => true,
			relayStatus: () => (opts.ownAddrs?.length ? 'reserved' : 'none'),
			onReachabilityChange: () => () => {},
		},
	};
}

const server: Machine = { peerId: 'server', isSelf: false, trusted: true, alwaysOn: true, lastPublishedAt: 1 };

describe('reachability', () => {
	it('is this device when it holds an address (a relay reservation)', async () => {
		const client = createCadreClient(fakeHost({ ownAddrs: ['/dns4/relay.example/tcp/443/wss/p2p/r/p2p-circuit'] }));
		expect(await client.reachability.get()).toMatchObject({ reachable: true, via: 'this-device' });
		expect(await client.invitable()).toEqual({ ok: true, value: 'this-device' });
	});

	it('is an own machine when an always-on machine has a public address, with no relay', async () => {
		const client = createCadreClient(fakeHost({ reach: 'anywhere', machines: [server] }));
		expect(await client.reachability.get()).toMatchObject({ reachable: true, via: 'own-machine', relayPending: false });
		expect(await client.invitable()).toEqual({ ok: true, value: 'own-machine' });
	});

	it('is not reachable when the own machine is on the home network only', async () => {
		const client = createCadreClient(fakeHost({ reach: 'local-network', machines: [server] }));
		expect(await client.reachability.get()).toMatchObject({ reachable: false, via: null });
		const invitable = await client.invitable();
		expect(invitable.ok ? null : invitable.error.kind).toBe('unreachable');
	});

	it('does not count a machine that is not always on, or not trusted', async () => {
		const phone = { ...server, alwaysOn: false };
		const untrusted = { ...server, trusted: false };
		for (const machine of [phone, untrusted]) {
			const client = createCadreClient(fakeHost({ reach: 'anywhere', machines: [machine] }));
			expect((await client.reachability.get()).reachable).toBe(false);
		}
	});

	it('says a chosen relay is still connecting when nothing else answers', async () => {
		const client = createCadreClient(fakeHost({ relays: ['/dns4/relay.example/tcp/443/wss/p2p/r'] }));
		expect(await client.reachability.get()).toMatchObject({ reachable: false, relayPending: true });
	});

	it('treats a control read that hangs as no answer, within its bound', async () => {
		const client = createCadreClient(fakeHost({ hang: true }), { controlReadMs: 50 });
		const started = Date.now();
		expect((await client.reachability.get()).reachable).toBe(false);
		expect(Date.now() - started).toBeLessThan(1000);
	});
});
