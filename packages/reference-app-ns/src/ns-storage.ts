/**
 * ns-storage.ts — lazy SQLite-backed `IRawStorage` for NativeScript strands.
 *
 * `CadreNodeConfig.storage.provider` is a *synchronous* factory
 * (`(scope) => IRawStorage`). The RN app gets away with that because
 * `rn-leveldb` opens synchronously; `openOptimysticNSDb` is **async**, so a sync
 * factory cannot open it directly.
 *
 * `makeLazyNsStorage(scope)` returns a proxy `IRawStorage` whose every
 * (already-async) method `await`s a cached `openOptimysticNSDb('sereus-<scope>')`
 * promise before delegating to the real `SqliteRawStorage`. This preserves the RN
 * app's per-scope storage isolation and sidesteps the sync/async mismatch.
 */

import type { ActionId, ActionRev, BlockId, IBlock, Transform } from '@optimystic/db-core';
import type { BlockMetadata, IRawStorage } from '@optimystic/db-p2p';

/**
 * The commit proof `IRawStorage` stores, derived from the interface rather than imported by
 * name. `@optimystic/db-p2p`'s `exports` map sends React-Native-condition resolvers — this app
 * included — to its `rn` entry, and that entry does not re-export `BlockCommitProof` even
 * though it DOES export the `IRawStorage` that requires it. Deriving keeps this file honest
 * against whichever entry resolves, and follows the type automatically if it changes.
 * Upstream gap tracked in `../optimystic/tickets/backlog/bug-rn-entry-omits-with-read-cache.md`;
 * import it by name once the rn entry exports it.
 */
type StoredBlockProof = Parameters<IRawStorage['saveBlockProof']>[2];
import { openOptimysticNSDb, SqliteRawStorage } from '@optimystic/db-p2p-storage-ns';

/**
 * One open promise per database name. cadre-core calls a strand's provider once per
 * strand runtime, and again after that strand stops (see `RawStorageProvider` in
 * cadre-core's `types.ts`); caching keeps a single SQLite connection (and its
 * prepared statements) per strand rather than reopening the file on that second
 * call. The cache is for the connection, not for the `LazyNsRawStorage` proxy over
 * it — cadre-core owns the store instance's lifetime itself.
 *
 * A rejected open is forgotten, so the next operation on that database retries —
 * the same policy as `openIdentityDb` in `cadre-phone.ts`. Callers already awaiting
 * the failed promise still receive its rejection.
 */
const openByDbName = new Map<string, Promise<SqliteRawStorage>>();

/**
 * NOTE: `openOptimysticNSDb` opens the native handle and then applies the schema, and
 * does not close the handle if applying the schema throws; a retry then opens a second
 * handle on the same file. Fine while schema application does not fail in practice; if
 * retried opens are ever seen blocking on a leaked handle, the fix belongs in the
 * upstream opener. Retries also have no backoff — one fresh open attempt per operation
 * on a permanently broken file; revisit only if a failing scope is seen issuing opens
 * in a tight loop.
 */
function openStorage(dbName: string): Promise<SqliteRawStorage> {
	const cached = openByDbName.get(dbName);
	if (cached) return cached;
	const opening = openOptimysticNSDb(dbName).then((db) => new SqliteRawStorage(db));
	openByDbName.set(dbName, opening);
	// The rejection itself reaches every caller awaiting `opening`; this only forgets it.
	void opening.catch(() => {
		if (openByDbName.get(dbName) === opening) openByDbName.delete(dbName);
	});
	return opening;
}

type OptionalMethodForwarded = 'getApproximateBytesUsed' | 'listBlockIds';
/**
 * `getStoreIdentity`: see the accepted tradeoff on `LazyNsRawStorage`. `readCached`: a
 * marker set only by a storage with a read cache beneath it, which `SqliteRawStorage`
 * does not have.
 */
type OptionalMemberOmitted = 'getStoreIdentity' | 'readCached';

type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];
type MustBeNever<T extends never> = T;
/**
 * Fails to compile when `IRawStorage` gains an optional member that is in neither list
 * above, so each one is forwarded or omitted by decision rather than by default.
 */
export type UnclassifiedOptionalMember = MustBeNever<
	Exclude<OptionalKeys<IRawStorage>, OptionalMethodForwarded | OptionalMemberOmitted>
>;

/**
 * Lazy `IRawStorage` proxy. Defers the async SQLite open until the first
 * operation, then delegates everything to the concrete `SqliteRawStorage`.
 *
 * `IRawStorage`'s optional methods are detected by callers checking that the method
 * exists, so one this proxy leaves out reads as "not supported" on this app. The
 * `implements` clause names the optional methods the proxy forwards, so dropping one
 * is a compile error, and `UnclassifiedOptionalMember` rejects one added upstream later.
 *
 * NOTE: accepted tradeoff — `getStoreIdentity` is omitted although `SqliteRawStorage`
 * has it. It is synchronous and must return a string fixed at construction, but the
 * real identity exists only after the asynchronous open; the interface says a backend
 * that cannot honour that must omit the method. `withReadCache` then identifies the
 * store by object. Revisit if two proxies over one database are seen getting separate
 * read caches, or if the interface allows a lazily-resolved identity.
 */
class LazyNsRawStorage
	implements IRawStorage, Required<Pick<IRawStorage, OptionalMethodForwarded>>
{
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

	async getBlockProof(blockId: BlockId, rev: number): Promise<StoredBlockProof | undefined> {
		return (await this.storage()).getBlockProof(blockId, rev);
	}

	async saveBlockProof(blockId: BlockId, rev: number, proof: StoredBlockProof): Promise<void> {
		return (await this.storage()).saveBlockProof(blockId, rev, proof);
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

	// NOTE: `SqliteRawStorage.listBlockIds` reads every block id into memory before yielding,
	// and runs at node startup and at each peer join. Cost on a large phone database is
	// unmeasured; if either is seen stalling, the upstream statement needs to page.
	async *listBlockIds(): AsyncIterable<BlockId> {
		const storage = await this.storage();
		yield* storage.listBlockIds();
	}
}

/**
 * Build a lazy per-scope `IRawStorage`. Pass as
 * `storage: { provider: (scope) => makeLazyNsStorage(scope) }`.
 *
 * `scope` is cadre-core's storage scope key — a strand id, or the party's control
 * key from `controlStorageScope`. Every key it mints is already within
 * `[a-z0-9._-]`, so it goes straight into the database name unescaped.
 *
 * NOTE: a dev device that ran a build predating the party scoping still has an
 * unscoped `sereus-control` database on disk. Nothing opens or deletes it — its
 * rows belong to whichever party was configured when they were written and nothing
 * recorded which, so adopting them into a party's store would reintroduce exactly
 * the cross-party bleed the scoping fixed. Dev builds only; it simply sits there.
 */
export function makeLazyNsStorage(scope: string): IRawStorage {
	return new LazyNsRawStorage(`sereus-${scope}`);
}
