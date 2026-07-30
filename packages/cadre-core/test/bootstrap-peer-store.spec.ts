import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { MemoryBootstrapPeerStore, type BootstrapPeerStore } from '../src/bootstrap-peer-store.js';
import { FileBootstrapPeerStore } from '../src/bootstrap-peer-store-file.js';

const PARTY = 'party-alpha';

/** A real Ed25519 peer id — the file loader validates ids, so they must parse. */
async function realPeerId(): Promise<string> {
	return peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
}

// Each backend supplies a fresh store and a teardown. The contract suite below
// runs identically against both — the only difference is persistence medium.
interface Backend {
	name: string;
	make: (partyId?: string) => Promise<BootstrapPeerStore>;
	cleanup: () => Promise<void>;
}

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'cadre-bootstrap-peers-'));
	tmpDirs.push(dir);
	return dir;
}

async function cleanTmpDirs(): Promise<void> {
	for (const dir of tmpDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
}

/** The single party JSON file in `dir` (fails the test if absent). */
async function storeFile(dir: string): Promise<string> {
	const file = (await readdir(dir)).find((f) => f.endsWith('.json'));
	if (!file) throw new Error('bootstrap-peer file not found');
	return join(dir, file);
}

const backends: Backend[] = [
	{
		name: 'MemoryBootstrapPeerStore',
		make: async (partyId = PARTY) => new MemoryBootstrapPeerStore(partyId),
		cleanup: async () => {}
	},
	{
		name: 'FileBootstrapPeerStore',
		make: async (partyId = PARTY) => FileBootstrapPeerStore.open(await makeTmpDir(), partyId),
		cleanup: cleanTmpDirs
	}
];

describe.each(backends)('BootstrapPeerStore contract: $name', ({ make, cleanup }) => {
	afterEach(async () => { await cleanup(); });

	it('starts empty and reports the scoping partyId', async () => {
		const store = await make();
		expect(store.partyId).toBe(PARTY);
		expect(store.all().size).toBe(0);
	});

	it('record() retains a peer\'s addresses, visible via all()', async () => {
		const store = await make();
		const [a, b] = [await realPeerId(), await realPeerId()];
		await store.record(a, ['/ip4/1.1.1.1/tcp/1/ws']);
		await store.record(b, ['/ip4/2.2.2.2/tcp/2/ws', '/ip4/3.3.3.3/tcp/3/ws']);

		expect([...store.all().keys()].sort()).toEqual([a, b].sort());
		expect(store.all().get(a)?.addrs).toEqual(['/ip4/1.1.1.1/tcp/1/ws']);
		expect(store.all().get(b)?.addrs).toHaveLength(2);
		expect(typeof store.all().get(a)?.recordedAt).toBe('number');
	});

	it('record() reflects the entry synchronously (durability is the promise, visibility is not)', async () => {
		const store = await make();
		const peer = await realPeerId();
		const pending = store.record(peer, ['/ip4/1.1.1.1/tcp/1/ws']);
		expect(store.all().has(peer)).toBe(true);
		await pending;
	});

	it('replaces a peer\'s addresses rather than merging them', async () => {
		const store = await make();
		const peer = await realPeerId();
		await store.record(peer, ['/ip4/1.1.1.1/tcp/1/ws']);
		await store.record(peer, ['/ip4/9.9.9.9/tcp/9/ws']);

		expect(store.all().size).toBe(1);
		expect(store.all().get(peer)?.addrs).toEqual(['/ip4/9.9.9.9/tcp/9/ws']);
	});

	it('all() returns a snapshot decoupled from later record() calls', async () => {
		const store = await make();
		const [a, b] = [await realPeerId(), await realPeerId()];
		await store.record(a, ['/ip4/1.1.1.1/tcp/1/ws']);
		const snapshot = store.all();
		await store.record(b, ['/ip4/2.2.2.2/tcp/2/ws']);

		expect(snapshot.has(b)).toBe(false);
		expect(store.all().has(b)).toBe(true);
	});
});

describe('FileBootstrapPeerStore specifics', () => {
	afterEach(cleanTmpDirs);

	it('persists across open() cycles (restart keeps the retry targets)', async () => {
		const dir = await makeTmpDir();
		const peer = await realPeerId();
		const first = await FileBootstrapPeerStore.open(dir, PARTY);
		await first.record(peer, ['/ip4/1.2.3.4/tcp/4001/ws']);

		const reloaded = await FileBootstrapPeerStore.open(dir, PARTY);
		expect(reloaded.all().get(peer)?.addrs).toEqual(['/ip4/1.2.3.4/tcp/4001/ws']);
	});

	it('an absent directory is a cold start (empty), not a crash', async () => {
		const store = await FileBootstrapPeerStore.open(
			join(tmpdir(), 'cadre-bootstrap-peers-missing', 'deep'), PARTY);
		expect(store.all().size).toBe(0);
	});

	it('a corrupt file is a cold start (empty), not a crash', async () => {
		const dir = await makeTmpDir();
		const seeded = await FileBootstrapPeerStore.open(dir, PARTY);
		await seeded.record(await realPeerId(), ['/ip4/1.1.1.1/tcp/1/ws']);
		await writeFile(await storeFile(dir), 'not json {', 'utf8');

		const reloaded = await FileBootstrapPeerStore.open(dir, PARTY);
		expect(reloaded.all().size).toBe(0);
	});

	it('a well-formed file with an unknown shape is a cold start', async () => {
		const dir = await makeTmpDir();
		const seeded = await FileBootstrapPeerStore.open(dir, PARTY);
		await seeded.record(await realPeerId(), ['/ip4/1.1.1.1/tcp/1/ws']);
		await writeFile(await storeFile(dir), JSON.stringify({ version: 99, partyId: PARTY, peers: {} }), 'utf8');

		const reloaded = await FileBootstrapPeerStore.open(dir, PARTY);
		expect(reloaded.all().size).toBe(0);
	});

	it('two parties sharing a directory never leak dial targets into each other', async () => {
		const dir = await makeTmpDir();
		const [a, b] = [await realPeerId(), await realPeerId()];
		const alpha = await FileBootstrapPeerStore.open(dir, 'party-alpha');
		const beta = await FileBootstrapPeerStore.open(dir, 'party-beta');
		await alpha.record(a, ['/ip4/1.1.1.1/tcp/1/ws']);
		await beta.record(b, ['/ip4/2.2.2.2/tcp/2/ws']);

		expect([...(await FileBootstrapPeerStore.open(dir, 'party-alpha')).all().keys()]).toEqual([a]);
		expect([...(await FileBootstrapPeerStore.open(dir, 'party-beta')).all().keys()]).toEqual([b]);
	});

	it('a file whose embedded partyId does not match the requested party loads empty', async () => {
		const dir = await makeTmpDir();
		const alpha = await FileBootstrapPeerStore.open(dir, 'party-alpha');
		await alpha.record(await realPeerId(), ['/ip4/1.1.1.1/tcp/1/ws']);
		// Simulate a foreign/renamed file: claim a different party while keeping
		// party-alpha's filename.
		const file = await storeFile(dir);
		const body = JSON.parse((await readFile(file)).toString('utf8')) as { partyId: string };
		body.partyId = 'party-other';
		await writeFile(file, JSON.stringify(body), 'utf8');

		const reloaded = await FileBootstrapPeerStore.open(dir, 'party-alpha');
		expect(reloaded.all().size).toBe(0);
	});

	it('a present-but-unreadable file throws rather than cold-starting empty', async () => {
		const dir = await makeTmpDir();
		const seeded = await FileBootstrapPeerStore.open(dir, PARTY);
		await seeded.record(await realPeerId(), ['/ip4/1.1.1.1/tcp/1/ws']);
		// Replace the file with a directory: present, but every read fails with
		// something other than ENOENT. Loading empty here would let the next
		// record() snapshot-write destroy a still-intact retry set.
		const file = await storeFile(dir);
		await rm(file);
		await mkdir(file);

		await expect(FileBootstrapPeerStore.open(dir, PARTY))
			.rejects.toThrow(/failed to read the bootstrap-peer store/i);
	});

	it('drops structurally junk entries on load and keeps the good ones', async () => {
		const dir = await makeTmpDir();
		const good = await realPeerId();
		const badId = 'not-a-peer-id';
		const noAddrs = await realPeerId();
		const nonStringAddr = await realPeerId();
		const notAnObject = await realPeerId();
		await writeFile(join(dir, `bootstrap-peers.${PARTY}.json`), JSON.stringify({
			version: 1,
			partyId: PARTY,
			peers: {
				[good]: { addrs: ['/ip4/1.1.1.1/tcp/1/ws'], recordedAt: 1 },
				[badId]: { addrs: ['/ip4/2.2.2.2/tcp/2/ws'], recordedAt: 1 },
				[noAddrs]: { addrs: [], recordedAt: 1 },
				[nonStringAddr]: { addrs: [42], recordedAt: 1 },
				[notAnObject]: 'nope'
			}
		}), 'utf8');

		const store = await FileBootstrapPeerStore.open(dir, PARTY);
		expect([...store.all().keys()]).toEqual([good]);
	});

	it('concurrent record() calls all land durably (serialised snapshot writes)', async () => {
		const dir = await makeTmpDir();
		const store = await FileBootstrapPeerStore.open(dir, PARTY);
		const peers = await Promise.all(Array.from({ length: 8 }, () => realPeerId()));
		await Promise.all(peers.map((p) => store.record(p, [`/ip4/1.1.1.1/tcp/1/ws`])));

		const reloaded = await FileBootstrapPeerStore.open(dir, PARTY);
		expect([...reloaded.all().keys()].sort()).toEqual([...peers].sort());
	});

	it('leaves no temp-file debris after writes', async () => {
		const dir = await makeTmpDir();
		const store = await FileBootstrapPeerStore.open(dir, PARTY);
		await store.record(await realPeerId(), ['/ip4/1.1.1.1/tcp/1/ws']);
		await store.record(await realPeerId(), ['/ip4/2.2.2.2/tcp/2/ws']);
		expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
	});
});
