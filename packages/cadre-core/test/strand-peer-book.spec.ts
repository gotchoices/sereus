import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import {
	MemoryStrandPeerBookStore,
	PersistentStrandPeerBookStore,
	mergeStrandPeerEntry,
	MAX_STRAND_PEERS,
	STRAND_PEER_MAX_AGE_MS,
	type StrandPeerBookStore,
	type StrandPeerEntry
} from '../src/strand-peer-book.js';
import { FileStrandPeerBookStore } from '../src/strand-peer-book-file.js';
import { MAX_STRAND_ADDRS } from '../src/strand-formation-protocol.js';
import type { DurableSlot } from '../src/node-local-snapshot.js';

/**
 * The strand peer book's contract — the merge rule every later ticket leans on (the
 * unsigned observation writers of `strand-peer-book-local`, the signed swap of
 * `strand-peer-book-swap`), the per-strand bounds, aging, address attribution, and the
 * persistent round trip that drops junk. The shared envelope/load policy itself is
 * `node-local-snapshot.spec.ts`'s and is not re-proved here.
 */

const PARTY = 'party-alpha';
/** "Now" at load: stamps near it are fresh under the default 14-day age, which is what most rows want. */
const T0 = Date.now();

/** A real Ed25519 peer id — the store validates ids, so they must parse. */
async function realPeerId(): Promise<string> {
	return peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
}

function addrFor(peerId: string, port = 4001): string {
	return `/ip4/203.0.113.7/tcp/${port}/ws/p2p/${peerId}`;
}

function unsigned(peerId: string, lastSeenAt: number, addrs = [addrFor(peerId)]): StrandPeerEntry {
	return { peerId, addrs, issuedAt: 0, lastSeenAt };
}

function signed(peerId: string, issuedAt: number, lastSeenAt = 0, addrs = [addrFor(peerId)]): StrandPeerEntry {
	return { peerId, addrs, issuedAt, sig: `sig-${issuedAt}`, lastSeenAt };
}

/** An in-memory {@link DurableSlot}: reopening over the same slot reads back the last save. */
function memorySlot(initial?: string): DurableSlot & { text: string | undefined } {
	const slot = {
		text: initial,
		load: async () => slot.text,
		save: async (next: string) => { slot.text = next; }
	};
	return slot;
}

// ── The merge rule, as a table ────────────────────────────────────────────────

describe('mergeStrandPeerEntry', () => {
	const P = 'peer';
	const a = [`/ip4/1.1.1.1/tcp/1/p2p/${P}`];
	const b = [`/ip4/2.2.2.2/tcp/2/p2p/${P}`];

	it.each<{ name: string; existing?: StrandPeerEntry; incoming: StrandPeerEntry; wins: 'existing' | 'incoming'; lastSeenAt: number }>([
		{
			name: 'nothing held: the incoming entry is taken as-is',
			incoming: { peerId: P, addrs: a, issuedAt: 0, lastSeenAt: 5 },
			wins: 'incoming', lastSeenAt: 5
		},
		{
			name: 'a signed entry never yields to an unsigned one, but lastSeenAt still rises',
			existing: { peerId: P, addrs: a, issuedAt: 10, sig: 's', lastSeenAt: 1 },
			incoming: { peerId: P, addrs: b, issuedAt: 0, lastSeenAt: 20 },
			wins: 'existing', lastSeenAt: 20
		},
		{
			name: 'an unsigned entry yields to a signed one',
			existing: { peerId: P, addrs: a, issuedAt: 0, lastSeenAt: 50 },
			incoming: { peerId: P, addrs: b, issuedAt: 10, sig: 's', lastSeenAt: 0 },
			wins: 'incoming', lastSeenAt: 50
		},
		{
			name: 'two signed: the greater issuedAt wins',
			existing: { peerId: P, addrs: a, issuedAt: 10, sig: 's10', lastSeenAt: 0 },
			incoming: { peerId: P, addrs: b, issuedAt: 11, sig: 's11', lastSeenAt: 0 },
			wins: 'incoming', lastSeenAt: 0
		},
		{
			name: 'two signed: a stale forwarded statement loses to the fresher one already held',
			existing: { peerId: P, addrs: a, issuedAt: 11, sig: 's11', lastSeenAt: 3 },
			incoming: { peerId: P, addrs: b, issuedAt: 10, sig: 's10', lastSeenAt: 0 },
			wins: 'existing', lastSeenAt: 3
		},
		{
			name: 'two signed: a fresher statement with NO addresses displaces a stale reachable list',
			existing: { peerId: P, addrs: a, issuedAt: 10, sig: 's10', lastSeenAt: 3 },
			incoming: { peerId: P, addrs: [], issuedAt: 12, sig: 's12', lastSeenAt: 0 },
			wins: 'incoming', lastSeenAt: 3
		},
		{
			name: 'two signed with the same issuedAt: the same statement, the incoming copy is taken',
			existing: { peerId: P, addrs: a, issuedAt: 10, sig: 's10', lastSeenAt: 0 },
			incoming: { peerId: P, addrs: a, issuedAt: 10, sig: 's10', lastSeenAt: 4 },
			wins: 'incoming', lastSeenAt: 4
		},
		{
			name: 'two unsigned: the greater lastSeenAt wins',
			existing: { peerId: P, addrs: a, issuedAt: 0, lastSeenAt: 1 },
			incoming: { peerId: P, addrs: b, issuedAt: 0, lastSeenAt: 2 },
			wins: 'incoming', lastSeenAt: 2
		},
		{
			name: 'two unsigned: an older observation loses and cannot lower lastSeenAt',
			existing: { peerId: P, addrs: a, issuedAt: 0, lastSeenAt: 2 },
			incoming: { peerId: P, addrs: b, issuedAt: 0, lastSeenAt: 1 },
			wins: 'existing', lastSeenAt: 2
		}
	])('$name', ({ existing, incoming, wins, lastSeenAt }) => {
		const winner = wins === 'incoming' ? incoming : existing!;
		const merged = mergeStrandPeerEntry(existing, incoming);
		expect(merged).toEqual({ ...winner, lastSeenAt });
		// A new object, never the input mutated in place.
		expect(merged).not.toBe(existing);
		expect(merged).not.toBe(incoming);
		expect(merged.addrs).not.toBe(winner.addrs);
	});
});

// ── The store contract, per backend ───────────────────────────────────────────

interface Backend {
	name: string;
	make: (options?: { maxAgeMs?: number; now?: () => number }) => Promise<StrandPeerBookStore>;
	cleanup: () => Promise<void>;
}

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'cadre-strand-peers-'));
	tmpDirs.push(dir);
	return dir;
}

async function cleanTmpDirs(): Promise<void> {
	for (const dir of tmpDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
}

const backends: Backend[] = [
	{
		name: 'MemoryStrandPeerBookStore',
		make: async (options) => new MemoryStrandPeerBookStore(PARTY, options),
		cleanup: async () => {}
	},
	{
		name: 'PersistentStrandPeerBookStore',
		make: async (options) => PersistentStrandPeerBookStore.open(memorySlot(), PARTY, options),
		cleanup: async () => {}
	},
	{
		name: 'FileStrandPeerBookStore',
		make: async (options) => FileStrandPeerBookStore.open(await makeTmpDir(), PARTY, options),
		cleanup: cleanTmpDirs
	}
];

describe.each(backends)('StrandPeerBookStore contract: $name', ({ make, cleanup }) => {
	afterEach(async () => { await cleanup(); });

	it('merge() is visible synchronously, keyed per strand, and entries() comes back freshest first', async () => {
		const store = await make();
		const [older, newer] = [await realPeerId(), await realPeerId()];
		expect(store.partyId).toBe(PARTY);
		expect(store.entries('s1')).toEqual([]);

		const pending = store.merge('s1', unsigned(older, T0));
		expect(store.entries('s1').map((e) => e.peerId)).toEqual([older]);
		await pending;
		await store.merge('s1', unsigned(newer, T0 + 1));
		await store.merge('s2', unsigned(older, T0 + 2, [addrFor(older, 9)]));

		expect(store.entries('s1').map((e) => e.peerId)).toEqual([newer, older]);
		// The same peer under another strand is another entry: keyed per strand.
		expect(store.entries('s2')).toEqual([unsigned(older, T0 + 2, [addrFor(older, 9)])]);
		// A snapshot: mutating it reaches nothing.
		store.entries('s1')[0].addrs.push('/ip4/9.9.9.9/tcp/9');
		expect(store.entries('s1')[0].addrs).toEqual([addrFor(newer)]);
	});

	it('keeps only addrs that attribute to the peer, signaling first, capped at MAX_STRAND_ADDRS', async () => {
		const store = await make();
		const [peer, other, relay] = await Promise.all([realPeerId(), realPeerId(), realPeerId()]);
		const direct = Array.from({ length: MAX_STRAND_ADDRS }, (_v, i) => addrFor(peer, 4000 + i));
		const circuit = `/ip4/9.9.9.9/tcp/4001/p2p/${relay}/p2p-circuit/p2p/${peer}`;
		await store.merge('s1', unsigned(peer, T0, [
			...direct,
			circuit,
			addrFor(other),                                     // someone else's address
			`/ip4/9.9.9.9/tcp/4001/p2p/${relay}/p2p-circuit`,   // relay hop, no destination
			'/ip4/10.0.0.1/tcp/1',                              // no peer at all
			'not a multiaddr'
		]));

		const [entry] = store.entries('s1');
		expect(entry.addrs).toHaveLength(MAX_STRAND_ADDRS);
		expect(entry.addrs[0]).toBe(circuit);
		expect(entry.addrs.slice(1)).toEqual(direct.slice(0, MAX_STRAND_ADDRS - 1));
	});

	it('keeps a signed entry\'s addrs in the signer\'s order, since the signature covers that order', async () => {
		const store = await make();
		const [peer, relay] = await Promise.all([realPeerId(), realPeerId()]);
		const direct = addrFor(peer);
		const circuit = `/ip4/9.9.9.9/tcp/4001/p2p/${relay}/p2p-circuit/p2p/${peer}`;
		await store.merge('s1', signed(peer, T0, 0, [direct, circuit]));
		expect(store.entries('s1')[0].addrs).toEqual([direct, circuit]);
	});

	it('evicts the stalest peer once a strand holds more than MAX_STRAND_PEERS', async () => {
		const store = await make();
		const peers = await Promise.all(Array.from({ length: MAX_STRAND_PEERS + 1 }, () => realPeerId()));
		// The first peer is the stalest (seen earliest); a signed entry counts by issuedAt.
		await store.merge('s1', unsigned(peers[0], T0));
		await store.merge('s1', signed(peers[1], T0 + 1));
		for (let i = 2; i < peers.length; i++) {
			await store.merge('s1', unsigned(peers[i], T0 + i));
		}

		const held = store.entries('s1').map((e) => e.peerId);
		expect(held).toHaveLength(MAX_STRAND_PEERS);
		expect(held).not.toContain(peers[0]);
		expect(held).toContain(peers[1]);
	});

	it('ages out an entry unrefreshed for maxAgeMs, on entries() and on the next merge()', async () => {
		let now = T0;
		const store = await make({ now: () => now });
		const [stale, live, refreshed] = await Promise.all([realPeerId(), realPeerId(), realPeerId()]);
		await store.merge('s1', unsigned(stale, T0 - STRAND_PEER_MAX_AGE_MS - 1));
		await store.merge('s1', signed(live, T0 - 1));
		await store.merge('s1', unsigned(refreshed, T0 - STRAND_PEER_MAX_AGE_MS));
		expect(store.entries('s1').map((e) => e.peerId)).toEqual([live, refreshed]);

		now = T0 + 1;
		// `refreshed` is exactly maxAge old now — still live at the boundary — and a
		// merge for it raises lastSeenAt; `stale` is gone for good from the next write.
		await store.merge('s1', unsigned(refreshed, now));
		expect(store.entries('s1').map((e) => e.peerId)).toEqual([refreshed, live]);
		// A merge whose entry is ALREADY past the age never lands at all.
		await store.merge('s1', signed(await realPeerId(), T0 - STRAND_PEER_MAX_AGE_MS - 5));
		expect(store.entries('s1').map((e) => e.peerId)).toEqual([refreshed, live]);
	});

	it('drops an entry whose peer id does not parse and keeps the rest', async () => {
		const store = await make();
		const good = await realPeerId();
		await store.merge('s1', unsigned(good, T0));
		await store.merge('s1', unsigned('not-a-peer-id', T0 + 1, ['/ip4/1.1.1.1/tcp/1/p2p/not-a-peer-id']));

		expect(store.entries('s1').map((e) => e.peerId)).toEqual([good]);
	});

	it('forget() drops one peer or the whole strand, reflected synchronously; absent is a no-op', async () => {
		const store = await make();
		const [a, b] = [await realPeerId(), await realPeerId()];
		await store.merge('s1', unsigned(a, T0));
		await store.merge('s1', unsigned(b, T0 + 1));
		await store.merge('s2', unsigned(a, T0));

		const pending = store.forget('s1', a);
		expect(store.entries('s1').map((e) => e.peerId)).toEqual([b]);
		await pending;
		await expect(store.forget('s1', await realPeerId())).resolves.toBeUndefined();
		await expect(store.forget('nope')).resolves.toBeUndefined();

		const whole = store.forget('s1');
		expect(store.entries('s1')).toEqual([]);
		await whole;
		// The other strand is untouched.
		expect(store.entries('s2').map((e) => e.peerId)).toEqual([a]);
	});
});

// ── Persistence ───────────────────────────────────────────────────────────────

describe('PersistentStrandPeerBookStore specifics', () => {
	it('round-trips across open() over the same slot, dropping junk and aged entries', async () => {
		const [good, aged, badAddrs, noStamp, badSig] = await Promise.all(
			Array.from({ length: 5 }, () => realPeerId())
		);
		const slot = memorySlot(JSON.stringify({
			version: 1,
			partyId: PARTY,
			strands: {
				s1: {
					[good]: { addrs: [addrFor(good)], issuedAt: 0, lastSeenAt: T0 },
					[aged]: { addrs: [addrFor(aged)], issuedAt: 0, lastSeenAt: T0 - STRAND_PEER_MAX_AGE_MS - 1 },
					[badAddrs]: { addrs: 'nope', issuedAt: 0, lastSeenAt: T0 },
					[noStamp]: { addrs: [addrFor(noStamp)], issuedAt: 0 },
					[badSig]: { addrs: [addrFor(badSig)], issuedAt: 1, sig: 42, lastSeenAt: T0 },
					'not-a-peer-id': { addrs: ['/ip4/1.1.1.1/tcp/1'], issuedAt: 0, lastSeenAt: T0 }
				},
				s2: 'not a record',
				s3: { [aged]: { addrs: [addrFor(aged)], issuedAt: 0, lastSeenAt: T0 - STRAND_PEER_MAX_AGE_MS - 1 } }
			}
		}));

		const store = await PersistentStrandPeerBookStore.open(slot, PARTY, { now: () => T0 });
		expect(store.entries('s1')).toEqual([{ peerId: good, addrs: [addrFor(good)], issuedAt: 0, lastSeenAt: T0 }]);
		expect(store.entries('s2')).toEqual([]);
		expect(store.entries('s3')).toEqual([]);

		// What the next write persists is exactly what is held — the junk is gone for good.
		const fresh = await realPeerId();
		await store.merge('s1', signed(fresh, T0 + 1));
		const reopened = await PersistentStrandPeerBookStore.open(slot, PARTY, { now: () => T0 + 1 });
		expect(reopened.entries('s1').map((e) => e.peerId)).toEqual([fresh, good]);
		expect(reopened.entries('s1')[0].sig).toBe(`sig-${T0 + 1}`);
	});

	it('a forget persists across open() and concurrent merges from several strands all land', async () => {
		const slot = memorySlot();
		const store = await PersistentStrandPeerBookStore.open(slot, PARTY);
		const peers = await Promise.all(Array.from({ length: 6 }, () => realPeerId()));
		await Promise.all(peers.map((peer, i) => store.merge(`s${i % 3}`, unsigned(peer, T0 + i))));
		await store.forget('s0');

		const reopened = await PersistentStrandPeerBookStore.open(slot, PARTY);
		expect(reopened.entries('s0')).toEqual([]);
		expect(reopened.entries('s1').map((e) => e.peerId).sort()).toEqual([peers[1], peers[4]].sort());
		expect(reopened.entries('s2').map((e) => e.peerId).sort()).toEqual([peers[2], peers[5]].sort());
	});
});

describe('FileStrandPeerBookStore specifics', () => {
	afterEach(cleanTmpDirs);

	it('persists across open() cycles and keeps parties apart', async () => {
		const dir = await makeTmpDir();
		const [a, b] = [await realPeerId(), await realPeerId()];
		const alpha = await FileStrandPeerBookStore.open(dir, 'party-alpha');
		const beta = await FileStrandPeerBookStore.open(dir, 'party-beta');
		await alpha.merge('s1', unsigned(a, T0));
		await beta.merge('s1', unsigned(b, T0));

		expect((await FileStrandPeerBookStore.open(dir, 'party-alpha')).entries('s1').map((e) => e.peerId)).toEqual([a]);
		expect((await FileStrandPeerBookStore.open(dir, 'party-beta')).entries('s1').map((e) => e.peerId)).toEqual([b]);
	});

	it('a corrupt file is a cold start (empty), not a crash', async () => {
		const dir = await makeTmpDir();
		const seeded = await FileStrandPeerBookStore.open(dir, PARTY);
		await seeded.merge('s1', unsigned(await realPeerId(), T0));
		await writeFile(join(dir, `strand-peers.${PARTY}.json`), 'not json {', 'utf8');

		expect((await FileStrandPeerBookStore.open(dir, PARTY)).entries('s1')).toEqual([]);
	});
});
