/**
 * Look INSIDE a node's own block store, so a test can prove a block physically
 * lives there rather than merely being readable through it.
 *
 * WHY THIS EXISTS. A cross-node `select` proves VISIBILITY, not storage. Optimystic's
 * `NetworkTransactor` picks one coordinator peer per block, and that coordinator answers
 * from its OWN local storage first (`CoordinatorRepo.get` → `storageRepo.get`, consulting
 * the cohort only when the block is missing locally or read-repair says stale). So when a
 * block's coordinator resolves to the AUTHORING node, the other node's `select` is a
 * remote call against the author's storage and nothing needs to live on the reader. A
 * test that wants to assert replication has to read the reader's raw store directly —
 * which is what this module is for.
 *
 * THE CONFOUND EVERY CALLER MUST AVOID. A read issued THROUGH the node under test can
 * itself pull a block into that node's local store: `CoordinatorRepo.restoreCorroborated`
 * calls `acquireBlockFromCohort`, which persists via `saveReplicatedBlock`. Probing a
 * store after the test has already read that data through the same node's database
 * therefore proves only "the bytes are here now", not "replication put them here". A
 * replication proof must write on the author and poll the other node's RAW STORE, never
 * its database. This module cannot enforce that; the test must.
 *
 * SCOPE KEYS. `CadreNodeConfig.storage.provider` is a per-scope factory: cadre-core calls
 * it as `provider('control')` for the control database and as `provider(strandId)` for
 * each strand (`cadre-node.ts` → `buildControlNodeOptions`, `strand-instance-manager.ts` →
 * `resolveStrandStorage`). {@link captureRawStorage} keys the stores it hands out by that
 * scope string, so a test can grab exactly the strand-scoped store with control-database
 * blocks cleanly excluded.
 */

import type { ActionId, ActionRev, BlockId } from '@optimystic/db-core';
import { MemoryRawStorage, type IRawStorage } from '@optimystic/db-p2p';

/** The scope key cadre-core uses for the control database's storage. */
const CONTROL_SCOPE = 'control';

/** Raised by every probe helper here, so a misuse never reads as a convergence timeout. */
export class BlockStoreProbeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BlockStoreProbeError';
	}
}

/**
 * Every raw store a node's config handed out, keyed by the scope it was asked for.
 *
 * One capture belongs to ONE node. Two nodes sharing a capture would share their stores
 * and any replication assertion between them would pass for the worst possible reason —
 * see {@link RawStorageCapture.forStrand}, which refuses that shape when it can see it.
 */
export interface RawStorageCapture {
	/** Pass as `storage.provider` in a `CadreNodeConfig`. */
	provider: (scope: string) => IRawStorage;
	/** The store created for `strandId`; throws naming the scopes seen if absent. */
	forStrand(strandId: string): IRawStorage;
	/** Every scope the provider has been asked for so far (`'control'` plus strand ids). */
	scopes(): string[];
}

/**
 * A storage provider that remembers the store it made for each scope.
 *
 * MEMOIZED PER SCOPE, deliberately: cadre-core calls the provider again whenever a strand
 * runtime is rebuilt (`startStrand` and `resumeStrand` both go through
 * `buildStrandRuntime`). A factory that minted a fresh `MemoryRawStorage` each time would
 * silently drop the strand's blocks on a resume — and would leave `forStrand` returning a
 * store the live node is no longer writing to. Memoizing makes the capture behave like a
 * real persistent provider (one directory per scope), which is the shape under test.
 *
 * @param factory - Builds one store. Defaults to an in-memory store, which is what every
 *   scenario in this package uses.
 */
export function captureRawStorage(factory: () => IRawStorage = () => new MemoryRawStorage()): RawStorageCapture {
	const stores = new Map<string, IRawStorage>();

	const provider = (scope: string): IRawStorage => {
		const existing = stores.get(scope);
		if (existing) return existing;
		const created = factory();
		stores.set(scope, created);
		return created;
	};

	const forStrand = (strandId: string): IRawStorage => {
		if (strandId === CONTROL_SCOPE) {
			throw new BlockStoreProbeError(
				`'${CONTROL_SCOPE}' is the control database's scope, not a strand id — forStrand cannot serve it`,
			);
		}
		const store = stores.get(strandId);
		if (!store) {
			throw new BlockStoreProbeError(
				`no raw store was created for strand '${strandId}'; scopes seen so far: [${[...stores.keys()].join(', ')}]`,
			);
		}
		// Scope collapse: if the control scope and the strand scope resolved to the SAME
		// object, this capture is not actually per-scope (e.g. a `factory` returning a
		// shared singleton) and every comparison below would silently include control
		// blocks. Fail naming the cause rather than compare garbage.
		if (store === stores.get(CONTROL_SCOPE)) {
			throw new BlockStoreProbeError(
				`strand '${strandId}' and the control database resolved to the SAME raw store — ` +
				'the capture is not per-scope, so strand-only comparisons are impossible',
			);
		}
		return store;
	};

	return { provider, forStrand, scopes: () => [...stores.keys()] };
}

/**
 * Every block this store holds durably, mapped to its latest COMMITTED revision.
 *
 * Blocks whose metadata carries no `latest` are omitted: `savePendingTransaction` seeds
 * metadata for a block that has not committed here, and a pending-only block is not yet a
 * durability claim about this node.
 *
 * @throws {BlockStoreProbeError} if the backend does not implement the optional
 *   `listBlockIds`. Reporting an empty index instead would make every coverage assertion
 *   built on it pass vacuously.
 */
export async function readBlockIndex(storage: IRawStorage): Promise<Map<BlockId, ActionRev>> {
	if (!storage.listBlockIds) {
		throw new BlockStoreProbeError(
			'raw storage does not implement the optional listBlockIds(); a block index cannot be read from it',
		);
	}
	const index = new Map<BlockId, ActionRev>();
	for await (const blockId of storage.listBlockIds()) {
		const metadata = await storage.getMetadata(blockId);
		if (metadata?.latest) index.set(blockId, metadata.latest);
	}
	return index;
}

/**
 * A predicate accepting only blocks that are NEW or have ADVANCED since `baseline`.
 *
 * Pass as {@link BlockCoverageOptions.include} to compare a node against only the work
 * done after some moment — the blocks a peer authored after another peer joined its
 * cohort, say — rather than against everything it has ever held.
 */
export function newOrAdvancedSince(
	baseline: ReadonlyMap<BlockId, ActionRev>,
): (blockId: BlockId, sourceRev: ActionRev) => boolean {
	return (blockId, sourceRev) => {
		const before = baseline.get(blockId);
		return before === undefined || sourceRev.rev > before.rev;
	};
}

/** How to narrow a {@link compareBlockCoverage} run. */
export interface BlockCoverageOptions {
	/**
	 * Restrict the comparison to the subset of `source`'s blocks this accepts. Omitted,
	 * every block `source` holds must be covered. See {@link newOrAdvancedSince} for the
	 * "only what was authored after moment X" narrowing.
	 */
	include?: (blockId: BlockId, sourceRev: ActionRev) => boolean;
}

/** What `target` is missing relative to `source`; every field empty means full coverage. */
export interface BlockCoverageGap {
	/** Block ids present in source, absent from target. */
	absent: BlockId[];
	/** Block ids present in target at a strictly older revision than source. */
	behind: Array<{ blockId: BlockId; sourceRev: number; targetRev: number }>;
	/** Block ids present at the right revision but with no content bytes stored. */
	metadataOnly: BlockId[];
}

/**
 * Whether `target` physically holds everything `source` does, at least as fresh.
 *
 * ONE-DIRECTIONAL by design: `target` may legitimately hold blocks `source` does not, and
 * may sit at a HIGHER revision. This is `source ⊆ target` at `targetRev >= sourceRev`,
 * never set equality and never revision equality.
 *
 * REPORTS, never asserts — a caller turning a gap into a failure can then name the
 * offending block ids, which a bare boolean could not.
 */
export async function compareBlockCoverage(
	source: IRawStorage,
	target: IRawStorage,
	options: BlockCoverageOptions = {},
): Promise<BlockCoverageGap> {
	const [sourceIndex, targetIndex] = await Promise.all([readBlockIndex(source), readBlockIndex(target)]);
	const gap: BlockCoverageGap = { absent: [], behind: [], metadataOnly: [] };

	for (const [blockId, sourceRev] of sourceIndex) {
		if (options.include && !options.include(blockId, sourceRev)) continue;
		const targetRev = targetIndex.get(blockId);
		if (!targetRev) {
			gap.absent.push(blockId);
		} else if (targetRev.rev < sourceRev.rev) {
			gap.behind.push({ blockId, sourceRev: sourceRev.rev, targetRev: targetRev.rev });
		} else if (!await hasContentBytes(target, blockId, targetRev.actionId)) {
			gap.metadataOnly.push(blockId);
		}
	}
	return gap;
}

/**
 * Whether the store holds the block's actual content for `actionId`, in EITHER of the two
 * legitimate shapes: a block replicated in through `saveReplicatedBlock` lands
 * materialized, while a block this node committed locally has its transform promoted into
 * the transaction store. Demanding one specific shape would report a false negative for
 * whichever half of the blocks arrived the other way.
 */
async function hasContentBytes(storage: IRawStorage, blockId: BlockId, actionId: ActionId): Promise<boolean> {
	if (await storage.getMaterializedBlock(blockId, actionId)) return true;
	return (await storage.getTransaction(blockId, actionId)) !== undefined;
}

/** Whether a gap is empty — i.e. the target covers the source. */
export function blockCoverageIsComplete(gap: BlockCoverageGap): boolean {
	return gap.absent.length === 0 && gap.behind.length === 0 && gap.metadataOnly.length === 0;
}

/** A one-line, block-id-naming rendering of a gap, for assertion and timeout messages. */
export function formatBlockCoverageGap(gap: BlockCoverageGap): string {
	if (blockCoverageIsComplete(gap)) return 'no gap (target covers source)';
	const parts: string[] = [];
	if (gap.absent.length > 0) parts.push(`absent: [${gap.absent.join(', ')}]`);
	if (gap.behind.length > 0) {
		parts.push(`behind: [${gap.behind.map(b => `${b.blockId} (source rev ${b.sourceRev} > target rev ${b.targetRev})`).join(', ')}]`);
	}
	if (gap.metadataOnly.length > 0) parts.push(`metadata-only (no content bytes): [${gap.metadataOnly.join(', ')}]`);
	return parts.join('; ');
}
