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
 * on the device was Babel's async-generator helper before 7.29.2 skipping Quereus's lock
 * release when `for await` exits early, which only happens in Metro's Babel-compiled
 * bundle; Node runs Quereus as published. `metro-babel/async-generator-cleanup.spec.ts`
 * guards that helper headlessly, and Maestro flow 4 is the device-side guard.
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
/**
 * The same two bounds for a node whose relay is configured but unreachable. Each adds
 * roughly one relay drive — `DEFAULT_RELAY_RESERVE_TIMEOUT_MS` (10 s), which a refused
 * dial spends polling in case libp2p's own discovery lands a reservation anyway.
 * `start()` waits out the control node's first attempt, and every strand launch waits
 * out its own supervisors' (`strand-instance-manager.ts` → `awaitFirstRelayAttempts`).
 * That ~10 s per strand launch is a real, accepted regression in founding latency on a
 * phone whose relay is down; the deadlines here are sized for it rather than hiding it.
 */
const RELAY_LIFECYCLE_DEADLINE_MS = 45_000;
const RELAY_FOUNDING_DEADLINE_MS = 30_000;

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
			relayAddrs: [],
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

/**
 * A relay named but unreachable is the everyday phone case — the relay is down, or
 * the phone is on a dead network — and `buildPhoneNodeConfig`'s `requireRelay: false`
 * is what keeps it a working phone rather than a phone that will not start. Nothing
 * here needs a relay server: an address nothing is listening on exercises the whole
 * fail-soft path.
 *
 * What this does NOT prove: that a phone with a WORKING relay can be dialed. No test in
 * this package puts the phone's config on a wire against a real relay.
 * `packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts`
 * proves the behaviour for a node of this shape (`listenAddrs: []` + `relayAddrs`), and
 * `test/phone-node-config.spec.ts` proves the phone's config resolves to that shape —
 * but the two are joined by inspection, not by a test.
 */
describe('solo phone founding with a relay configured but unreachable', () => {
	const partyId = `rn-relay-down-founding-${uuid()}`;
	/** Nothing listens on port 1, so every dial is refused at once. The peer id is real (it must parse); the host is not. */
	const UNREACHABLE_RELAY = '/ip4/127.0.0.1/tcp/1/ws/p2p/12D3KooWK99VoVxNE7XzyBwXEzW7xhK7Gpv85r9F3V3fyKSUKPH5';
	let node: CadreNode | undefined;
	/** The posture the instant `start()` resolved — see the assertion for why it is captured rather than re-read. */
	let postureAfterStart: ReturnType<CadreNode['getRelayReservationState']> | undefined;

	function running(): CadreNode {
		if (!node) throw new Error('the node was never constructed; see the beforeAll failure');
		return node;
	}

	beforeAll(async () => {
		const cadre = new CadreNode(buildPhoneNodeConfig({
			partyId,
			bootstrapAddrs: [],
			relayAddrs: [UNREACHABLE_RELAY],
			keyStore: new InMemoryKeyStore(),
			storageProvider: phoneStorageOverFakeNative(),
			transports: [webSockets(), circuitRelayTransport()],
			trustedOwnerStore: new MemoryTrustedOwnerStore(partyId),
			bootstrapPeerStore: new MemoryBootstrapPeerStore(partyId),
			enrolledMachineStore: new MemoryEnrolledMachineStore(partyId),
		}));
		node = cadre;
		await within('node.start() with a dead relay', RELAY_LIFECYCLE_DEADLINE_MS, () => cadre.start());
		postureAfterStart = cadre.getRelayReservationState();
		await within('runOwnerGenesis()', LIFECYCLE_DEADLINE_MS, () => runOwnerGenesis(cadre));
	}, RELAY_LIFECYCLE_DEADLINE_MS * 2);

	afterAll(async () => {
		if (node) await within('node.stop()', LIFECYCLE_DEADLINE_MS, () => running().stop());
	}, LIFECYCLE_DEADLINE_MS);

	it('starts anyway, and keeps trying for the reservation in the background', () => {
		// Sampled at the instant `start()` returned: the first drive has just failed and
		// the supervisor has scheduled its retry, so this moment is deterministic.
		// Re-reading later is not — the supervisor alternates between a 10 s drive
		// (`dialing`) and its backoff (`retrying`), which is why the live read below
		// accepts either.
		expect(postureAfterStart?.status).toBe('retrying');
		expect(postureAfterStart?.addrs).toEqual([UNREACHABLE_RELAY]);
		expect(postureAfterStart?.circuitAddrs).toEqual([]);
		expect(postureAfterStart?.error).toEqual(expect.any(String));
	});

	it('has no address anyone could dial, so an invitation would be refused', () => {
		// The precondition `CadreNode.createOpenInvitation` actually has, and the guard
		// `use-cadre.ts` → `createClosedStrandWithInvite` checks before founding anything.
		expect(running().getMultiaddrs()).toEqual([]);
		// Still trying — never `error` (nobody is trying) and never `none` (nothing configured).
		expect(['retrying', 'dialing']).toContain(running().getRelayReservationState().status);
	});

	it('founds a chat strand regardless — a phone with no relay is still a working phone', async () => {
		const cadre = running();
		const strandId = uuid();

		const instance = await within('createChatStrand() with a dead relay', RELAY_FOUNDING_DEADLINE_MS,
			() => createChatStrand(cadre, strandId));

		expect(instance.strandId).toBe(strandId);
		expect(instance.status).toBe('active');
	}, RELAY_FOUNDING_DEADLINE_MS * 2);
});
