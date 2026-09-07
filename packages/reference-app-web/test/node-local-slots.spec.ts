/**
 * `kvSlot` — the browser's `DurableSlot` over the control database's `kv` store.
 *
 * Scope is deliberately narrow. The node-local *store policy* over an arbitrary
 * slot (cold start, corrupt JSON, foreign partyId, unknown envelope,
 * discard-all vs drop-entry, synchronous visibility, failed-persist recovery) is
 * owned and covered by `packages/cadre-core/test/node-local-snapshot.spec.ts`
 * against its own fake slot — re-asserting it here would only duplicate it.
 * What this file covers is what web actually owns: `kvSlot` itself, and the
 * composition of a real `kvSlot` with the three stores — including the two
 * places the composition could quietly disagree with what the store expects (a
 * non-string `kv` value, and a read that fails). The enrolled-machine count's
 * own policy lives in `packages/cadre-core/test/enrolled-machine-store.spec.ts`;
 * it deliberately cold-starts where the other two throw, which is the one thing
 * asserted here.
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import {
	PersistentTrustedOwnerStore,
	PersistentBootstrapPeerStore,
	PersistentEnrolledMachineStore,
} from '@serfab/cadre-core';
import type { OptimysticWebDBHandle } from '@optimystic/db-p2p-storage-web';
import {
	kvSlot,
	TRUSTED_OWNERS_KV_KEY,
	BOOTSTRAP_PEERS_KV_KEY,
	ENROLLED_MACHINES_KV_KEY,
} from '../src/lib/node-local-slots';

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
	putError: Error | null = null;

	async get(_storeName: 'kv', key: string): Promise<string | Uint8Array | undefined> {
		if (this.getError) throw this.getError;
		return this.store.get(key);
	}

	async put(_storeName: 'kv', value: string | Uint8Array, key: string): Promise<string> {
		if (this.putError) throw this.putError;
		this.store.set(key, value);
		return key;
	}
}

// NOTE: the cast is unchecked — `IDBPDatabase` has far more surface than this
// double implements, so the compiler cannot hold the two `kv` signatures
// together. They match `OptimysticWebDB['kv']` (`key: string`,
// `value: string | Uint8Array`) as of db-p2p-storage-web 0.17; if that store's
// key or value type changes, this fake keeps compiling while testing the old
// shape. Pin the two methods against the real type if that ever bites.
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

	it('keeps distinct keys of one database independent', async () => {
		const { handle } = fakeHandle();
		await kvSlot(handle, TRUSTED_OWNERS_KV_KEY).save('owners');
		await kvSlot(handle, BOOTSTRAP_PEERS_KV_KEY).save('peers');
		expect(await kvSlot(handle, TRUSTED_OWNERS_KV_KEY).load()).toBe('owners');
		expect(await kvSlot(handle, BOOTSTRAP_PEERS_KV_KEY).load()).toBe('peers');
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

	it('rejects on a failed write rather than resolving', async () => {
		const { fake, handle } = fakeHandle();
		fake.putError = new Error('quota exceeded');
		await expect(kvSlot(handle, 'k').save('text')).rejects.toThrow('quota exceeded');
	});
});

// ── The node-local stores over a real kvSlot ──────────────────────────────────

describe('node-local stores over kvSlot', () => {
	/**
	 * The `kv` keys are a persistence contract: renaming one silently orphans
	 * every existing tab's anchor and dial targets rather than failing.
	 */
	it('pins the kv keys the stores are persisted under', () => {
		expect(TRUSTED_OWNERS_KV_KEY).toBe('trusted-owners');
		expect(BOOTSTRAP_PEERS_KV_KEY).toBe('bootstrap-peers');
		expect(ENROLLED_MACHINES_KV_KEY).toBe('enrolled-machines');
	});

	it('gives every record a key of its own, so no snapshot write clobbers another', () => {
		const keys = [TRUSTED_OWNERS_KV_KEY, BOOTSTRAP_PEERS_KV_KEY, ENROLLED_MACHINES_KV_KEY];
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('persists the enrolled-machine count across a fresh open() of the same slot', async () => {
		const { handle } = fakeHandle();
		const first = await PersistentEnrolledMachineStore.open(kvSlot(handle, ENROLLED_MACHINES_KV_KEY), 'party-1');
		await first.record(4);

		const reopened = await PersistentEnrolledMachineStore.open(kvSlot(handle, ENROLLED_MACHINES_KV_KEY), 'party-1');
		expect(reopened.count()).toBe(4);
	});

	// The deliberate divergence: this record is a block-repair hint, recomputed the
	// moment the control database is up, so an unreadable slot must not stop the tab
	// starting. `enrolled-machine-store.ts` carries the reasoning.
	it('cold-starts the enrolled-machine count when the database read fails, rather than rejecting', async () => {
		const { fake, handle } = fakeHandle();
		fake.getError = new Error('IndexedDB blocked');

		const store = await PersistentEnrolledMachineStore.open(kvSlot(handle, ENROLLED_MACHINES_KV_KEY), 'party-1');
		expect(store.count()).toBeUndefined();
	});

	it('persists a trusted owner key across a fresh open() of the same slot', async () => {
		const { handle } = fakeHandle();
		const first = await PersistentTrustedOwnerStore.open(kvSlot(handle, TRUSTED_OWNERS_KV_KEY), 'party-1');
		await first.trust('owner-key-b64', 'genesis');

		const reopened = await PersistentTrustedOwnerStore.open(kvSlot(handle, TRUSTED_OWNERS_KV_KEY), 'party-1');
		expect(reopened.has('owner-key-b64')).toBe(true);
		expect(reopened.all()).toEqual(new Set(['owner-key-b64']));
	});

	it('persists a bootstrap peer across a fresh open() of the same slot', async () => {
		const { handle } = fakeHandle();
		const peer = await realPeerId();
		const first = await PersistentBootstrapPeerStore.open(kvSlot(handle, BOOTSTRAP_PEERS_KV_KEY), 'party-1');
		await first.record(peer, ['/ip4/1.2.3.4/tcp/4001/ws']);

		const reopened = await PersistentBootstrapPeerStore.open(kvSlot(handle, BOOTSTRAP_PEERS_KV_KEY), 'party-1');
		expect([...reopened.all().keys()]).toEqual([peer]);
		expect(reopened.all().get(peer)?.addrs).toEqual(['/ip4/1.2.3.4/tcp/4001/ws']);
	});

	// Both records share ONE database with the tab's identity (see the module
	// header of `node-local-slots.ts`), so their snapshot writes are the one place
	// they could clobber each other.
	it('keeps all three records side by side in one database', async () => {
		const { handle } = fakeHandle();
		const peer = await realPeerId();
		const owners = await PersistentTrustedOwnerStore.open(kvSlot(handle, TRUSTED_OWNERS_KV_KEY), 'party-1');
		const peers = await PersistentBootstrapPeerStore.open(kvSlot(handle, BOOTSTRAP_PEERS_KV_KEY), 'party-1');
		const counts = await PersistentEnrolledMachineStore.open(kvSlot(handle, ENROLLED_MACHINES_KV_KEY), 'party-1');
		await owners.trust('owner-key-b64', 'genesis');
		await peers.record(peer, ['/ip4/1.2.3.4/tcp/4001/ws']);
		await counts.record(4);

		const reopenedOwners = await PersistentTrustedOwnerStore.open(kvSlot(handle, TRUSTED_OWNERS_KV_KEY), 'party-1');
		const reopenedPeers = await PersistentBootstrapPeerStore.open(kvSlot(handle, BOOTSTRAP_PEERS_KV_KEY), 'party-1');
		const reopenedCounts = await PersistentEnrolledMachineStore.open(kvSlot(handle, ENROLLED_MACHINES_KV_KEY), 'party-1');
		expect(reopenedOwners.all()).toEqual(new Set(['owner-key-b64']));
		expect([...reopenedPeers.all().keys()]).toEqual([peer]);
		expect(reopenedCounts.count()).toBe(4);
	});

	// `kv` values are `string | Uint8Array`; `kvSlot` reports a non-string as
	// absent, so the store must see a cold start rather than a load failure.
	it('cold-starts empty when the kv value is not text', async () => {
		const { fake, handle } = fakeHandle();
		fake.store.set(TRUSTED_OWNERS_KV_KEY, new Uint8Array([1, 2, 3]));

		const store = await PersistentTrustedOwnerStore.open(kvSlot(handle, TRUSTED_OWNERS_KV_KEY), 'party-1');
		expect(store.all().size).toBe(0);
	});

	// The load-bearing half of the same distinction: a genuine IndexedDB fault
	// must NOT look like a cold start, or the next snapshot write destroys an
	// intact record. `startCadre` relies on open() rejecting here.
	it('rejects open() when the database read fails, rather than cold-starting', async () => {
		const { fake, handle } = fakeHandle();
		fake.getError = new Error('IndexedDB blocked');

		await expect(
			PersistentTrustedOwnerStore.open(kvSlot(handle, TRUSTED_OWNERS_KV_KEY), 'party-1')
		).rejects.toThrow('IndexedDB blocked');
		await expect(
			PersistentBootstrapPeerStore.open(kvSlot(handle, BOOTSTRAP_PEERS_KV_KEY), 'party-1')
		).rejects.toThrow('IndexedDB blocked');
		expect(fake.store.size).toBe(0);
	});
});
