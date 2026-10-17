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
 * The same change classifier ({@link classifyControlSchemaChange}) is what
 * `control-schema-versions.spec.ts` runs over each pair of consecutive control schema versions,
 * so a schema edit that no store could be migrated across fails when it is made. Where the
 * version lives, when it changes and what a new version may change: docs/architecture.md →
 * "Control schema changes and incompatible stores".
 *
 * NOTE: the stored tag is the version the store's `OwnerKey` table was CREATED under. The
 * optimystic plugin does not persist `alter table … set tags` (Quereus applies a tag change to
 * its catalog without calling the module, and the plugin follows it in memory only), so the
 * `set tags` an additive upgrade runs raises the version for that process alone. The check stays
 * safe regardless, because it lets through only DDL that adds, so an older build's diff against
 * an upgraded store lists the drop and is refused on that ground. Migrating a store in place
 * (control-store-migrates-on-start) needs the version a store was upgraded to, so it needs that
 * persisted upstream (optimystic-catalog-only-alter-table).
 */

import { Parser, type Database, type SchemaManager, type SqlValue, type TableSchema } from '@quereus/quereus';
import type { AlterTableStmt, ColumnDef, Statement } from '@quereus/quereus/parser';
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
 *  - any pending statement is not `additive` ({@link classifyControlSchemaChange}): every other
 *    change to an existing control table is refused by the optimystic module or discards rows; or
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
	const pending = await pendingControlSchemaChanges(db);
	// `catalog-only` changes stay refused until the optimystic module applies them
	// (optimystic-catalog-only-alter-table); control-store-migrates-on-start widens this then.
	if (storeVersion > buildVersion || pending.some((change) => change.kind !== 'additive')) {
		throw new ControlStoreIncompatibleError(partyId, storeVersion, buildVersion, pending.map((change) => change.ddl));
	}
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
 * migratable (docs/architecture.md → "Control schema changes and incompatible stores"):
 *  - `additive`: a new table, a new index, or a table tag change, which the optimystic module
 *    applies today without touching a row;
 *  - `catalog-only`: a change the optimystic module applies to the table's catalog record without
 *    rewriting a row, once optimystic-catalog-only-alter-table ships;
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
export function classifyControlSchemaChange(statement: Statement, catalog: SchemaManager): ControlSchemaChangeKind {
	switch (statement.type) {
		case 'createTable':
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

/** Whether the table has the column and no index, unique constraint or primary key covers it. */
function isUnkeyedColumn(table: TableSchema | undefined, name: string): boolean {
	const column = table?.columnIndexMap.get(name.toLowerCase());
	if (table === undefined || column === undefined) {
		return false;
	}
	return !table.primaryKeyDefinition.some((key) => key.index === column)
		&& !(table.indexes ?? []).some((index) => index.columns.some((indexed) => indexed.index === column))
		&& !(table.uniqueConstraints ?? []).some((unique) => unique.columns.includes(column));
}
