import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { PersistentTrustedOwnerStore, PersistentBootstrapPeerStore } from '@serfab/cadre-core';
import type { OptimysticWebDBHandle } from '@optimystic/db-p2p-storage-web';
import { kvSlot, TRUSTED_OWNERS_KV_KEY, BOOTSTRAP_PEERS_KV_KEY } from '../src/lib/node-local-slots';

/**
 * A real Ed25519 peer id — the bootstrap-peer store's loader validates ids on
 * reload, so a fixture that must survive a round trip has to actually parse.
 */
async function realPeerId(): Promise<string> {
	return peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
}

// ── Fake IndexedDB handle ─────────────────────────────────────────────────────
// `kvSlot` only ever calls `handle.get('kv', key)` / `handle.put('kv', text, key)`
// at runtime, so a map-backed double covers both without a real IndexedDB.

class FakeKvHandle {
	readonly store = new Map<string, string | Uint8Array>();
	getError: Error | null = null;

	async get(_storeName: 'kv', key: string): Promise<string | Uint8Array | undefined> {
		if (this.getError) throw this.getError;
		return this.store.get(key);
	}

	async put(_storeName: 'kv', value: string | Uint8Array, key: string): Promise<string> {
		this.store.set(key, value);
		return key;
	}
}

function fakeHandle(): { fake: FakeKvHandle; handle: OptimysticWebDBHandle } {
	const fake = new FakeKvHandle();
	return { fake, handle: fake as unknown as OptimysticWebDBHandle };
}

// ── kvSlot ─────────────────────────────────────────────────────────────────────

describe('kvSlot', () => {
	it('round-trips save → load through the backing map, statelessly', async () => {
		const { handle } = fakeHandle();
		await kvSlot(handle, 'k').save('hello world');
		// A fresh slot instance, same backing map: proves the slot itself holds no
		// state, only the map does.
		expect(await kvSlot(handle, 'k').load()).toBe('hello world');
	});

	it('loads undefined (not a throw) for a non-string value already under the key', async () => {
		const { fake, handle } = fakeHandle();
		fake.store.set('k', new Uint8Array([1, 2, 3]));
		expect(await kvSlot(handle, 'k').load()).toBeUndefined();
	});

	it('loads undefined for a never-written key', async () => {
		const { handle } = fakeHandle();
		expect(await kvSlot(handle, 'never').load()).toBeUndefined();
	});

	it('rejects on a failed read rather than resolving undefined', async () => {
		const { fake, handle } = fakeHandle();
		fake.getError = new Error('IndexedDB blocked');
		await expect(kvSlot(handle, 'k').load()).rejects.toThrow('IndexedDB blocked');
	});
});

// ── PersistentTrustedOwnerStore ────────────────────────────────────────────────

describe('PersistentTrustedOwnerStore over kvSlot', () => {
	it('persists a trusted key across a fresh open() of the same slot', async () => {
		const { handle } = fakeHandle();
		const first = await PersistentTrustedOwnerStore.open(kvSlot(handle, TRUSTED_OWNERS_KV_KEY), 'party-1');
		await first.trust('owner-key-b64', 'genesis');

		const reopened = await PersistentTrustedOwnerStore.open(kvSlot(handle, TRUSTED_OWNERS_KV_KEY), 'party-1');
		expect(reopened.has('owner-key-b64')).toBe(true);
		expect(reopened.all()).toEqual(new Set(['owner-key-b64']));
	});

	it('a foreign partyId over the same slot cold-starts empty, not a throw', async () => {
		const { handle } = fakeHandle();
		const partyA = await PersistentTrustedOwnerStore.open(kvSlot(handle, TRUSTED_OWNERS_KV_KEY), 'party-a');
		await partyA.trust('owner-key-b64', 'genesis');

		const partyB = await PersistentTrustedOwnerStore.open(kvSlot(handle, TRUSTED_OWNERS_KV_KEY), 'party-b');
		expect(partyB.all().size).toBe(0);
	});

	it('corrupt JSON in the slot cold-starts empty, not a throw', async () => {
		const { fake, handle } = fakeHandle();
		fake.store.set(TRUSTED_OWNERS_KV_KEY, '{not valid json');

		const store = await PersistentTrustedOwnerStore.open(kvSlot(handle, TRUSTED_OWNERS_KV_KEY), 'party-1');
		expect(store.all().size).toBe(0);
	});
});

// ── PersistentBootstrapPeerStore ────────────────────────────────────────────────

describe('PersistentBootstrapPeerStore over kvSlot', () => {
	it('persists a recorded peer across a fresh open() of the same slot', async () => {
		const { handle } = fakeHandle();
		const peer = await realPeerId();
		const first = await PersistentBootstrapPeerStore.open(kvSlot(handle, BOOTSTRAP_PEERS_KV_KEY), 'party-1');
		await first.record(peer, ['/ip4/1.2.3.4/tcp/4001/ws']);

		const reopened = await PersistentBootstrapPeerStore.open(kvSlot(handle, BOOTSTRAP_PEERS_KV_KEY), 'party-1');
		expect([...reopened.all().keys()]).toEqual([peer]);
		expect(reopened.all().get(peer)?.addrs).toEqual(['/ip4/1.2.3.4/tcp/4001/ws']);
	});

	it('a foreign partyId over the same slot cold-starts empty, not a throw', async () => {
		const { handle } = fakeHandle();
		const partyA = await PersistentBootstrapPeerStore.open(kvSlot(handle, BOOTSTRAP_PEERS_KV_KEY), 'party-a');
		await partyA.record(await realPeerId(), ['/ip4/1.1.1.1/tcp/1/ws']);

		const partyB = await PersistentBootstrapPeerStore.open(kvSlot(handle, BOOTSTRAP_PEERS_KV_KEY), 'party-b');
		expect(partyB.all().size).toBe(0);
	});

	it('corrupt JSON in the slot cold-starts empty, not a throw', async () => {
		const { fake, handle } = fakeHandle();
		fake.store.set(BOOTSTRAP_PEERS_KV_KEY, '{not valid json');

		const store = await PersistentBootstrapPeerStore.open(kvSlot(handle, BOOTSTRAP_PEERS_KV_KEY), 'party-1');
		expect(store.all().size).toBe(0);
	});

	it('drops a structurally junk entry on load but keeps its well-formed sibling', async () => {
		const { fake, handle } = fakeHandle();
		const good = await realPeerId();
		const envelope = {
			version: 1,
			partyId: 'party-1',
			peers: {
				[good]: { addrs: ['/ip4/1.1.1.1/tcp/1/ws'], recordedAt: 1 },
				'junk-entry': { addrs: [], recordedAt: 1 } // empty addrs: structurally unusable
			}
		};
		fake.store.set(BOOTSTRAP_PEERS_KV_KEY, JSON.stringify(envelope));

		const store = await PersistentBootstrapPeerStore.open(kvSlot(handle, BOOTSTRAP_PEERS_KV_KEY), 'party-1');
		expect([...store.all().keys()]).toEqual([good]);
	});
});
