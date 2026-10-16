import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import type { IRawStorage } from '@optimystic/db-p2p';
import type { Database } from '@quereus/quereus';
import { ControlDatabase } from '../src/control-database.js';
import { CONTROL_SCHEMA, CONTROL_SCHEMA_VERSION, CONTROL_SCHEMA_VERSION_TAG } from '../src/control-schema.js';
import { ControlStoreIncompatibleError } from '../src/control-schema-version.js';
import { controlStorageScope } from '../src/storage-scope.js';
import { createControlNode, freshPartyId } from './control-db-node-helpers.js';

/**
 * A control store restarted under a build whose control schema differs from the one that wrote
 * it: `ControlDatabase.initialize` checks the stored schema version and the pending DDL before
 * applying anything (`control-schema-version.ts`). One case per branch of that check.
 *
 * Each "lifetime" is a fresh libp2p node and `ControlDatabase` over the SAME `MemoryRawStorage`,
 * so only stored blocks cross from one start to the next. The store's schema is chosen by writing
 * a variant of `CONTROL_SCHEMA` to a file and passing it as `schemaPath`; `undefined` is the
 * embedded schema, i.e. this build.
 */

const VERSION_CLAUSE = `with tags ("${CONTROL_SCHEMA_VERSION_TAG}" = ${CONTROL_SCHEMA_VERSION}) `;

/** `text` with the one occurrence of `from` replaced; throws rather than build a fixture that changed nothing. */
function replaceOnce(text: string, from: string, to: string): string {
	const parts = text.split(from);
	if (parts.length !== 2) {
		throw new Error(`fixture anchor ${JSON.stringify(from)} occurs ${parts.length - 1} times in the control schema`);
	}
	return parts.join(to);
}

/** `schema` as a release before schema versions wrote it: no version tag. */
const withoutVersion = (schema: string): string => replaceOnce(schema, VERSION_CLAUSE, '');

/** `schema` with its version tag at `version`. */
const atVersion = (schema: string, version: number): string =>
	replaceOnce(schema, VERSION_CLAUSE, `with tags ("${CONTROL_SCHEMA_VERSION_TAG}" = ${version}) `);

/** `schema` with one more table, `Legacy`, which no release of the control schema declares. */
const withLegacyTable = (schema: string): string => replaceOnce(
	schema,
	'\n}\n\napply schema CadreControl;',
	'\n    table Legacy (Id text primary key);\n}\n\napply schema CadreControl;'
);

let schemaDir: string | undefined;

/** Write `schema` to a file of its own and return the path, for `schemaPath`. */
async function schemaFile(name: string, schema: string): Promise<string> {
	schemaDir ??= await mkdtemp(join(tmpdir(), 'control-store-incompatible-'));
	const path = join(schemaDir, `${name}.qsql`);
	await writeFile(path, schema, 'utf-8');
	return path;
}

afterAll(async () => {
	if (schemaDir !== undefined) {
		await rm(schemaDir, { recursive: true, force: true });
	}
});

/**
 * Start a control database over `storage` under `schemaPath` (the embedded schema when
 * undefined), hand its Quereus database to `read`, and shut everything down. Rejects with
 * whatever `initialize` throws.
 */
async function lifetime<T>(
	storage: IRawStorage,
	partyId: string,
	schemaPath: string | undefined,
	read: (db: Database) => Promise<T> | T
): Promise<T> {
	const node = await createControlNode(partyId, storage);
	const controlDb = new ControlDatabase({ partyId, schemaPath, libp2pNode: node, coordinatedRepo: node.coordinatedRepo });
	try {
		await controlDb.initialize();
		return await read(controlDb.getDatabase());
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

/** The version tag the live `OwnerKey` table carries, undefined when it carries none. */
const ownerKeyVersionTag = (db: Database): unknown =>
	db.schemaManager.getTable('CadreControl', 'OwnerKey')?.tags?.[CONTROL_SCHEMA_VERSION_TAG];

const hasTable = (db: Database, name: string): boolean =>
	db.schemaManager.getTable('CadreControl', name) !== undefined;

describe('a control store written under another control schema', () => {
	it('with a change that is not additive: refused, and nothing is dropped', async () => {
		// The shape a store takes when an older release created it and a newer one added a
		// table since (the added table's version never reaches storage, NOTE in
		// control-schema-version.ts): its version is below this build's, so only the pending
		// `drop table` can refuse it. The constraint edits the version history actually holds
		// take the same branch.
		const partyId = freshPartyId('incompatible-drop');
		const storage = new MemoryRawStorage();
		const storeSchema = await schemaFile('older-with-legacy', withLegacyTable(withoutVersion(CONTROL_SCHEMA)));
		await lifetime(storage, partyId, storeSchema, noRead);

		const refusal = await refusalOf(lifetime(storage, partyId, undefined, noRead));
		expect({ storeVersion: refusal.storeVersion, buildVersion: refusal.buildVersion, storageScope: refusal.storageScope })
			.toEqual({ storeVersion: 0, buildVersion: CONTROL_SCHEMA_VERSION, storageScope: controlStorageScope(partyId) });
		expect(refusal.pendingDdl.length).toBeGreaterThan(0);

		// Without the check the apply drops it: `diff schema` lists `drop table` for a table the
		// declaration lacks, and that step runs on the optimystic module.
		expect(await lifetime(storage, partyId, storeSchema, (db) => hasTable(db, 'Legacy'))).toBe(true);
	});

	it('created by a newer release: refused even when the pending changes only add', async () => {
		// The newer release no longer declares an index this build does, so this build's diff is
		// a `create index` — additive — and only the version refuses it. Applying it would leave
		// the newer release a store it must refuse in turn (`drop index`).
		const partyId = freshPartyId('incompatible-newer');
		const storage = new MemoryRawStorage();
		const newer = await schemaFile('newer-without-index', replaceOnce(
			atVersion(CONTROL_SCHEMA, CONTROL_SCHEMA_VERSION + 1),
			'    index FormationUsageByToken on FormationUsage (Token);\n',
			''
		));
		await lifetime(storage, partyId, newer, noRead);

		const refusal = await refusalOf(lifetime(storage, partyId, undefined, noRead));
		expect({ storeVersion: refusal.storeVersion, buildVersion: refusal.buildVersion })
			.toEqual({ storeVersion: CONTROL_SCHEMA_VERSION + 1, buildVersion: CONTROL_SCHEMA_VERSION });

		// The newer release still starts on its store: had this build created the index, the newer
		// release's own diff would now be a `drop index`.
		expect(await lifetime(storage, partyId, newer, noRead)).toBeUndefined();
	});

	it('from before versions were recorded, lacking a table the build adds: starts and adds it', async () => {
		const partyId = freshPartyId('compatible-pre-version');
		const storage = new MemoryRawStorage();
		await lifetime(storage, partyId, await schemaFile('pre-version', withoutVersion(CONTROL_SCHEMA)), noRead);

		const newer = await schemaFile('newer-with-legacy', withLegacyTable(atVersion(CONTROL_SCHEMA, CONTROL_SCHEMA_VERSION + 1)));
		const started = await lifetime(storage, partyId, newer, (db) => ({ legacy: hasTable(db, 'Legacy'), version: ownerKeyVersionTag(db) }));
		expect(started).toEqual({ legacy: true, version: CONTROL_SCHEMA_VERSION + 1 });
	});
});
