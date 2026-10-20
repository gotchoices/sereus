import debug from 'debug';
import type { Database, TableSchema } from '@quereus/quereus';
import type { Collection, CollectionId } from '@optimystic/db-core';
import { defaultCollectionUri } from '@optimystic/quereus-plugin-optimystic';

const log = debug('sereus:plugin:empty-collections');

/**
 * The part of the Optimystic plugin's transaction bridge this module reads: the live registry of
 * every collection a table opened (its main tree, index trees and unique-enforcement trees),
 * filled as each table initializes.
 */
export interface CollectionRegistrySource {
	getCollectionRegistry(): Map<CollectionId, Collection<unknown>>;
}

/**
 * Commit an empty collection for every Optimystic table declared in `schemaNames` that has none
 * yet, except the tables named in `except`, and resolve to how many collections were committed.
 *
 * Opening a table whose collection was never committed stages a fresh empty one in this node's
 * tracker and writes nothing (`Collection.createOrOpen`'s invented branch), and a SQL commit
 * flushes only the trees it wrote to. So the step opens every table, which registers each of its
 * trees with the bridge, then syncs every registered collection still in that invented state.
 *
 * `except` holds qualified table names (`'Strand.Header'`) whose collections the caller is about
 * to create by writing rows: an insert writes every tree of its table, so each of those trees is
 * left out whether or not it was opened here. A name that matches no declared Optimystic table
 * throws, so a renamed table cannot quietly fall back to committing everything.
 *
 * Commits outside any SQL transaction whatever is staged in those collections, so it is only
 * sound while nothing else writes through `db`.
 */
export async function createEmptyCollections(
	db: Database,
	bridge: CollectionRegistrySource,
	schemaNames: readonly string[],
	except: readonly string[] = []
): Promise<number> {
	const declared = optimysticTables(db, schemaNames);
	const excluded = excludedTables(declared, except, schemaNames);
	const tables = declared.filter(table => !excluded.includes(table));
	await openTables(db, tables);
	const registry = bridge.getCollectionRegistry();
	assertMainCollectionsRegistered(registry, tables, schemaNames);
	return await syncInventedCollections(registry, excluded.map(mainCollectionId));
}

/**
 * Every Optimystic table the named schemas declare. A table reaches Optimystic either through its
 * own `using` clause (an sApp's) or through the database's default vtab (the control tables), and
 * both record `vtabModuleName`. None found means the filter no longer matches how those tables
 * are backed, and carrying on would give no table a collection while appearing to work.
 */
function optimysticTables(db: Database, schemaNames: readonly string[]): TableSchema[] {
	const tables = schemaNames.flatMap(name => {
		const schema = db.schemaManager.getSchema(name);
		return schema
			? Array.from(schema.getAllTables()).filter(table => !table.isView && table.vtabModuleName === 'optimystic')
			: [];
	});
	if (tables.length === 0) {
		throw new Error(`Schemas ${schemaNames.join(', ')} declare no optimystic table; cannot give their tables an empty collection`);
	}
	return tables;
}

/** The declared tables `except` names, compared case-insensitively as SQL identifiers are. */
function excludedTables(declared: readonly TableSchema[], except: readonly string[], schemaNames: readonly string[]): TableSchema[] {
	return except.map(name => {
		const table = declared.find(candidate => `${candidate.schemaName}.${candidate.name}`.toLowerCase() === name.toLowerCase());
		if (!table) {
			throw new Error(`Cannot leave ${name} out of the empty collections: schemas ${schemaNames.join(', ')} declare no optimystic table by that name`);
		}
		return table;
	});
}

/** A read initializes the table's vtab, which is what opens and registers its collections. */
async function openTables(db: Database, tables: readonly TableSchema[]): Promise<void> {
	for (const table of tables) {
		for await (const _row of db.eval(`select 1 from ${table.schemaName}."${table.name}" limit 1`)) {
			break;
		}
	}
}

/**
 * A declared table whose main collection is not registered means the plugin's open or
 * registration path has changed under this module; founding on would leave that table with no
 * collection while appearing to have given every table one.
 */
function assertMainCollectionsRegistered(
	registry: ReadonlyMap<CollectionId, unknown>,
	tables: readonly TableSchema[],
	schemaNames: readonly string[]
): void {
	const unregistered = tables.filter(table => !registry.has(mainCollectionId(table)));
	if (unregistered.length > 0) {
		const names = unregistered.map(table => `${table.schemaName}.${table.name} (${mainCollectionId(table)})`).join(', ');
		throw new Error(`Opening the tables of ${schemaNames.join(', ')} registered no collection for ${names}; cannot give those tables an empty collection`);
	}
}

/** The collection id the Optimystic vtab stores `table` under: its URI without the `tree://` scheme. */
function mainCollectionId(table: TableSchema): CollectionId {
	const explicitUri = table.vtabArgs?.['0'];
	const uri = typeof explicitUri === 'string' && explicitUri !== '' ? explicitUri : defaultCollectionUri(table.schemaName, table.name);
	return (uri.startsWith('tree://') ? uri.slice('tree://'.length) : uri) as CollectionId;
}

async function syncInventedCollections(
	registry: ReadonlyMap<CollectionId, Collection<unknown>>,
	excludedMainIds: readonly CollectionId[]
): Promise<number> {
	let committed = 0;
	for (const [id, collection] of registry) {
		if (belongsToExcludedTable(id, excludedMainIds)) {
			continue;
		}
		// `committedRevision() === undefined` is the invented STATE, which its doc says is safe to branch on.
		if (collection.committedRevision() === undefined && collection.hasUnsyncedChanges()) {
			await collection.sync();
			log('Committed empty collection %s', id);
			committed++;
		}
	}
	return committed;
}

/**
 * Whether `id` is one of an excluded table's trees: its main collection, or an index or
 * unique-enforcement tree, which the Optimystic plugin keeps at `<main uri>/index/<name>`.
 * Matched by id rather than by "opened here", because the caller's own reads of an excluded
 * table registered it before this step ran.
 */
function belongsToExcludedTable(id: CollectionId, excludedMainIds: readonly CollectionId[]): boolean {
	return excludedMainIds.some(mainId => id === mainId || id.startsWith(`${mainId}/index/`));
}
