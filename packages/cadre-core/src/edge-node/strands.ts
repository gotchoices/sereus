/**
 * Strand helpers every edge app needs around a running node, from sereus-chat's bring-up.
 */

import { StrandAwaitingFirstSyncError } from '../strand-first-sync-gate.js';
import type { CadreNode } from '../cadre-node.js';
import type { StrandConfig, StrandInstance } from '../types.js';
import { causeChain, reportsUnansweredShortfall } from '../control-retry.js';

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
 * Optimystic's cluster coordinator reporting a write too few of the cohort answered. Transient right
 * after a node restarts alone: its cohort has not reconnected yet. A lone node's own refusal to
 * write by itself is claimed too — `CoordinatorRepo.refuseSoloPend` builds the shortfall with
 * `approvals: 1, rejections: 0`, a zero rejection count like any silent-cohort shortfall, and
 * `soloRefused` naming why, which nothing here branches on.
 *
 * The SAME predicate the control-write classifier claims the shortfall with
 * ({@link reportsUnansweredShortfall}), so the funnel every control write passes through and this
 * helper cannot drift apart on which shortfall is worth re-presenting. What this helper does NOT
 * share is that funnel's commit-phase veto: it wraps an app's own write, with no transactor
 * aggregate around it to read a phase off.
 *
 * Matching the class rather than the sentence NARROWS this helper, deliberately. A shortfall
 * carrying a REJECTION is no longer claimed (a member voted no, and no backoff changes that), nor is
 * a non-`Error` throw, which can carry no typed link at all — and this helper sleeps 3 s between
 * five attempts, so claiming one on its text would spend 12 s before the identical failure.
 *
 * It does not measurably widen the reach, despite now walking the chain: the old match read
 * `describeThrown(err)`, the top-level `message` alone, but every wrapper between the raise site and
 * an app interpolates the inner message into its own, so the sentence was visible there anyway.
 * Reaching the typed link at any depth is what makes the claim independent of that — an upstream
 * rewording, or a wrapper that summarises instead of interpolating, no longer silently disables the
 * retry.
 */
function isTransientWriteFailure(err: unknown): boolean {
	return reportsUnansweredShortfall(causeChain(err));
}
