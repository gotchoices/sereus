import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import type { IRawStorage } from '@optimystic/db-p2p';
import type { Database } from '@quereus/quereus';
import { ControlDatabase } from '../src/control-database.js';
import { CONTROL_SCHEMA, CONTROL_SCHEMA_BASELINE_VERSION, CONTROL_SCHEMA_VERSION, CONTROL_SCHEMA_VERSION_TAG } from '../src/control-schema.js';
import { ControlStoreIncompatibleError, pendingControlSchemaChanges } from '../src/control-schema-version.js';
import { controlStorageScope } from '../src/storage-scope.js';
import {
	atVersion,
	controlSchemaReleases,
	replaceOnce,
	withLegacyTable,
	withoutVersion,
	writeSchemaFile,
	type ControlSchemaReleases
} from '../../../test-harness/control-schema-releases.js';
import { freshKeyPair, peerIdOf, signAs } from './control-constraint-helpers.js';
import { createControlNode, freshPartyId } from './control-db-node-helpers.js';

/**
 * A control store restarted under a build whose control schema differs from the one that wrote
 * it. `ControlDatabase.initialize` reads the stored schema version and the pending DDL before
 * applying anything (`control-schema-version.ts`): a store from an older migratable release is
 * migrated by the apply and keeps its rows, and every other store is refused with a reason.
 * One case for the migration, one per reason.
 *
 * Each "lifetime" is a fresh libp2p node and `ControlDatabase` over the SAME `MemoryRawStorage`,
 * so only stored blocks cross from one start to the next. The store's schema is chosen by
 * `schemaPath`: a file holding a variant of a schema, or `undefined` for the embedded schema,
 * i.e. this build. The migration case runs between the two "releases"
 * `test-harness/control-schema-releases.ts` builds from the baseline fixture; the refusal cases
 * vary the embedded schema, so each stays relative to this build when the version moves.
 */

let schemaDir: string;
let releases: ControlSchemaReleases;

/** The embedded schema with its version tag at `version`. */
const buildAtVersion = (version: number): string => atVersion(CONTROL_SCHEMA, CONTROL_SCHEMA_VERSION, version);

beforeAll(async () => {
	schemaDir = await mkdtemp(join(tmpdir(), 'control-store-migration-'));
	releases = await controlSchemaReleases(CONTROL_SCHEMA_BASELINE_VERSION);
});

afterAll(async () => {
	await rm(schemaDir, { recursive: true, force: true });
});

/**
 * Start a control database over `storage` under `schemaPath` (the embedded schema when
 * undefined), hand it to `read`, and shut everything down. Rejects with whatever `initialize`
 * throws.
 */
async function lifetime<T>(
	storage: IRawStorage,
	partyId: string,
	schemaPath: string | undefined,
	read: (controlDb: ControlDatabase) => Promise<T> | T
): Promise<T> {
	const node = await createControlNode(partyId, storage);
	const controlDb = new ControlDatabase({ partyId, schemaPath, libp2pNode: node, coordinatedRepo: node.coordinatedRepo });
	try {
		await controlDb.initialize();
		return await read(controlDb);
	} finally {
		// Nested, not sequential: a `close()` that throws must not strand the libp2p node.
		try {
			await controlDb.close();
		} finally {
			await node.stop();
		}
	}
}

/** The start's refusal, which the case requires to be a {@link ControlStoreIncompatibleError}. */
async function refusalOf(start: Promise<unknown>): Promise<ControlStoreIncompatibleError> {
	const failure = await start.then(() => null, (err: unknown) => err);
	expect(failure).toBeInstanceOf(ControlStoreIncompatibleError);
	return failure as ControlStoreIncompatibleError;
}

const noRead = (): void => undefined;

const RECREATE_ADVICE = 'recreate the control store';

/** The version tag the live `OwnerKey` table carries, undefined when it carries none. */
const ownerKeyVersionTag = (db: Database): unknown =>
	db.schemaManager.getTable('CadreControl', 'OwnerKey')?.tags?.[CONTROL_SCHEMA_VERSION_TAG];

const hasTable = (db: Database, name: string): boolean =>
	db.schemaManager.getTable('CadreControl', name) !== undefined;

describe('a control store written under another control schema version', () => {
	it('from the previous version: migrates on start and keeps its rows', async () => {
		const partyId = freshPartyId('migrates');
		const storage = new MemoryRawStorage();
		const previous = await writeSchemaFile(schemaDir, 'previous', releases.previous);
		const next = await writeSchemaFile(schemaDir, 'next', releases.next);
		const owner = freshKeyPair();
		const sign = (message: Uint8Array): string => signAs(owner, message);
		const device = freshKeyPair();
		const devicePeerId = peerIdOf(device);
		const validationKey = freshKeyPair().publicKey;

		// Rows written under the previous release: an owner key with a label, a peer row on the
		// table whose column the next release drops, and a validation key on the table it widens.
		await lifetime(storage, partyId, previous, async (controlDb) => {
			expect(await controlDb.ensureOwnerKey(owner.publicKey, 'phone')).toBe(true);
			const peerRow = { peerId: devicePeerId, publicKey: device.publicKey, multiaddr: '', updatedAt: Date.now(), sig: null, profile: null };
			expect(await controlDb.insertCadrePeer(peerRow, owner.publicKey, sign)).toBe(true);
			await controlDb.insertValidationKey(validationKey, owner.publicKey, sign);
		});

		// The next release starts, migrates the store, and reads every row back.
		const migrated = await lifetime(storage, partyId, next, async (controlDb) => ({
			ownerKeys: (await controlDb.queryOwnerKeyRows()).map(({ key, label, stampId }) => ({ key, label, stamped: stampId !== null })),
			peers: (await controlDb.queryCadrePeers()).map((peer) => peer.peerId),
			validationKeys: await controlDb.queryValidationKeys(),
			annotation: hasTable(controlDb.getDatabase(), 'Annotation'),
			pending: await pendingControlSchemaChanges(controlDb.getDatabase()),
			version: ownerKeyVersionTag(controlDb.getDatabase())
		}));
		expect(migrated).toEqual({
			ownerKeys: [{ key: owner.publicKey, label: 'phone', stamped: true }],
			peers: [devicePeerId],
			validationKeys: [validationKey],
			annotation: true,
			pending: [],
			version: releases.nextVersion
		});

		// A second start on the same release finds nothing left to apply.
		expect(await lifetime(storage, partyId, next, (controlDb) => pendingControlSchemaChanges(controlDb.getDatabase()))).toEqual([]);

		// The version was SAVED, not just held in memory: the previous release now reads it from
		// the hydrated catalog before applying anything, and is refused on it. (After an apply the
		// tag reads the build's version either way, so only a pre-apply read can tell.)
		const refusal = await refusalOf(lifetime(storage, partyId, previous, noRead));
		expect({ reason: refusal.reason, storeVersion: refusal.storeVersion, buildVersion: refusal.buildVersion })
			.toEqual({ reason: 'newer-release', storeVersion: releases.nextVersion, buildVersion: releases.baselineVersion });
	});

	it('migrated by a newer release: refused as newer-release, without recreate advice, even when the pending changes only add', async () => {
		// The newer release no longer declares an index this build does, so this build's diff is
		// a `create index` — additive — and only the version refuses it. Applying it would leave
		// the newer release a store it must refuse in turn (`drop index`).
		const partyId = freshPartyId('newer-release');
		const storage = new MemoryRawStorage();
		const newer = await writeSchemaFile(schemaDir, 'newer-without-index', replaceOnce(
			buildAtVersion(CONTROL_SCHEMA_VERSION + 1),
			'    index FormationUsageByToken on FormationUsage (Token);\n',
			''
		));
		await lifetime(storage, partyId, newer, noRead);

		const refusal = await refusalOf(lifetime(storage, partyId, undefined, noRead));
		expect({ reason: refusal.reason, storeVersion: refusal.storeVersion, buildVersion: refusal.buildVersion })
			.toEqual({ reason: 'newer-release', storeVersion: CONTROL_SCHEMA_VERSION + 1, buildVersion: CONTROL_SCHEMA_VERSION });
		// The other machine's rows are intact; the user updates this machine instead.
		expect(refusal.message).not.toContain(RECREATE_ADVICE);

		// The newer release still starts on its store: had this build created the index, the newer
		// release's own diff would now be a `drop index`.
		expect(await lifetime(storage, partyId, newer, noRead)).toBeUndefined();
	});

	it('from before migrations: refused as before-migrations even when the pending changes only add', async () => {
		// A store that records no version (1.16.0 and earlier) reads as 0. The build adds a
		// table, so the diff is additive, and only the baseline refuses it.
		const partyId = freshPartyId('before-migrations');
		const storage = new MemoryRawStorage();
		const preVersion = await writeSchemaFile(schemaDir, 'pre-version', withoutVersion(CONTROL_SCHEMA, CONTROL_SCHEMA_VERSION));
		await lifetime(storage, partyId, preVersion, noRead);

		const nextWithLegacy = await writeSchemaFile(schemaDir, 'next-with-legacy', withLegacyTable(buildAtVersion(CONTROL_SCHEMA_VERSION + 1)));
		const refuse = (): Promise<ControlStoreIncompatibleError> => refusalOf(lifetime(storage, partyId, nextWithLegacy, noRead));
		const refusal = await refuse();
		expect({ reason: refusal.reason, storeVersion: refusal.storeVersion, buildVersion: refusal.buildVersion, storageScope: refusal.storageScope })
			.toEqual({ reason: 'before-migrations', storeVersion: 0, buildVersion: CONTROL_SCHEMA_VERSION + 1, storageScope: controlStorageScope(partyId) });
		expect(refusal.message).toContain(RECREATE_ADVICE);
		expect(refusal.pendingDdl.join('\n')).toMatch(/create table\b.*\bLegacy\b/i);

		// Nothing was applied: a second start reads the same store, still at version 0 with the
		// table still pending. (Its own release cannot stand in for that check any more: on this
		// build a version-0 schema is refused the same way.)
		const again = await refuse();
		expect({ storeVersion: again.storeVersion, pendingDdl: again.pendingDdl }).toEqual({ storeVersion: 0, pendingDdl: refusal.pendingDdl });
	});

	it('with a change that rewrites or discards rows: refused as not-migratable, and nothing is dropped', async () => {
		// A store at the baseline version holding a table this build does not declare: the pending
		// `drop table` is the only thing against it. Reachable only from a development or hand-made
		// store, since the edit-time check keeps every shipped version migratable.
		const partyId = freshPartyId('not-migratable');
		const storage = new MemoryRawStorage();
		const storeSchema = await writeSchemaFile(schemaDir, 'build-with-legacy', withLegacyTable(CONTROL_SCHEMA));
		await lifetime(storage, partyId, storeSchema, noRead);

		const refusal = await refusalOf(lifetime(storage, partyId, undefined, noRead));
		expect({ reason: refusal.reason, storeVersion: refusal.storeVersion, buildVersion: refusal.buildVersion })
			.toEqual({ reason: 'not-migratable', storeVersion: CONTROL_SCHEMA_VERSION, buildVersion: CONTROL_SCHEMA_VERSION });
		expect(refusal.pendingDdl.length).toBeGreaterThan(0);
		expect(refusal.message).toContain(RECREATE_ADVICE);

		// Without the check the apply drops it: `diff schema` lists `drop table` for a table the
		// declaration lacks, and that step runs on the optimystic module.
		expect(await lifetime(storage, partyId, storeSchema, (controlDb) => hasTable(controlDb.getDatabase(), 'Legacy'))).toBe(true);
	});
});
