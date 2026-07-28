import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryTrustedOwnerStore, type TrustedOwnerStore } from '../src/trusted-owner-store.js';
import { FileTrustedOwnerStore } from '../src/trusted-owner-store-file.js';

const PARTY = 'party-alpha';
const KEY_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const KEY_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

// Each backend supplies a fresh store and a teardown. The contract suite below
// runs identically against both — the only difference is persistence medium.
interface Backend {
	name: string;
	make: (partyId?: string) => Promise<TrustedOwnerStore>;
	cleanup: () => Promise<void>;
}

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'cadre-trusted-owners-'));
	tmpDirs.push(dir);
	return dir;
}

/** The single party-anchor JSON file in `dir` (fails the test if absent). */
async function anchorFile(dir: string): Promise<string> {
	const file = (await readdir(dir)).find((f) => f.endsWith('.json'));
	if (!file) throw new Error('anchor file not found');
	return join(dir, file);
}

const backends: Backend[] = [
	{
		name: 'MemoryTrustedOwnerStore',
		make: async (partyId = PARTY) => new MemoryTrustedOwnerStore(partyId),
		cleanup: async () => {}
	},
	{
		name: 'FileTrustedOwnerStore',
		make: async (partyId = PARTY) => FileTrustedOwnerStore.open(await makeTmpDir(), partyId),
		cleanup: async () => {
			for (const dir of tmpDirs.splice(0)) {
				await rm(dir, { recursive: true, force: true });
			}
		}
	}
];

describe.each(backends)('TrustedOwnerStore contract: $name', ({ make, cleanup }) => {
	afterEach(async () => { await cleanup(); });

	it('starts empty and reports the scoping partyId', async () => {
		const store = await make();
		expect(store.partyId).toBe(PARTY);
		expect(store.has(KEY_A)).toBe(false);
		expect(store.all().size).toBe(0);
	});

	it('trust() anchors a key, visible via has() and all()', async () => {
		const store = await make();
		await store.trust(KEY_A, 'genesis');
		await store.trust(KEY_B, 'invite');
		expect(store.has(KEY_A)).toBe(true);
		expect(store.has(KEY_B)).toBe(true);
		expect(store.all()).toEqual(new Set([KEY_A, KEY_B]));
	});

	it('trust() reflects the key synchronously (durability is the promise, visibility is not)', async () => {
		const store = await make();
		const pending = store.trust(KEY_A, 'operator');
		expect(store.has(KEY_A)).toBe(true);
		await pending;
	});

	it('re-trusting a known key is an idempotent no-op (any source)', async () => {
		const store = await make();
		await store.trust(KEY_A, 'invite');
		await store.trust(KEY_A, 'invite');
		await store.trust(KEY_A, 'operator');
		expect(store.all()).toEqual(new Set([KEY_A]));
	});

	it('all() returns a snapshot decoupled from later trust() calls', async () => {
		const store = await make();
		await store.trust(KEY_A, 'genesis');
		const snapshot = store.all();
		await store.trust(KEY_B, 'invite');
		expect(snapshot.has(KEY_B)).toBe(false);
		expect(store.all().has(KEY_B)).toBe(true);
	});
});

describe('FileTrustedOwnerStore specifics', () => {
	afterEach(async () => {
		for (const dir of tmpDirs.splice(0)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('persists across open() cycles (restart keeps the anchor)', async () => {
		const dir = await makeTmpDir();
		const first = await FileTrustedOwnerStore.open(dir, PARTY);
		await first.trust(KEY_A, 'invite');
		await first.trust(KEY_B, 'genesis');

		const reloaded = await FileTrustedOwnerStore.open(dir, PARTY);
		expect(reloaded.all()).toEqual(new Set([KEY_A, KEY_B]));
	});

	it('an absent directory is a cold start (empty), not a crash', async () => {
		const store = await FileTrustedOwnerStore.open(
			join(tmpdir(), 'cadre-trusted-owners-missing', 'deep'), PARTY);
		expect(store.all().size).toBe(0);
	});

	it('a corrupt anchor file is a cold start (empty), not a crash', async () => {
		const dir = await makeTmpDir();
		const seeded = await FileTrustedOwnerStore.open(dir, PARTY);
		await seeded.trust(KEY_A, 'invite');
		// Locate the anchor file this store wrote and corrupt it.
		await writeFile(await anchorFile(dir), 'not json {', 'utf8');

		const reloaded = await FileTrustedOwnerStore.open(dir, PARTY);
		expect(reloaded.all().size).toBe(0);
	});

	it('a well-formed file with an unknown shape is a cold start', async () => {
		const dir = await makeTmpDir();
		const seeded = await FileTrustedOwnerStore.open(dir, PARTY);
		await seeded.trust(KEY_A, 'invite');
		await writeFile(await anchorFile(dir), JSON.stringify({ version: 99, partyId: PARTY, owners: {} }), 'utf8');

		const reloaded = await FileTrustedOwnerStore.open(dir, PARTY);
		expect(reloaded.all().size).toBe(0);
	});

	it('two parties sharing a directory never leak trust into each other', async () => {
		const dir = await makeTmpDir();
		const alpha = await FileTrustedOwnerStore.open(dir, 'party-alpha');
		const beta = await FileTrustedOwnerStore.open(dir, 'party-beta');
		await alpha.trust(KEY_A, 'genesis');
		await beta.trust(KEY_B, 'invite');

		const alphaReloaded = await FileTrustedOwnerStore.open(dir, 'party-alpha');
		const betaReloaded = await FileTrustedOwnerStore.open(dir, 'party-beta');
		expect(alphaReloaded.all()).toEqual(new Set([KEY_A]));
		expect(betaReloaded.all()).toEqual(new Set([KEY_B]));
	});

	it('a file whose embedded partyId does not match the requested party loads empty', async () => {
		const dir = await makeTmpDir();
		const alpha = await FileTrustedOwnerStore.open(dir, 'party-alpha');
		await alpha.trust(KEY_A, 'genesis');
		// Simulate a foreign/renamed anchor: rewrite the file body to claim a
		// different party while keeping party-alpha's filename.
		const file = await anchorFile(dir);
		const body = JSON.parse((await readFile(file)).toString('utf8')) as { partyId: string };
		body.partyId = 'party-other';
		await writeFile(file, JSON.stringify(body), 'utf8');

		const reloaded = await FileTrustedOwnerStore.open(dir, 'party-alpha');
		expect(reloaded.all().size).toBe(0);
	});

	it('a present-but-unreadable anchor throws rather than cold-starting empty', async () => {
		const dir = await makeTmpDir();
		const seeded = await FileTrustedOwnerStore.open(dir, PARTY);
		await seeded.trust(KEY_A, 'operator');
		// Replace the anchor with a directory: present, but every read fails with
		// something other than ENOENT. Loading empty here would let the next
		// trust() snapshot-write destroy a still-intact anchor, so open() must throw.
		const file = await anchorFile(dir);
		await rm(file);
		await mkdir(file);

		await expect(FileTrustedOwnerStore.open(dir, PARTY)).rejects.toThrow(/failed to read the trusted-owner anchor/i);
	});

	it('persists each key\'s provenance, write-once across re-trust and reload', async () => {
		const dir = await makeTmpDir();
		const first = await FileTrustedOwnerStore.open(dir, PARTY);
		await first.trust(KEY_A, 'genesis');
		await first.trust(KEY_B, 'invite');
		// Re-trusting with a different source must not rewrite the original.
		await first.trust(KEY_A, 'operator');

		const body = JSON.parse((await readFile(await anchorFile(dir))).toString('utf8')) as {
			version: number;
			partyId: string;
			owners: Record<string, { source: string; trustedAt: number }>;
		};
		expect(body.version).toBe(1);
		expect(body.partyId).toBe(PARTY);
		expect(body.owners[KEY_A]?.source).toBe('genesis');
		expect(body.owners[KEY_B]?.source).toBe('invite');
		expect(typeof body.owners[KEY_A]?.trustedAt).toBe('number');

		// A reload sees the same provenance (it is what a later source-aware
		// consumer would read back).
		const reloaded = await FileTrustedOwnerStore.open(dir, PARTY);
		expect(reloaded.all()).toEqual(new Set([KEY_A, KEY_B]));
	});

	it('concurrent trust() calls all land durably (serialised snapshot writes)', async () => {
		const dir = await makeTmpDir();
		const store = await FileTrustedOwnerStore.open(dir, PARTY);
		const keys = Array.from({ length: 8 }, (_, i) => `KEY_${i}`);
		await Promise.all(keys.map((k) => store.trust(k, 'operator')));

		const reloaded = await FileTrustedOwnerStore.open(dir, PARTY);
		expect(reloaded.all()).toEqual(new Set(keys));
	});

	it('leaves no temp-file debris after writes', async () => {
		const dir = await makeTmpDir();
		const store = await FileTrustedOwnerStore.open(dir, PARTY);
		await store.trust(KEY_A, 'operator');
		await store.trust(KEY_B, 'operator');
		const leftovers = (await readdir(dir)).filter((f) => f.endsWith('.tmp'));
		expect(leftovers).toEqual([]);
	});
});
