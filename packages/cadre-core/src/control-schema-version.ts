/**
 * control-schema-version.ts — the check `ControlDatabase.loadSchema` runs on a warm control
 * store after declaring the control schema and before applying it.
 *
 * `apply schema CadreControl` runs whatever DDL makes the hydrated catalog equal the declared
 * schema. Against a store written by another release that DDL is either refused by the
 * optimystic module part-way through (`alter table … drop constraint`, `add column`,
 * `drop column`), which fails the start with a message naming whichever step came first, or
 * runs and destroys rows (`drop table`). This module decides from the pending DDL and the
 * stored schema version, before any of it runs, and throws one typed error instead.
 *
 * Where the version lives and the rule for bumping it: `CONTROL_SCHEMA_VERSION` in
 * `control-schema.ts`.
 *
 * NOTE: the stored tag is the version the store's `OwnerKey` table was CREATED under. The
 * optimystic plugin does not persist `alter table … set tags` (Quereus applies a tag change to
 * its catalog without calling the module, and the plugin follows it in memory only), so the
 * `set tags` an additive upgrade runs raises the version for that process alone. The check stays
 * safe regardless, because it lets through only DDL that adds, so an older build's diff against
 * an upgraded store lists the drop and is refused on that ground. If versioned migrations
 * (plan/control-schema-versioned-migrations) need the version a store was upgraded to, they need
 * that persisted upstream or recorded elsewhere.
 */

import { Parser, type Database, type SqlValue } from '@quereus/quereus';
import type { Statement } from '@quereus/quereus/parser';
import { CONTROL_SCHEMA_NAME, CONTROL_SCHEMA_VERSION_TAG } from './control-schema.js';
import { controlStorageScope } from './storage-scope.js';

/** The control table whose tags carry {@link CONTROL_SCHEMA_VERSION_TAG}. */
const VERSION_TABLE = 'OwnerKey';

/** A warm control store this build cannot apply its control schema to without destroying data. */
export class ControlStoreIncompatibleError extends Error {
	readonly partyId: string;
	/** The version the store records: the one it was created under; 0 = before versions were recorded. */
	readonly storeVersion: number;
	/** The version this build declares. */
	readonly buildVersion: number;
	/** The DDL the apply would have run, from `diff schema`; for diagnostics, not for parsing. */
	readonly pendingDdl: readonly string[];
	/** `controlStorageScope(partyId)`: the storage the embedder deletes to recreate (docs/architecture.md). */
	readonly storageScope: string;

	constructor(partyId: string, storeVersion: number, buildVersion: number, pendingDdl: readonly string[]) {
		const storageScope = controlStorageScope(partyId);
		super(
			`The control store for party ${JSON.stringify(partyId)} ${provenance(storeVersion, buildVersion)} ` +
			`(it records control schema version ${storeVersion}; this build declares ${buildVersion}), and this build ` +
			'cannot apply its control schema to it without losing data. Run a release whose control schema ' +
			`matches the store, or recreate the control store (storage scope ${storageScope}) as ` +
			'docs/architecture.md describes.'
		);
		this.name = 'ControlStoreIncompatibleError';
		this.partyId = partyId;
		this.storeVersion = storeVersion;
		this.buildVersion = buildVersion;
		this.pendingDdl = pendingDdl;
		this.storageScope = storageScope;
	}
}

/**
 * Which release created the store, relative to this build, for the error message. Created, not
 * last written: the stored version does not move on an additive upgrade (module NOTE).
 */
function provenance(storeVersion: number, buildVersion: number): string {
	if (storeVersion > buildVersion) {
		return 'was created by a newer release';
	}
	return storeVersion < buildVersion
		? 'was created by an older release'
		: 'was created under the same control schema version';
}

/**
 * Throw {@link ControlStoreIncompatibleError} when applying the declared control schema to the
 * hydrated store would destroy data; return having run nothing otherwise. Needs
 * `declare schema CadreControl` to have run, and runs only `diff schema`, which executes no DDL.
 *
 * A cold store (the hydrated catalog lists no control table) passes without a diff: the apply
 * creates everything. A warm store is refused when either
 *  - any pending statement is not additive ({@link isAdditiveStatement}): every other change to
 *    an existing control table is refused by the optimystic module or discards rows; or
 *  - its version is above the build's: a newer release created it, so even a diff that only adds
 *    (the newer release no longer declares something this build does) would put back what that
 *    release removed, and the newer release would then refuse its own store.
 *
 * So a store from an older release still warm-starts when the only change since is a new table
 * or index.
 */
export async function refuseIncompatibleControlStore(db: Database, partyId: string): Promise<void> {
	if (!isWarmControlStore(db)) {
		return;
	}
	const storeVersion = schemaVersionOf(db.schemaManager.getTable(CONTROL_SCHEMA_NAME, VERSION_TABLE)?.tags);
	const buildVersion = declaredSchemaVersion(db);
	const pendingDdl = await pendingSchemaDdl(db);
	if (storeVersion > buildVersion || !pendingDdl.every(isAdditiveDdl)) {
		throw new ControlStoreIncompatibleError(partyId, storeVersion, buildVersion, pendingDdl);
	}
}

/** Whether the hydrated catalog lists at least one control table, i.e. the store was written before. */
function isWarmControlStore(db: Database): boolean {
	const schema = db.schemaManager.getSchema(CONTROL_SCHEMA_NAME);
	return schema !== undefined && !schema.getAllTables().next().done;
}

/** The version the declared control schema carries on its version table; 0 when it carries none. */
function declaredSchemaVersion(db: Database): number {
	const declared = db.declaredSchemaManager.getDeclaredSchema(CONTROL_SCHEMA_NAME);
	const table = declared?.items.find(
		(item) => item.type === 'declaredTable' && item.tableStmt.table.name.toLowerCase() === VERSION_TABLE.toLowerCase()
	);
	return schemaVersionOf(table?.type === 'declaredTable' ? table.tableStmt.tags : undefined);
}

/**
 * The control schema version a table's tags record: 0 when the tag is absent, which is what
 * every store written before versions were recorded holds.
 */
function schemaVersionOf(tags: Readonly<Record<string, SqlValue>> | undefined): number {
	const value = tags?.[CONTROL_SCHEMA_VERSION_TAG];
	if (value === undefined || value === null) {
		return 0;
	}
	const version = typeof value === 'bigint' ? Number(value) : value;
	if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
		throw new Error(`The ${VERSION_TABLE} tag ${CONTROL_SCHEMA_VERSION_TAG} holds ${String(value)}, not a control schema version`);
	}
	return version;
}

/** The DDL `apply schema CadreControl` would run now, one statement per entry. */
async function pendingSchemaDdl(db: Database): Promise<string[]> {
	const ddl: string[] = [];
	for await (const row of db.eval(`diff schema ${CONTROL_SCHEMA_NAME}`)) {
		ddl.push(row.ddl as string);
	}
	return ddl;
}

/** Whether one `diff schema` row only adds to the store, judged on its parsed statements. */
function isAdditiveDdl(ddl: string): boolean {
	return new Parser().parseAll(ddl).every(isAdditiveStatement);
}

/**
 * The statements the optimystic module applies to a warm store without losing a row: a new
 * table, a new index, and a tag change (catalog-only metadata, which is how the version tag
 * moves up).
 */
function isAdditiveStatement(statement: Statement): boolean {
	switch (statement.type) {
		case 'createTable':
		case 'createIndex':
			return true;
		case 'alterTable':
			return statement.action.type === 'setTags';
		default:
			return false;
	}
}
