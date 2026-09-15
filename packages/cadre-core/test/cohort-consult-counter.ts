import { CoordinatorRepo } from '@optimystic/db-p2p';
import type { BlockId } from '@optimystic/db-core';

/**
 * Counts the control plane's cost ABOVE the write-through storage cache: how often
 * Optimystic's coordinator consults a block's cohort (the machines responsible for it)
 * for the latest revision, and how many commits a flow issues. Neither reaches
 * `IRawStorage`, so `storage-op-counter.ts` cannot see them.
 *
 * What is counted:
 *  - a CONSULT is one call of `CoordinatorRepo.fetchBlockFromCluster` — the per-block pass
 *    `CoordinatorRepo.get` runs for a block missing locally (every read) or held past its
 *    read-repair window (at most once per `readRepairWindowMs`, 10 s by default). On a
 *    cohort of one it is a local `findCluster`; on a party of several machines it is a
 *    round trip to every other cohort member. The count is the portable signal.
 *  - a COMMIT is one call of `CoordinatorRepo.commit`.
 *
 * Wraps the prototype, so the patch is process-wide: install it before the node under
 * measurement starts and `restore()` it in a `finally`. Vitest runs each spec file in its
 * own worker, so it cannot leak across files, only across tests of one file.
 *
 * Not a `*.spec.ts` file, so vitest's `test/**\/*.spec.ts` glob never runs it as a suite.
 */

export interface ConsultSnapshot {
	/** `fetchBlockFromCluster` calls. */
	consults: number;
	/** Distinct block ids those consults named. */
	distinctBlocks: number;
	/** `commit` calls. */
	commits: number;
	/** Consults per block id, busiest first. */
	perBlock: Map<BlockId, number>;
}

export interface ConsultCounter {
	/**
	 * Tallies since install or the last {@link reset}. `label` narrows to the repos given
	 * that label by {@link labelUnlabeled}; omitted, every repo counts, labelled or not.
	 */
	snapshot(label?: string): ConsultSnapshot;
	/** Zero every tally. Labels are identities, not tallies, so they survive. */
	reset(): void;
	/**
	 * Give `label` to every repo seen so far that has none yet, and return how many were
	 * labelled. Call it at the end of the phase that brought a repo into being — after
	 * `start()` for the control network's repo, after `foundStrand` for the strand's.
	 */
	labelUnlabeled(label: string): number;
	/** How many repos carry `label`. */
	instanceCount(label: string): number;
	/**
	 * Reinstate the methods that were installed before this counter. A no-op once it has
	 * succeeded; throws (without marking itself restored) while a later patch is still
	 * installed over this one — restore in reverse order of application, as
	 * `packages/integration-tests/src/harness/key-network-patch.ts` does.
	 */
	restore(): void;
}

/** The consult method is TypeScript-private; this is the shape the one cast below asserts. */
type ConsultMethod = (this: CoordinatorRepo, blockId: BlockId, ...rest: unknown[]) => Promise<unknown>;
type CommitMethod = CoordinatorRepo['commit'];

interface PatchableCoordinatorRepo {
	fetchBlockFromCluster: ConsultMethod;
	commit: CommitMethod;
}

interface InstanceTally {
	label?: string;
	consults: number;
	commits: number;
	perBlock: Map<BlockId, number>;
}

/**
 * Install the counter over `CoordinatorRepo.prototype`.
 *
 * @throws if `fetchBlockFromCluster` or `commit` is no longer a function on the prototype —
 *   an upstream rename must fail here rather than install a wrapper nothing calls. (A method
 *   that still exists but is no longer called is caught by the calling spec's floor.)
 */
export function installConsultCounter(): ConsultCounter {
	// The single cast: `fetchBlockFromCluster` is private, so it is not on the public type.
	const proto = CoordinatorRepo.prototype as unknown as PatchableCoordinatorRepo;
	for (const method of ['fetchBlockFromCluster', 'commit'] as const) {
		if (typeof proto[method] !== 'function') {
			throw new Error(
				`cohort-consult-counter: CoordinatorRepo.prototype.${method} is not a function — `
				+ 'renamed or removed upstream in @optimystic/db-p2p; point the counter at its replacement');
		}
	}

	const tallies = new Map<object, InstanceTally>();
	const tallyFor = (repo: object): InstanceTally => {
		let tally = tallies.get(repo);
		if (!tally) {
			tally = { consults: 0, commits: 0, perBlock: new Map() };
			tallies.set(repo, tally);
		}
		return tally;
	};

	// Recorded BEFORE delegating, so a call counts when it is issued rather than when it settles.
	const innerConsult = proto.fetchBlockFromCluster;
	const patchedConsult: ConsultMethod = function (this: CoordinatorRepo, blockId, ...rest) {
		const tally = tallyFor(this);
		tally.consults++;
		tally.perBlock.set(blockId, (tally.perBlock.get(blockId) ?? 0) + 1);
		return innerConsult.call(this, blockId, ...rest);
	};
	const innerCommit = proto.commit;
	const patchedCommit: CommitMethod = function (this: CoordinatorRepo, ...args) {
		tallyFor(this).commits++;
		return innerCommit.apply(this, args);
	};
	proto.fetchBlockFromCluster = patchedConsult;
	proto.commit = patchedCommit;

	let restored = false;
	return {
		snapshot(label?: string): ConsultSnapshot {
			let consults = 0;
			let commits = 0;
			const perBlock = new Map<BlockId, number>();
			for (const tally of tallies.values()) {
				if (label !== undefined && tally.label !== label) continue;
				consults += tally.consults;
				commits += tally.commits;
				for (const [blockId, n] of tally.perBlock) {
					perBlock.set(blockId, (perBlock.get(blockId) ?? 0) + n);
				}
			}
			const sorted = new Map([...perBlock].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
			return { consults, distinctBlocks: sorted.size, commits, perBlock: sorted };
		},
		reset(): void {
			for (const tally of tallies.values()) {
				tally.consults = 0;
				tally.commits = 0;
				tally.perBlock.clear();
			}
		},
		labelUnlabeled(label: string): number {
			let labelled = 0;
			for (const tally of tallies.values()) {
				if (tally.label !== undefined) continue;
				tally.label = label;
				labelled++;
			}
			return labelled;
		},
		instanceCount(label: string): number {
			return [...tallies.values()].filter((tally) => tally.label === label).length;
		},
		restore(): void {
			if (restored) return;
			if (proto.fetchBlockFromCluster !== patchedConsult || proto.commit !== patchedCommit) {
				throw new Error(
					'cohort-consult-counter: cannot restore CoordinatorRepo.prototype — a later patch is still '
					+ 'installed over this one. Restore in reverse order of application (last applied, first '
					+ 'restored); the counter is left installed until that happens.');
			}
			proto.fetchBlockFromCluster = innerConsult;
			proto.commit = innerCommit;
			restored = true;
		}
	};
}

/** Consults per block as `block×n`, busiest first — what an assertion message names when a phase grows. */
export function formatPerBlock(snapshot: ConsultSnapshot): string {
	return snapshot.perBlock.size === 0
		? '(no consults)'
		: [...snapshot.perBlock].map(([blockId, n]) => `${blockId}×${n}`).join(', ');
}

/** One greppable line per phase: `[<scope>] <phase>: consults=… distinctBlocks=… commits=… — <per block>`. */
export function formatConsultSnapshot(scope: string, phase: string, snapshot: ConsultSnapshot): string {
	return `[${scope}] ${phase}: consults=${snapshot.consults} distinctBlocks=${snapshot.distinctBlocks} `
		+ `commits=${snapshot.commits} — ${formatPerBlock(snapshot)}`;
}
