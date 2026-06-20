import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readdir, stat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryKeyStore, KeyStoreAccessError, DEFAULT_IDENTITY_KEY_ID, type KeyStore } from '../src/key-store.js';
import { FileKeyStore } from '../src/key-store-file.js';

// Mock node:fs/promises so the atomic-write tests can force a `rename` failure.
// Everything else delegates to the real implementation, so the shared contract
// suite (which exercises real set/get/delete/list) runs unchanged.
vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return { ...actual, rename: vi.fn(actual.rename) };
});

/** Spread to plain arrays for a content-wise byte comparison. */
function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
	return !!a && a.length === b.length && [...a].every((v, i) => v === b[i]);
}

// Each backend supplies a fresh store and a teardown. The contract suite below
// runs identically against both — the only difference is persistence medium.
interface Backend {
	name: string;
	make: () => Promise<KeyStore>;
	cleanup: () => Promise<void>;
}

const tmpDirs: string[] = [];

const backends: Backend[] = [
	{
		name: 'InMemoryKeyStore',
		make: async () => new InMemoryKeyStore(),
		cleanup: async () => {}
	},
	{
		name: 'FileKeyStore',
		make: async () => {
			const dir = await mkdtemp(join(tmpdir(), 'cadre-keystore-'));
			tmpDirs.push(dir);
			return new FileKeyStore(dir);
		},
		cleanup: async () => {
			for (const dir of tmpDirs.splice(0)) {
				await rm(dir, { recursive: true, force: true });
			}
		}
	}
];

describe.each(backends)('KeyStore contract: $name', ({ make, cleanup }) => {
	afterEach(async () => { await cleanup(); });

	it('round-trips set → get with identical bytes', async () => {
		const store = await make();
		const material = new Uint8Array([1, 2, 3, 250, 0, 128, 255]);
		await store.set(DEFAULT_IDENTITY_KEY_ID, material);

		const got = await store.get(DEFAULT_IDENTITY_KEY_ID);
		expect(sameBytes(got, material)).toBe(true);
	});

	it('returns undefined (not a throw) for a missing slot', async () => {
		const store = await make();
		await expect(store.get('cadre/absent')).resolves.toBeUndefined();
	});

	it('overwrites a slot silently on a second set', async () => {
		const store = await make();
		await store.set('k', new Uint8Array([1, 1, 1]));
		await store.set('k', new Uint8Array([9, 8, 7, 6]));

		const got = await store.get('k');
		expect(sameBytes(got, new Uint8Array([9, 8, 7, 6]))).toBe(true);
	});

	it('isolates stored bytes from later mutation of the caller buffer', async () => {
		const store = await make();
		const material = new Uint8Array([5, 6, 7]);
		await store.set('k', material);
		material[0] = 99; // mutate after set

		const got = await store.get('k');
		expect(sameBytes(got, new Uint8Array([5, 6, 7]))).toBe(true);
	});

	it('delete removes a slot and is idempotent on an absent slot', async () => {
		const store = await make();
		await store.set('k', new Uint8Array([1]));

		await store.delete('k');
		await expect(store.get('k')).resolves.toBeUndefined();

		// Deleting again (now absent) must succeed without throwing.
		await expect(store.delete('k')).resolves.toBeUndefined();
		await expect(store.delete('never-existed')).resolves.toBeUndefined();
	});

	it('list reflects exactly the slots written and removed', async () => {
		const store = await make();
		await expect(store.list()).resolves.toEqual([]);

		await store.set('a', new Uint8Array([1]));
		await store.set('b', new Uint8Array([2]));
		await store.set('c', new Uint8Array([3]));
		expect((await store.list()).sort()).toEqual(['a', 'b', 'c']);

		await store.delete('b');
		expect((await store.list()).sort()).toEqual(['a', 'c']);
	});

	it('round-trips awkward keyIds (slashes, spaces, unicode, fs-reserved chars) without collision', async () => {
		const store = await make();
		const awkward: Array<[string, Uint8Array]> = [
			['cadre/identity', new Uint8Array([10])],
			['with space and #hash', new Uint8Array([20])],
			['unicode-Ω-✓-é', new Uint8Array([30])],
			['star*colon:lt<gt>pipe|q?', new Uint8Array([40])],
			['a/b/c/nested', new Uint8Array([50])]
		];

		for (const [id, mat] of awkward) {
			await store.set(id, mat);
		}

		// Every id round-trips its own bytes (no collision between encodings).
		for (const [id, mat] of awkward) {
			expect(sameBytes(await store.get(id), mat)).toBe(true);
		}

		// list() recovers exactly the original ids.
		expect((await store.list()).sort()).toEqual(awkward.map(([id]) => id).sort());
	});
});

describe('FileKeyStore specifics', () => {
	afterEach(async () => {
		for (const dir of tmpDirs.splice(0)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('list() on a never-created directory is empty (no throw)', async () => {
		const dir = join(tmpdir(), 'cadre-keystore-missing-' + DEFAULT_IDENTITY_KEY_ID.replace(/\W/g, '_'));
		const store = new FileKeyStore(join(dir, 'sub', 'sub2'));
		await expect(store.list()).resolves.toEqual([]);
	});

	it('get() on a never-created directory returns undefined (no throw)', async () => {
		const store = new FileKeyStore(join(tmpdir(), 'cadre-keystore-missing', 'deep'));
		await expect(store.get('cadre/identity')).resolves.toBeUndefined();
	});

	it('list() skips a foreign .key file with an undecodable name (no throw)', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'cadre-keystore-foreign-'));
		tmpDirs.push(dir);
		const store = new FileKeyStore(dir);
		await store.set('real', new Uint8Array([1]));
		// A `.key` file this store never wrote, whose stem is an invalid percent
		// sequence — decodeURIComponent would throw on it.
		await writeFile(join(dir, '%ZZ.key'), new Uint8Array([9]));

		expect(await store.list()).toEqual(['real']);
	});

	it('leaves no .tmp debris after a successful set', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'cadre-keystore-atomic-'));
		tmpDirs.push(dir);
		const store = new FileKeyStore(dir);
		await store.set('id', new Uint8Array([1, 2, 3]));

		// The atomic rename consumes the temp file; only the `.key` slot remains.
		const raw = await readdir(dir);
		expect(raw.some((name) => name.endsWith('.tmp'))).toBe(false);
		expect(await store.list()).toEqual(['id']);
	});

	it('list() never surfaces a stray non-.key file (e.g. crash-orphaned .tmp)', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'cadre-keystore-stray-'));
		tmpDirs.push(dir);
		const store = new FileKeyStore(dir);
		await store.set('real', new Uint8Array([1]));
		// A temp file a crashed write could leave behind: list() must ignore it.
		await writeFile(join(dir, 'real.deadbeef.tmp'), new Uint8Array([9]));

		expect(await store.list()).toEqual(['real']);
	});

	it('a mid-write failure preserves the previous slot and leaves no .tmp debris', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'cadre-keystore-fail-'));
		tmpDirs.push(dir);
		const store = new FileKeyStore(dir);

		// Seed a good slot.
		await store.set('id', new Uint8Array([1, 2, 3]));

		// Simulate a crash during the atomic swap: the temp file is created and
		// written, but the rename that would publish it fails (e.g. power loss).
		vi.mocked(rename).mockRejectedValueOnce(new Error('simulated power loss'));
		await expect(store.set('id', new Uint8Array([9, 9, 9, 9])))
			.rejects.toThrow('simulated power loss');

		// Previous bytes survive intact and fully loadable.
		expect(sameBytes(await store.get('id'), new Uint8Array([1, 2, 3]))).toBe(true);

		// No `.tmp` debris remains for a retry to trip over.
		const raw = await readdir(dir);
		expect(raw.some((name) => name.endsWith('.tmp'))).toBe(false);
		expect(await store.list()).toEqual(['id']);
	});

	it('a failed first write leaves no slot and no .tmp debris (no phantom slot)', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'cadre-keystore-firstfail-'));
		tmpDirs.push(dir);
		const store = new FileKeyStore(dir);

		// No prior slot: the rename that would publish the very first write fails.
		vi.mocked(rename).mockRejectedValueOnce(new Error('simulated power loss'));
		await expect(store.set('id', new Uint8Array([9, 9, 9, 9])))
			.rejects.toThrow('simulated power loss');

		// The slot was never published, so get() still reports it empty...
		await expect(store.get('id')).resolves.toBeUndefined();
		// ...and the temp file was cleaned up, leaving the directory empty.
		expect(await readdir(dir)).toEqual([]);
		expect(await store.list()).toEqual([]);
	});

	// POSIX-only: Windows has no 0o600-style mode bits to assert against.
	it.skipIf(process.platform === 'win32')('keeps best-effort 0o600 on the final slot, even on overwrite', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'cadre-keystore-perm-'));
		tmpDirs.push(dir);
		const store = new FileKeyStore(dir);
		await store.set('id', new Uint8Array([1]));
		await store.set('id', new Uint8Array([2, 3])); // overwrite via rename must not widen mode

		const names = await readdir(dir);
		const slot = names.find((name) => name.endsWith('.key'));
		expect(slot).toBeDefined();
		if (!slot) return;
		const st = await stat(join(dir, slot));
		expect(st.mode & 0o777).toBe(0o600);
	});
});

describe('KeyStoreAccessError', () => {
	it('carries the keyId and forwards a cause without embedding material', () => {
		const cause = new Error('biometric cancelled');
		const err = new KeyStoreAccessError('cadre/identity', 'access denied', { cause });

		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe('KeyStoreAccessError');
		expect(err.keyId).toBe('cadre/identity');
		expect(err.message).toBe('access denied');
		expect(err.cause).toBe(cause);
	});
});
