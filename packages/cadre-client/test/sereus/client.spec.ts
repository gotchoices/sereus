/**
 * Over a stand-in node: who answers an invitation from this device, and which cadrons this device
 * is connected to.
 */
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { MachineRemovalRefusedError, type CadreNode } from '@serfab/cadre-core';
import { createCadreClient } from '../../src/sereus/client.js';
import type { CadreHost } from '../../src/sereus/host.js';

type Machine = { peerId: string; isSelf: boolean; trusted: boolean; alwaysOn: boolean | null; lastPublishedAt: number | null };

function fakeHost(opts: {
	ownAddrs?: string[];
	reach?: 'anywhere' | 'local-network' | 'issuer-only';
	machines?: Machine[];
	relays?: string[];
	hang?: boolean;
	/** Peers holding a control connection to this device. */
	connectedTo?: string[];
	/** Receives the control node's libp2p event listeners. */
	control?: EventTarget;
	/** Stand-ins for the node's own calls, merged over the defaults. */
	extra?: Record<string, unknown>;
	host?: Partial<CadreHost>;
}): CadreHost {
	const never = new Promise<never>(() => {});
	const control = opts.control ?? new EventTarget();
	const controlNode = Object.assign(control, {
		getConnections: () => (opts.connectedTo ?? []).map(id => ({ remotePeer: { toString: () => id } })),
	});
	const node = {
		running: true,
		getControlNode: () => controlNode,
		peerId: { toString: () => 'self' },
		getMultiaddrs: () => opts.ownAddrs ?? [],
		invitationReach: () => (opts.hang ? never : Promise.resolve(opts.reach ?? 'issuer-only')),
		listMachines: () => (opts.hang ? never : Promise.resolve(opts.machines ?? [])),
		listMembers: () => Promise.resolve([]),
		getOwnerSigner: () => null,
		removePeer: () => { throw new Error('removePeer must not be used: it leaves invitations and closed-strand keys'); },
		...opts.extra,
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
		...opts.host,
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

describe('connected cadrons', () => {
	const phone: Machine = { peerId: 'phone2', isSelf: false, trusted: true, alwaysOn: false, lastPublishedAt: Date.now() - 60_000 };

	it('marks the cadrons this device holds a control connection to, and itself while its node runs', async () => {
		const client = createCadreClient(fakeHost({ machines: [server, phone], connectedTo: ['server'] }));
		const status = await client.cadre.status();
		const byId = new Map(status.ok ? status.value.machines.map(m => [m.peerId, m.connected]) : []);
		expect([...byId]).toEqual([['self', true], ['server', true], ['phone2', false]]);
	});

	it('reports cadrons connecting and dropping, once per burst', async () => {
		const control = new EventTarget();
		const client = createCadreClient(fakeHost({ control }), { peerChangeMs: 30 });
		let calls = 0;
		const off = client.changes.cadre(() => { calls++; });
		control.dispatchEvent(new Event('peer:connect'));
		control.dispatchEvent(new Event('peer:disconnect'));
		control.dispatchEvent(new Event('peer:connect'));
		await new Promise(r => setTimeout(r, 80));
		expect(calls).toBe(1);
		off();
		control.dispatchEvent(new Event('peer:connect'));
		await new Promise(r => setTimeout(r, 80));
		expect(calls).toBe(1);
	});
});

describe('removing a cadron', () => {
	const removal = {
		removeMachine: async () => ({
			removedPeer: true, removedDeviceToken: false, withdrawnInvitations: ['i1', 'i2'],
			strands: [{ strandId: 's1', outcome: 'rotated' }, { strandId: 's2', outcome: 'pending' }],
		}),
		planMachineRemoval: async () => ({
			machine: server, refusal: null, invitations: ['i1', 'i2'],
			strands: [{ strandId: 's1', rotation: 'here' }],
		}),
	};

	it('removes it completely (removeMachine, not removePeer) and says what that did', async () => {
		const client = createCadreClient(fakeHost({ machines: [server], extra: removal }));
		expect(await client.cadre.removeMachine('server')).toEqual({
			ok: true,
			value: { withdrawnInvitations: 2, closedStrands: [{ strandId: 's1', outcome: 'rotated' }, { strandId: 's2', outcome: 'pending' }] },
		});
	});

	it('plans the removal for the confirmation', async () => {
		const client = createCadreClient(fakeHost({ extra: removal }));
		expect(await client.cadre.planRemoval('server')).toEqual({
			ok: true,
			value: { refusal: null, alreadyRemoved: false, invitations: 2, closedStrands: [{ strandId: 's1', replaced: 'here' }] },
		});
	});

	it('turns a refusal into removal-refused with its reason', async () => {
		const client = createCadreClient(fakeHost({
			extra: { removeMachine: async () => { throw new MachineRemovalRefusedError('self', 'self'); } },
		}));
		const r = await client.cadre.removeMachine('self');
		expect(r.ok ? null : [r.error.kind, r.error.reason]).toEqual(['removal-refused', 'self']);
	});

	it('reports a removal made here, and one found when the list is read again', async () => {
		const machines: Machine[] = [server, { ...server, peerId: 'other' }];
		let failRead = false;
		const client = createCadreClient(fakeHost({
			extra: { ...removal, listMachines: () => (failRead ? Promise.reject(new Error('timed out')) : Promise.resolve([...machines])) },
		}));
		const removed: string[] = [];
		client.changes.removed(id => removed.push(id));
		await client.cadre.status();
		await client.cadre.removeMachine('server');
		machines.shift();
		await client.cadre.status();
		failRead = true;
		await client.cadre.status(); // incomplete: compares nothing
		failRead = false;
		machines.length = 0; // 'other' removed on another device
		await client.cadre.status();
		expect(removed).toEqual(['server', 'other']);
	});
});

describe('adding a node by its address', () => {
	const ADDR = '/dns4/node.example.com/tcp/443/wss/p2p/12D3KooWHA9QDCHrzvezCn4oHuqUfDgdwwQaRdn7bMAyenKmofdM';
	const seeding = (accepted: boolean) => ({
		addDrone: async () => ({ seed: { s: 1 }, encodedSeed: 'seed-text' }),
		deliverSeed: async () => (accepted ? { accepted: true } : { accepted: false, reason: 'not listening' }),
		reconcileControlCohort: async () => {},
	});

	it('authorizes the node and delivers the seed', async () => {
		const client = createCadreClient(fakeHost({ extra: seeding(true) }));
		expect(await client.cadre.connectNode(ADDR)).toEqual({ ok: true, value: { peerId: '12D3KooWHA9QDCHrzvezCn4oHuqUfDgdwwQaRdn7bMAyenKmofdM', delivered: true } });
	});

	it('hands back the seed when the node does not take it over the network', async () => {
		const client = createCadreClient(fakeHost({ extra: seeding(false) }));
		const r = await client.cadre.connectNode(ADDR);
		expect(r.ok && r.value).toMatchObject({ delivered: false, reason: 'not listening', seed: 'seed-text' });
	});

	it('refuses an address that names no node', async () => {
		const client = createCadreClient(fakeHost({ extra: seeding(true) }));
		const bad = await client.cadre.connectNode('/dns4/node.example.com/tcp/443/wss');
		const junk = await client.cadre.connectNode('not an address');
		expect([bad, junk].map(r => (r.ok ? null : [r.error.kind, r.error.reason]))).toEqual([['invalid-address', 'no-peer-id'], ['invalid-address', 'unparsable']]);
	});
});

describe('the claim preview and the owner key', () => {
	const CODE_NODE = { getOwnerSigner: () => ({ publicKey: 'OwnerKeyPublicHalf' }) };

	it('names the cadre the node would join and the owner fingerprint it will show', async () => {
		const { encodeNodeClaimPayload } = await import('@serfab/cadre-core');
		const peerId = '12D3KooWHA9QDCHrzvezCn4oHuqUfDgdwwQaRdn7bMAyenKmofdM';
		const code = encodeNodeClaimPayload({ peerId, multiaddrs: [`/dns4/n.example.com/tcp/443/wss/p2p/${peerId}`], secret: randomBytes(32).toString('base64url') });
		const client = createCadreClient(fakeHost({ extra: CODE_NODE }));
		const r = await client.cadre.inspectNodeCode(code);
		expect(r.ok && { partyId: r.value.partyId, ownerFingerprint: r.value.ownerFingerprint }).toEqual({ partyId: 'party', ownerFingerprint: 'OwnerKey' });
	});

	it("exports through the host's own hook when it has one", async () => {
		const client = createCadreClient(fakeHost({ host: { exportOwnerKey: async () => 'private-half' } }));
		expect(await client.cadre.exportOwnerKey()).toEqual({ ok: true, value: 'private-half' });
	});
});

describe('cadron preferences', () => {
	it('are stored with their format version', async () => {
		let saved = '';
		const client = createCadreClient(fakeHost({ host: { preferences: { load: async () => undefined, save: async t => { saved = t; } } } }));
		await client.invitations.setPreferences({ maxAddrs: 3 });
		expect(JSON.parse(saved)).toMatchObject({ format: 1, maxAddrs: 3 });
	});
});
