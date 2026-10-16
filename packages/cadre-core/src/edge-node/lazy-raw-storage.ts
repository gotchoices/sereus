/**
 * `lazyRawStorage` — an `IRawStorage` over an opener that is asynchronous.
 *
 * `CadreNodeConfig.storage.provider`, and so `EdgeNodeStorage.rawStorage`, is a synchronous
 * factory. rn-leveldb opens synchronously, but IndexedDB and NativeScript's SQLite open with a
 * promise, so those platforms return this proxy: every (already asynchronous) method awaits one
 * cached `open()` before delegating, and an async-iterator method opens only once iteration
 * starts. Per-scope handle caching, and closing, stay the platform's: the proxy owns nothing.
 */

import type { ActionId, ActionRev, BlockId, IBlock, Transform } from '@optimystic/db-core';
import type { BlockCommitProof, BlockMetadata, FlushOptions, IRawStorage, StoreDurability } from '@optimystic/db-p2p';

/** The optional `IRawStorage` members this proxy forwards, delegating when the opened storage has them. */
type OptionalMethodForwarded = 'getApproximateBytesUsed' | 'listBlockIds';
/**
 * `getStoreIdentity`: see the accepted tradeoff on {@link LazyRawStorage}. `readCached`: a marker
 * set only by a storage with a read cache beneath it, which the proxy cannot know before opening
 * and cadre-core's cache wrap reads before any open. `close`: the storage behind the proxy is the
 * platform's, shared with every later proxy over the same scope, and nothing in cadre-core closes
 * a store its provider returned.
 */
type OptionalMemberOmitted = 'getStoreIdentity' | 'readCached' | 'close';

type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];
type MustBeNever<T extends never> = T;
/**
 * Fails to compile when `IRawStorage` gains an optional member that is in neither list above, so
 * each one is forwarded or omitted by decision rather than by default.
 */
export type UnclassifiedOptionalMember = MustBeNever<
	Exclude<OptionalKeys<IRawStorage>, OptionalMethodForwarded | OptionalMemberOmitted>
>;

/**
 * `IRawStorage`'s optional methods are detected by callers checking that the method exists, so
 * one this proxy leaves out reads as "not supported". The `implements` clause names the optional
 * methods the proxy forwards, so dropping one is a compile error, and `UnclassifiedOptionalMember`
 * rejects one added upstream later. The two forwarded ones delegate when the opened storage has
 * them and otherwise answer as an omission would (0 bytes; no block ids).
 *
 * NOTE: those two are always present on the proxy, a stub when the opened storage lacks them,
 * which `IRawStorage` asks backends not to do (feature detection should see the true capability:
 * the peer-join backfill is inert without `listBlockIds` and runs an empty scan with the stub).
 * The proxy cannot know before opening, and every storage a platform opens behind it (IndexedDB,
 * SQLite) has both. If a platform ever opens one without them, let it declare the capability
 * beside `durability` and omit the method here.
 *
 * NOTE: accepted tradeoff — `getStoreIdentity` is omitted although the opened storage may have it.
 * It is synchronous and must return a string fixed at construction, but the real identity exists
 * only after the asynchronous open; the interface says a backend that cannot honour that must
 * omit the method. `withReadCache` then identifies the store by object. Revisit if two proxies over
 * one scope are seen getting separate read caches, or if the interface allows a lazily-resolved
 * identity.
 */
class LazyRawStorage implements IRawStorage, Required<Pick<IRawStorage, OptionalMethodForwarded>> {
	private opening: Promise<IRawStorage> | null = null;

	constructor(
		private readonly open: () => Promise<IRawStorage>,
		readonly durability: StoreDurability,
	) {}

	/**
	 * One open shared by every call; a rejected open is forgotten, so the next call retries while
	 * the calls that awaited the failed one still get its rejection.
	 *
	 * NOTE: retries have no backoff: one fresh open attempt per operation on a permanently broken
	 * scope. Revisit only if a failing scope is seen issuing opens in a tight loop.
	 */
	private storage(): Promise<IRawStorage> {
		if (this.opening) return this.opening;
		const opening = this.open();
		this.opening = opening;
		// The rejection itself reaches every caller awaiting `opening`; this only forgets it.
		void opening.catch(() => {
			if (this.opening === opening) this.opening = null;
		});
		return opening;
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

	async *listRevisions(blockId: BlockId, startRev: number, endRev: number): AsyncIterable<ActionRev> {
		const storage = await this.storage();
		yield* storage.listRevisions(blockId, startRev, endRev);
	}

	async getPendingTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		return (await this.storage()).getPendingTransaction(blockId, actionId);
	}

	async savePendingTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void> {
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

	async saveTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void> {
		return (await this.storage()).saveTransaction(blockId, actionId, transform);
	}

	async getBlockProof(blockId: BlockId, rev: number): Promise<BlockCommitProof | undefined> {
		return (await this.storage()).getBlockProof(blockId, rev);
	}

	async saveBlockProof(blockId: BlockId, rev: number, proof: BlockCommitProof): Promise<void> {
		return (await this.storage()).saveBlockProof(blockId, rev, proof);
	}

	async getMaterializedBlock(blockId: BlockId, actionId: ActionId): Promise<IBlock | undefined> {
		return (await this.storage()).getMaterializedBlock(blockId, actionId);
	}

	async saveMaterializedBlock(blockId: BlockId, actionId: ActionId, block?: IBlock): Promise<void> {
		return (await this.storage()).saveMaterializedBlock(blockId, actionId, block);
	}

	async promotePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		return (await this.storage()).promotePendingTransaction(blockId, actionId);
	}

	async flush(options?: FlushOptions): Promise<void> {
		return (await this.storage()).flush(options);
	}

	async whenDurable(): Promise<void> {
		return (await this.storage()).whenDurable();
	}

	async getApproximateBytesUsed(): Promise<number> {
		const storage = await this.storage();
		return storage.getApproximateBytesUsed ? storage.getApproximateBytesUsed() : 0;
	}

	async *listBlockIds(): AsyncIterable<BlockId> {
		const storage = await this.storage();
		if (storage.listBlockIds) yield* storage.listBlockIds();
	}
}

/**
 * An `IRawStorage` whose every method awaits one cached `open()` before delegating. A rejected
 * open is forgotten, so the next call retries; the async-iterator methods open only once
 * iteration starts.
 *
 * `durability` is what the opened storage reports (`IRawStorage.durability`), stated here because
 * it is read synchronously, before any open: a platform knows its backend (`'power-loss'` for
 * SQLite and IndexedDB).
 */
export function lazyRawStorage(open: () => Promise<IRawStorage>, durability: StoreDurability): IRawStorage {
	return new LazyRawStorage(open, durability);
}
