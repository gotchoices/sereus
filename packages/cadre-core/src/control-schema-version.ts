/**
 * control-schema-version.ts — the check `ControlDatabase.loadSchema` runs on a warm control
 * store after declaring the control schema and before applying it.
 *
 * `apply schema CadreControl` runs whatever DDL makes the hydrated catalog equal the declared
 * schema, and that apply is how a store written under an older control schema version is
 * migrated in place: between consecutive versions the difference is limited to statements the
 * optimystic module applies to a table's catalog record without rewriting a row, so running the
 * diff from a store at version K to this build's declaration runs each version's changes from
 * K+1 up to the build's, in order. This module decides, from the stored version and the pending
 * DDL and before any of it runs, whether the apply may go ahead, and throws one typed error
 * naming the reason when it may not.
 *
 * The same change classifier ({@link classifyControlSchemaChange}) is what
 * `control-schema-versions.spec.ts` runs over each pair of consecutive control schema versions,
 * so a schema edit that no store could be migrated across fails when it is made. Where the
 * version lives, when it changes and what a new version may change: docs/architecture.md →
 * "Control schema versions and migrations".
 *
 * The stored tag is the version of the last start that applied the schema to the store: the
 * apply's `alter table OwnerKey set tags (…)` persists since Optimystic 1.16.0, so after a
 * migrating start the store records this build's version. A store additively upgraded by a build
 * from before that still reads the version it was created under, which is harmless: the diff is
 * computed from the catalog, not from the number, and the number only has to tell a store that
 * a newer release migrated from one this build can migrate.
 */

import { Parser, type Database, type SchemaManager, type SqlValue, type TableSchema } from '@quereus/quereus';
import type { AlterTableStmt, ColumnDef, Statement } from '@quereus/quereus/parser';
import { CONTROL_SCHEMA_BASELINE_VERSION, CONTROL_SCHEMA_NAME, CONTROL_SCHEMA_VERSION_TAG } from './control-schema.js';
import { controlStorageScope } from './storage-scope.js';

/** The control table whose tags carry {@link CONTROL_SCHEMA_VERSION_TAG}. */
const VERSION_TABLE = 'OwnerKey';

/**
 * Why a warm control store is refused, in the order the check decides them:
 *  - `newer-release`: the store records a version above this build's, so a newer release has
 *    migrated it (this machine before a downgrade, or another machine sharing its catalog
 *    lineage); this machine is the one to update.
 *  - `before-migrations`: the store records a version below {@link CONTROL_SCHEMA_BASELINE_VERSION}
 *    (written by 1.16.0 or earlier); it cannot be migrated and must be recreated.
 *  - `not-migratable`: a pending statement would rewrite or discard rows. Reachable only from a
 *    development or hand-made store, since the edit-time check refuses such a version.
 */
export type ControlStoreIncompatibility = 'newer-release' | 'before-migrations' | 'not-migratable';

/** A warm control store this build cannot apply its control schema to. */
export class ControlStoreIncompatibleError extends Error {
	readonly reason: ControlStoreIncompatibility;
	readonly partyId: string;
	/** The version the store records: the one its last migrating start declared; 0 = before versions were recorded. */
	readonly storeVersion: number;
	/** The version this build declares. */
	readonly buildVersion: number;
	/** The DDL the apply would have run, from `diff schema`; for diagnostics, not for parsing. */
	readonly pendingDdl: readonly string[];
	/** `controlStorageScope(partyId)`: the storage the embedder deletes to recreate (docs/architecture.md). */
	readonly storageScope: string;

	constructor(
		reason: ControlStoreIncompatibility,
		partyId: string,
		storeVersion: number,
		buildVersion: number,
		pendingDdl: readonly string[]
	) {
		const storageScope = controlStorageScope(partyId);
		super(refusalMessage(reason, partyId, storeVersion, buildVersion, storageScope));
		this.name = 'ControlStoreIncompatibleError';
		this.reason = reason;
		this.partyId = partyId;
		this.storeVersion = storeVersion;
		this.buildVersion = buildVersion;
		this.pendingDdl = pendingDdl;
		this.storageScope = storageScope;
	}
}

/**
 * The message for each {@link ControlStoreIncompatibility}. Only the two recreate cases advise
 * recreating: a store a newer release migrated holds rows written since, and recreating it
 * would throw them away.
 */
function refusalMessage(
	reason: ControlStoreIncompatibility,
	partyId: string,
	storeVersion: number,
	buildVersion: number,
	storageScope: string
): string {
	const store = `The control store for party ${JSON.stringify(partyId)}`;
	const versions = `it records control schema version ${storeVersion}; this build declares ${buildVersion}`;
	const recreate = 'Run a release whose control schema matches the store, or recreate the control store ' +
		`(storage scope ${storageScope}) as docs/architecture.md describes.`;
	switch (reason) {
		case 'newer-release':
			return `${store} was migrated by a newer release (${versions}). Update this app or node to that ` +
				'release or a later one; the store and its rows are intact.';
		case 'before-migrations':
			return `${store} was written before control schema migrations (${versions}; migrations start at ` +
				`version ${CONTROL_SCHEMA_BASELINE_VERSION}, and docs/architecture.md says why earlier stores are not ` +
				`migrated), so this build cannot upgrade it in place. ${recreate}`;
		case 'not-migratable':
			return `${store} cannot be migrated to this build's control schema (${versions}): applying it would ` +
				`rewrite or discard stored rows. ${recreate}`;
	}
}

/**
 * Throw {@link ControlStoreIncompatibleError} when the declared control schema must not be applied
 * to the hydrated store; return having run nothing otherwise, and the apply then migrates the
 * store. Needs `declare schema CadreControl` to have run, and runs only `diff schema`, which
 * executes no DDL.
 *
 * A cold store (the hydrated catalog lists no control table) passes without a diff: the apply
 * creates everything. A warm store is refused for the first of these that holds
 * ({@link ControlStoreIncompatibility}):
 *  - its version is above the build's: even a diff that only adds (the newer release no longer
 *    declares something this build does) would put back what that release removed, and the newer
 *    release would then refuse its own store;
 *  - its version is below the baseline, whatever the diff: a store written by 1.16.0 or earlier,
 *    which the baseline paragraph of docs/architecture.md explains cannot be migrated;
 *  - any pending statement is `unmigratable` ({@link classifyControlSchemaChange}).
 *
 * Every `additive` and `catalog-only` change passes, so a store from an older migratable
 * release warm-starts and the apply brings it to this build's version. A store that is both
 * older than the baseline and not migratable reports `before-migrations`, whose message gives the
 * recreate advice and points at the explanation.
 */
export async function refuseIncompatibleControlStore(db: Database, partyId: string): Promise<void> {
	if (!isWarmControlStore(db)) {
		return;
	}
	const storeVersion = schemaVersionOf(db.schemaManager.getTable(CONTROL_SCHEMA_NAME, VERSION_TABLE)?.tags);
	const buildVersion = declaredSchemaVersion(db);
	const pending = await pendingControlSchemaChanges(db);
	const reason = incompatibilityOf(storeVersion, buildVersion, pending);
	if (reason !== undefined) {
		throw new ControlStoreIncompatibleError(reason, partyId, storeVersion, buildVersion, pending.map((change) => change.ddl));
	}
}

/** The first {@link ControlStoreIncompatibility} that holds for a warm store, or undefined when the apply may migrate it. */
function incompatibilityOf(
	storeVersion: number,
	buildVersion: number,
	pending: readonly PendingControlSchemaChange[]
): ControlStoreIncompatibility | undefined {
	if (storeVersion > buildVersion) {
		return 'newer-release';
	}
	if (storeVersion < CONTROL_SCHEMA_BASELINE_VERSION) {
		return 'before-migrations';
	}
	return pending.some((change) => change.kind === 'unmigratable') ? 'not-migratable' : undefined;
}

/** Whether the hydrated catalog lists at least one control table, i.e. the store was written before. */
function isWarmControlStore(db: Database): boolean {
	const schema = db.schemaManager.getSchema(CONTROL_SCHEMA_NAME);
	return schema !== undefined && !schema.getAllTables().next().done;
}

/** The version the declared control schema carries on its version table; 0 when it carries none. */
export function declaredSchemaVersion(db: Database): number {
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

/**
 * How applying one `diff schema` statement to a warm store treats its rows, from most to least
 * migratable (docs/architecture.md → "Control schema versions and migrations"):
 *  - `additive`: a new table, a new index, or a table tag change, which the optimystic module
 *    applies without touching a row;
 *  - `catalog-only`: a change the optimystic module applies to the table's catalog record without
 *    rewriting a row (since Optimystic 1.16.0);
 *  - `unmigratable`: everything else, which rewrites or discards rows.
 */
export type ControlSchemaChangeKind = 'additive' | 'catalog-only' | 'unmigratable';

const CHANGE_KINDS: readonly ControlSchemaChangeKind[] = ['additive', 'catalog-only', 'unmigratable'];

/** One row of `diff schema CadreControl`, classified. */
export interface PendingControlSchemaChange {
	readonly ddl: string;
	/** The least migratable kind among the row's statements. */
	readonly kind: ControlSchemaChangeKind;
}

/**
 * The DDL `apply schema CadreControl` would run now, one entry per `diff schema` row, each
 * classified against the catalog `db` holds. Needs `declare schema CadreControl` to have run.
 */
export async function pendingControlSchemaChanges(db: Database): Promise<PendingControlSchemaChange[]> {
	const changes: PendingControlSchemaChange[] = [];
	for await (const row of db.eval(`diff schema ${CONTROL_SCHEMA_NAME}`)) {
		const ddl = row.ddl as string;
		const kinds = new Parser().parseAll(ddl).map((statement) => classifyControlSchemaChange(statement, db.schemaManager));
		changes.push({ ddl, kind: leastMigratable(kinds) });
	}
	return changes;
}

/** The least migratable of `kinds`; `additive` when there are none. */
function leastMigratable(kinds: readonly ControlSchemaChangeKind[]): ControlSchemaChangeKind {
	return CHANGE_KINDS[Math.max(0, ...kinds.map((kind) => CHANGE_KINDS.indexOf(kind)))];
}

/**
 * The {@link ControlSchemaChangeKind} of one statement `diff schema` emits. A name the statement
 * drops is resolved against `catalog`, the one the statement would run against: the hydrated
 * store's at runtime.
 */
function classifyControlSchemaChange(statement: Statement, catalog: SchemaManager): ControlSchemaChangeKind {
	switch (statement.type) {
		case 'createTable':
			return 'additive';
		// NOTE: a `unique index` over an existing table fails the apply on a store whose rows
		// already repeat the key, which the spec's empty tables cannot show. If a version adds
		// one to a table that holds rows, prove the stored rows are unique on it.
		case 'createIndex':
			return 'additive';
		case 'drop':
			return statement.objectType === 'index' ? 'catalog-only' : 'unmigratable';
		case 'alterTable':
			return classifyTableAlteration(statement, catalog);
		default:
			return 'unmigratable';
	}
}

function classifyTableAlteration({ table, action }: AlterTableStmt, catalog: SchemaManager): ControlSchemaChangeKind {
	const stored = (): TableSchema | undefined => catalog.getTable(table.schema ?? CONTROL_SCHEMA_NAME, table.name);
	switch (action.type) {
		case 'setTags':
			return 'additive';
		// NOTE: Quereus checks stored rows against an added CHECK, so one that a stored row fails
		// fails the apply on that store; control-schema-versions.spec.ts diffs empty tables and
		// cannot see it. If a version adds a CHECK over existing columns, prove the rows hold it.
		case 'addConstraint':
			return action.constraint.type === 'check' ? 'catalog-only' : 'unmigratable';
		case 'dropConstraint':
			return hasCheckConstraint(stored(), action.name) ? 'catalog-only' : 'unmigratable';
		case 'addColumn':
			return isPlainNullableColumn(action.column) ? 'catalog-only' : 'unmigratable';
		case 'dropColumn':
			return isUnkeyedColumn(stored(), action.name) ? 'catalog-only' : 'unmigratable';
		default:
			return 'unmigratable';
	}
}

function hasCheckConstraint(table: TableSchema | undefined, name: string): boolean {
	return table?.checkConstraints.some((check) => check.name?.toLowerCase() === name.toLowerCase()) ?? false;
}

/**
 * Whether existing rows can read null for the column: declared `null` and nothing else (no
 * default, generated expression or other column constraint). The `null` must be explicit,
 * because Quereus makes a column not null unless it says otherwise.
 */
function isPlainNullableColumn(column: ColumnDef): boolean {
	return column.constraints.length > 0 && column.constraints.every((constraint) => constraint.type === 'null');
}

/**
 * Whether the table has the column and no index, unique constraint or primary key covers it.
 *
 * NOTE: judged against the catalog before the apply, so a column whose covering index the same
 * diff drops (`diff schema` emits the `drop index` first) still counts as covered. Conservative;
 * if a version needs that change, judge the diff as a sequence.
 */
function isUnkeyedColumn(table: TableSchema | undefined, name: string): boolean {
	const column = table?.columnIndexMap.get(name.toLowerCase());
	if (table === undefined || column === undefined) {
		return false;
	}
	return !table.primaryKeyDefinition.some((key) => key.index === column)
		&& !(table.indexes ?? []).some((index) => index.columns.some((indexed) => indexed.index === column))
		&& !(table.uniqueConstraints ?? []).some((unique) => unique.columns.includes(column));
}
