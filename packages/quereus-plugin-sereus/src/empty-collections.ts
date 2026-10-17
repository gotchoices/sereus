import debug from 'debug';
import type { Database, TableSchema } from '@quereus/quereus';
import type { Collection, CollectionId } from '@optimystic/db-core';
import { defaultCollectionUri } from '@optimystic/quereus-plugin-optimystic';

const log = debug('sereus:plugin:strand');

/** The schemas whose tables a founder gives a collection: strand membership, then the sApp's. */
const FOUNDED_SCHEMAS = ['Strand', 'App'] as const;

/**
 * The part of the Optimystic plugin's transaction bridge this module reads: the live registry of
 * every collection a table opened (its main tree, index trees and unique-enforcement trees),
 * filled as each table initializes.
 */
export interface CollectionRegistrySource {
	getCollectionRegistry(): Map<CollectionId, Collection<unknown>>;
}

/**
 * Commit an empty collection for every table declared in the `Strand` and `App` schemas that
 * has none yet, and resolve to how many collections were committed.
 *
 * Opening a table whose collection was never committed stages a fresh empty one in this node's
 * tracker and writes nothing (`Collection.createOrOpen`'s invented branch), and a SQL commit
 * flushes only the trees it wrote to. So the step opens every table, which registers each of its
 * trees with the bridge, then syncs every registered collection still in that invented state.
 *
 * Commits outside any SQL transaction whatever is staged in those collections, so it is only
 * sound while nothing else writes through `db`.
 */
export async function createEmptyCollections(db: Database, bridge: CollectionRegistrySource): Promise<number> {
	const tables = foundedTables(db);
	await openTables(db, tables);
	const registry = bridge.getCollectionRegistry();
	assertMainCollectionsRegistered(registry, tables);
	return await syncInventedCollections(registry);
}

function foundedTables(db: Database): TableSchema[] {
	return FOUNDED_SCHEMAS.flatMap(name => {
		const schema = db.schemaManager.getSchema(name);
		return schema
			? Array.from(schema.getAllTables()).filter(table => !table.isView && table.vtabModuleName === 'optimystic')
			: [];
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
function assertMainCollectionsRegistered(registry: ReadonlyMap<CollectionId, unknown>, tables: readonly TableSchema[]): void {
	const unregistered = tables.filter(table => !registry.has(mainCollectionId(table)));
	if (unregistered.length > 0) {
		const names = unregistered.map(table => `${table.schemaName}.${table.name} (${mainCollectionId(table)})`).join(', ');
		throw new Error(`Opening the strand's tables registered no collection for ${names}; cannot give those tables an empty collection`);
	}
}

/** The collection id the Optimystic vtab stores `table` under: its URI without the `tree://` scheme. */
function mainCollectionId(table: TableSchema): CollectionId {
	const explicitUri = table.vtabArgs?.['0'];
	const uri = typeof explicitUri === 'string' && explicitUri !== '' ? explicitUri : defaultCollectionUri(table.schemaName, table.name);
	return (uri.startsWith('tree://') ? uri.slice('tree://'.length) : uri) as CollectionId;
}

async function syncInventedCollections(registry: ReadonlyMap<CollectionId, Collection<unknown>>): Promise<number> {
	let committed = 0;
	for (const [id, collection] of registry) {
		// `committedRevision() === undefined` is the invented STATE, which its doc says is safe to branch on.
		if (collection.committedRevision() === undefined && collection.hasUnsyncedChanges()) {
			await collection.sync();
			log('Committed empty collection %s', id);
			committed++;
		}
	}
	return committed;
}
