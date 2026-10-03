/**
 * Strand helpers every phone app needs around a running node, from sereus-chat's bring-up.
 */

import { StrandAwaitingFirstSyncError } from '@serfab/cadre-core';
import type { CadreNode, StrandConfig, StrandInstance } from '@serfab/cadre-core';

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
			`[cadre-rn/phone-node] first sync of ${config.strandRow.Id} still arriving; ` +
			`waiting up to ${patienceMs / 1000} s for it to become writable`,
		);
		return await node.whenStrandWritable(config.strandRow.Id, { timeoutMs: patienceMs });
	}
}

/**
 * Optimystic's cluster coordinator reports a write that could not gather enough approvals this
 * way. It is transient right after a node restarts alone: its cohort has not reconnected yet.
 *
 * NOTE: matched on the message because Optimystic throws a plain `Error` here. If it gains a typed
 * error, match on that instead — a reworded message would silently stop the retries.
 */
const SUPER_MAJORITY_FAILURE = /Failed to get super-majority/i;

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
			console.info(`[cadre-rn/phone-node] write attempt ${attempt} lacked a super-majority; retrying in ${delayMs} ms`);
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
}

function isTransientWriteFailure(err: unknown): boolean {
	return SUPER_MAJORITY_FAILURE.test(err instanceof Error ? err.message : String(err));
}
