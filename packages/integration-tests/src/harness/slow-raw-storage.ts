/**
 * A raw-storage backend that sleeps a fixed amount before every operation.
 *
 * Control-database bring-up costs (raw-storage operations issued) × per-operation
 * latency, and the operation count is fixed and known — `control-database.ts`'s
 * `loadSchema` note records it, and `control-start-storage-op-budget.spec.ts` pins
 * it. So multiplying the per-operation latency is a DETERMINISTIC way to make
 * bring-up take a chosen number of seconds, which is what a scenario needs when it
 * wants to prove something about a window bring-up would otherwise flash past.
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
 * per-ITEM latency is not what bring-up duration is made of.
 */

import type { BlockMetadata, IRawStorage } from '@optimystic/db-p2p';
import { MemoryRawStorage } from '@optimystic/db-p2p';
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

/** A `StorageConfig.provider` over fresh {@link SlowRawStorage}-wrapped memory backends. */
export function slowMemoryStorageProvider(opDelayMs: number): () => IRawStorage {
	return () => new SlowRawStorage(new MemoryRawStorage(), opDelayMs);
}
