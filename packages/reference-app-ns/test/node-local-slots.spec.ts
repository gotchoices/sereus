/**
 * `node-local-slots.ts` — the phone's single `DurableSlot` backend for
 * cadre-core's node-local records (`PersistentTrustedOwnerStore`,
 * `PersistentBootstrapPeerStore`), over the `kv` table of the
 * `sereus-peer-identity` SQLite database.
 *
 * Scope is deliberately narrow. The node-local *store policy* over an arbitrary
 * slot (cold start, corrupt JSON, foreign partyId, discard-all vs drop-entry,
 * synchronous visibility, failed-persist recovery) is owned and covered by
 * `packages/cadre-core/test/node-local-snapshot.spec.ts` against its own fake
 * slot — re-asserting it here would only duplicate it. What this file covers is
 * what the NS app actually owns: the pass-through slot itself (`kvSlot`), the
 * two key-shape helpers, and the composition of the real slot with the two
 * node-local stores.
 *
 * No real SQLite here. What `SqliteKVStore` does with SQL belongs to
 * `@optimystic/db-p2p-storage-ns` and is covered in that repo; the seam this
 * package owns is `KvStoreApi`, which exists precisely so an in-memory fake can
 * stand in for it.
 */
import { describe, it, expect } from 'vitest';
import { PersistentTrustedOwnerStore, PersistentBootstrapPeerStore } from '@serfab/cadre-core';
import {
	kvSlot,
	anchorSlotKey,
	bootstrapPeersSlotKey,
	type KvStoreApi,
} from '../src/node-local-slots';

/**
 * A real Ed25519 peer id, generated once for this fixture — `@libp2p/crypto` and
 * `@libp2p/peer-id` are only transitive deps of `reference-app-ns`, not direct
 * ones, and the bootstrap-peer store's loader runs `peerIdFromString` on every
 * key on reload, so a fixture that must survive a reload has to actually parse.
 */
const REAL_PEER_ID = '12D3KooWQVo7JTYHgoj9rt9HScoxaM5axn3uB8P1WHiKrhhUqed3';

// ── Fake SqliteKVStore ────────────────────────────────────────────────────────

class FakeKvStore implements KvStoreApi {
	readonly map = new Map<string, string>();
	getError: Error | null = null;
	setError: Error | null = null;

	async get(key: string): Promise<string | undefined> {
		if (this.getError) throw this.getError;
		return this.map.get(key);
	}

	async set(key: string, value: string): Promise<void> {
		if (this.setError) throw this.setError;
		this.map.set(key, value);
	}
}

// ── kvSlot ────────────────────────────────────────────────────────────────────

describe('kvSlot', () => {
	it('round-trips save → load through the fake, statelessly', async () => {
		const kv = new FakeKvStore();
		await kvSlot(kv, 'k').save('hello world');
		// A fresh slot instance, same backing fake: proves the slot itself holds no
		// state, only the fake does.
		expect(await kvSlot(kv, 'k').load()).toBe('hello world');
	});

	it('loads undefined for a never-written key', async () => {
		const kv = new FakeKvStore();
		expect(await kvSlot(kv, 'never').load()).toBeUndefined();
	});

	it('rejects on a failed read rather than resolving undefined', async () => {
		// Load-bearing: were a read fault to surface as `undefined`, the store above
		// would cold-start over an intact record and the next save would overwrite it.
		const kv = new FakeKvStore();
		kv.map.set('k', 'an intact record');
		kv.getError = new Error('SQLite read failed');

		await expect(kvSlot(kv, 'k').load()).rejects.toThrow('SQLite read failed');
		expect(kv.map.get('k')).toBe('an intact record');
	});

	it('rejects on a failed write rather than resolving', async () => {
		const kv = new FakeKvStore();
		kv.setError = new Error('SQLite write failed');

		await expect(kvSlot(kv, 'k').save('text')).rejects.toThrow('SQLite write failed');
		expect(kv.map.size).toBe(0);
	});
});

// ── Key-shape helpers ─────────────────────────────────────────────────────────
// Persistence contracts: renaming one of these silently orphans every installed
// phone's anchor / dial targets rather than failing.

describe('key-shape helpers', () => {
	it('pins the two key strings exactly', () => {
		expect(anchorSlotKey('p')).toBe('trusted-owners.p');
		expect(bootstrapPeersSlotKey('p')).toBe('bootstrap-peers.p');
	});

	it('gives distinct parties distinct keys', () => {
		expect(anchorSlotKey('party-1')).not.toBe(anchorSlotKey('party-2'));
		expect(bootstrapPeersSlotKey('party-1')).not.toBe(bootstrapPeersSlotKey('party-2'));
	});

	it('never lets the two families collide, for any pair of parties', () => {
		// Both records share one `SqliteKVStore` with an EMPTY prefix (see
		// `cadre-phone.ts`), so a collision would have one record silently overwrite
		// the other rather than land in a separate namespace.
		const parties = ['p', 'party-1', 'trusted-owners.p', 'bootstrap-peers.p', ''];
		const anchors = parties.map(anchorSlotKey);
		const peers = parties.map(bootstrapPeersSlotKey);

		for (const anchor of anchors) {
			expect(peers).not.toContain(anchor);
		}
		expect(new Set([...anchors, ...peers]).size).toBe(anchors.length + peers.length);
	});
});

// ── PersistentTrustedOwnerStore over a real kvSlot ─────────────────────────────

describe('PersistentTrustedOwnerStore over kvSlot', () => {
	it('persists a trusted owner key across a fresh open() of the same slot', async () => {
		const kv = new FakeKvStore();
		const key = anchorSlotKey('party-1');

		const first = await PersistentTrustedOwnerStore.open(kvSlot(kv, key), 'party-1');
		await first.trust('owner-key-b64', 'invite');

		const reopened = await PersistentTrustedOwnerStore.open(kvSlot(kv, key), 'party-1');
		expect(reopened.has('owner-key-b64')).toBe(true);
		expect(reopened.all()).toEqual(new Set(['owner-key-b64']));
	});

	it('records the source in the raw persisted envelope', async () => {
		const kv = new FakeKvStore();
		const key = anchorSlotKey('party-1');

		const store = await PersistentTrustedOwnerStore.open(kvSlot(kv, key), 'party-1');
		await store.trust('owner-key-b64', 'invite');

		const raw = JSON.parse(kv.map.get(key)!) as { owners: Record<string, { source: string }> };
		expect(raw.owners['owner-key-b64']?.source).toBe('invite');
	});

	it('junk text pre-seeded in the slot ⇒ empty store, no throw', async () => {
		const kv = new FakeKvStore();
		const key = anchorSlotKey('party-1');
		kv.map.set(key, 'not json at all');

		const store = await PersistentTrustedOwnerStore.open(kvSlot(kv, key), 'party-1');
		expect(store.all().size).toBe(0);
	});

	it('an envelope carrying a foreign partyId ⇒ empty store', async () => {
		const kv = new FakeKvStore();
		const key = anchorSlotKey('party-1');
		kv.map.set(
			key,
			JSON.stringify({ version: 1, partyId: 'someone-else', owners: { x: { source: 'invite', trustedAt: 1 } } }),
		);

		const store = await PersistentTrustedOwnerStore.open(kvSlot(kv, key), 'party-1');
		expect(store.all().size).toBe(0);
	});

	it('a failed read rejects open() rather than cold-starting, and touches nothing', async () => {
		const kv = new FakeKvStore();
		const key = anchorSlotKey('party-1');
		kv.getError = new Error('SQLite read failed');

		await expect(PersistentTrustedOwnerStore.open(kvSlot(kv, key), 'party-1')).rejects.toThrow(
			'SQLite read failed',
		);
		expect(kv.map.size).toBe(0);
	});

	it('a failed persist rejects trust() but the in-memory trust still stands', async () => {
		const kv = new FakeKvStore();
		const key = anchorSlotKey('party-1');
		const store = await PersistentTrustedOwnerStore.open(kvSlot(kv, key), 'party-1');
		kv.setError = new Error('SQLite write failed');

		await expect(store.trust('owner-key-b64', 'invite')).rejects.toThrow('SQLite write failed');
		expect(store.has('owner-key-b64')).toBe(true);
	});
});

// ── PersistentBootstrapPeerStore over a real kvSlot ────────────────────────────

describe('PersistentBootstrapPeerStore over kvSlot', () => {
	it('persists a bootstrap peer across a fresh open() of the same slot', async () => {
		const kv = new FakeKvStore();
		const key = bootstrapPeersSlotKey('party-1');

		const first = await PersistentBootstrapPeerStore.open(kvSlot(kv, key), 'party-1');
		await first.record(REAL_PEER_ID, ['/ip4/1.2.3.4/tcp/4001/ws']);

		const reopened = await PersistentBootstrapPeerStore.open(kvSlot(kv, key), 'party-1');
		expect([...reopened.all().keys()]).toEqual([REAL_PEER_ID]);
		expect(reopened.all().get(REAL_PEER_ID)?.addrs).toEqual(['/ip4/1.2.3.4/tcp/4001/ws']);
	});

	it('records the addrs in the raw persisted envelope', async () => {
		const kv = new FakeKvStore();
		const key = bootstrapPeersSlotKey('party-1');

		const store = await PersistentBootstrapPeerStore.open(kvSlot(kv, key), 'party-1');
		await store.record(REAL_PEER_ID, ['/ip4/1.2.3.4/tcp/4001/ws']);

		const raw = JSON.parse(kv.map.get(key)!) as { peers: Record<string, { addrs: string[] }> };
		expect(raw.peers[REAL_PEER_ID]?.addrs).toEqual(['/ip4/1.2.3.4/tcp/4001/ws']);
	});

	it('junk text pre-seeded in the slot ⇒ empty store, no throw', async () => {
		const kv = new FakeKvStore();
		const key = bootstrapPeersSlotKey('party-1');
		kv.map.set(key, 'not json at all');

		const store = await PersistentBootstrapPeerStore.open(kvSlot(kv, key), 'party-1');
		expect(store.all().size).toBe(0);
	});

	it('an envelope carrying a foreign partyId ⇒ empty store', async () => {
		const kv = new FakeKvStore();
		const key = bootstrapPeersSlotKey('party-1');
		kv.map.set(
			key,
			JSON.stringify({
				version: 1,
				partyId: 'someone-else',
				peers: { [REAL_PEER_ID]: { addrs: ['/ip4/1.2.3.4/tcp/4001/ws'], recordedAt: 1 } },
			}),
		);

		const store = await PersistentBootstrapPeerStore.open(kvSlot(kv, key), 'party-1');
		expect(store.all().size).toBe(0);
	});

	it('a failed read rejects open() rather than cold-starting, and touches nothing', async () => {
		const kv = new FakeKvStore();
		const key = bootstrapPeersSlotKey('party-1');
		kv.getError = new Error('SQLite read failed');

		await expect(PersistentBootstrapPeerStore.open(kvSlot(kv, key), 'party-1')).rejects.toThrow(
			'SQLite read failed',
		);
		expect(kv.map.size).toBe(0);
	});

	it('a failed persist rejects record() but the in-memory record still stands', async () => {
		const kv = new FakeKvStore();
		const key = bootstrapPeersSlotKey('party-1');
		const store = await PersistentBootstrapPeerStore.open(kvSlot(kv, key), 'party-1');
		kv.setError = new Error('SQLite write failed');

		await expect(store.record(REAL_PEER_ID, ['/ip4/1.2.3.4/tcp/4001/ws'])).rejects.toThrow('SQLite write failed');
		expect([...store.all().keys()]).toEqual([REAL_PEER_ID]);
	});
});

// ── Both records in ONE kv store, under an empty prefix ───────────────────────
// `cadre-phone.ts` gives BOTH stores the same `SqliteKVStore` instance with the
// empty prefix `''`, so the two records are neighbours in one `kv` table rather
// than in separate namespaces. Asserting the key strings differ is not enough:
// what matters is that neither write clobbers the other.

describe('the two node-local records sharing one kv store', () => {
	it('lets the anchor and the bootstrap peers survive each other\'s writes', async () => {
		const kv = new FakeKvStore();
		const anchors = await PersistentTrustedOwnerStore.open(kvSlot(kv, anchorSlotKey('party-1')), 'party-1');
		const peers = await PersistentBootstrapPeerStore.open(kvSlot(kv, bootstrapPeersSlotKey('party-1')), 'party-1');

		await anchors.trust('owner-key-b64', 'genesis');
		await peers.record(REAL_PEER_ID, ['/ip4/1.2.3.4/tcp/4001/ws']);
		await anchors.trust('second-owner-b64', 'invite');

		const reopenedAnchors = await PersistentTrustedOwnerStore.open(
			kvSlot(kv, anchorSlotKey('party-1')),
			'party-1',
		);
		const reopenedPeers = await PersistentBootstrapPeerStore.open(
			kvSlot(kv, bootstrapPeersSlotKey('party-1')),
			'party-1',
		);
		expect(reopenedAnchors.all()).toEqual(new Set(['owner-key-b64', 'second-owner-b64']));
		expect([...reopenedPeers.all().keys()]).toEqual([REAL_PEER_ID]);
	});

	it('keeps one party\'s records out of another party\'s slots', async () => {
		const kv = new FakeKvStore();
		const mine = await PersistentTrustedOwnerStore.open(kvSlot(kv, anchorSlotKey('party-1')), 'party-1');
		await mine.trust('owner-key-b64', 'genesis');

		const theirs = await PersistentTrustedOwnerStore.open(kvSlot(kv, anchorSlotKey('party-2')), 'party-2');
		expect(theirs.all().size).toBe(0);
	});
});
