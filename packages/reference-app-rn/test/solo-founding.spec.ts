import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { webSockets } from '@libp2p/websockets';
import type { IRawStorage } from '@optimystic/db-p2p';
import { LevelDBRawStorage, openOptimysticRNDb } from '@optimystic/db-p2p-storage-rn';
import {
	CadreNode,
	InMemoryKeyStore,
	MemoryBootstrapPeerStore,
	MemoryEnrolledMachineStore,
	MemoryTrustedOwnerStore,
} from '@serfab/cadre-core';
import { createChatStrand, createClosedChatStrand } from '../src/chat-strand.js';
import { buildPhoneNodeConfig, runOwnerGenesis } from '../src/phone-node-config.js';
import { uuid } from '../src/uuid.js';
import { FakeWriteBatch, fakeRNLevelDBOpener } from './fake-rn-leveldb.js';

/**
 * A phone on its own founds strands promptly: the headless guard for the 2026-09-14
 * device report in which "Create Chat Strand" showed no result for minutes (fix ticket
 * `rn-solo-founding-stall-on-device`). It cannot reproduce that stall. The cause found
 * on the device is a lock Quereus leaves held when `for await` exits early, and it only
 * happens in Metro's Babel-compiled bundle; Node runs Quereus as published. Maestro
 * flow 4 is the device-side guard.
 *
 * The node is built by the app's own `buildPhoneNodeConfig` and `runOwnerGenesis`,
 * not a copy, so the config tested is the config the phone runs. Storage is the
 * phone's real rn-leveldb adapter — `openOptimysticRNDb` into `LevelDBRawStorage`,
 * the calls `cadre-phone.ts` makes — over an in-memory fake of the native module.
 * That is also the adapter's first Node coverage: optimystic's own tests drive
 * `classic-level` instead.
 *
 * Not covered: the native module's speed, Hermes, and the WebRTC transport, whose
 * Node build needs the native `node-datachannel` addon (`cadre-phone.ts` adds it as a
 * third transport).
 */

/** Founding measured about 60 ms here on 2026-09-15; 10 s leaves room for a loaded CI machine and still catches a stall. */
const FOUNDING_DEADLINE_MS = 10_000;
/** `start()` and `stop()` bring libp2p up and down: a looser bound, still finite. */
const LIFECYCLE_DEADLINE_MS = 30_000;

/** Fail naming `label` when `op` has not settled within `ms`, rather than hitting vitest's anonymous timeout. */
async function within<T>(label: string, ms: number, op: () => Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms);
	});
	try {
		return await Promise.race([op(), deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/** `cadre-phone.ts`'s `createStorage`, with rn-leveldb's native constructors swapped for the fake. */
function phoneStorageOverFakeNative(): (id: string) => IRawStorage {
	const openFn = fakeRNLevelDBOpener();
	return (id) => new LevelDBRawStorage(openOptimysticRNDb({ openFn, WriteBatch: FakeWriteBatch, name: `sereus-${id}` }));
}

describe('solo phone founding (app node config over the rn-leveldb adapter)', () => {
	const partyId = `rn-solo-founding-${uuid()}`;
	let node: CadreNode | undefined;

	function running(): CadreNode {
		if (!node) throw new Error('the node was never constructed; see the beforeAll failure');
		return node;
	}

	beforeAll(async () => {
		const cadre = new CadreNode(buildPhoneNodeConfig({
			partyId,
			bootstrapAddrs: [],
			keyStore: new InMemoryKeyStore(),
			storageProvider: phoneStorageOverFakeNative(),
			transports: [webSockets(), circuitRelayTransport()],
			trustedOwnerStore: new MemoryTrustedOwnerStore(partyId),
			bootstrapPeerStore: new MemoryBootstrapPeerStore(partyId),
			enrolledMachineStore: new MemoryEnrolledMachineStore(partyId),
		}));
		node = cadre;
		await within('node.start()', LIFECYCLE_DEADLINE_MS, () => cadre.start());
		await within('runOwnerGenesis()', LIFECYCLE_DEADLINE_MS, () => runOwnerGenesis(cadre));
		// runOwnerGenesis is fail-soft (it logs and returns), so check its effect here: a
		// genesis failure should fail as itself, not later as a refused strand publish.
		expect(await cadre.getControlDatabase()?.hasOwnerKey()).toBe(true);
	}, LIFECYCLE_DEADLINE_MS * 2);

	afterAll(async () => {
		if (node) await within('node.stop()', LIFECYCLE_DEADLINE_MS, () => running().stop());
	}, LIFECYCLE_DEADLINE_MS);

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('founds an open chat strand, as its founder, inside the deadline', async () => {
		const cadre = running();
		const foundStrand = vi.spyOn(cadre, 'foundStrand');
		const strandId = uuid();

		const instance = await within('createChatStrand()', FOUNDING_DEADLINE_MS, () => createChatStrand(cadre, strandId));

		expect(instance.strandId).toBe(strandId);
		expect(instance.status).toBe('active');
		// createChatStrand drops FoundStrandResult.founded; read it from the call it made.
		expect(foundStrand.mock.settledResults).toEqual([
			{ type: 'fulfilled', value: expect.objectContaining({ founded: true }) },
		]);
	}, FOUNDING_DEADLINE_MS * 2);

	it('founds a closed chat strand, which also takes the party membership-key path, inside the deadline', async () => {
		const cadre = running();
		const foundStrand = vi.spyOn(cadre, 'foundStrand');
		const warn = vi.spyOn(console, 'warn');
		const strandId = uuid();

		const { instance, memberPrivateKey } = await within('createClosedChatStrand()', FOUNDING_DEADLINE_MS,
			() => createClosedChatStrand(cadre, strandId));

		expect(instance.strandId).toBe(strandId);
		expect(instance.status).toBe('active');
		expect(memberPrivateKey).toEqual(expect.any(String));
		expect(foundStrand.mock.settledResults).toEqual([
			{ type: 'fulfilled', value: expect.objectContaining({ founded: true }) },
		]);
		// The owner-role insert into the new strand's database is best-effort and only
		// warns when it is skipped or fails, so a warning here is a missing role row. Match
		// on the first argument alone: the skip warning has no second one.
		const chatStrandWarnings = warn.mock.calls.filter(([message]) => String(message).includes('[chat-strand]'));
		expect(chatStrandWarnings).toEqual([]);
	}, FOUNDING_DEADLINE_MS * 2);
});
