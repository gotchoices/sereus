/**
 * `createPhoneNode` running a real `CadreNode` under Node. Only the two native modules are
 * replaced: the secure store by `FakeSecureStore`, rn-leveldb by the repo's in-memory fake
 * in its locking form, which refuses to open a name that is already open, as the native
 * module does. So a database the phone node failed to close fails the next start here too.
 *
 * Each case uses its own storage prefix and party, because `createPhoneNode` refuses a
 * second live node over one prefix (one of the cases below).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SAppConfig } from '@serfab/cadre-core';
import { FakeWriteBatch, lockingFakeRNLevelDB } from '../../../../test-harness/fake-rn-leveldb.js';
import {
	createPhoneNode,
	DEFAULT_PHONE_NODE_NAMES,
	type PhoneNode,
	type PhoneNodePlatform,
	type PhoneNodeStatus,
} from '../../src/phone-node/index.js';
import { FakeSecureStore } from '../fake-secure-store.js';

/** A start brings libp2p up; generous for a loaded CI machine, still finite. */
const LIFECYCLE_MS = 60_000;

/** An unsigned sApp, which only a node that relaxes schema signing accepts: `configure` does. */
const NOTES_SAPP: SAppConfig = {
	id: 'cadre-rn-phone-node-spec',
	version: '1',
	schema: 'table Note (Id text primary key, Body text not null);',
};

let sequence = 0;

/** A fresh device: its own secure store, its own LevelDB files, its own storage names. */
function device(overrides: Partial<PhoneNodePlatform> = {}) {
	sequence += 1;
	const leveldb = lockingFakeRNLevelDB();
	const secureStore = new FakeSecureStore();
	const platform: PhoneNodePlatform = {
		secureStore,
		leveldb: { openFn: leveldb.openFn, WriteBatch: FakeWriteBatch },
		names: {
			storagePrefix: `spec${sequence}-`,
			nodeLocalDb: `spec${sequence}-node-local`,
			nodeLocalKvPrefix: `spec${sequence}:node-local:`,
		},
		dataVersion: 'spec-data-1',
		configure: (config) => ({ ...config, requireSignedSchemas: false }),
		...overrides,
	};
	return { platform, leveldb, partyId: `phone-node-spec-${sequence}` };
}

function options(partyId: string, relayAddrs: string[] = []) {
	return { partyId, bootstrapAddrs: [], relayAddrs };
}

const started: PhoneNode[] = [];

/** Create a phone node the suite stops afterwards, whatever the case did. */
function phoneNode(platform: PhoneNodePlatform): PhoneNode {
	const created = createPhoneNode(platform);
	started.push(created);
	return created;
}

afterEach(async () => {
	for (const node of started.splice(0)) await node.stop();
	vi.restoreAllMocks();
}, LIFECYCLE_MS);

describe('createPhoneNode — start and stop', () => {
	it('starts, enrols itself as its party\'s owner, and reports running', async () => {
		const { platform, partyId } = device();
		const phone = phoneNode(platform);
		const states: PhoneNodeStatus['state'][] = [];
		phone.onStatus((status) => states.push(status.state));

		const node = await phone.start(options(partyId));

		expect(node.isRunning).toBe(true);
		expect(phone.node).toBe(node);
		expect(phone.status).toMatchObject({ state: 'running', owner: 'enrolled' });
		expect(await node.getControlDatabase()?.hasOwnerKey()).toBe(true);
		expect(phone.ownerPublicKey()).toEqual(expect.any(String));
		expect(states).toEqual(['starting', 'running']);
	}, LIFECYCLE_MS);

	it('joins a start in flight rather than building a second node', async () => {
		const { platform, partyId } = device();
		const phone = phoneNode(platform);

		const [first, second] = await Promise.all([phone.start(options(partyId)), phone.start(options(partyId))]);

		expect(second).toBe(first);
	}, LIFECYCLE_MS);

	it('closes every database it opened on stop, so the next start can open them again', async () => {
		const { platform, leveldb, partyId } = device();
		const phone = phoneNode(platform);

		await phone.start(options(partyId));
		expect(leveldb.openNames().length).toBeGreaterThan(1); // node-local and control, at least
		await phone.stop();

		expect(leveldb.openNames()).toEqual([]);
		expect(phone.status).toEqual({ state: 'stopped' });
		await phone.start(options(partyId)); // the locking fake throws "DB is open" otherwise
		expect(phone.status.state).toBe('running');
	}, LIFECYCLE_MS * 2);

	it('keeps its identity across a stop and a start: it lives in the secure store', async () => {
		const { platform, partyId } = device();
		const phone = phoneNode(platform);

		await phone.start(options(partyId));
		const before = phone.ownerPublicKey();
		await phone.stop();
		await phone.start(options(partyId));

		expect(phone.ownerPublicKey()).toBe(before);
	}, LIFECYCLE_MS * 2);

	it('reports a failed start, closes what it opened, and starts afresh next time', async () => {
		const { platform, leveldb, partyId } = device();
		const phone = phoneNode(platform);
		vi.spyOn(console, 'warn').mockImplementation(() => {});

		// A malformed relay is refused at config resolution, inside `start()`.
		await expect(phone.start(options(partyId, ['not-a-multiaddr']))).rejects.toThrow(/relayAddrs/);

		expect(phone.status).toMatchObject({ state: 'failed', error: expect.any(Error) });
		expect(phone.node).toBeNull();
		expect(leveldb.openNames()).toEqual([]);
		await phone.start(options(partyId));
		expect(phone.status.state).toBe('running');
	}, LIFECYCLE_MS * 2);
});

describe('createPhoneNode — the start/stop rules a phone depends on', () => {
	it('fails the start when the secure store refuses a read, rather than minting a new identity', async () => {
		const { platform, partyId } = device();
		const phone = phoneNode(platform);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		(platform.secureStore as FakeSecureStore).getError = new Error('biometric prompt cancelled');

		await expect(phone.start(options(partyId))).rejects.toThrow();

		expect(phone.status.state).toBe('failed');
		expect(phone.node).toBeNull();
	}, LIFECYCLE_MS);

	it('closes every database on stop even when stopping the node throws', async () => {
		const { platform, leveldb, partyId } = device();
		const phone = phoneNode(platform);
		const node = await phone.start(options(partyId));
		const realStop = node.stop.bind(node);
		vi.spyOn(node, 'stop').mockImplementationOnce(async () => {
			await realStop();
			throw new Error('stop failed');
		});

		await expect(phone.stop()).rejects.toThrow('stop failed');

		expect(leveldb.openNames()).toEqual([]);
		expect(phone.node).toBeNull();
	}, LIFECYCLE_MS);

	it('waits for a start in flight, then stops the node it produced', async () => {
		const { platform, partyId } = device();
		const phone = phoneNode(platform);

		const starting = phone.start(options(partyId));
		await phone.stop();
		const node = await starting;

		expect(node.isRunning).toBe(false);
		expect(phone.status).toEqual({ state: 'stopped' });
		expect(await phone.loadSavedStart()).toMatchObject({ autoStart: false });
	}, LIFECYCLE_MS);

	it('starts again after the node died without a stop, reusing its open databases', async () => {
		// The OS killing the node (or a crash inside it) runs none of `stop`. The next start
		// must not open a second handle on a database still open: the locking fake throws.
		const { platform, partyId } = device();
		const phone = phoneNode(platform);
		const first = await phone.start(options(partyId));
		await first.stop();

		const second = await phone.start(options(partyId));

		expect(second).not.toBe(first);
		expect(second.isRunning).toBe(true);
	}, LIFECYCLE_MS * 2);
});

describe('createPhoneNode — the saved start', () => {
	it('remembers a successful start for unattended starts, and forgets autoStart on stop', async () => {
		const { platform, partyId } = device();
		const phone = phoneNode(platform);

		expect(await phone.loadSavedStart()).toBeUndefined();
		await phone.start(options(partyId));
		expect(await phone.loadSavedStart()).toEqual({ options: options(partyId), autoStart: true, writtenBy: 'spec-data-1' });

		await phone.stop();
		expect(await phone.loadSavedStart()).toMatchObject({ autoStart: false });
	}, LIFECYCLE_MS);

	it('saves the Noise mode resolved, so a later build\'s default does not change this device', async () => {
		const build = vi.fn(() => undefined); // pure JavaScript Noise, so nothing native loads
		const { platform, partyId } = device({ noiseCrypto: { build, defaultMode: 'symmetric' } });
		const phone = phoneNode(platform);

		await phone.start(options(partyId));

		expect(build).toHaveBeenCalledWith('symmetric');
		expect(phone.options?.noiseCryptoMode).toBe('symmetric');
		expect((await phone.loadSavedStart())?.options.noiseCryptoMode).toBe('symmetric');
	}, LIFECYCLE_MS);

	it('does not replace the saved start when a start fails', async () => {
		const { platform, partyId } = device();
		const phone = phoneNode(platform);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		await phone.start(options(partyId));
		await phone.stop();

		await expect(phone.start(options(partyId, ['not-a-multiaddr']))).rejects.toThrow();

		expect((await phone.loadSavedStart())?.options.relayAddrs).toEqual([]);
	}, LIFECYCLE_MS * 2);
});

describe('createPhoneNode — restart and subscriptions', () => {
	it('re-applies subscriptions to the node a restart builds, and keeps autoStart through it', async () => {
		const { platform, partyId } = device();
		const phone = phoneNode(platform);
		const startedStrands: string[] = [];
		phone.on('strand:started', ({ strandId }) => startedStrands.push(strandId));

		const first = await phone.start(options(partyId));
		const second = await phone.restart(options(partyId));
		await second.foundStrand({ strandId: 'after-restart', type: 'o', sAppConfig: NOTES_SAPP });

		expect(second).not.toBe(first);
		expect(startedStrands).toContain('after-restart');
		expect(await phone.loadSavedStart()).toMatchObject({ autoStart: true });
	}, LIFECYCLE_MS * 2);

	it('stops delivering to a handler once it is unsubscribed', async () => {
		const { platform, partyId } = device();
		const phone = phoneNode(platform);
		const handler = vi.fn();
		const unsubscribe = phone.on('strand:started', handler);

		const node = await phone.start(options(partyId));
		unsubscribe();
		await node.foundStrand({ strandId: 'unheard', type: 'o', sAppConfig: NOTES_SAPP });

		expect(handler).not.toHaveBeenCalled();
	}, LIFECYCLE_MS);
});

describe('createPhoneNode — storage names', () => {
	it('pins the default names: renaming one orphans every installed phone\'s records', () => {
		expect(DEFAULT_PHONE_NODE_NAMES).toEqual({
			storagePrefix: 'sereus-',
			nodeLocalDb: 'sereus-node-local',
			nodeLocalKvPrefix: 'sereus:node-local:',
			savedStartKey: 'start-options',
		});
	});
});

describe('createPhoneNode — one per app', () => {
	it('refuses a second phone node over storage that a running one holds', async () => {
		const { platform, partyId } = device();
		const phone = phoneNode(platform);
		await phone.start(options(partyId));

		expect(() => createPhoneNode(platform)).toThrow(/already running/);
	}, LIFECYCLE_MS);

	it('allows a new one once the old one is stopped, as a development reload needs', async () => {
		const { platform, partyId } = device();
		const phone = phoneNode(platform);
		await phone.start(options(partyId));
		await phone.stop();

		expect(() => phoneNode(platform)).not.toThrow();
	}, LIFECYCLE_MS);
});
