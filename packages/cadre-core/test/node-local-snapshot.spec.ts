import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { DurableSlot } from '../src/node-local-snapshot.js';
import { PersistentTrustedOwnerStore } from '../src/trusted-owner-store.js';
import { PersistentBootstrapPeerStore } from '../src/bootstrap-peer-store.js';

const PARTY = 'party-alpha';
const KEY_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const KEY_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

async function realPeerId(): Promise<string> {
	return peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
}

/**
 * In-memory {@link DurableSlot} standing in for a platform backend (IndexedDB,
 * SecureStore, SQLite). `loadError` / `saveError` reproduce the two failure
 * modes the load policy turns on: a slot that is present but unreadable, and a
 * save that does not land.
 */
class FakeSlot implements DurableSlot {
	text: string | undefined;
	loadError: Error | undefined;
	saveError: Error | undefined;
	saves = 0;

	constructor(text?: string) {
		this.text = text;
	}

	async load(): Promise<string | undefined> {
		if (this.loadError) throw this.loadError;
		return this.text;
	}

	async save(text: string): Promise<void> {
		this.saves += 1;
		if (this.saveError) throw this.saveError;
		this.text = text;
	}
}

function envelope(payloadKey: string, partyId: string, entries: Record<string, unknown>): string {
	return JSON.stringify({ version: 1, partyId, [payloadKey]: entries });
}

describe('PersistentTrustedOwnerStore over a DurableSlot', () => {
	it('an unwritten slot is a cold start (empty), not a throw', async () => {
		const store = await PersistentTrustedOwnerStore.open(new FakeSlot(), PARTY);
		expect(store.partyId).toBe(PARTY);
		expect(store.all().size).toBe(0);
	});

	it('round-trips through the slot (a reopen keeps the anchor)', async () => {
		const slot = new FakeSlot();
		const first = await PersistentTrustedOwnerStore.open(slot, PARTY);
		await first.trust(KEY_A, 'genesis');
		await first.trust(KEY_B, 'invite');

		const reloaded = await PersistentTrustedOwnerStore.open(slot, PARTY);
		expect(reloaded.all()).toEqual(new Set([KEY_A, KEY_B]));
	});

	it('unparsable slot text is a cold start (empty)', async () => {
		const store = await PersistentTrustedOwnerStore.open(new FakeSlot('not json {'), PARTY);
		expect(store.all().size).toBe(0);
	});

	it('an unknown envelope shape is a cold start (empty)', async () => {
		const slot = new FakeSlot(JSON.stringify({ version: 99, partyId: PARTY, owners: {} }));
		expect((await PersistentTrustedOwnerStore.open(slot, PARTY)).all().size).toBe(0);
	});

	it('a foreign partyId is a cold start (empty) — a reused slot must not leak trust', async () => {
		const slot = new FakeSlot(envelope('owners', 'party-other', {
			[KEY_A]: { source: 'genesis', trustedAt: 1 }
		}));
		expect((await PersistentTrustedOwnerStore.open(slot, PARTY)).all().size).toBe(0);
	});

	it('one malformed entry discards the whole anchor (subset trust is a silent downgrade)', async () => {
		const slot = new FakeSlot(envelope('owners', PARTY, {
			[KEY_A]: { source: 'genesis', trustedAt: 1 },
			[KEY_B]: { source: 'not-a-source', trustedAt: 1 }
		}));
		expect((await PersistentTrustedOwnerStore.open(slot, PARTY)).all().size).toBe(0);
	});

	it('a payload that is an array, not a record, is a cold start (empty)', async () => {
		const slot = new FakeSlot(JSON.stringify({
			version: 1, partyId: PARTY, owners: [{ source: 'genesis', trustedAt: 1 }]
		}));
		expect((await PersistentTrustedOwnerStore.open(slot, PARTY)).all().size).toBe(0);
	});

	it('a present-but-unreadable slot rejects open() and writes nothing', async () => {
		const slot = new FakeSlot(envelope('owners', PARTY, {}));
		slot.loadError = new Error('EACCES');

		await expect(PersistentTrustedOwnerStore.open(slot, PARTY))
			.rejects.toThrow(/failed to read the trusted-owner anchor/i);
		expect(slot.saves).toBe(0);
	});

	it('the load error names the slot\'s own failure, not only via cause', async () => {
		const slot = new FakeSlot(envelope('owners', PARTY, {}));
		// Operator-facing print sites log `error.message` alone, so the backend's
		// detail (which file / which database) must survive in the message itself.
		slot.loadError = new Error('FileDurableSlot: /state/trusted-owners.p.json is present but unreadable');

		await expect(PersistentTrustedOwnerStore.open(slot, PARTY))
			.rejects.toThrow(/\/state\/trusted-owners\.p\.json is present but unreadable/);
	});

	it('trust() is visible synchronously, before the returned promise settles', async () => {
		const store = await PersistentTrustedOwnerStore.open(new FakeSlot(), PARTY);
		const pending = store.trust(KEY_A, 'operator');
		expect(store.has(KEY_A)).toBe(true);
		await pending;
	});

	it('a failed persist rejects the caller, keeps the key, and the next write re-lands the full set', async () => {
		const slot = new FakeSlot();
		slot.saveError = new Error('quota exceeded');
		const store = await PersistentTrustedOwnerStore.open(slot, PARTY);

		await expect(store.trust(KEY_A, 'genesis')).rejects.toThrow(/quota exceeded/);
		// This session's trust decision stands even though nothing landed.
		expect(store.has(KEY_A)).toBe(true);
		expect(slot.text).toBeUndefined();

		slot.saveError = undefined;
		await store.trust(KEY_B, 'invite');

		const reloaded = await PersistentTrustedOwnerStore.open(slot, PARTY);
		expect(reloaded.all()).toEqual(new Set([KEY_A, KEY_B]));
	});

	it('re-trusting a known key skips the write chain entirely', async () => {
		const slot = new FakeSlot();
		const store = await PersistentTrustedOwnerStore.open(slot, PARTY);
		await store.trust(KEY_A, 'genesis');
		await store.trust(KEY_A, 'operator');

		expect(slot.saves).toBe(1);
		expect(store.all()).toEqual(new Set([KEY_A]));
	});
});

describe('PersistentBootstrapPeerStore over a DurableSlot', () => {
	it('an unwritten slot is a cold start (empty), not a throw', async () => {
		const store = await PersistentBootstrapPeerStore.open(new FakeSlot(), PARTY);
		expect(store.partyId).toBe(PARTY);
		expect(store.all().size).toBe(0);
	});

	it('round-trips through the slot (a reopen keeps the retry targets)', async () => {
		const slot = new FakeSlot();
		const peer = await realPeerId();
		const first = await PersistentBootstrapPeerStore.open(slot, PARTY);
		await first.record(peer, ['/ip4/1.2.3.4/tcp/4001/ws']);

		const reloaded = await PersistentBootstrapPeerStore.open(slot, PARTY);
		expect(reloaded.all().get(peer)?.addrs).toEqual(['/ip4/1.2.3.4/tcp/4001/ws']);
	});

	it('unparsable slot text is a cold start (empty)', async () => {
		expect((await PersistentBootstrapPeerStore.open(new FakeSlot('not json {'), PARTY)).all().size).toBe(0);
	});

	it('a foreign partyId is a cold start (empty)', async () => {
		const slot = new FakeSlot(envelope('peers', 'party-other', {
			[await realPeerId()]: { addrs: ['/ip4/1.1.1.1/tcp/1/ws'], recordedAt: 1 }
		}));
		expect((await PersistentBootstrapPeerStore.open(slot, PARTY)).all().size).toBe(0);
	});

	it('one malformed entry is dropped and its siblings retained', async () => {
		const good = await realPeerId();
		const slot = new FakeSlot(envelope('peers', PARTY, {
			[good]: { addrs: ['/ip4/1.1.1.1/tcp/1/ws'], recordedAt: 1 },
			'not-a-peer-id': { addrs: ['/ip4/2.2.2.2/tcp/2/ws'], recordedAt: 1 },
			[await realPeerId()]: { addrs: [], recordedAt: 1 },
			[await realPeerId()]: { addrs: [42], recordedAt: 1 },
			[await realPeerId()]: 'nope'
		}));

		expect([...(await PersistentBootstrapPeerStore.open(slot, PARTY)).all().keys()]).toEqual([good]);
	});

	it('a present-but-unreadable slot rejects open() and writes nothing', async () => {
		const slot = new FakeSlot(envelope('peers', PARTY, {}));
		slot.loadError = new Error('EIO');

		await expect(PersistentBootstrapPeerStore.open(slot, PARTY))
			.rejects.toThrow(/failed to read the bootstrap-peer store/i);
		expect(slot.saves).toBe(0);
	});

	it('record() is visible synchronously, before the returned promise settles', async () => {
		const store = await PersistentBootstrapPeerStore.open(new FakeSlot(), PARTY);
		const peer = await realPeerId();
		const pending = store.record(peer, ['/ip4/1.1.1.1/tcp/1/ws']);
		expect(store.all().has(peer)).toBe(true);
		await pending;
	});

	it('a failed persist rejects the caller, keeps the entry, and the next write re-lands the full set', async () => {
		const slot = new FakeSlot();
		slot.saveError = new Error('disk full');
		const store = await PersistentBootstrapPeerStore.open(slot, PARTY);
		const [a, b] = [await realPeerId(), await realPeerId()];

		await expect(store.record(a, ['/ip4/1.1.1.1/tcp/1/ws'])).rejects.toThrow(/disk full/);
		expect(store.all().has(a)).toBe(true);
		expect(slot.text).toBeUndefined();

		slot.saveError = undefined;
		await store.record(b, ['/ip4/2.2.2.2/tcp/2/ws']);

		const reloaded = await PersistentBootstrapPeerStore.open(slot, PARTY);
		expect([...reloaded.all().keys()].sort()).toEqual([a, b].sort());
	});
});
