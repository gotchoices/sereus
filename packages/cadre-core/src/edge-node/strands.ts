/**
 * Strand helpers every edge app needs around a running node, from sereus-chat's bring-up.
 */

import { PromiseShortfallError } from '@optimystic/db-core';
import { StrandAwaitingFirstSyncError } from '../strand-first-sync-gate.js';
import type { CadreNode } from '../cadre-node.js';
import type { StrandConfig, StrandInstance } from '../types.js';
import { causeChain } from '../control-retry.js';

/** Default patience for {@link attachStrandWhenWritable}: generous enough that running out means something is wrong. */
export const DEFAULT_STRAND_PATIENCE_MS = 240_000;

/**
 * `addStrand`, then keep waiting when the first sync outlasts its budget.
 *
 * `addStrand` rejects with `StrandAwaitingFirstSyncError` when the first sync has not finished,
 * and leaves the strand launched and syncing: the timeout is a progress report, not an outcome.
 * Measured on a link with a 1.8 s round trip, a first sync completed at about 150 s against a
 * 120 s budget. So this waits for the strand to become writable, and rejects only when it has not
 * within `patienceMs`.
 */
export async function attachStrandWhenWritable(
	node: CadreNode,
	config: StrandConfig,
	options: { patienceMs?: number } = {},
): Promise<StrandInstance> {
	try {
		return await node.addStrand(config);
	} catch (err) {
		if (!(err instanceof StrandAwaitingFirstSyncError)) throw err;
		const patienceMs = options.patienceMs ?? DEFAULT_STRAND_PATIENCE_MS;
		console.info(
			`[cadre-core/edge-node] first sync of ${config.strandRow.Id} still arriving; ` +
			`waiting up to ${patienceMs / 1000} s for it to become writable`,
		);
		return await node.whenStrandWritable(config.strandRow.Id, { timeoutMs: patienceMs });
	}
}

/**
 * Run a write, retrying only on the transient super-majority failure the first writes after a lone
 * restart hit (v1.9 release notes): `attempts` tries, `delayMs` apart. Any other error, and the
 * last attempt's, propagates.
 */
export async function retryAfterRestart<T>(
	write: () => Promise<T>,
	options: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
	const attempts = options.attempts ?? 5;
	const delayMs = options.delayMs ?? 3_000;
	for (let attempt = 1; ; attempt++) {
		try {
			return await write();
		} catch (err) {
			if (!isTransientWriteFailure(err) || attempt >= attempts) throw err;
			console.info(`[cadre-core/edge-node] write attempt ${attempt} lacked a super-majority; retrying in ${delayMs} ms`);
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
}

/**
 * Optimystic's cluster coordinator reporting a write too few of the cohort answered —
 * `PromiseShortfallError` with nobody having voted no. Transient right after a node restarts alone:
 * its cohort has not reconnected yet, and a lone node's own refusal to write by itself carries
 * `approvals: 1, rejections: 0` like any silent-cohort shortfall (`CoordinatorRepo.refuseSoloPend`),
 * so it is claimed here too.
 *
 * The same typed test the control write uses (`isUnansweredShortfall` in `control-write-retry.ts`),
 * and deliberately so — the two policies must not drift apart on which shortfall is worth
 * re-presenting. Matching the class rather than the sentence changes this helper's reach in two
 * ways, both intended:
 *
 * - it reaches ANY DEPTH. The old text match read `describeThrown(err)`, which is the top-level
 *   `message` alone, so a shortfall under any wrapper — which is every shortfall reaching an app
 *   through SQL — was silently not retried. The first writes after a lone restart, which this
 *   helper exists for, are exactly the wrapped ones.
 * - it no longer claims a shortfall carrying a REJECTION (a member voted no, and no backoff changes
 *   that), nor a non-`Error` throw, which can carry no typed link at all — and claiming one on its
 *   text would spend 12 s of sleep before the identical failure.
 *
 * `soloRefused` names why a lone node refused, and is deliberately not branched on.
 */
function isTransientWriteFailure(err: unknown): boolean {
	return causeChain(err).some(link => link instanceof PromiseShortfallError && link.rejections === 0);
}
