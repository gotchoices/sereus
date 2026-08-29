import type { BlockCommitProof, BlockMetadata, IRawStorage } from '@optimystic/db-p2p';
import type { ActionId, ActionRev, BlockId, IBlock, Transform } from '@optimystic/db-core';

/**
 * Shared raw-storage operation counting for the storage-budget suites —
 * `control-start-storage-op-budget.spec.ts` (the control database's start cost)
 * and `strand-solo-write-budget.spec.ts` (a solo strand's launch/insert/select
 * cost on each transactor). Hoisted from the former so the two suites cannot
 * drift apart; the control spec's unchanged budgets are the proof the hoist was
 * faithful.
 *
 * Not a `*.spec.ts` file, so vitest's `test/**\/*.spec.ts` glob never runs it
 * as a suite (same pattern as `control-db-node-helpers.ts`).
 */

export interface MethodCount {
	method: string;
	calls: number;
	blocks: number;
}

export interface OpSnapshot {
	/** Every call into `IRawStorage`, whatever the method. */
	total: number;
	/** Distinct block ids touched across all methods — the denominator of the redundancy ratio. */
	distinctBlocks: number;
	byMethod: MethodCount[];
}

/**
 * Tallies calls into an `IRawStorage`, by method and by distinct block id.
 *
 * Both halves matter. The total is the cost; the distinct-block count is what makes
 * it diagnosable — the measured control start reads one block's metadata dozens of
 * times, so a change that removes redundancy moves the ratio, while a change that
 * adds a table moves the distinct count. A total-only budget cannot tell those two
 * apart.
 */
export class StorageOpCounter {
	private readonly calls = new Map<string, number>();
	private readonly blocksByMethod = new Map<string, Set<BlockId>>();
	private readonly blocks = new Set<BlockId>();

	/** `blockId` omitted for the whole-store methods (`listBlockIds`, `getApproximateBytesUsed`). */
	record(method: string, blockId?: BlockId): void {
		this.calls.set(method, (this.calls.get(method) ?? 0) + 1);
		if (blockId === undefined) return;
		this.blocks.add(blockId);
		let seen = this.blocksByMethod.get(method);
		if (!seen) {
			seen = new Set<BlockId>();
			this.blocksByMethod.set(method, seen);
		}
		seen.add(blockId);
	}

	reset(): void {
		this.calls.clear();
		this.blocksByMethod.clear();
		this.blocks.clear();
	}

	snapshot(): OpSnapshot {
		const byMethod = [...this.calls]
			.map(([method, calls]) => ({ method, calls, blocks: this.blocksByMethod.get(method)?.size ?? 0 }))
			.sort((a, b) => b.calls - a.calls);
		return {
			total: byMethod.reduce((sum, m) => sum + m.calls, 0),
			distinctBlocks: this.blocks.size,
			byMethod
		};
	}
}

/** Per-method `calls/distinct-blocks`, busiest first — the measurement table on one line. */
export function formatBreakdown(snapshot: OpSnapshot): string {
	return snapshot.byMethod.map((m) => `${m.method} ${m.calls}/${m.blocks}`).join(', ');
}

/**
 * One line per phase, in the `calls / distinct blocks` shape. `prefix` is the
 * calling spec's greppable tag (e.g. `storage-op-budget`, `strand-write-budget`)
 * so each suite's lines stay grep-distinct in a shared run log.
 */
export function formatSnapshot(prefix: string, label: string, snapshot: OpSnapshot): string {
	return `[${prefix}] ${label}: ${snapshot.total} ops over ${snapshot.distinctBlocks} distinct blocks — ${formatBreakdown(snapshot)}`;
}

/**
 * Counting passthrough over a real `IRawStorage`. Every method records BEFORE
 * delegating, so an operation is counted when it is issued rather than when it
 * settles — that is what the device pays for.
 *
 * The two iterable methods return the inner iterable directly instead of being
 * `async *` generators: a generator would not count until something started
 * iterating it, which would undercount an issued-but-abandoned listing.
 *
 * Written out method by method rather than as a `Proxy` so it type-checks against
 * `IRawStorage` — a new method on that interface should fail the build here, not
 * silently go uncounted.
 */
export class CountingRawStorage implements IRawStorage {
	/**
	 * Mirrors `KvRawStorage`: the optional members exist only when the inner storage
	 * has them, because callers feature-detect (`typeof storage.listBlockIds === 'function'`).
	 * A stub here would change what the node under measurement actually does.
	 */
	listBlockIds?: () => AsyncIterable<BlockId>;
	getApproximateBytesUsed?: () => Promise<number>;

	constructor(
		private readonly inner: IRawStorage,
		private readonly counter: StorageOpCounter
	) {
		if (inner.listBlockIds) {
			this.listBlockIds = () => {
				this.counter.record('listBlockIds');
				return inner.listBlockIds!();
			};
		}
		if (inner.getApproximateBytesUsed) {
			this.getApproximateBytesUsed = () => {
				this.counter.record('getApproximateBytesUsed');
				return inner.getApproximateBytesUsed!();
			};
		}
	}

	getMetadata(blockId: BlockId): Promise<BlockMetadata | undefined> {
		this.counter.record('getMetadata', blockId);
		return this.inner.getMetadata(blockId);
	}

	saveMetadata(blockId: BlockId, metadata: BlockMetadata): Promise<void> {
		this.counter.record('saveMetadata', blockId);
		return this.inner.saveMetadata(blockId, metadata);
	}

	getRevision(blockId: BlockId, rev: number): Promise<ActionId | undefined> {
		this.counter.record('getRevision', blockId);
		return this.inner.getRevision(blockId, rev);
	}

	saveRevision(blockId: BlockId, rev: number, actionId: ActionId): Promise<void> {
		this.counter.record('saveRevision', blockId);
		return this.inner.saveRevision(blockId, rev, actionId);
	}

	listRevisions(blockId: BlockId, startRev: number, endRev: number): AsyncIterable<ActionRev> {
		this.counter.record('listRevisions', blockId);
		return this.inner.listRevisions(blockId, startRev, endRev);
	}

	getPendingTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		this.counter.record('getPendingTransaction', blockId);
		return this.inner.getPendingTransaction(blockId, actionId);
	}

	savePendingTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void> {
		this.counter.record('savePendingTransaction', blockId);
		return this.inner.savePendingTransaction(blockId, actionId, transform);
	}

	deletePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		this.counter.record('deletePendingTransaction', blockId);
		return this.inner.deletePendingTransaction(blockId, actionId);
	}

	listPendingTransactions(blockId: BlockId): AsyncIterable<ActionId> {
		this.counter.record('listPendingTransactions', blockId);
		return this.inner.listPendingTransactions(blockId);
	}

	getTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		this.counter.record('getTransaction', blockId);
		return this.inner.getTransaction(blockId, actionId);
	}

	saveTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void> {
		this.counter.record('saveTransaction', blockId);
		return this.inner.saveTransaction(blockId, actionId, transform);
	}

	getBlockProof(blockId: BlockId, rev: number): Promise<BlockCommitProof | undefined> {
		this.counter.record('getBlockProof', blockId);
		return this.inner.getBlockProof(blockId, rev);
	}

	saveBlockProof(blockId: BlockId, rev: number, proof: BlockCommitProof): Promise<void> {
		this.counter.record('saveBlockProof', blockId);
		return this.inner.saveBlockProof(blockId, rev, proof);
	}

	getMaterializedBlock(blockId: BlockId, actionId: ActionId): Promise<IBlock | undefined> {
		this.counter.record('getMaterializedBlock', blockId);
		return this.inner.getMaterializedBlock(blockId, actionId);
	}

	saveMaterializedBlock(blockId: BlockId, actionId: ActionId, block?: IBlock): Promise<void> {
		this.counter.record('saveMaterializedBlock', blockId);
		return this.inner.saveMaterializedBlock(blockId, actionId, block);
	}

	promotePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		this.counter.record('promotePendingTransaction', blockId);
		return this.inner.promotePendingTransaction(blockId, actionId);
	}
}
