import { chainMessages, retryControlOperation } from './control-retry.js';
import type { ControlRetryOptions } from './control-retry.js';
import { isUncommittedTransactorAggregate } from './control-write-retry.js';

/**
 * Bounded retry for TRANSIENT control-read failures — the classifier and policy behind
 * `ControlDatabase.readRows`, the single funnel every control read passes through.
 *
 * Why this exists: control WRITES have absorbed transient cluster failures since
 * `control-write-retry.ts` landed, but a read had no second chance — one stream reset
 * during a scan ended the read outright (measured: a rigged single `eval` failure killed
 * `queryRevokedStamps` after exactly one attempt while the same injection against `exec`
 * was absorbed). This module gives reads the same bounded re-presentation with a SHORTER
 * deadline and a NARROWER failure set, because the tightest caller deadline over a control
 * read is the inbound admission gate's 2 s fail-open timeout
 * (`ADMISSION_DECISION_TIMEOUT_MS`, `membership-connection-gater.ts`) — a read budget that
 * does not fit inside it with headroom spends its retries after the gate has already
 * admitted.
 *
 * This is deliberately NOT "the write classifier minus its commit veto" — the retriable
 * set differs in both directions (see {@link isRetriableControlReadFailure}). The loop
 * lives in `control-retry.ts`, shared with the write policy; this module owns only the
 * read policy. And like the write side, classification is by TEXT: optimystic's
 * `OptimysticVirtualTable` catches every scan-path error and rethrows
 * `new Error('Query failed: ' + message)` with NO `cause`
 * (`quereus-plugin-optimystic/src/optimystic-module.ts`), so the typed
 * `BlockUnavailableError` and its `reason` field are destroyed before they reach this
 * repo; Quereus then wraps that as `Error during query on table '<T>': …` preserving
 * `cause` (`quereus/src/runtime/emit/scan.ts`). Every matcher fails CLOSED — an upstream
 * rewording stops the retry engaging, it never makes it unsafe.
 */

/**
 * Attempts allowed per control read: the first, plus two retries. Attempts are cheap here —
 * the observed transient failure (the transactor's read-phase aggregate off a stream still
 * forming) surfaces in ~25 ms — and {@link CONTROL_READ_RETRY_BUDGET_MS} is what terminates
 * the loop when an attempt is slow instead.
 */
export const CONTROL_READ_ATTEMPTS = 3;

/**
 * Backoff before read retry N, jittered ±50% and capped at the largest base by the shared
 * loop — worst case ~750 ms of total sleep. Much shorter than the write list because the
 * whole loop must fit under {@link CONTROL_READ_RETRY_BUDGET_MS}.
 */
export const CONTROL_READ_RETRY_DELAYS_MS: readonly number[] = [100, 400];

/**
 * Elapsed-time ceiling on the whole read-retry loop, checked after a failed attempt BEFORE
 * sleeping — so one slow attempt (e.g. a `cohort-unreachable` read that burned the
 * transactor's own deadline) terminates the loop rather than compounding.
 *
 * 1500 ms, sized against `ADMISSION_DECISION_TIMEOUT_MS` (2000 ms): the inbound admission
 * gate reads the control DB and is FAIL-OPEN on both throw and timeout, so a read that
 * outlives the gate's deadline spends its retries after the gate has already admitted an
 * unplaced peer. Under the deadline, a read that succeeds on its second attempt lets the
 * gate make the real decision instead. `control-read-retry.spec.ts` asserts the
 * relationship so a future edit to either constant reddens instead of silently
 * reintroducing the fail-open admit. NOTE: `queryCadrePeers` / `queryPeerRecord` each
 * issue TWO network reads (the revoked-stamp filter plus the row scan) and the budget is
 * per read, so a membership read can spend up to two budgets back to back — still inside
 * 2 s only because each stays well under it. Do not raise these numbers without
 * re-checking against `ADMISSION_DECISION_TIMEOUT_MS`.
 */
export const CONTROL_READ_RETRY_BUDGET_MS = 1_500;

/**
 * The block-unavailability reasons a repeat read can actually improve on, matched against
 * upstream's exact template `Block <id> is unavailable (<reason>): …`
 * (`BlockUnavailableError`, `db-core/src/network/struct.ts`):
 *
 * - **`peers-unreachable`** — part of the cohort answered and part could not be asked, and
 *   OTHER coordinators are reachable, so asking one of them can still settle it. Upstream's
 *   own definition invites the second attempt.
 * - **`cohort-unreachable`** — the marginal member of the set. Upstream says the answer
 *   will not improve until this node's connectivity does — but during bring-up connectivity
 *   DOES improve within a second (the boot-time failure shape recorded in
 *   `tickets/blocked/control-read-over-fresh-edge-stream-resets`), and the cost of being
 *   wrong is bounded by {@link CONTROL_READ_RETRY_BUDGET_MS}, which is the whole reason it
 *   is safe to include.
 *
 * Deliberately NOT matched:
 *
 * - **`claimed-elsewhere`** — a cohort peer positively claims the block exists and nobody
 *   could corroborate or acquire it. MEASURED not to clear: reissuing the same call every
 *   second for 60 s returned the identical error every time (2026-08-20, recorded in the
 *   fix ticket). Retrying spends the whole budget and fails anyway; the root cause is
 *   upstream and tracked by `tickets/blocked/block-held-by-only-one-machine-is-unreadable`
 *   — this retry must not paper over it.
 * - **`unmaterializable`** — records are held locally but cannot be reassembled. A local
 *   data problem; a second read reads the same records.
 * - **`Block <id> may be stale`** (`BlockPossiblyStaleError`) — about currency, not
 *   existence: a cohort claim no reachable coordinator could confirm or refute will not
 *   resolve inside a few hundred milliseconds of backoff.
 * - Anything unmatched. The default is no retry.
 */
const RETRIABLE_BLOCK_UNAVAILABLE =
	/Block \S+ is unavailable \((?:peers-unreachable|cohort-unreachable)\)/;

/** A block-unavailable read failure whose reason a repeat read can improve on. */
function isRetriableBlockUnavailable(message: string): boolean {
	return RETRIABLE_BLOCK_UNAVAILABLE.test(message);
}

/**
 * Pacing overrides for {@link retryControlRead} — the read twin of
 * `ControlWriteRetryOptions`. Every field defaults to the shipped read policy
 * ({@link CONTROL_READ_ATTEMPTS}, {@link CONTROL_READ_RETRY_DELAYS_MS},
 * {@link isRetriableControlReadFailure}); field shapes and semantics live on the shared
 * {@link ControlRetryOptions}.
 */
export type ControlReadRetryOptions = ControlRetryOptions;

/**
 * Did this control read fail in a way a repeat read can improve on?
 *
 * Two classes, both meaning "the cluster could not be ASKED properly just now":
 *
 * - the transactor's read-phase aggregate (`Some peers did not complete: …[block:…]`),
 *   reused verbatim from the write classifier — a `get` batch formats the single-block
 *   `[block:` token, and a read can never produce the commit-phase `[blocks:` token, so
 *   the write side's indeterminate-commit veto has nothing to veto here (a read commits
 *   nothing and re-running it is always safe);
 * - the block-unavailability reasons in {@link RETRIABLE_BLOCK_UNAVAILABLE} (and only
 *   those — see its comment for the measured exclusions).
 *
 * Classifies by MESSAGE, walking the `cause` chain with the shared `chainMessages`,
 * because only text survives the trip out of optimystic (see the module comment).
 * Anything that is not an `Error` is never retried.
 */
export function isRetriableControlReadFailure(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	return chainMessages(error).some(message =>
		isUncommittedTransactorAggregate(message) || isRetriableBlockUnavailable(message));
}

/**
 * Run `attempt` — a full drain of one control read — up to
 * {@link CONTROL_READ_ATTEMPTS} times, retrying only failures
 * {@link isRetriableControlReadFailure} calls transient, and only while
 * {@link CONTROL_READ_RETRY_BUDGET_MS} has not elapsed.
 *
 * Reads are idempotent, so `attempt` needs no atomicity contract — but it must be a
 * COLLECTING drain, not a live iterator: a half-consumed iterator cannot be retried
 * without re-yielding rows the caller already saw, which is why
 * `ControlDatabase.readRows` materializes before this loop ever sees a failure.
 *
 * On exhaustion the LAST error is rethrown unchanged. Log lines carry the
 * `Control read [<label>] …` prefix so a read's retries can be attributed among the
 * several reads in flight concurrently in a real party.
 */
export function retryControlRead<T>(
	attempt: () => Promise<T>,
	options: ControlReadRetryOptions = {}
): Promise<T> {
	return retryControlOperation(attempt, {
		attempts: CONTROL_READ_ATTEMPTS,
		delaysMs: CONTROL_READ_RETRY_DELAYS_MS,
		budgetMs: CONTROL_READ_RETRY_BUDGET_MS,
		isRetriable: isRetriableControlReadFailure,
		logPrefix: 'Control read',
	}, options);
}
