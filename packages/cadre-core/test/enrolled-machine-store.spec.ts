import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import debug from 'debug';
import {
	MemoryEnrolledMachineStore,
	PersistentEnrolledMachineStore,
	type EnrolledMachineStore
} from '../src/enrolled-machine-store.js';
import { FileEnrolledMachineStore } from '../src/enrolled-machine-store-file.js';
import type { DurableSlot } from '../src/node-local-snapshot.js';

/**
 * The node-local enrolled-machine count: the control network's block-repair
 * yardstick, remembered across a restart because the control libp2p node is built
 * before the database that could answer the question exists.
 *
 * The load policy asserted here is deliberately NOT its two siblings' — every
 * failure mode, INCLUDING a present-but-unreadable slot, cold-starts to
 * `undefined` rather than throwing. `bootstrap-peer-store.spec.ts` asserts the
 * opposite for that record, on purpose; see the `enrolled-machine-store.ts` module
 * comment for why the two differ.
 */

const PARTY = 'party-alpha';

interface Backend {
	name: string;
	make: (partyId?: string) => Promise<EnrolledMachineStore>;
	cleanup: () => Promise<void>;
}

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'cadre-enrolled-machines-'));
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
	if (!file) throw new Error('enrolled-machine file not found');
	return join(dir, file);
}

/** Write a raw envelope straight into the party's file, bypassing the store. */
async function seedRaw(dir: string, partyId: string, body: unknown): Promise<void> {
	await writeFile(join(dir, `enrolled-machines.${partyId}.json`), JSON.stringify(body), 'utf8');
}

/**
 * Run `body` with this module's namespace enabled and debug's sink captured. Same
 * shape as `control-read-retry.spec.ts`'s helper — the namespace set and the sink
 * are process-global in `debug`, so both are restored even when `body` throws.
 */
async function captureStoreLog(body: () => Promise<void>): Promise<string[]> {
	const lines: string[] = [];
	const previousNamespaces = debug.disable();
	const previousLog = debug.log;
	debug.enable('sereus:cadre:enrolled-machine-store');
	debug.log = function (this: unknown, ...args: unknown[]): void { lines.push(format(...args)); };
	try {
		await body();
	} finally {
		debug.log = previousLog;
		debug.disable();
		if (previousNamespaces) debug.enable(previousNamespaces);
	}
	return lines;
}

const backends: Backend[] = [
	{
		name: 'MemoryEnrolledMachineStore',
		make: async (partyId = PARTY) => new MemoryEnrolledMachineStore(partyId),
		cleanup: async () => {}
	},
	{
		name: 'FileEnrolledMachineStore',
		make: async (partyId = PARTY) => FileEnrolledMachineStore.open(await makeTmpDir(), partyId),
		cleanup: cleanTmpDirs
	}
];

describe.each(backends)('EnrolledMachineStore contract: $name', ({ make, cleanup }) => {
	afterEach(async () => { await cleanup(); });

	it('starts with no count and reports the scoping partyId', async () => {
		const store = await make();
		expect(store.partyId).toBe(PARTY);
		// `undefined`, never 0 — "this node does not know" is what `controlClusterPolicy`
		// answers with the frozen base policy, and 0 would be a declaration nobody chose.
		expect(store.count()).toBeUndefined();
	});

	it('record() reflects the count synchronously (durability is the promise, visibility is not)', async () => {
		const store = await make();
		const pending = store.record(4);
		expect(store.count()).toBe(4);
		await pending;
	});

	it('records a LOWER count, so a party that shrinks is not stuck at its high-water mark', async () => {
		const store = await make();
		await store.record(5);
		await store.record(3);
		expect(store.count()).toBe(3);
	});

	it('re-recording the same count is a no-op that keeps it', async () => {
		const store = await make();
		await store.record(3);
		await store.record(3);
		expect(store.count()).toBe(3);
	});

	// A caller bug, not a persisted-junk case: the sole caller records
	// `authorizedControlPeers.size + 1`, which is always a positive integer.
	it.each([0, -1, 2.5, Number.NaN])('ignores a non-positive-integer count (%p) rather than recording it', async (bad) => {
		const store = await make();
		await store.record(3);
		await store.record(bad);
		expect(store.count()).toBe(3);
	});

	it('never rejects, even when the count is degenerate', async () => {
		const store = await make();
		await expect(store.record(0)).resolves.toBeUndefined();
	});
});

describe('FileEnrolledMachineStore specifics', () => {
	afterEach(cleanTmpDirs);

	it('persists across open() cycles — the whole point of the record', async () => {
		const dir = await makeTmpDir();
		const first = await FileEnrolledMachineStore.open(dir, PARTY);
		await first.record(5);

		const reloaded = await FileEnrolledMachineStore.open(dir, PARTY);
		expect(reloaded.count()).toBe(5);
	});

	it('persists a DECREASE across a reopen (a removed machine stays removed)', async () => {
		const dir = await makeTmpDir();
		const first = await FileEnrolledMachineStore.open(dir, PARTY);
		await first.record(5);
		await first.record(2);

		expect((await FileEnrolledMachineStore.open(dir, PARTY)).count()).toBe(2);
	});

	it('writes the documented envelope', async () => {
		const dir = await makeTmpDir();
		const store = await FileEnrolledMachineStore.open(dir, PARTY);
		await store.record(3);

		const body = JSON.parse((await readFile(await storeFile(dir))).toString('utf8')) as unknown;
		expect(body).toEqual({ version: 1, partyId: PARTY, enrolledMachines: 3 });
	});

	it('an absent directory is a cold start, not a crash', async () => {
		const store = await FileEnrolledMachineStore.open(
			join(tmpdir(), 'cadre-enrolled-machines-missing', 'deep'), PARTY);
		expect(store.count()).toBeUndefined();
	});

	it('a corrupt file is a cold start', async () => {
		const dir = await makeTmpDir();
		await (await FileEnrolledMachineStore.open(dir, PARTY)).record(3);
		await writeFile(await storeFile(dir), 'not json {', 'utf8');

		expect((await FileEnrolledMachineStore.open(dir, PARTY)).count()).toBeUndefined();
	});

	it('an unknown envelope version is a cold start', async () => {
		const dir = await makeTmpDir();
		await seedRaw(dir, PARTY, { version: 99, partyId: PARTY, enrolledMachines: 3 });

		expect((await FileEnrolledMachineStore.open(dir, PARTY)).count()).toBeUndefined();
	});

	it('an envelope claiming a foreign partyId is a cold start', async () => {
		const dir = await makeTmpDir();
		await seedRaw(dir, PARTY, { version: 1, partyId: 'party-other', enrolledMachines: 3 });

		expect((await FileEnrolledMachineStore.open(dir, PARTY)).count()).toBeUndefined();
	});

	it('two parties sharing a directory keep separate counts', async () => {
		const dir = await makeTmpDir();
		await (await FileEnrolledMachineStore.open(dir, 'party-alpha')).record(3);
		await (await FileEnrolledMachineStore.open(dir, 'party-beta')).record(7);

		expect((await FileEnrolledMachineStore.open(dir, 'party-alpha')).count()).toBe(3);
		expect((await FileEnrolledMachineStore.open(dir, 'party-beta')).count()).toBe(7);
	});

	// Each shape cold-starts rather than being coerced. Coercing `'3'` here would be
	// the first line of a parser, and Optimystic treats a degenerate declaration as
	// absent anyway — so a rounded value would be a number nobody chose.
	it.each([
		['a stringified number', '3'],
		['zero', 0],
		['a negative count', -1],
		['a fractional count', 2.5],
		['null', null],
		['a boolean', true],
		['an object', { count: 3 }]
	])('junk payload — %s — is a cold start, not a coercion', async (_label, value) => {
		const dir = await makeTmpDir();
		await seedRaw(dir, PARTY, { version: 1, partyId: PARTY, enrolledMachines: value });

		expect((await FileEnrolledMachineStore.open(dir, PARTY)).count()).toBeUndefined();
	});

	it('a missing enrolledMachines key is a cold start', async () => {
		const dir = await makeTmpDir();
		await seedRaw(dir, PARTY, { version: 1, partyId: PARTY });

		expect((await FileEnrolledMachineStore.open(dir, PARTY)).count()).toBeUndefined();
	});

	it('an array envelope is a cold start rather than reaching the payload read', async () => {
		const dir = await makeTmpDir();
		await seedRaw(dir, PARTY, [{ version: 1, partyId: PARTY, enrolledMachines: 3 }]);

		expect((await FileEnrolledMachineStore.open(dir, PARTY)).count()).toBeUndefined();
	});

	it('a present-but-unreadable file COLD-STARTS rather than throwing — the divergence from the sibling stores', async () => {
		const dir = await makeTmpDir();
		await (await FileEnrolledMachineStore.open(dir, PARTY)).record(3);
		// Replace the file with a directory: present, but every read fails with
		// something other than ENOENT. `FileBootstrapPeerStore` throws here on purpose;
		// this record must not, because refusing to start a node over an unreadable
		// repair HINT is strictly worse than declaring today's default.
		const file = await storeFile(dir);
		await rm(file);
		await mkdir(file);

		const store = await FileEnrolledMachineStore.open(dir, PARTY);
		expect(store.count()).toBeUndefined();
	});

	it('logs the unreadable file rather than swallowing it silently', async () => {
		const dir = await makeTmpDir();
		await (await FileEnrolledMachineStore.open(dir, PARTY)).record(3);
		const file = await storeFile(dir);
		await rm(file);
		await mkdir(file);

		const lines = await captureStoreLog(async () => {
			await FileEnrolledMachineStore.open(dir, PARTY);
		});

		expect(lines.some((line) => /present but unreadable/i.test(line))).toBe(true);
	});

	it('logs a junk payload rather than cold-starting silently', async () => {
		const dir = await makeTmpDir();
		await seedRaw(dir, PARTY, { version: 1, partyId: PARTY, enrolledMachines: '3' });

		const lines = await captureStoreLog(async () => {
			await FileEnrolledMachineStore.open(dir, PARTY);
		});

		expect(lines.some((line) => /unusable enrolledMachines value/i.test(line))).toBe(true);
	});
});

describe('PersistentEnrolledMachineStore over a fake slot', () => {
	/** A `DurableSlot` whose reads and writes can be made to fail on demand. */
	class FakeSlot implements DurableSlot {
		text: string | undefined;
		loadError: Error | null = null;
		saveError: Error | null = null;
		saves = 0;

		async load(): Promise<string | undefined> {
			if (this.loadError) throw this.loadError;
			return this.text;
		}

		async save(text: string): Promise<void> {
			this.saves++;
			if (this.saveError) throw this.saveError;
			this.text = text;
		}
	}

	it('open() resolves on a failed read instead of rejecting, and writes nothing', async () => {
		const slot = new FakeSlot();
		slot.loadError = new Error('slot read failed');

		const store = await PersistentEnrolledMachineStore.open(slot, PARTY);

		expect(store.count()).toBeUndefined();
		expect(slot.saves).toBe(0);
	});

	it('a failed persist does NOT reject and leaves the in-memory count correct', async () => {
		const slot = new FakeSlot();
		const store = await PersistentEnrolledMachineStore.open(slot, PARTY);
		slot.saveError = new Error('slot write failed');

		// `refreshAuthorizedControlPeers` leaves this promise un-awaited (`void`), so a
		// rejection here would surface as an unhandled rejection in the embedder.
		await expect(store.record(3)).resolves.toBeUndefined();
		expect(store.count()).toBe(3);
	});

	it('logs a failed persist rather than swallowing it silently', async () => {
		const slot = new FakeSlot();
		const store = await PersistentEnrolledMachineStore.open(slot, PARTY);
		slot.saveError = new Error('slot write failed');

		const lines = await captureStoreLog(async () => { await store.record(3); });

		expect(lines.some((line) => /persisting 3 enrolled machine/i.test(line))).toBe(true);
	});

	it('retries the next record after a failed persist rather than skipping it as unchanged', async () => {
		const slot = new FakeSlot();
		const store = await PersistentEnrolledMachineStore.open(slot, PARTY);
		slot.saveError = new Error('slot write failed');
		await store.record(3);
		expect(slot.text).toBeUndefined();

		// Same number again: the unchanged-write skip is keyed off what is believed to
		// be IN the slot, so a write that failed is re-attempted rather than suppressed.
		slot.saveError = null;
		await store.record(3);

		expect(JSON.parse(slot.text ?? '{}')).toEqual({ version: 1, partyId: PARTY, enrolledMachines: 3 });
	});

	it('skips the write when the slot already holds the count (the refresh cadence would rewrite it forever)', async () => {
		const slot = new FakeSlot();
		const store = await PersistentEnrolledMachineStore.open(slot, PARTY);
		await store.record(3);
		const afterFirst = slot.saves;

		await store.record(3);
		await store.record(3);

		expect(slot.saves).toBe(afterFirst);
	});

	it('a value recorded back to what the slot holds, mid-write, leaves the slot and its belief agreed', async () => {
		// The one interleaving the two skip tests above do not reach: a write for a NEW
		// value is already chained when the caller records the value the slot ALREADY
		// holds. The second call short-circuits on `persisted`, so the chained link is
		// what must not write the number that was reverted — it re-reads the settled
		// count when it runs rather than capturing the one it was queued for.
		const slot = new FakeSlot();
		const store = await PersistentEnrolledMachineStore.open(slot, PARTY);
		await store.record(3);
		const afterFirst = slot.saves;

		const chained = store.record(4);
		await store.record(3);
		await chained;

		expect(store.count()).toBe(3);
		expect(JSON.parse(slot.text ?? '{}')).toEqual({ version: 1, partyId: PARTY, enrolledMachines: 3 });
		expect(slot.saves).toBe(afterFirst);

		// And the belief is not left stale by that short-circuit: a genuinely new count
		// still reaches the slot afterwards.
		await store.record(5);
		expect(JSON.parse(slot.text ?? '{}')).toEqual({ version: 1, partyId: PARTY, enrolledMachines: 5 });
	});

	it('a burst of records collapses to one write of the latest value', async () => {
		const slot = new FakeSlot();
		const store = await PersistentEnrolledMachineStore.open(slot, PARTY);

		// Un-awaited, as the production caller issues them.
		void store.record(2);
		void store.record(3);
		await store.record(4);

		expect(store.count()).toBe(4);
		expect(JSON.parse(slot.text ?? '{}')).toEqual({ version: 1, partyId: PARTY, enrolledMachines: 4 });
		// Two writes at most: the first record's, plus one carrying the settled value.
		expect(slot.saves).toBeLessThanOrEqual(2);
	});
});
