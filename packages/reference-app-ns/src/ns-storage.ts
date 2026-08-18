/**
 * ns-storage.ts — lazy SQLite-backed `IRawStorage` for NativeScript strands.
 *
 * `CadreNodeConfig.storage.provider` is a *synchronous* factory
 * (`(strandId) => IRawStorage`). The RN app gets away with that because
 * `rn-leveldb` opens synchronously; `openOptimysticNSDb` is **async**, so a sync
 * factory cannot open it directly.
 *
 * `makeLazyNsStorage(strandId)` returns a proxy `IRawStorage` whose every
 * (already-async) method `await`s a cached `openOptimysticNSDb('sereus-<strandId>')`
 * promise before delegating to the real `SqliteRawStorage`. This preserves the RN
 * app's per-strand storage isolation and sidesteps the sync/async mismatch.
 */

import type { ActionId, ActionRev, BlockId, IBlock, Transform } from '@optimystic/db-core';
import type { BlockMetadata, IRawStorage } from '@optimystic/db-p2p';
import { openOptimysticNSDb, SqliteRawStorage } from '@optimystic/db-p2p-storage-ns';

/**
 * One open promise per database name. cadre-core calls a strand's provider once per
 * strand runtime, and again after that strand stops (see `RawStorageProvider` in
 * cadre-core's `types.ts`); caching keeps a single SQLite connection (and its
 * prepared statements) per strand rather than reopening the file on that second
 * call. The cache is for the connection, not for the `LazyNsRawStorage` proxy over
 * it — cadre-core owns the store instance's lifetime itself.
 */
const openByDbName = new Map<string, Promise<SqliteRawStorage>>();

function openStorage(dbName: string): Promise<SqliteRawStorage> {
	let pending = openByDbName.get(dbName);
	if (!pending) {
		pending = openOptimysticNSDb(dbName).then((db) => new SqliteRawStorage(db));
		openByDbName.set(dbName, pending);
	}
	return pending;
}

/**
 * Lazy `IRawStorage` proxy. Defers the async SQLite open until the first
 * operation, then delegates everything to the concrete `SqliteRawStorage`.
 */
class LazyNsRawStorage implements IRawStorage {
	constructor(private readonly dbName: string) {}

	private storage(): Promise<SqliteRawStorage> {
		return openStorage(this.dbName);
	}

	async getMetadata(blockId: BlockId): Promise<BlockMetadata | undefined> {
		return (await this.storage()).getMetadata(blockId);
	}

	async saveMetadata(blockId: BlockId, metadata: BlockMetadata): Promise<void> {
		return (await this.storage()).saveMetadata(blockId, metadata);
	}

	async getRevision(blockId: BlockId, rev: number): Promise<ActionId | undefined> {
		return (await this.storage()).getRevision(blockId, rev);
	}

	async saveRevision(blockId: BlockId, rev: number, actionId: ActionId): Promise<void> {
		return (await this.storage()).saveRevision(blockId, rev, actionId);
	}

	async *listRevisions(
		blockId: BlockId,
		startRev: number,
		endRev: number,
	): AsyncIterable<ActionRev> {
		const storage = await this.storage();
		yield* storage.listRevisions(blockId, startRev, endRev);
	}

	async getPendingTransaction(
		blockId: BlockId,
		actionId: ActionId,
	): Promise<Transform | undefined> {
		return (await this.storage()).getPendingTransaction(blockId, actionId);
	}

	async savePendingTransaction(
		blockId: BlockId,
		actionId: ActionId,
		transform: Transform,
	): Promise<void> {
		return (await this.storage()).savePendingTransaction(blockId, actionId, transform);
	}

	async deletePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		return (await this.storage()).deletePendingTransaction(blockId, actionId);
	}

	async *listPendingTransactions(blockId: BlockId): AsyncIterable<ActionId> {
		const storage = await this.storage();
		yield* storage.listPendingTransactions(blockId);
	}

	async getTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		return (await this.storage()).getTransaction(blockId, actionId);
	}

	async saveTransaction(
		blockId: BlockId,
		actionId: ActionId,
		transform: Transform,
	): Promise<void> {
		return (await this.storage()).saveTransaction(blockId, actionId, transform);
	}

	async getMaterializedBlock(blockId: BlockId, actionId: ActionId): Promise<IBlock | undefined> {
		return (await this.storage()).getMaterializedBlock(blockId, actionId);
	}

	async saveMaterializedBlock(
		blockId: BlockId,
		actionId: ActionId,
		block?: IBlock,
	): Promise<void> {
		return (await this.storage()).saveMaterializedBlock(blockId, actionId, block);
	}

	async promotePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		return (await this.storage()).promotePendingTransaction(blockId, actionId);
	}

	async getApproximateBytesUsed(): Promise<number> {
		return (await this.storage()).getApproximateBytesUsed();
	}
}

/**
 * Build a lazy per-strand `IRawStorage`. Pass as
 * `storage: { provider: (strandId) => makeLazyNsStorage(strandId) }`.
 */
export function makeLazyNsStorage(strandId: string): IRawStorage {
	return new LazyNsRawStorage(`sereus-${strandId}`);
}
