/**
 * A raw-storage backend that sleeps a fixed amount before every operation.
 *
 * Control-database bring-up costs (raw-storage operations that reach this store) ×
 * per-operation latency, and the operation count is fixed and known —
 * `control-database.ts`'s `loadSchema` note records it, and
 * `control-start-storage-op-budget.spec.ts` pins it. So multiplying the per-operation
 * latency makes bring-up take a chosen number of seconds without depending on machine
 * speed, which is what a scenario needs when it wants to prove something about a window
 * bring-up would otherwise flash past.
 *
 * The concrete use is `control-bring-up-quiet-period.integration.ts`:
 * `@libp2p/bootstrap` emits its discovery events one second after
 * `libp2p.start()`, and on an idle machine with in-memory storage bring-up finishes
 * in ~100 ms — so the ordering under test is a race the test would win by accident.
 * A few milliseconds of sleep per operation pushes bring-up well past that fuse and
 * makes the assertion mean what it says.
 *
 * Every method delegates; the sleep is the only behaviour added. The three
 * streaming methods sleep once and then hand back the underlying iterable, since
 * per-ITEM latency is not what bring-up duration is made of. `whenDurable` waits on
 * the inner storage without sleeping: it issues no operation of its own.
 *
 * NOTE: not every bring-up operation reaches this store. cadre-core fronts a scope's block
 * store with a leased read cache (`node-storage-cache.ts`), which passes a
 * `MemoryRawStorage` through untouched but NOT this wrapper around one — so a block read
 * the cache already holds never sleeps, and the count that matters is the operations that
 * MISS the cache, not the operations issued. The margin is not thin: measured 2026-11-26,
 * `control-bring-up-quiet-period` at `storageOpDelayMs: 50` brought up in 4,639 ms against
 * the 1,000 ms bootstrap fuse it has to clear. If that gap ever closes, slow the cache's
 * own misses rather than raising the delay until the remaining misses add up again —
 * raising it buys less time than the arithmetic in that scenario's `STORAGE_OP_DELAY_MS`
 * comment implies.
 */

import type { BlockCommitProof, BlockMetadata, FlushOptions, IRawStorage, StoreDurability, StoredProofEntry } from '@optimystic/db-p2p';
import { memoryNodeStorage } from '@optimystic/db-p2p';
import type { NodeStorageOpener } from './node-fixtures.js';
import type { ActionId, ActionRev, BlockId, IBlock, Transform } from '@optimystic/db-core';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SlowRawStorage implements IRawStorage {
	constructor(
		private readonly inner: IRawStorage,
		private readonly opDelayMs: number
	) {}

	private slow(): Promise<void> {
		return sleep(this.opDelayMs);
	}

	async getMetadata(blockId: BlockId): Promise<BlockMetadata | undefined> {
		await this.slow();
		return this.inner.getMetadata(blockId);
	}

	async saveMetadata(blockId: BlockId, metadata: BlockMetadata): Promise<void> {
		await this.slow();
		return this.inner.saveMetadata(blockId, metadata);
	}

	async getRevision(blockId: BlockId, rev: number): Promise<ActionId | undefined> {
		await this.slow();
		return this.inner.getRevision(blockId, rev);
	}

	async saveRevision(blockId: BlockId, rev: number, actionId: ActionId): Promise<void> {
		await this.slow();
		return this.inner.saveRevision(blockId, rev, actionId);
	}

	async *listRevisions(blockId: BlockId, startRev: number, endRev: number): AsyncIterable<ActionRev> {
		await this.slow();
		yield* this.inner.listRevisions(blockId, startRev, endRev);
	}

	async getPendingTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		await this.slow();
		return this.inner.getPendingTransaction(blockId, actionId);
	}

	async savePendingTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void> {
		await this.slow();
		return this.inner.savePendingTransaction(blockId, actionId, transform);
	}

	async deletePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		await this.slow();
		return this.inner.deletePendingTransaction(blockId, actionId);
	}

	async *listPendingTransactions(blockId: BlockId): AsyncIterable<ActionId> {
		await this.slow();
		yield* this.inner.listPendingTransactions(blockId);
	}

	async getTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		await this.slow();
		return this.inner.getTransaction(blockId, actionId);
	}

	async saveTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void> {
		await this.slow();
		return this.inner.saveTransaction(blockId, actionId, transform);
	}

	async getBlockProof(blockId: BlockId, rev: number): Promise<BlockCommitProof | undefined> {
		await this.slow();
		return this.inner.getBlockProof(blockId, rev);
	}

	async saveBlockProof(blockId: BlockId, rev: number, proof: BlockCommitProof): Promise<void> {
		await this.slow();
		return this.inner.saveBlockProof(blockId, rev, proof);
	}

	async getProofEntry(blockId: BlockId, rev: number): Promise<StoredProofEntry | undefined> {
		await this.slow();
		return this.inner.getProofEntry(blockId, rev);
	}

	async saveProofEntry(blockId: BlockId, rev: number, entry: StoredProofEntry): Promise<void> {
		await this.slow();
		return this.inner.saveProofEntry(blockId, rev, entry);
	}

	async getCommitProof(messageHash: string): Promise<BlockCommitProof | undefined> {
		await this.slow();
		return this.inner.getCommitProof(messageHash);
	}

	async saveCommitProof(messageHash: string, proof: BlockCommitProof): Promise<void> {
		await this.slow();
		return this.inner.saveCommitProof(messageHash, proof);
	}

	async getMaterializedBlock(blockId: BlockId, actionId: ActionId): Promise<IBlock | undefined> {
		await this.slow();
		return this.inner.getMaterializedBlock(blockId, actionId);
	}

	async saveMaterializedBlock(blockId: BlockId, actionId: ActionId, block?: IBlock): Promise<void> {
		await this.slow();
		return this.inner.saveMaterializedBlock(blockId, actionId, block);
	}

	async promotePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		await this.slow();
		return this.inner.promotePendingTransaction(blockId, actionId);
	}

	async deleteBlock(blockId: BlockId): Promise<void> {
		await this.slow();
		return this.inner.deleteBlock(blockId);
	}

	async flush(options?: FlushOptions): Promise<void> {
		await this.slow();
		return this.inner.flush(options);
	}

	whenDurable(): Promise<void> {
		return this.inner.whenDurable();
	}

	get durability(): StoreDurability {
		return this.inner.durability;
	}

	async getApproximateBytesUsed(): Promise<number> {
		await this.slow();
		return (await this.inner.getApproximateBytesUsed?.()) ?? 0;
	}

	async *listBlockIds(): AsyncIterable<BlockId> {
		await this.slow();
		const ids = this.inner.listBlockIds?.();
		if (ids) {
			yield* ids;
		}
	}
}

/**
 * A `StorageConfig.open` over fresh memory backends whose BLOCK store alone is slowed.
 *
 * Only `blocks`, because the duration this buys is control-database bring-up, and bring-up is
 * block reads and writes — the fixed count `control-start-storage-op-budget.spec.ts` pins.
 * Wrapping the key-value and piece stores too would also stretch the clock's high-water mark,
 * the blob records and the owed-blob ledger, which this option was never about: a scenario
 * asking for a few milliseconds per block operation would silently pay for those as well.
 */
export function slowMemoryStorageProvider(opDelayMs: number): NodeStorageOpener {
	return async (_scope: string) => {
		const storage = memoryNodeStorage();
		return { ...storage, blocks: new SlowRawStorage(storage.blocks, opDelayMs) };
	};
}
