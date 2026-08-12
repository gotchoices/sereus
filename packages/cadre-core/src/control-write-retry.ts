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
 * TWO policies ship from here, and the split is deliberate: the default
 * ({@link isRetriableControlWriteFailure}, {@link CONTROL_WRITE_ATTEMPTS}) sits under every
 * control write, and {@link SCHEMA_INIT_RETRY_POLICY} is opted into by
 * `ControlDatabase.loadSchema` alone. The widened one absorbs one extra failure class whose
 * re-run safety holds for schema DDL and NOT for writes in general; anything added to the default
 * list must be safe for all ~19 callers.
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
 * Attempts allowed for {@link SCHEMA_INIT_RETRY_POLICY}, the one call site that also absorbs a
 * self-coordination refusal.
 *
 * Two more than {@link CONTROL_WRITE_ATTEMPTS} because what this retry buys is wall-clock for a
 * cold-starting node's bootstrap dials to land, and because the refusal is cheap to re-provoke
 * relative to a cluster round-trip: `findCoordinator` already spends its own bounded wait before
 * raising (3 attempts, 500 ms apart, `db-p2p/src/libp2p-key-network.ts` ~422) and then decides
 * LOCALLY that it may not elect itself, so no peer is contacted and no cohort deadline is
 * consumed.
 *
 * Note that the ~1 s `findCoordinator` spends internally is real, on top of this policy's own
 * backoff — which is exactly why {@link CONTROL_WRITE_RETRY_BUDGET_MS} and not this count is what
 * actually terminates the loop in the worst case.
 */
export const SCHEMA_INIT_ATTEMPTS = 5;

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
 * Backoff for {@link SCHEMA_INIT_RETRY_POLICY}, jittered and capped the same way. Worst case
 * ~4.6 s of sleep across four retries (375 + 750 + 1500 + 2000, each capped at the largest base),
 * which stays inside {@link CONTROL_WRITE_RETRY_BUDGET_MS} — the budget still terminates the loop
 * first if any single attempt is itself slow.
 *
 * Sized against measured facts, not guessed:
 *
 *  - the self-coordination guard clears the moment the node has ONE connection again (both
 *    branches that raise `grace-period-not-elapsed` require `getConnections().length === 0`), not
 *    when the 30 s grace period expires — so this does NOT need to cover the grace period, only
 *    the gap until a bootstrap dial completes;
 *  - the guard's 30 s `gracePeriodMs` cannot be tuned from this repo anyway: no caller in either
 *    repo passes a `SelfCoordinationConfig`, so the default is always in force;
 *  - a node that has NEVER connected is waved through as a bootstrap node (network high-water
 *    mark of 1), so this retry only ever delays a node that HAS seen peers. One whose peers are
 *    gone for good still fails, ~4.6 s later — which is why the budget stays at the shared
 *    ceiling rather than stretching to cover the full 30 s window.
 */
const SCHEMA_INIT_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1_000, 2_000];

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
 * The guard against that is live: `control-write-degraded-cohort-member.integration.ts` asserts
 * this classifier against the real degraded-cohort failure object and asserts the `[block:`
 * token on the live aggregate; if it reddens there, an upstream reformat is the first thing to
 * check.
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
 * Optimystic refusing to let a node elect ITSELF coordinator because its last connection dropped
 * less than the guard's grace period ago (`Libp2pKeyPeerNetwork.shouldAllowSelfCoordination` →
 * `findCoordinator`, `db-p2p/src/libp2p-key-network.ts`).
 *
 * Matched ONLY with the `grace-period-not-elapsed` reason. The same sentence is raised with three
 * other reasons and none of them is worth a retry: `disabled` is static configuration, and
 * `partition-detected` / `suspicious-shrinkage` describe a network condition that will not resolve
 * inside a few seconds of backoff. The grace-period one WILL — it clears as soon as the node holds
 * one connection again, which a cold-starting node dialling its bootstrap peers is actively
 * working on.
 *
 * NOTE: matched by TEXT, not by type, and that is forced rather than chosen.
 * `FindCoordinatorError` (`code: 'SELF_COORDINATION_BLOCKED'`) is exported from `@optimystic/db-p2p`
 * and this package depends on it, but the error OBJECT does not survive the trip:
 * `OptimysticVirtualTable.initialize` catches and rethrows as `new Error(message)` with no `cause`
 * (`quereus-plugin-optimystic/src/optimystic-module.ts`), so only the text reaches this repo. Like
 * every matcher here this fails CLOSED — a rewording upstream stops the retry engaging, it never
 * makes it unsafe.
 */
const SELF_COORDINATION_GRACE_REFUSAL =
	/Self-coordination blocked: grace-period-not-elapsed\. No coordinator available for key\./;

/** Self-coordination refused because the node's last connection dropped moments ago. */
function isSelfCoordinationGraceRefusal(message: string): boolean {
	return SELF_COORDINATION_GRACE_REFUSAL.test(message);
}

/**
 * Every message in the failure's `cause` chain.
 *
 * `unwrapError` declares its `message` as `string`, but it follows `.cause` without checking what
 * that holds — a chain link that is not an `Error` (a stream rejected with a bare string reason,
 * an `AbortSignal.reason` that is a plain object) yields `undefined` there, and calling
 * `.includes` on it would throw a `TypeError` out of this classifier, INSIDE `retryControlWrite`'s
 * catch, replacing the real control-write failure with a confusing one. Non-strings are dropped:
 * a link nobody can read is a link that matches nothing, which is already the conservative answer.
 *
 * NOTE: a cause chain with a CYCLE would spin forever inside `unwrapError` itself. No error in
 * this repo builds one; if a hang ever localises to a control-write failure path, look there.
 */
function chainMessages(error: Error): string[] {
	return unwrapError(error)
		.map(({ message }) => message)
		.filter(message => typeof message === 'string');
}

/**
 * The error messages that mean "the cohort did not answer AND nothing committed", and nothing
 * else. The observed one-shot failure was `registerSelf()` racing a connection still forming:
 * a read/pend-phase transactor aggregate with `cause=The stream has been reset`.
 *
 * Deliberately NOT matched: every constraint / authorization failure
 * (`CHECK constraint failed:`, `UNIQUE constraint failed:`) — those reach the same funnel
 * and must be retried zero times: the cohort REFUSED the write, so re-presenting it
 * re-presents a spent signature and can never commit.
 */
const RETRIABLE_CONTROL_WRITE_MATCHERS: readonly ((message: string) => boolean)[] = [
	isUncommittedTransactorAggregate,
	isUnansweredSuperMajorityShortfall,
];

/**
 * The above PLUS the self-coordination grace refusal — the classifier for schema init ONLY
 * ({@link SCHEMA_INIT_RETRY_POLICY}), deliberately not folded into the list above.
 *
 * Why this class is safe HERE and not everywhere: a write refused at coordinator SELECTION never
 * reached a peer, so re-presenting it is a proven non-commit. But `findCoordinator` is also
 * reached from `NetworkTransactor.commitBlock` during PHASE 2 (`resolveCoordinator`,
 * `db-core/src/transactor/network-transactor.ts`), and `commit()` commits the header block before
 * the rest — so a general control write refused there can be refused AFTER something already
 * committed. Worse, that error carries no `[blocks:` batch token, so
 * {@link reportsIndeterminateCommit} would not veto it, and re-running an insert body over a write
 * that landed is exactly the `UNIQUE constraint failed: CadrePeer.PeerId` failure that veto exists
 * to prevent.
 *
 * Schema init does not have that problem: `apply schema` is a diff rather than a replay and a
 * failed `create table` leaves the catalog clean, so a re-run emits only the tables that did not
 * land (the full argument is at the `loadSchema` call site in `control-database.ts`).
 */
const RETRIABLE_SCHEMA_INIT_MATCHERS: readonly ((message: string) => boolean)[] = [
	...RETRIABLE_CONTROL_WRITE_MATCHERS,
	isSelfCoordinationGraceRefusal,
];

/**
 * Did this control write fail because the cluster cohort did not ANSWER — i.e. is
 * re-presenting the SAME signed write a moment later the right response?
 *
 * Classifies by MESSAGE, walking the `cause` chain with Quereus' own {@link unwrapError} —
 * the failure surface is not recognisable by type. The transactor and the coordinator both throw bare `Error`s, and by
 * the time one reaches `ControlDatabase` it is wrapped in a `QuereusError` (the real chain
 * is `QuereusError` → `Error` → `Error`), so the match must work at any depth. Anything
 * that is not an `Error` is never retried.
 *
 * {@link reportsIndeterminateCommit} vetoes the whole chain before any matcher runs, so a
 * failure that reports a commit-phase batch anywhere is never retried on the strength of some
 * other level looking transient.
 *
 * NOTE: this depends on engine/transactor error TEXT. The messages producible without a
 * network are driven from the REAL engine in `control-formation-seat-budget.spec.ts`, so
 * a rewording reddens a spec rather than silently disabling the retry. The two RETRIABLE
 * messages need a real multi-node cluster to produce; the degraded-cohort scenario
 * (`control-write-degraded-cohort-member.integration.ts`) asserts this classifier against
 * both LIVE — the super-majority shortfall from a real silent member, and the transactor
 * aggregate from a real stream reset, which the retry there absorbs end to end.
 */
export function isRetriableControlWriteFailure(error: unknown): boolean {
	return matchesRetriableMessage(error, RETRIABLE_CONTROL_WRITE_MATCHERS);
}

/**
 * {@link isRetriableControlWriteFailure} widened by exactly one class — the self-coordination
 * grace refusal ({@link RETRIABLE_SCHEMA_INIT_MATCHERS}) — for `ControlDatabase.loadSchema`.
 *
 * Opt-in per call site, via {@link SCHEMA_INIT_RETRY_POLICY}. Every other control write keeps the
 * default classifier untouched.
 */
export function isRetriableSchemaInitFailure(error: unknown): boolean {
	return matchesRetriableMessage(error, RETRIABLE_SCHEMA_INIT_MATCHERS);
}

/**
 * Shared body of both classifiers: walk the `cause` chain, let
 * {@link reportsIndeterminateCommit} veto it, then ask `matchers`. The veto runs BEFORE any
 * matcher for every policy — a chain reporting a commit-phase batch is never retried, however
 * transient some other level looks.
 */
function matchesRetriableMessage(
	error: unknown,
	matchers: readonly ((message: string) => boolean)[]
): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const messages = chainMessages(error);
	if (reportsIndeterminateCommit(messages)) {
		return false;
	}
	return messages.some(message => matchers.some(matches => matches(message)));
}

/**
 * Policy and pacing for {@link retryControlWrite}. Production callers pass nothing (or a named
 * policy such as {@link SCHEMA_INIT_RETRY_POLICY}); specs inject a recorded `sleep`, a shorter
 * delay list, or a fake clock so no test ever waits out a real backoff.
 *
 * Every field defaults to the shipped control-write policy, so an omitted field is byte-identical
 * to the behaviour before per-call-site policies existed.
 */
export interface ControlWriteRetryOptions {
	/**
	 * Total attempts, first included. Default {@link CONTROL_WRITE_ATTEMPTS}, floored at 1 —
	 * below that the loop would run the body zero times and rethrow a `lastError` nobody set.
	 */
	attempts?: number;
	/** Backoff base before retry N (last entry repeats). Default {@link CONTROL_WRITE_RETRY_DELAYS_MS}. */
	delaysMs?: readonly number[];
	/**
	 * Which failures are transient enough to re-present. Default
	 * {@link isRetriableControlWriteFailure}; the only other shipped value is
	 * {@link isRetriableSchemaInitFailure}, via {@link SCHEMA_INIT_RETRY_POLICY}.
	 */
	isRetriable?: (error: unknown) => boolean;
	/**
	 * Operation label stamped into every log line this loop emits (rendered as
	 * `Control write [<label>] …`), and NOTHING else — no behavioural effect. The debug
	 * log is the only surface where the loop's decisions are observable (the rethrown
	 * error is unchanged and no attempt counter is exposed), and several writes retry
	 * CONCURRENTLY in a real party, so an unlabelled line cannot be attributed to a
	 * write. The degraded-cohort scenario asserts on these lines per-operation.
	 */
	label?: string;
	/** The sleep primitive. Default: `setTimeout`. */
	sleep?: (ms: number) => Promise<void>;
	/** Clock for the elapsed-budget check. Default: `Date.now`. */
	now?: () => number;
}

/**
 * The one non-default retry policy: `ControlDatabase.loadSchema`'s distributed DDL, which
 * additionally absorbs optimystic's self-coordination grace refusal and gets more attempts over a
 * longer backoff to do it (see {@link SCHEMA_INIT_ATTEMPTS} and
 * {@link SCHEMA_INIT_RETRY_DELAYS_MS}). Still bounded by the shared
 * {@link CONTROL_WRITE_RETRY_BUDGET_MS}.
 *
 * NOTE: exactly one call site opts in today, and the re-run safety this policy assumes is that
 * site's, not a general property — `apply schema` is a diff and a failed `create table` leaves the
 * catalog clean. A second opt-in must re-derive that argument for its own write body first; if this
 * policy ever grows a third consumer, rename it for what the callers share rather than widening it
 * by default.
 */
export const SCHEMA_INIT_RETRY_POLICY: Readonly<ControlWriteRetryOptions> = {
	attempts: SCHEMA_INIT_ATTEMPTS,
	delaysMs: SCHEMA_INIT_RETRY_DELAYS_MS,
	isRetriable: isRetriableSchemaInitFailure,
};

/**
 * Run `attempt` up to {@link CONTROL_WRITE_ATTEMPTS} times (or `options.attempts`), retrying only
 * failures the policy's classifier — {@link isRetriableControlWriteFailure} by default —
 * calls transient, and only while {@link CONTROL_WRITE_RETRY_BUDGET_MS} has not elapsed.
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
	const attempts = Math.max(1, options.attempts ?? CONTROL_WRITE_ATTEMPTS);
	const delays = options.delaysMs ?? CONTROL_WRITE_RETRY_DELAYS_MS;
	const isRetriable = options.isRetriable ?? isRetriableControlWriteFailure;
	const sleep = options.sleep ?? defaultSleep;
	const now = options.now ?? Date.now;
	// Empty when unlabelled, so an unlabelled line is byte-identical to what this loop
	// logged before labels existed.
	const tag = options.label ? ` [${options.label}]` : '';
	const start = now();
	let lastError: unknown;
	let attemptsMade = 0;
	for (let attemptNumber = 1; attemptNumber <= attempts; attemptNumber++) {
		attemptsMade = attemptNumber;
		try {
			const result = await attempt();
			if (attemptNumber > 1) {
				log('Control write%s committed on attempt %d/%d', tag, attemptNumber, attempts);
			}
			return result;
		} catch (error) {
			if (!isRetriable(error)) {
				// The ONLY trace that this funnel saw a failure and declined it. Without it the
				// log is silent either way, so "the classifier vetoed this one" is
				// indistinguishable from "the retry is not wired into this path at all".
				log('Control write%s failed non-transiently on attempt %d/%d, not retried here: %s',
					tag, attemptNumber, attempts, error);
				throw error;
			}
			lastError = error;
			if (attemptNumber === attempts) {
				break;
			}
			const elapsed = now() - start;
			if (elapsed >= CONTROL_WRITE_RETRY_BUDGET_MS) {
				break;
			}
			const delay = jitteredDelay(delays, attemptNumber);
			log('Control write%s failed transiently (attempt %d/%d), retrying in %d ms: %s',
				tag, attemptNumber, attempts, delay, error);
			await sleep(delay);
		}
	}
	log('Control write%s failed after %d/%d attempt(s): %s', tag, attemptsMade, attempts, lastError);
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
