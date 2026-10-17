/**
 * `createPhoneNode` running a real `CadreNode` under Node. Only the two native modules are
 * replaced: the secure store by `FakeSecureStore`, rn-leveldb by the repo's in-memory fake
 * in its locking form, which refuses to open a name that is already open, as the native
 * module does. So a database the phone node failed to close fails the next start here too.
 *
 * Each case uses its own storage prefix and party, because `createPhoneNode` refuses a
 * second live node over one prefix (one of the cases below).
 */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	adoptStrandBundle,
	controlStorageScope,
	DEFAULT_OWNER_KEY_ID,
	ed25519PublicKeyB64FromPeerId,
	ed25519PublicKeyFromPrivate,
	encodeOwnerGrant,
	exportStrandBundle,
	StrandMoveNotOwnerError,
	type CadreInvitation,
	type CadreRemoval,
	type OwnerGrantBundle,
	type SAppConfig,
} from '@serfab/cadre-core';
import { fromString as uint8ArrayFromString } from 'uint8arrays';
import { FakeWriteBatch, lockingFakeRNLevelDB } from '../../../../test-harness/fake-rn-leveldb.js';
import { SecureStoreKeyStore, secureStoreKeySegment } from '../../src/key-store.js';
import { anchorSlotKey } from '../../src/node-local.js';
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
		leveldb: { openFn: leveldb.openFn, WriteBatch: FakeWriteBatch, destroy: leveldb.destroy },
		names: {
			storagePrefix: `spec${sequence}-`,
			nodeLocalDb: `spec${sequence}-node-local`,
			nodeLocalKvPrefix: `spec${sequence}:node-local:`,
		},
		dataVersion: 'spec-data-1',
		configure: (config) => ({ ...config, requireSignedSchemas: false }),
		...overrides,
	};
	return { platform, leveldb, secureStore, partyId: `phone-node-spec-${sequence}` };
}

function options(partyId: string, relayAddrs: string[] = []) {
	return { partyId, bootstrapAddrs: [], relayAddrs };
}

/**
 * A well-formed invitation to another party, signed by a key nobody holds, that expired a
 * minute ago: a waiting redemption refuses it by this device's clock before dialing anyone.
 */
function expiredInvitation(partyId: string): CadreInvitation {
	const ownerKey = ed25519PublicKeyFromPrivate(randomBytes(32).toString('base64url'));
	const invitePrivateKey = randomBytes(32).toString('base64url');
	return {
		v: 1,
		partyId,
		invitePrivateKey,
		invite: {
			key: ed25519PublicKeyFromPrivate(invitePrivateKey),
			peerId: null,
			expiresAt: new Date(Date.now() - 60_000).toISOString(),
			totalUses: 1,
			stampId: 'phone-node-spec-invite',
			issuerKey: ownerKey,
			issuerSig: 'never-checked-by-the-device',
		},
		ownerKeys: [ownerKey],
		members: [],
	};
}

/**
 * A well-formed owner grant for another party, signed by a key nobody holds, that expired a
 * minute ago: refused by this device's clock before dialing anyone, as the invitation is. The
 * credential a join that moves strands needs, since a machine invitation grants no ownership.
 */
function expiredOwnerGrant(partyId: string): OwnerGrantBundle {
	const ownerKey = ed25519PublicKeyFromPrivate(randomBytes(32).toString('base64url'));
	const grantPrivateKey = randomBytes(32).toString('base64url');
	return {
		v: 1,
		partyId,
		grantPrivateKey,
		grant: {
			key: ed25519PublicKeyFromPrivate(grantPrivateKey),
			label: null,
			expiresAt: new Date(Date.now() - 60_000).toISOString(),
			totalUses: 1,
			stampId: 'phone-node-spec-grant',
			issuerKey: ownerKey,
			issuerSig: 'never-checked-by-the-device',
		},
		ownerKeys: [ownerKey],
		members: [],
	};
}

/** The secure-store key a join keeps the strands of `partyId`, the party it leaves, under: a persistence contract. */
function moveRecordKey(partyId: string): string {
	return 'sereus.ks.' + secureStoreKeySegment(`cadre/strand-move/${secureStoreKeySegment(partyId)}`);
}

/** Whether `party`'s control database holds any entry. Opened and closed again, so it must not be open. */
function controlDatabaseHoldsData(platform: PhoneNodePlatform, leveldb: ReturnType<typeof lockingFakeRNLevelDB>, party: string): boolean {
	const db = leveldb.openFn(`${platform.names!.storagePrefix}${controlStorageScope(party)}`, true, false);
	try {
		return db.newIterator().seekToFirst().valid();
	} finally {
		db.close();
	}
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

	it('keeps its identity and its owner key across a stop and a start: both live in the secure store', async () => {
		const { platform, partyId } = device();
		const phone = phoneNode(platform);

		await phone.start(options(partyId));
		const before = { peerId: phone.node?.peerId?.toString(), ownerKey: phone.ownerPublicKey() };
		await phone.stop();
		await phone.start(options(partyId));

		expect({ peerId: phone.node?.peerId?.toString(), ownerKey: phone.ownerPublicKey() }).toEqual(before);
	}, LIFECYCLE_MS * 2);

	it('reports the identity\'s peer id before any start, and the first start uses it', async () => {
		const { platform, partyId } = device();
		const phone = phoneNode(platform);

		const peerId = await phone.identityPeerId();
		await phone.start(options(partyId));

		expect(phone.node?.peerId?.toString()).toBe(peerId);
	}, LIFECYCLE_MS);

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

	it('runs a start called during a stop after it, on databases of its own', async () => {
		// A foreground return or push wake can call start while a stop is tearing down. It
		// must neither be handed the node being stopped nor reuse handles the stop closes.
		const { platform, leveldb, partyId } = device();
		const phone = phoneNode(platform);
		const first = await phone.start(options(partyId));

		const stopping = phone.stop();
		const starting = phone.start(options(partyId));
		await stopping;
		const second = await starting;

		expect(second).not.toBe(first);
		expect(phone.status.state).toBe('running');
		expect(leveldb.openNames().length).toBeGreaterThan(1);
		expect(await phone.loadSavedStart()).toMatchObject({ autoStart: true });
	}, LIFECYCLE_MS * 2);

	it('answers loadSavedStart during a stop with what the stop saves', async () => {
		// The lifecycle runner's cold start reads the saved start when it finds no node, which
		// is also what it finds mid-stop: it must read `autoStart: false`, not the value being replaced.
		const { platform, partyId } = device();
		const phone = phoneNode(platform);
		await phone.start(options(partyId));

		const stopping = phone.stop();
		const saved = await phone.loadSavedStart();
		await stopping;

		expect(saved).toMatchObject({ autoStart: false });
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

describe('createPhoneNode — its owner key', () => {
	/** The phone's owner slot, emptied as a lost Keychain or Keystore entry would be. */
	async function loseOwnerSlot(secureStore: FakeSecureStore): Promise<void> {
		await new SecureStoreKeyStore(secureStore).delete(DEFAULT_OWNER_KEY_ID);
	}

	it('founds its party with an owner key of its own, under its label, apart from the identity', async () => {
		const { platform, partyId } = device();
		const phone = phoneNode(platform);

		await phone.start({ ...options(partyId), ownerKeyLabel: 'Ann\'s phone' });

		const ownerKey = phone.ownerPublicKey();
		expect(ownerKey).not.toBe(ed25519PublicKeyB64FromPeerId(await phone.identityPeerId()));
		expect(await phone.listOwnerKeys()).toEqual([{ key: ownerKey, label: 'Ann\'s phone', vouchedBy: null, heldHere: true, trusted: true }]);
	}, LIFECYCLE_MS);

	it('is a member, founding nothing, when its owner slot was lost, and an owner again once it imports its backup', async () => {
		const { platform, secureStore, partyId } = device();
		const phone = phoneNode(platform);
		await phone.start(options(partyId));
		const backup = await phone.exportOwnerKey();
		const ownerKey = phone.ownerPublicKey();
		expect(backup.publicKey).toBe(ownerKey);
		await phone.stop();
		await loseOwnerSlot(secureStore);

		const node = await phone.start(options(partyId));

		expect(phone.status).toMatchObject({ state: 'running', owner: 'member' });
		expect(phone.ownerPublicKey()).toBeNull();
		expect(await new SecureStoreKeyStore(secureStore).get(DEFAULT_OWNER_KEY_ID)).toBeUndefined();
		expect((await phone.listOwnerKeys()).map((row) => row.key)).toEqual([ownerKey]);
		expect(await phone.importOwnerKey(backup.exportText)).toEqual({ publicKey: ownerKey, wired: true });
		expect(phone.status).toMatchObject({ state: 'running', owner: 'enrolled' });
		expect(phone.node).toBe(node);
	}, LIFECYCLE_MS * 2);

	it('wires the owner slot\'s key on a party it joined', async () => {
		// The slot holds a backup the user imported, not the key that founded the party: a joined
		// start wires whichever key the slot holds, when the party lists it.
		const { platform, secureStore, partyId } = device();
		const phone = phoneNode(platform);
		await phone.start(options(partyId));
		const backup = await phone.addBackupOwnerKey({ label: 'backup' });
		await phone.stop();
		await loseOwnerSlot(secureStore);
		expect(await phone.importOwnerKey(backup.exportText)).toEqual({ publicKey: backup.publicKey, wired: false });

		await phone.start({ ...options(partyId), origin: 'joined' });

		expect(phone.status).toMatchObject({ state: 'running', owner: 'enrolled' });
		expect(phone.ownerPublicKey()).toBe(backup.publicKey);
	}, LIFECYCLE_MS * 2);

	it('is an owner again with a fresh key once it redeems a backup grant, and makes no key for another cadre\'s', async () => {
		// A grant names the issuer's address, so the phone listens on one.
		const { platform, secureStore, partyId } = device({ listenAddrs: () => ['/ip4/127.0.0.1/tcp/0/ws'] });
		const phone = phoneNode(platform);
		const founded = await phone.start(options(partyId));
		// The machine row the member's own-store redemption is judged by; otherwise written a second after start.
		await founded.registerSelf();
		const backup = await phone.createOwnerGrant({ label: 'Paper', expiresInMs: null });
		await phone.stop();
		await loseOwnerSlot(secureStore);
		await phone.start(options(partyId));
		expect(phone.status).toMatchObject({ state: 'running', owner: 'member' });

		await expect(phone.redeemOwnerGrant(encodeOwnerGrant(expiredOwnerGrant('another-party')))).rejects.toMatchObject({ code: 'party-mismatch' });
		expect(await new SecureStoreKeyStore(secureStore).get(DEFAULT_OWNER_KEY_ID), 'no key made for another cadre\'s grant').toBeUndefined();

		const redeemed = await phone.redeemOwnerGrant(backup.encoded);

		expect(redeemed).toMatchObject({ alreadyOwner: false, wired: true });
		expect(phone.status).toMatchObject({ state: 'running', owner: 'enrolled' });
		expect(phone.ownerPublicKey()).toBe(redeemed.ownerKey);
		expect((await phone.listOwnerKeys()).find((row) => row.key === redeemed.ownerKey)?.label).toBe('Paper');
	}, LIFECYCLE_MS * 2);
});

describe('createPhoneNode — joining another party', () => {
	it('never seats itself as a founder of a party it joined: no owner row, and reported as a member', async () => {
		// Owner genesis on a joined party whose control store has not arrived would insert
		// this app's key as a second founding owner.
		const { platform, partyId } = device();
		const phone = phoneNode(platform);

		const node = await phone.start({ ...options(partyId), origin: 'joined' });

		expect(await node.getControlDatabase()?.hasOwnerKey()).toBe(false);
		expect(phone.status).toMatchObject({ state: 'running', owner: 'member' });
		expect(phone.ownerPublicKey()).toBeNull();
	}, LIFECYCLE_MS);

	it('goes back to the party it left, its options and saved start unchanged, when the join fails', async () => {
		const { platform, partyId } = device();
		const phone = phoneNode(platform);
		const left = await phone.start(options(partyId));
		const savedBefore = await phone.loadSavedStart();

		await expect(phone.joinCadre(expiredInvitation(`${partyId}-joined`)))
			.rejects.toMatchObject({ name: 'CadreInviteRejectedError', code: 'invite-spent' });

		expect(phone.status).toMatchObject({ state: 'running', owner: 'enrolled' });
		expect(phone.node).not.toBe(left);
		expect(phone.options).toEqual(savedBefore?.options);
		expect(await phone.loadSavedStart()).toEqual(savedBefore);
	}, LIFECYCLE_MS * 3);

	it('refuses, before anything stops, a member\'s join that would leave its strands behind', async () => {
		const { platform, secureStore, partyId } = device();
		const phone = phoneNode(platform);
		const left = await phone.start(options(partyId));
		await left.foundStrand({ strandId: `${partyId}-strand`, type: 'o', sAppConfig: NOTES_SAPP });

		await expect(phone.joinCadre(expiredInvitation(`${partyId}-joined`)))
			.rejects.toMatchObject({ name: 'StrandsNeedOwnerJoinError', strandCount: 1 });

		expect(phone.node).toBe(left);
		expect(left.isRunning).toBe(true);
		expect(secureStore.setOptionsByKey.has(moveRecordKey(partyId))).toBe(false);
	}, LIFECYCLE_MS);

	it('discards the strands it recorded for the move when the join fails', async () => {
		// With strands to move, the join needs an owner grant; it seats the slot's key, which a
		// founded party already holds, so a failed join leaves the slot as it was.
		const { platform, secureStore, partyId } = device();
		const phone = phoneNode(platform);
		const left = await phone.start(options(partyId));
		await left.foundStrand({ strandId: `${partyId}-strand`, type: 'o', sAppConfig: NOTES_SAPP });
		const ownerKey = phone.ownerPublicKey();

		await expect(phone.joinCadre(expiredOwnerGrant(`${partyId}-joined`)))
			.rejects.toMatchObject({ name: 'OwnerGrantRejectedError', code: 'grant-spent' });

		expect(phone.status).toMatchObject({ state: 'running', owner: 'enrolled' });
		expect(phone.ownerPublicKey()).toBe(ownerKey);
		expect(secureStore.setOptionsByKey.has(moveRecordKey(partyId)), 'recorded before the switch').toBe(true);
		expect(secureStore.map.has(moveRecordKey(partyId)), 'discarded by the rollback').toBe(false);
	}, LIFECYCLE_MS * 3);

	it('records the strands of a stopped party for the move too, and stays stopped when the join fails', async () => {
		// With no node running, the strands are read from a node started for the export alone:
		// a join that skipped them would leave a party that looks moved but still holds them.
		const { platform, secureStore, partyId } = device();
		const phone = phoneNode(platform);
		const left = await phone.start(options(partyId));
		await left.foundStrand({ strandId: `${partyId}-strand`, type: 'o', sAppConfig: NOTES_SAPP });
		await phone.stop();

		await expect(phone.joinCadre(expiredOwnerGrant(`${partyId}-joined`)))
			.rejects.toMatchObject({ name: 'OwnerGrantRejectedError', code: 'grant-spent' });

		expect(phone.status).toEqual({ state: 'stopped' });
		expect(secureStore.setOptionsByKey.has(moveRecordKey(partyId)), 'recorded before the switch').toBe(true);
		expect(secureStore.map.has(moveRecordKey(partyId)), 'discarded by the rollback').toBe(false);
	}, LIFECYCLE_MS * 3);

	it('finishes a waiting move once the joined party lists the app\'s own key, asking for the owner row again first', async () => {
		// A joined start settles as a member when its owner row has not arrived within the bound.
		// An owner grant landing after that must be picked up by Retry, not refused as not-owner.
		const { platform, secureStore, partyId: former } = device();
		const phone = phoneNode(platform);
		const strandId = `${former}-strand`;
		const left = await phone.start(options(former));
		await left.foundStrand({ strandId, type: 'o', sAppConfig: NOTES_SAPP });
		const bundle = await exportStrandBundle(left);
		const ownerKey = phone.ownerPublicKey()!;
		await phone.stop();
		const joined = `${former}-joined`;
		// The record a join to `joined` leaves behind, written as the kit writes it: a persistence contract, as `moveRecordKey` is.
		await new SecureStoreKeyStore(secureStore).set(
			`cadre/strand-move/${secureStoreKeySegment(former)}`,
			uint8ArrayFromString(JSON.stringify({ v: 1, targetPartyId: joined, bundle, moved: [], refused: [] }), 'utf8'),
		);
		const node = await phone.start({ ...options(joined), origin: 'joined', formerPartyId: former });
		expect(phone.status).toMatchObject({ state: 'running', owner: 'member' });
		await expect(phone.finishStrandMove()).rejects.toBeInstanceOf(StrandMoveNotOwnerError);

		await node.getControlDatabase()!.ensureOwnerKey(ownerKey, 'phone'); // the owner grant's row, arriving late
		const report = await phone.finishStrandMove();

		expect(report?.moved).toEqual([strandId]);
		expect(phone.status).toMatchObject({ state: 'running', owner: 'enrolled' });
		expect(phone.ownerPublicKey()).toBe(ownerKey);
		expect(await phone.pendingStrandMove()).toBeUndefined();
	}, LIFECYCLE_MS * 3);
});

describe('createPhoneNode — dissolving the party it left', () => {
	it('deletes the left party\'s storage once the running party holds its strands, and runs on without formerPartyId', async () => {
		const { platform, leveldb, secureStore, partyId: former } = device();
		const phone = phoneNode(platform);
		const strandId = `${former}-strand`;
		const left = await phone.start(options(former));
		await left.foundStrand({ strandId, type: 'o', sAppConfig: NOTES_SAPP });
		const bundle = await exportStrandBundle(left);
		await phone.stop();
		const joined = options(`${former}-joined`);
		// Founded rather than joined, so no member of the joined party is needed: the dissolve does not read `origin`.
		await adoptStrandBundle(await phone.start({ ...joined, formerPartyId: former }), bundle);
		expect(secureStore.map.has(anchorSlotKey(former))).toBe(true);

		await phone.dissolveFormerParty();

		expect(phone.status).toMatchObject({ state: 'running', owner: 'enrolled' });
		const saved = await phone.loadSavedStart();
		expect(saved?.options).toEqual(joined);
		expect(secureStore.map.has(anchorSlotKey(former))).toBe(false);
		expect(controlDatabaseHoldsData(platform, leveldb, former)).toBe(false);
		await phone.stop();
		const again = await phone.start(saved!.options);
		expect(await again.getControlDatabase()?.queryStrand(strandId)).toMatchObject({ Id: strandId });
	}, LIFECYCLE_MS * 6);

	it('refuses while the left party holds a strand the running party lacks, and dissolves once it is discarded', async () => {
		const { platform, leveldb, partyId: former } = device();
		const phone = phoneNode(platform);
		const strandId = `${former}-strand`;
		const left = await phone.start(options(former));
		await left.foundStrand({ strandId, type: 'o', sAppConfig: NOTES_SAPP });
		await phone.stop();
		await phone.start({ ...options(`${former}-joined`), formerPartyId: former });

		await expect(phone.dissolveFormerParty()).rejects.toMatchObject({
			name: 'FormerPartyNotEmptyError',
			strandIds: [strandId],
			pendingJoinIds: [],
			otherMachines: [],
		});

		expect(phone.status.state).toBe('running');
		expect(phone.options?.formerPartyId).toBe(former);
		expect(controlDatabaseHoldsData(platform, leveldb, former)).toBe(true);
		await phone.dissolveFormerParty({ discard: [strandId] });
		expect(phone.options?.formerPartyId).toBeUndefined();
		expect(controlDatabaseHoldsData(platform, leveldb, former)).toBe(false);
	}, LIFECYCLE_MS * 6);

	it('finishes a removal that failed partway at the start that follows, which drops formerPartyId', async () => {
		const { platform, secureStore, partyId: former } = device();
		const phone = phoneNode(platform);
		await phone.start(options(former));
		await phone.stop();
		await phone.start({ ...options(`${former}-joined`), formerPartyId: former });
		const deleteItem = secureStore.deleteItemAsync.bind(secureStore);
		const fault = new Error('secure store unavailable');
		let faulted = false;
		vi.spyOn(secureStore, 'deleteItemAsync').mockImplementation(async (key) => {
			if (key === anchorSlotKey(former) && !faulted) {
				faulted = true;
				throw fault;
			}
			return deleteItem(key);
		});

		await expect(phone.dissolveFormerParty()).rejects.toBe(fault);

		expect(phone.status.state).toBe('running');
		expect(phone.options?.formerPartyId).toBeUndefined();
		expect(secureStore.map.has(anchorSlotKey(former))).toBe(false);
		expect((await phone.loadSavedStart())?.options.formerPartyId).toBeUndefined();
	}, LIFECYCLE_MS * 6);
});

describe('createPhoneNode — removed from its party by an owner', () => {
	it('stops, deletes the party\'s storage, and saves the party it left as a start that waits for the user', async () => {
		const { platform, leveldb, secureStore, partyId: former } = device();
		const phone = phoneNode(platform);
		const removedFrom = `${former}-joined`;
		// Founded rather than joined, so genesis writes the rows and anchor this must delete: the removal does not read `origin`.
		const node = await phone.start({ ...options(removedFrom), formerPartyId: former });
		expect(await node.getControlDatabase()?.hasOwnerKey()).toBe(true);
		expect(secureStore.map.has(anchorSlotKey(removedFrom))).toBe(true);
		const removal: CadreRemoval = { partyId: removedFrom, stampId: 'phone-node-spec-stamp', signerKey: null, at: Date.now() };

		// What the node raises on learning its removal; a real one needs a second owner machine to remove it.
		(node as unknown as { emit(event: 'cadre:removed', data: CadreRemoval): void }).emit('cadre:removed', removal);
		const saved = await phone.loadSavedStart(); // answers once the kit has acted on the removal

		expect(phone.status).toEqual({ state: 'removed', partyId: removedFrom, removal, formerPartyId: former });
		expect(node.isRunning).toBe(false);
		expect(saved).toEqual({ options: { ...options(former), origin: 'founded' }, autoStart: false, writtenBy: 'spec-data-1' });
		expect(secureStore.map.has(anchorSlotKey(removedFrom))).toBe(false);
		expect(controlDatabaseHoldsData(platform, leveldb, removedFrom)).toBe(false);
		await phone.start(saved!.options); // the app's "go back to your own cadre"
		expect(phone.status).toMatchObject({ state: 'running', owner: 'enrolled' });
	}, LIFECYCLE_MS * 3);
});

describe('createPhoneNode — storage names', () => {
	it('pins the default names: renaming one orphans every installed phone\'s records', () => {
		expect(DEFAULT_PHONE_NODE_NAMES).toEqual({
			storagePrefix: 'sereus-',
			nodeLocalDb: 'sereus-node-local',
			nodeLocalKvPrefix: 'sereus:node-local:',
			savedStartKey: 'start-options',
			dissolveMarkerKey: 'dissolving-party',
			linkRequestKey: 'link-join-request',
			recommendationsKey: 'recommended-apps',
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
