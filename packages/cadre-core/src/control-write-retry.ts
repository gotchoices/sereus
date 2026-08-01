import debug from 'debug';
import { unwrapError } from '@quereus/quereus';

const log = debug('sereus:cadre:control-db');

/**
 * Bounded retry for TRANSIENT control-write failures — the classifier and loop behind
 * `ControlDatabase.lockedWithRetry`, the single funnel every local control write passes
 * through.
 *
 * Why this exists: the control database replicates every block to the whole party, so a
 * three-machine party commits control writes unanimously (`ceil(3 × 0.75) = 3` approvals) —
 * and no `superMajorityThreshold` can lower that bar without violating Optimystic's
 * partition-safety condition at the shipped admission fraction (the arithmetic lives in
 * `docs/architecture.md` → "Replication cluster size"). Cadre therefore accepts unanimity
 * and absorbs the transient half of its cost here: a write that failed because the cohort
 * did not ANSWER (a stream reset mid-connection-formation, zero approvals) is re-presented
 * a moment later, which the degraded-cohort-member scenario measured as safe (a failed
 * write rolls back, nothing half-commits) and effective (the next write commits in ~1 s).
 *
 * A write somebody actually REJECTED is never retried — re-presenting it would re-present
 * a spent signature against a cohort that already said no.
 *
 * Lives outside `control-database.ts` so the integration package can drive the classifier
 * against real engine errors (follow-up ticket `control-write-retry-real-error-coverage`)
 * without importing the whole database class.
 */

/**
 * Attempts allowed per control write: the first, plus two retries of a transiently-failed
 * cluster commit. Bounded so a genuinely unreachable cohort terminates in the transactor's
 * own error rather than spinning; two retries covers the observed failure (a stream still
 * forming when the write fired) with margin.
 */
export const CONTROL_WRITE_ATTEMPTS = 3;

/**
 * Elapsed-time ceiling on the whole retry loop, measured from the START of the first
 * attempt and checked after a failed attempt BEFORE sleeping.
 *
 * This budget — not the attempt count — is what makes the policy safe to sit under every
 * control write. A transient failure (stream reset while a connection is still forming)
 * surfaces in well under a second, so it is retried and the loop adds at most ~2.2 s. A
 * genuinely silent cohort member fails at ~20 s (two 10 s `ClusterClient` response-deadline
 * attempts, measured in `control-write-degraded-cohort-member.integration.ts`), which
 * already exceeds this budget when attempt 1 returns — so that case is surfaced immediately
 * and retry adds ZERO latency to the case where it cannot help.
 */
export const CONTROL_WRITE_RETRY_BUDGET_MS = 10_000;

/**
 * Backoff before retry N, jittered ±50% (so the first sleep is 125–375 ms — the jitter can
 * never floor a delay to zero). Each single sleep is additionally capped at the LARGEST
 * delay in the list, so a `stop()` racing a backoff is never held up by more than ~1 s.
 * There is no `AbortSignal` at this seam to cancel a sleep outright; the cap is the
 * substitute, deliberately not plumbing one through every write path.
 */
const CONTROL_WRITE_RETRY_DELAYS_MS: readonly number[] = [250, 1_000];

/**
 * The two error messages that mean "the cohort did not answer", and nothing else.
 *
 * - `Some peers did not complete:` — the network transactor's aggregate
 *   (`db-core/src/transactor/network-transactor.ts`), the surface a reset stream produces.
 *   The observed one-shot failure was exactly this: `registerSelf()` racing a connection
 *   still forming, `cause=The stream has been reset`.
 *
 *   NOTE: the transactor raises this message from THREE sites — `get` (a block read, which
 *   a write body also performs), `pend` (phase 1, nothing committed) and `commitBlocks`
 *   (phase 2). The first two are unambiguously safe to re-present. The commit-phase one is
 *   the open question: `TransactorSource.transact` cancels the pend and rethrows, but peers
 *   that already committed stay committed, so a retried body could re-issue SQL over a write
 *   that partly landed and surface a constraint failure instead of the transient error.
 *   Unobserved and narrow (it needs a commit-phase partial failure to survive the
 *   transactor's own budget); establishing whether it is reachable, and narrowing this
 *   pattern if it is, is an arm of `control-write-retry-real-error-coverage`.
 * - `Failed to get super-majority: N/M approvals (needed K, 0 rejections)` — the cluster
 *   coordinator's shortfall error (`db-p2p/src/repo/cluster-coordinator.ts`), matched ONLY
 *   with a zero rejection count. The same message with a non-zero count means a member
 *   actually voted no (that branch carries `membership-not-admitted` rejections), and
 *   retrying it would re-present a spent signature to a cohort that already refused it.
 *   This one is raised while collecting PROMISES, before any commit, so re-presenting it is
 *   safe. A decisive rejection is a different error entirely (`ValidatorRejectionError`,
 *   `Transaction rejected by validators`), which this classifier also never matches.
 *
 * Deliberately NOT matched: every constraint / authorization failure
 * (`CHECK constraint failed:`, `UNIQUE constraint failed:`) — those reach the same funnel
 * and must be retried zero times. In particular the lost-use-number messages
 * (`isLostUseNumberRace` in `control-database.ts`) are constraint failures, so this
 * classifier and that one are DISJOINT and the two retry loops can never multiply.
 */
const RETRIABLE_CONTROL_WRITE_PATTERNS = [
	/Some peers did not complete:/,
	/Failed to get super-majority: \d+\/\d+ approvals \(needed \d+, 0 rejections\)/,
];

/**
 * Did this control write fail because the cluster cohort did not ANSWER — i.e. is
 * re-presenting the SAME signed write a moment later the right response?
 *
 * Classifies by MESSAGE, walking the `cause` chain with Quereus' own {@link unwrapError} —
 * the exact shape of `isLostUseNumberRace`, for the same reason: neither surface is
 * recognisable by type. The transactor and the coordinator both throw bare `Error`s, and by
 * the time one reaches `ControlDatabase` it is wrapped in a `QuereusError` (the real chain
 * is `QuereusError` → `Error` → `Error`), so the match must work at any depth. Anything
 * that is not an `Error` is never retried.
 *
 * NOTE: this depends on engine/transactor error TEXT. The literal-string classifier table
 * lives in `control-write-retry.spec.ts`; producing these messages from the real engine so
 * a rewording fails a spec instead of silently disabling the retry is the follow-up ticket
 * `control-write-retry-real-error-coverage`.
 */
export function isRetriableControlWriteFailure(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	return unwrapError(error).some(({ message }) =>
		RETRIABLE_CONTROL_WRITE_PATTERNS.some(pattern => pattern.test(message)));
}

/**
 * Test seams for {@link retryControlWrite}'s pacing. Production callers pass nothing;
 * specs inject a recorded `sleep`, a shorter delay list, or a fake clock so no test ever
 * waits out a real backoff.
 */
export interface ControlWriteRetryOptions {
	/** Backoff base before retry N (last entry repeats). Default {@link CONTROL_WRITE_RETRY_DELAYS_MS}. */
	delaysMs?: readonly number[];
	/** The sleep primitive. Default: `setTimeout`. */
	sleep?: (ms: number) => Promise<void>;
	/** Clock for the elapsed-budget check. Default: `Date.now`. */
	now?: () => number;
}

/**
 * Run `attempt` up to {@link CONTROL_WRITE_ATTEMPTS} times, retrying only failures
 * {@link isRetriableControlWriteFailure} classifies as transient and only while
 * {@link CONTROL_WRITE_RETRY_BUDGET_MS} has not elapsed.
 *
 * `attempt` must be atomic and re-runnable: a failed cluster write rolls back (nothing is
 * half-applied), and re-running the body re-runs its reads too — `ControlDatabase`'s
 * locked write bodies all satisfy this (see the contract on
 * `ControlDatabase.withWriteLock`). The backoff sleeps happen with NO lock held; the caller
 * takes and releases its lock inside `attempt`.
 *
 * On exhaustion (attempts or budget) the LAST error is rethrown unchanged — never wrapped,
 * so the exact messages downstream code and the degraded-cohort-member scenario assert on
 * survive. A non-retriable failure propagates from the attempt that raised it.
 */
export async function retryControlWrite<T>(
	attempt: () => Promise<T>,
	options: ControlWriteRetryOptions = {}
): Promise<T> {
	const delays = options.delaysMs ?? CONTROL_WRITE_RETRY_DELAYS_MS;
	const sleep = options.sleep ?? defaultSleep;
	const now = options.now ?? Date.now;
	const start = now();
	let lastError: unknown;
	let attemptsMade = 0;
	for (let attemptNumber = 1; attemptNumber <= CONTROL_WRITE_ATTEMPTS; attemptNumber++) {
		attemptsMade = attemptNumber;
		try {
			const result = await attempt();
			if (attemptNumber > 1) {
				log('Control write committed on attempt %d/%d', attemptNumber, CONTROL_WRITE_ATTEMPTS);
			}
			return result;
		} catch (error) {
			if (!isRetriableControlWriteFailure(error)) {
				throw error;
			}
			lastError = error;
			if (attemptNumber === CONTROL_WRITE_ATTEMPTS) {
				break;
			}
			const elapsed = now() - start;
			if (elapsed >= CONTROL_WRITE_RETRY_BUDGET_MS) {
				break;
			}
			const delay = jitteredDelay(delays, attemptNumber);
			log('Control write failed transiently (attempt %d/%d), retrying in %d ms: %s',
				attemptNumber, CONTROL_WRITE_ATTEMPTS, delay, error);
			await sleep(delay);
		}
	}
	log('Control write failed after %d/%d attempt(s): %s', attemptsMade, CONTROL_WRITE_ATTEMPTS, lastError);
	throw lastError;
}

/**
 * Backoff for the retry that follows attempt `attemptNumber`: the matching base delay
 * (last entry repeats), jittered ±50%, then capped at the list's largest base so no single
 * sleep exceeds it (see {@link CONTROL_WRITE_RETRY_DELAYS_MS} for why). `Math.random` is
 * fine here — the jitter only de-synchronizes concurrent retriers, nothing is derived
 * from it.
 *
 * NOTE: the cap bites on the LAST delay, whose base IS the largest, so ~half of those sleeps
 * land exactly on the cap rather than spread — de-synchronization is only partial there.
 * Harmless while retriers are a handful of party nodes whose attempts already start seconds
 * apart; if a party ever retries in a tight synchronized herd, raise the cap above the
 * largest base instead of jittering about it.
 */
function jitteredDelay(delays: readonly number[], attemptNumber: number): number {
	if (delays.length === 0) {
		return 0;
	}
	const base = delays[Math.min(attemptNumber - 1, delays.length - 1)]!;
	const jittered = base * (0.5 + Math.random());
	return Math.min(jittered, Math.max(...delays));
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
