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
 * Lives outside `control-database.ts` so a spec can drive the classifier against real engine
 * errors without importing the whole database class.
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

/** The network transactor's aggregate, raised when some cohort peers gave no usable answer. */
const TRANSACTOR_AGGREGATE = /Some peers did not complete:/;

/**
 * How the aggregate's per-batch details name a SINGLE-block batch — the shape both the block
 * read (`get`) and phase 1 (`pend`) format, and the only shape safe to re-present.
 */
const SINGLE_BLOCK_BATCH_TOKEN = '[block:';

/**
 * How the aggregate's per-batch details name a MULTI-block batch — the shape phase 2
 * (`commitBlocks`) formats, and the marker of an outcome too indeterminate to retry.
 */
const COMMIT_BATCH_TOKEN = '[blocks:';

/**
 * The cluster coordinator's super-majority shortfall (`db-p2p/src/repo/cluster-coordinator.ts`),
 * matched ONLY with a ZERO rejection count. The same message with a non-zero count means a
 * member actually voted no (that branch carries `membership-not-admitted` rejections), and
 * retrying it would re-present a spent signature to a cohort that already refused it. This one
 * is raised while collecting PROMISES, before any commit, so re-presenting it is safe. A
 * decisive rejection is a different error entirely (`ValidatorRejectionError`,
 * `Transaction rejected by validators`), which this classifier also never matches.
 */
const SUPER_MAJORITY_SHORTFALL_UNANSWERED =
	/Failed to get super-majority: \d+\/\d+ approvals \(needed \d+, 0 rejections\)/;

/**
 * Is this a transactor aggregate from a phase where nothing can have committed yet?
 *
 * The transactor raises `Some peers did not complete:` from three sites
 * (`db-core/src/transactor/network-transactor.ts`), and only two of them are safe to
 * re-present:
 *
 * - `get` (a block read, which a write body also performs) and `pend` (phase 1) fail before
 *   anything commits, so the write is known not to have landed;
 * - `commitBlocks` (phase 2) is REACHABLE here and NOT safe. `commitBlock` throws the
 *   aggregate when a header/tail commit got NO response at all — precisely the transient
 *   class this retry targets — and that escapes `commit()`, survives `TransactorSource`'s
 *   cancel-and-rethrow (cancel reaches PENDING actions only; a peer that already committed
 *   stays committed) and `Collection.syncInternal` (which retries StaleFailure RETURN values,
 *   not throws), reaching this funnel QuereusError-wrapped. The tail commit is one batch to
 *   one coordinator running consensus internally, so a no-response there is INDETERMINATE:
 *   the commit may have completed with only the response lost. Re-running the write body over
 *   a write that landed turns a success into a constraint failure (e.g.
 *   `UNIQUE constraint failed: CadrePeer.PeerId`). Surfacing the transient error instead lets
 *   the caller re-read committed state and decide. Commit-phase messages are vetoed by
 *   {@link reportsIndeterminateCommit}, not here.
 *
 * The `cause` chain does not discriminate the phases — a commit-phase aggregate carries the
 * same stream-reset/dial error a pend-phase one does. The per-batch DETAIL text does: `get`
 * and `pend` format `<peerId>[block:<id>](<status>)`, `commitBlocks` formats
 * `<peerId>[blocks:<count>](<status>)`. `[block:` cannot occur inside `[blocks:`, so the two
 * tokens are disjoint and separate the phases.
 *
 * NOTE: the discriminator is a formatting detail of another repo. If Optimystic ever reformats
 * those per-batch details, this fails CLOSED — the aggregate stops matching and control writes
 * simply stop being retried, silently losing the absorption rather than doing anything unsafe.
 * The guard against that is a scenario asserting the classifier against a live cluster failure
 * (`control-write-retry-scenario-coverage`); if that lands and later reddens here, an upstream
 * reformat is the first thing to check.
 *
 * An aggregate whose details came out EMPTY (possible when `formatBatchStatuses` has no
 * batches to format) carries neither token, matches nothing here, and is not retried — an
 * unattributable failure is not a proven non-commit.
 */
function isUncommittedTransactorAggregate(message: string): boolean {
	return TRANSACTOR_AGGREGATE.test(message) && message.includes(SINGLE_BLOCK_BATCH_TOKEN);
}

/**
 * Does ANY message in the failure's `cause` chain describe a commit-phase batch — i.e. an
 * outcome nobody can call committed or not?
 *
 * Vetoes the whole chain rather than the one message carrying the token, and vetoes it
 * regardless of which matcher would otherwise have claimed it. The narrower per-message rule
 * would already catch every shape the transactor is known to build (a commit-phase aggregate
 * emits `[blocks:` for every batch it formats, and embeds its cause's message inline as
 * `root: …`, so both tokens land in one string) — but "known to build" is an argument about
 * another repo's error assembly, and this way an indeterminate commit anywhere in the chain
 * costs a retry we could have had instead of risking a re-run over a write that landed.
 */
function reportsIndeterminateCommit(messages: readonly string[]): boolean {
	return messages.some(message => message.includes(COMMIT_BATCH_TOKEN));
}

/** The coordinator's shortfall, raised pre-commit, with nobody having voted no. */
function isUnansweredSuperMajorityShortfall(message: string): boolean {
	return SUPER_MAJORITY_SHORTFALL_UNANSWERED.test(message);
}

/**
 * The error messages that mean "the cohort did not answer AND nothing committed", and nothing
 * else. The observed one-shot failure was `registerSelf()` racing a connection still forming:
 * a read/pend-phase transactor aggregate with `cause=The stream has been reset`.
 *
 * Deliberately NOT matched: every constraint / authorization failure
 * (`CHECK constraint failed:`, `UNIQUE constraint failed:`) — those reach the same funnel
 * and must be retried zero times. In particular the lost-use-number messages
 * (`isLostUseNumberRace` in `control-database.ts`) are constraint failures, so this
 * classifier and that one are DISJOINT and the two retry loops can never multiply.
 */
const RETRIABLE_CONTROL_WRITE_MATCHERS: readonly ((message: string) => boolean)[] = [
	isUncommittedTransactorAggregate,
	isUnansweredSuperMajorityShortfall,
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
 * {@link reportsIndeterminateCommit} vetoes the whole chain before any matcher runs, so a
 * failure that reports a commit-phase batch anywhere is never retried on the strength of some
 * other level looking transient.
 *
 * NOTE: this depends on engine/transactor error TEXT. The messages producible without a
 * network are driven from the REAL engine in `control-formation-use-number-retry.spec.ts`, so
 * a rewording reddens a spec rather than silently disabling the retry. The two RETRIABLE
 * messages need a real multi-node cluster to produce and are still literals in
 * `control-write-retry.spec.ts`; `control-write-retry-scenario-coverage` closes that gap.
 */
export function isRetriableControlWriteFailure(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const messages = unwrapError(error).map(({ message }) => message);
	if (reportsIndeterminateCommit(messages)) {
		return false;
	}
	return messages.some(message =>
		RETRIABLE_CONTROL_WRITE_MATCHERS.some(matches => matches(message)));
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
