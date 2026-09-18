import { describe, it, expect } from 'vitest';
import {
	CoordinatorPartialCommitError,
	SyncRetryExhaustedError,
	SyncRevisionStalledError,
	TornActionError,
} from '@optimystic/db-core';
import { PartialCommitError } from '@optimystic/quereus-plugin-optimystic';
import { QuereusError, StatusCode } from '@quereus/quereus';
import {
	CONTROL_WRITE_ATTEMPTS,
	CONTROL_WRITE_RETRY_BUDGET_MS,
	SCHEMA_INIT_ATTEMPTS,
	SCHEMA_INIT_RETRY_POLICY,
	isRetriableControlWriteFailure,
	isRetriableSchemaInitFailure,
	retryControlWrite,
	type ControlWriteRetryOptions
} from '../src/control-write-retry.js';
import { ControlDatabase } from '../src/control-database.js';
import type { ControlDatabaseConfig } from '../src/control-database.js';
import { captureDebugLog } from './capture-debug-log.js';
import type { ControlRetryAbandonment } from '../src/control-retry.js';

/**
 * The transient-control-write classifier and retry loop behind
 * `ControlDatabase.lockedWithRetry`, in isolation — no database, no network.
 *
 * The classifier table below asserts against message LITERALS, a known dependency on
 * engine/transactor error text. It is only half the coverage, deliberately:
 *
 *  - the NON-retriable side (constraint/authorization failures) is additionally driven
 *    from the REAL engine in `control-formation-seat-budget.spec.ts`, which boots a
 *    `CadreNode` — so a reworded constraint message reddens a spec there;
 *  - the RETRIABLE side cannot be produced here at all. Both messages come off a real
 *    multi-node cluster (the network transactor's aggregate, the cluster coordinator's
 *    super-majority shortfall), which needs an integration scenario, not a unit spec.
 *    `packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts`
 *    now produces both LIVE and asserts this classifier against them, so an upstream
 *    rewording reddens there rather than silently disabling the retry. The literals below
 *    are transcribed from the transactor's own format strings
 *    (`db-core/src/transactor/network-transactor.ts`) — they are not claimed to be
 *    captured output.
 */

/**
 * The real failure arrives as `QuereusError` → `Error` → `Error`, with the recognisable
 * message potentially at any depth — so every classifier case here asserts through a
 * three-level `cause` chain with decoy text on the outer layers, not a flat message.
 */
function nested(message: string): Error {
	return new Error('Runtime error during write', {
		cause: new Error('control write failed', { cause: new Error(message) }),
	});
}

/** Pacing that never sleeps and never advances the budget clock. */
function immediatePacing(overrides: ControlWriteRetryOptions = {}): ControlWriteRetryOptions {
	return { sleep: () => Promise.resolve(), now: () => 0, ...overrides };
}

/**
 * One `create table` of the control DDL failing, as Quereus' migration loop reports it:
 * `Failed to execute DDL: <ddl>\nError: <cause message>`, with the cause preserved on the
 * chain (`runBatchedMigrationLoop` in
 * `quereus/src/runtime/emit/schema-declarative.ts`). The classifier walks the chain, so it
 * sees the inner message either way — the outer text is here so the schema-init cases below
 * fail against the surface a real startup actually produces.
 */
function ddlFailure(causeMessage: string): string {
	return `Failed to execute DDL: create table CadreControl.FormationUsage (Token text not null, UsageStampId text not null)\nError: ${causeMessage}`;
}

/**
 * The transactor aggregate as the block-read (`get`) and phase-1 (`pend`) sites format it:
 * per-batch details name a SINGLE block, `<peerId>[block:<id>](<status>)`. Nothing has
 * committed when either site raises, so the write is known not to have landed.
 *
 * This one is a real captured message (recorded in
 * `tickets/fix/control-read-over-fresh-edge-stream-resets.md`), not a reconstruction.
 */
const TRANSACTOR_AGGREGATE =
	'Some peers did not complete: 12D3KooWBkxetzv16fD2997rSFQfqDQJYX7NFhmcwhk3AEfqr1VU[block:PaWaynQLVfuwhcw4tGh0uX_BDGPyoXWs-VPZOs0OpGk](in-flight) cause=The stream has been reset; root: The stream has been reset';
/**
 * The SAME aggregate message from the phase-2 (`commitBlocks`) site, which formats a batch's
 * block COUNT instead — `<peerId>[blocks:<count>](<status>)`. A no-response there is
 * indeterminate (the coordinator may have committed and only the reply was lost), so this one
 * must never be re-presented.
 *
 * The status reads `in-flight`, not `no-response`, because a batch can only carry a `cause=` if
 * its RPC REJECTED — and `Pending.isError` implies `isResponse` is false, which every one of the
 * transactor's three formatters renders as `in-flight`. `no-response` means the batch has no
 * request at all, and those never print a cause.
 */
const TRANSACTOR_AGGREGATE_COMMIT_PHASE =
	'Some peers did not complete: 12D3KooWpeer[blocks:3](in-flight) cause=The stream has been reset; root: The stream has been reset';
/** The aggregate with no per-batch details at all — `formatBatchStatuses` had nothing to format. */
const TRANSACTOR_AGGREGATE_NO_DETAILS =
	'Some peers did not complete: ; root: The stream has been reset';
/**
 * The THIRD and last place `[block:` appears — `NetworkTransactor.dischargeCancel`
 * (`db-core/src/transactor/network-transactor.ts` ~1156; the other two are `get` at ~304 and
 * `pend` at ~579, and the commit site at ~942 renders `[blocks:` instead), raised when a failed commit
 * attempt's own cancel could not discharge the pend it left behind within its bounded
 * six rounds. This is a reconstruction (built from that formatter's literal template),
 * not a capture — no run recorded in `tickets/.pre-existing-known.md` has produced one.
 *
 * The status token reads `in-flight`, not `no-response`, for the same reason
 * {@link TRANSACTOR_AGGREGATE_COMMIT_PHASE} does: a batch only carries a `cause=` when its
 * RPC rejected, and every one of the transactor's three formatters — including this one —
 * renders that as `in-flight`.
 */
const CANCEL_DISCHARGE_AGGREGATE =
	'Cancel of action N7Wj4Q9nOWCkm5G1cxTPWg did not discharge 1 block(s): '
	+ 'PaWaynQLVfuwhcw4tGh0uX_BDGPyoXWs-VPZOs0OpGk; peers: '
	+ '12D3KooWBkxetzv16fD2997rSFQfqDQJYX7NFhmcwhk3AEfqr1VU[block:PaWaynQLVfuwhcw4tGh0uX_BDGPyoXWs-VPZOs0OpGk](in-flight) '
	+ 'cause=The stream has been reset; root: The stream has been reset';
/**
 * A collection's own retry budget giving up on a standing `pending conflict` — Optimystic's
 * `SyncRetryExhaustedError`, raised by `Collection.sync` after it has already spent its own
 * bounded attempts (`db-core/src/collection/collection.ts`) racing a rival action for the
 * same block. Reaches this funnel with no transactor-aggregate wrapper at all, so no matcher
 * here claims it — and as the real class it is vetoed by type besides (the
 * `typed possibly-stored failures` cases below). This literal pins the text half.
 *
 * THE LIVE SHAPE contention takes today. Since optimystic made "another write holds this
 * block right now" a `held` verdict — counting toward neither approvals nor rejections
 * (`validatePendOperations`, `db-p2p/src/cluster/cluster-repo.ts`) — a contended write is no
 * longer refused by a vote; it is retried by the collection's own sync until that budget runs
 * out, and arrives here like this. Declining it is correct and must stay that way: against a
 * rival that will never clear, no budget is enough, and upstream measured a LIVE rival being
 * absorbed in two of the collection's own retries.
 *
 * A real captured literal, not a reconstruction: from the `[self-record-update]` write on node
 * B during round 4 of the 2026-09-17 verification series (see
 * `retire-the-stream-reset-retry-fingerprint`'s close-out). The log it came from
 * (`tickets/.logs/control-write-retry-absorb.probe-r2.log`) is pruned on age; this is the
 * surviving copy.
 */
const SYNC_RETRY_EXHAUSTED_PENDING_CONFLICT =
	'sync for collection default/cadrecontrol/CadrePeer exhausted 10 retries: pending conflict: '
	+ 'block(s) held by unresolved rival action(s) f7cM8wOiFkZ4O_bOrXFVQQ';
const SUPER_MAJORITY_NONE_ANSWERED =
	'Failed to get super-majority: 0/3 approvals (needed 3, 0 rejections)';
const SUPER_MAJORITY_PARTIAL =
	'Failed to get super-majority: 2/3 approvals (needed 3, 0 rejections)';
const SUPER_MAJORITY_REJECTED =
	'Failed to get super-majority: 2/3 approvals (needed 3, 1 rejections)';
/**
 * The shortfall exactly as a THREE-node party raises it — the shape that makes a third
 * node's join fragile. A control transaction there needs 2 of 2 remaining peers to answer,
 * so ONE flaky peer response is fatal where a two-node party would have tolerated it.
 * Transcribed from the failing `provider-seed-accepted` run recorded in
 * `tickets/implement/29.3-third-node-join-ddl-init.md`.
 *
 * A RECONSTRUCTION, and knowingly a partial one: the transcription kept this inner sentence
 * but elided the surrounding transactor aggregate, which is where the `[block:`/`[blocks:`
 * token that decides retriability lives (see the two aggregate forms below). Twelve runs of
 * `provider-seed-accepted.integration.ts` on 2026-08-02/03 failed to re-capture the failure —
 * every DDL death in those runs was `Missing block` instead — so the elided segment is still
 * unrecorded.
 */
const SUPER_MAJORITY_THIRD_NODE_JOIN =
	'Failed to get super-majority: 1/2 approvals (needed 2, 0 rejections)';
/**
 * How the coordinator's shortfall actually reaches this classifier: NOT as a bare sentence but
 * inline, as one batch's `cause=` inside a transactor aggregate, with the same text repeated as
 * the aggregate's `root:`. `ClusterCoordinator.executeClusterTransaction` raises the shortfall
 * and BOTH `CoordinatorRepo.pend` and `.commit` call it, so the identical sentence can arrive
 * from either phase — and only the bracket token tells them apart.
 *
 * This pend-phase form is retried twice over: `isUncommittedTransactorAggregate` claims it on
 * `[block:`, and `isUnansweredSuperMajorityShortfall` claims the inline sentence.
 */
const SUPER_MAJORITY_IN_PEND_AGGREGATE =
	'Some peers did not complete: 12D3KooWa[block:PaWaynQLVfuwhcw4tGh0uX](in-flight) cause=Failed to get super-majority: 1/2 approvals (needed 2, 0 rejections), 12D3KooWb[block:PaWaynQLVfuwhcw4tGh0uX](in-flight) cause=The stream has been reset; root: Failed to get super-majority: 1/2 approvals (needed 2, 0 rejections)';
/**
 * A promise-phase REJECTION, not a shortfall — wrapped in the same `[block:` aggregate as every
 * other promise-phase failure. `isUncommittedTransactorAggregate` claims the wrapper on its own,
 * whatever the cause inside says (its accepted-tradeoff `NOTE:` explains why that is kept), and
 * this case is what pins that.
 *
 * A HISTORICAL capture. Its cause text is a `pending conflict` refusal, which upstream no longer
 * produces: contention now votes `held` and counts toward neither approvals nor rejections, so a
 * contended write reaches this funnel as {@link SYNC_RETRY_EXHAUSTED_PENDING_CONFLICT} instead.
 * The literal is kept because the WRAPPER shape it demonstrates is not historical at all — stale
 * revision, block-unavailable, membership-not-admitted and a configured validator's refusal all
 * still arrive rejected inside this same aggregate, and stale revision is the one this loop
 * genuinely rescues (it re-runs the write body's reads). Read the cause text as an example of a
 * rejection, not as a claim about what contention looks like now.
 *
 * A real captured message, not a reconstruction: the `[peer-insert]` write A ran on 2026-09-17,
 * refused by C's unresolved pending action. It was transcribed from
 * `tickets/.logs/control-write-hears-zero.gate-r1.log`, which that directory's pruner ages out —
 * the literal below is the surviving copy, so do not "restore" it from a shorter paraphrase.
 */
const PROMISE_PHASE_REJECTION_IN_PEND_AGGREGATE =
	'Some peers did not complete: 12D3KooWSsZxd8HWy9sqb9h81WTJZTwyvBQVVtnnzAP9WbvHdq7M[block:BWDONTuAJIRFiDg3IXDvK7UGss915dSNOT62ze8Ni-Y](in-flight) cause=Transaction rejected by validators (1/3 rejected): 12D3KooWM6oCfDDA1T9bD3A4nm4di5LdG7fkgkrZKr1W9zmfViGj: pending conflict: block BWDONTuAJIRFiDg3IXDvK7UGss915dSNOT62ze8Ni-Y held by unresolved action(s) Iw7_hcvHMj5jXg0VRx3xDA; root: Transaction rejected by validators (1/3 rejected): 12D3KooWM6oCfDDA1T9bD3A4nm4di5LdG7fkgkrZKr1W9zmfViGj: pending conflict: block BWDONTuAJIRFiDg3IXDvK7UGss915dSNOT62ze8Ni-Y held by unresolved action(s) Iw7_hcvHMj5jXg0VRx3xDA';
/**
 * The SAME shortfall sentence carried by a COMMIT-phase aggregate. Vetoed, and this is the case
 * that decides whether the schema-init retry does anything at all: if a joining node's real
 * failure looks like this, the retry silently never engages. Do not widen
 * `reportsIndeterminateCommit` to make this pass — the veto is there because re-running a write
 * that may have landed turns a success into a constraint failure.
 */
const SUPER_MAJORITY_IN_COMMIT_AGGREGATE =
	'Some peers did not complete: 12D3KooWa[blocks:2](in-flight) cause=Failed to get super-majority: 1/2 approvals (needed 2, 0 rejections); root: Failed to get super-majority: 1/2 approvals (needed 2, 0 rejections)';
/**
 * A durable convergence fault, not a transient one: a collection reports a committed
 * revision whose header block reads as affirmatively ABSENT. Tracked separately in
 * `tickets/blocked/control-db-cross-node-convergence-halted.md`; a retry cannot heal it, so
 * the classifier must keep letting it through unmatched.
 */
const MISSING_BLOCK = 'Missing block (jQlkVafUFlI6FzOGGAlViyK5GrgcSm_4SL7HfPKwhis)';
/**
 * Optimystic refusing to let a node elect ITSELF coordinator while its last connection is still
 * within the guard's 30 s grace period — raised by `Libp2pKeyPeerNetwork.findCoordinator`
 * (`db-p2p/src/libp2p-key-network.ts` ~539). Transcribed verbatim from that throw's template.
 *
 * Retriable for SCHEMA INIT only: a write refused at coordinator SELECTION never reached a peer,
 * so nothing pended and nothing committed. Not retriable in general — `findCoordinator` is also
 * reached from `NetworkTransactor.commitBlock`'s phase 2, where a refusal can land after the
 * header block already committed, and carries no `[blocks:` token for
 * `reportsIndeterminateCommit` to veto on.
 */
const SELF_COORDINATION_BLOCKED =
	'Self-coordination blocked: grace-period-not-elapsed. No coordinator available for key.';
/**
 * The same refusal as it actually reaches this repo, wrapped twice on the way out of optimystic
 * and Quereus — `OptimysticVirtualTable.initialize` rethrows as a bare `new Error(message)` with
 * NO `cause`, so the text is all that survives. Copied from the node-B startup death recorded in
 * `tickets/implement/1-control-write-retry-covers-self-coordination-blocked.md`; wrap it in
 * {@link ddlFailure} for the full startup surface.
 */
const SELF_COORDINATION_IN_MODULE_CREATE =
	`Module 'optimystic' create failed for table 'Revocation': `
	+ `Failed to initialize Optimystic table: ${SELF_COORDINATION_BLOCKED}`;
/**
 * The other three reasons the SAME sentence carries. None is retried: `disabled` is static
 * configuration, and a detected partition or a suspicious shrinkage will not resolve inside a few
 * seconds of backoff — so retrying them would add latency before the identical error.
 */
const SELF_COORDINATION_OTHER_REASONS = [
	'Self-coordination blocked: disabled. No coordinator available for key.',
	'Self-coordination blocked: partition-detected. No coordinator available for key.',
	'Self-coordination blocked: suspicious-shrinkage. No coordinator available for key.',
];

describe('isRetriableControlWriteFailure', () => {
	it('retries the read/pend-phase transactor aggregate ("the cohort did not answer")', () => {
		expect(isRetriableControlWriteFailure(nested(TRANSACTOR_AGGREGATE))).toBe(true);
	});

	/**
	 * The distinction the `[block:` / `[blocks:` token draws. A commit-phase no-response is
	 * INDETERMINATE — the coordinator runs consensus internally and may have committed with only
	 * the reply lost — so re-running the write body would risk turning a success into a
	 * constraint failure. Same message prefix, same `cause`; only the per-batch detail differs.
	 */
	it('never retries the commit-phase aggregate — the write may have landed', () => {
		expect(isRetriableControlWriteFailure(nested(TRANSACTOR_AGGREGATE_COMMIT_PHASE))).toBe(false);
	});

	it('never retries an aggregate whose phase cannot be told from its details', () => {
		// No details, so no token: an unattributable failure is not a proven non-commit.
		expect(isRetriableControlWriteFailure(nested(TRANSACTOR_AGGREGATE_NO_DETAILS))).toBe(false);
		// A single-block batch alongside a commit batch: the conservative arm wins.
		expect(isRetriableControlWriteFailure(nested(
			'Some peers did not complete: 12D3KooWa[block:blk-7](no-response), 12D3KooWb[blocks:3](no-response)',
		))).toBe(false);
	});

	/**
	 * The veto spans the `cause` chain, not one message. A read-phase aggregate at one level
	 * must not license a retry when ANOTHER level reports a commit-phase batch — whichever
	 * order the two land in. Asserted for the retriable transactor arm and the super-majority
	 * arm alike, since an indeterminate commit disqualifies a re-run no matter what else in
	 * the chain looks transient.
	 */
	it('never retries a chain that reports a commit-phase batch at ANY level', () => {
		const chained = (outer: string, inner: string): Error =>
			new Error(outer, { cause: new Error(inner) });

		for (const retriable of [TRANSACTOR_AGGREGATE, SUPER_MAJORITY_NONE_ANSWERED]) {
			// The control: on its own, each of these IS retried.
			expect(isRetriableControlWriteFailure(new Error(retriable))).toBe(true);
			expect(isRetriableControlWriteFailure(
				chained(retriable, TRANSACTOR_AGGREGATE_COMMIT_PHASE))).toBe(false);
			expect(isRetriableControlWriteFailure(
				chained(TRANSACTOR_AGGREGATE_COMMIT_PHASE, retriable))).toBe(false);
		}
	});

	it('retries a super-majority shortfall with ZERO rejections, at any approval count', () => {
		expect(isRetriableControlWriteFailure(nested(SUPER_MAJORITY_NONE_ANSWERED))).toBe(true);
		expect(isRetriableControlWriteFailure(nested(SUPER_MAJORITY_PARTIAL))).toBe(true);
	});

	it('never retries a super-majority shortfall carrying a rejection — somebody voted no', () => {
		expect(isRetriableControlWriteFailure(nested(SUPER_MAJORITY_REJECTED))).toBe(false);
	});

	/**
	 * Pins the accepted tradeoff recorded at `isUncommittedTransactorAggregate`'s `NOTE:`: unlike
	 * the bare-message rejection above, a rejection carried inside a promise-phase `[block:`
	 * aggregate IS retried — the matcher claims the wrapper on its own, whatever the cause inside
	 * it says. Real capture (see the constant's comment), though its particular cause text is
	 * historical; what this case guards is the wrapper rule, which still governs every rejection
	 * the promise phase can still raise.
	 */
	it('retries a promise-phase rejection carried inside a [block: aggregate — the accepted tradeoff', () => {
		expect(isRetriableControlWriteFailure(nested(PROMISE_PHASE_REJECTION_IN_PEND_AGGREGATE))).toBe(true);
	});

	/**
	 * Pins `isUncommittedTransactorAggregate`'s NOTE: the discriminator is the `Some peers did
	 * not complete:` PREFIX and the `[block:` token together, never `[block:` alone. A cancel
	 * that fails to discharge a pend also formats a `[block:` batch detail, but under a
	 * different prefix (`Cancel of action … did not discharge …`) — so it must stay declined.
	 * Relaxing the discriminator to "contains `[block:`" would read this as a retriable
	 * get/pend and re-present a write whose own cancel is what is still unresolved.
	 */
	it('never retries the cancel-discharge aggregate, even though it contains `[block:`', () => {
		expect(isRetriableControlWriteFailure(nested(CANCEL_DISCHARGE_AGGREGATE))).toBe(false);
	});

	/**
	 * The shape a third node's join failure ACTUALLY has: the shortfall inline inside a
	 * transactor aggregate, not on its own. Same sentence, same `cause` chain, opposite verdicts
	 * — the per-batch bracket token is the whole discriminator, so this pair is what makes the
	 * schema-init retry either useful or a no-op. Asserted bare and through the `Failed to
	 * execute DDL:` wrapper a joining node actually prints.
	 *
	 * Which token a real joining node carries is still UNCAPTURED (see
	 * {@link SUPER_MAJORITY_THIRD_NODE_JOIN}). If a capture ever arrives and it is `[blocks:`,
	 * the second half of this case is the proof that the retry never engages for it.
	 */
	it('separates the pend- and commit-phase forms of the SAME super-majority shortfall', () => {
		expect(isRetriableControlWriteFailure(nested(SUPER_MAJORITY_IN_PEND_AGGREGATE))).toBe(true);
		expect(isRetriableControlWriteFailure(nested(SUPER_MAJORITY_IN_COMMIT_AGGREGATE))).toBe(false);

		expect(isRetriableControlWriteFailure(
			nested(ddlFailure(SUPER_MAJORITY_IN_PEND_AGGREGATE)))).toBe(true);
		expect(isRetriableControlWriteFailure(
			nested(ddlFailure(SUPER_MAJORITY_IN_COMMIT_AGGREGATE)))).toBe(false);
	});

	/**
	 * `Missing block` is a DURABLE fault (a committed revision whose header block is
	 * affirmatively absent), so it matches nothing here and propagates unchanged. Asserted
	 * explicitly because the schema-init retry below shares this classifier: widening it to
	 * absorb this message would make a joining node spin over an unhealable condition and
	 * then report the same failure ~2 s later.
	 */
	it('never retries a missing-block convergence fault — a retry cannot heal it', () => {
		expect(isRetriableControlWriteFailure(nested(MISSING_BLOCK))).toBe(false);
		expect(isRetriableControlWriteFailure(nested(ddlFailure(MISSING_BLOCK)))).toBe(false);
	});

	/**
	 * A `pending conflict` that reaches this classifier NOT wrapped in a `[block:` aggregate —
	 * because Optimystic's own collection sync already spent its own ten retries racing the
	 * rival action and gave up. Correctly declined here: nothing in this message says the
	 * cohort did not answer, and re-presenting it a further two times inside this loop's
	 * budget would just repeat a race Optimystic already lost on its own terms.
	 *
	 * This is the LIVE shape of contention, and it is the one that goes silent: the write is
	 * abandoned on attempt 1 and, when it is a background write, nobody is awaiting the error.
	 * `ControlDatabase.setControlWriteAbandonedListener` and the node's
	 * `control:write-abandoned` event exist for exactly this, and the abandonment cases at the
	 * bottom of this file pin the loop's half of it.
	 */
	it('never retries a SyncRetryExhaustedError-shaped pending-conflict message', () => {
		expect(isRetriableControlWriteFailure(nested(SYNC_RETRY_EXHAUSTED_PENDING_CONFLICT))).toBe(false);
	});

	/**
	 * The one class the SCHEMA-INIT policy adds and this one deliberately refuses. Asserted here,
	 * not only in the schema-init block below, because the whole point of the split is that this
	 * default classifier — the one under all ~19 other control writes — keeps saying no.
	 */
	it('never retries a self-coordination refusal — safe only for schema init', () => {
		expect(isRetriableControlWriteFailure(nested(SELF_COORDINATION_BLOCKED))).toBe(false);
		expect(isRetriableControlWriteFailure(
			nested(ddlFailure(SELF_COORDINATION_IN_MODULE_CREATE)))).toBe(false);
	});

	it('never retries constraint/authorization failures — a retry would re-present a spent signature', () => {
		expect(isRetriableControlWriteFailure(nested('CHECK constraint failed: Authorized'))).toBe(false);
		expect(isRetriableControlWriteFailure(nested('UNIQUE constraint failed: FormationUsage.UsageStampId'))).toBe(false);
	});

	/**
	 * A `cause` chain link that is not an `Error`. `unwrapError` follows `.cause` blindly and
	 * reports an `undefined` message for such a link, so matching on it unguarded throws a
	 * `TypeError` — and it would throw from inside `retryControlWrite`'s catch, replacing the real
	 * control-write failure with a confusing one. The classifier must ANSWER instead, and must
	 * still read the levels that ARE strings.
	 */
	it('answers instead of throwing when the cause chain carries a non-Error link', () => {
		expect(isRetriableControlWriteFailure(
			new Error('control write failed', { cause: 'connection closed' }))).toBe(false);
		expect(isRetriableControlWriteFailure(
			new Error(TRANSACTOR_AGGREGATE, { cause: { reason: 'aborted' } }))).toBe(true);
		expect(isRetriableControlWriteFailure(
			new Error(TRANSACTOR_AGGREGATE_COMMIT_PHASE, { cause: 'connection closed' }))).toBe(false);
	});

	it('never retries a non-Error throw, even one whose text would match', () => {
		expect(isRetriableControlWriteFailure(TRANSACTOR_AGGREGATE)).toBe(false);
		expect(isRetriableControlWriteFailure(undefined)).toBe(false);
		expect(isRetriableControlWriteFailure({ message: TRANSACTOR_AGGREGATE })).toBe(false);
	});
});

/**
 * The widened classifier `ControlDatabase.loadSchema` opts into — the default plus optimystic's
 * self-coordination grace refusal, and nothing else.
 *
 * Message literals again, and here the load-bearing one is CAPTURED rather than reconstructed: the
 * refusal text comes from a real node-B startup death. The end-to-end proof
 * (`provider-seed-accepted.integration.ts`) reproduces the fingerprint on roughly 1 run in 3, so
 * these cases — not that scenario — are what actually pins the behaviour.
 */
describe('isRetriableSchemaInitFailure', () => {
	it('retries the self-coordination grace refusal the default classifier refuses', () => {
		expect(isRetriableSchemaInitFailure(nested(SELF_COORDINATION_BLOCKED))).toBe(true);
		// The surface a real startup prints: optimystic's rethrow inside Quereus' module-create
		// wrapper inside the DDL wrapper. The classifier matches on text, which every wrap
		// embeds (why text, on SELF_COORDINATION_GRACE_REFUSAL).
		expect(isRetriableSchemaInitFailure(
			nested(ddlFailure(SELF_COORDINATION_IN_MODULE_CREATE)))).toBe(true);
	});

	/**
	 * The reason token is part of the match, not decoration. Only `grace-period-not-elapsed`
	 * clears on its own (it needs one connection back, not the full 30 s grace period); the others
	 * would spend the whole budget to reach the same error.
	 */
	it('retries only the grace-period reason, not the other three', () => {
		for (const message of SELF_COORDINATION_OTHER_REASONS) {
			expect(isRetriableSchemaInitFailure(nested(message))).toBe(false);
			expect(isRetriableSchemaInitFailure(nested(ddlFailure(message)))).toBe(false);
		}
	});

	/**
	 * The indeterminate-commit veto is NOT relaxed for this policy. A chain carrying a commit-phase
	 * batch token is refused even when another level shows the retriable refusal — re-running the
	 * DDL is safe, but only because nothing committed, and `[blocks:` is precisely the evidence
	 * that something may have.
	 */
	it('keeps the commit-phase veto in force', () => {
		expect(isRetriableSchemaInitFailure(new Error(SELF_COORDINATION_BLOCKED, {
			cause: new Error(TRANSACTOR_AGGREGATE_COMMIT_PHASE),
		}))).toBe(false);
		expect(isRetriableSchemaInitFailure(new Error(TRANSACTOR_AGGREGATE_COMMIT_PHASE, {
			cause: new Error(SELF_COORDINATION_BLOCKED),
		}))).toBe(false);
		expect(isRetriableSchemaInitFailure(nested(SUPER_MAJORITY_IN_COMMIT_AGGREGATE))).toBe(false);
	});

	/**
	 * Widened, not replaced: every verdict the default classifier reaches, this one reaches too.
	 * Driven from the same table so a future edit to either list cannot silently diverge.
	 */
	it('agrees with the default classifier on every other message', () => {
		const retriable = [
			TRANSACTOR_AGGREGATE,
			SUPER_MAJORITY_NONE_ANSWERED,
			SUPER_MAJORITY_PARTIAL,
			SUPER_MAJORITY_IN_PEND_AGGREGATE,
		];
		const notRetriable = [
			TRANSACTOR_AGGREGATE_NO_DETAILS,
			SUPER_MAJORITY_REJECTED,
			MISSING_BLOCK,
			'UNIQUE constraint failed: FormationUsage.UsageStampId',
			'CHECK constraint failed: Authorized',
		];
		for (const message of retriable) {
			expect(isRetriableControlWriteFailure(nested(message))).toBe(true);
			expect(isRetriableSchemaInitFailure(nested(message))).toBe(true);
		}
		for (const message of notRetriable) {
			expect(isRetriableControlWriteFailure(nested(message))).toBe(false);
			expect(isRetriableSchemaInitFailure(nested(message))).toBe(false);
		}
	});

	it('never retries a non-Error throw, even one whose text would match', () => {
		expect(isRetriableSchemaInitFailure(SELF_COORDINATION_BLOCKED)).toBe(false);
		expect(isRetriableSchemaInitFailure({ message: SELF_COORDINATION_BLOCKED })).toBe(false);
	});
});

/** The control collection most of the typed cases below are raised against. */
const PEER_COLLECTION = 'default/cadrecontrol/CadrePeer';

/**
 * A real upstream `TornActionError`: the write's log entry is stored, one block is not known to
 * hold it. `final` is the only field the classifier may act on; `detail` is upstream's "never
 * branch on it" text, defaulted here to a rival-holds-revision refusal.
 */
function tornWrite(final: boolean, detail = 'block PaWaynQLVfuwhcw4tGh0uX is held at rev 13 by another action'): TornActionError {
	return new TornActionError(PEER_COLLECTION, 'N7Wj4Q9nOWCkm5G1cxTPWg', 12, ['PaWaynQLVfuwhcw4tGh0uX'],
		'rival-holds-revision', final, detail);
}

/**
 * How a commit failure reaches `ControlDatabase`: the optimystic bridge rethrows the original
 * error, and Quereus wraps it in a `QuereusError` whose `cause` is that error.
 */
function viaQuereus(error: Error): QuereusError {
	return new QuereusError(`Commit failed: ${error.message}`, StatusCode.ERROR, error);
}

/**
 * The bridge's other rethrow shape (`TransactionBridge.mapCommitRefusal`): a new `Error` with a
 * re-rendered message and the original error as `cause`, then Quereus' wrap over that.
 */
function viaRefusalRewrap(error: Error): QuereusError {
	return viaQuereus(new Error('concurrent modification: another writer changed or removed the row in CadrePeer', { cause: error }));
}

/** A failure delivered bare, through Quereus, and through the bridge's rewrap — every shape it can take. */
function everyDelivery(error: Error): Error[] {
	return [error, viaQuereus(error), viaRefusalRewrap(error)];
}

/** Both write classifiers — the typed veto and matcher sit in their shared body, so each case holds for both. */
const WRITE_CLASSIFIERS = [
	['isRetriableControlWriteFailure', isRetriableControlWriteFailure],
	['isRetriableSchemaInitFailure', isRetriableSchemaInitFailure],
] as const;

/**
 * Failures upstream raises as TYPED errors that say whether any of the write is stored, classified
 * by class and field rather than by text — built here from the real `@optimystic/*` classes and
 * wrapped the way they arrive, because `instanceof` is the whole mechanism.
 *
 * The rule under test: a torn write is re-presented only when upstream marks it `final` (not
 * saved, cannot land, its pending records confirmed cancelled); a non-final torn write, a spent
 * sync budget, and a partial commit are never re-presented, whatever text they carry.
 */
describe.each(WRITE_CLASSIFIERS)('%s — typed possibly-stored failures', (_name, classify) => {
	it('retries a final torn write, bare and wrapped', () => {
		for (const delivered of everyDelivery(tornWrite(true))) {
			expect(classify(delivered)).toBe(true);
		}
	});

	it('never retries a non-final torn write — it may be saved already or land later', () => {
		for (const delivered of everyDelivery(tornWrite(false))) {
			expect(classify(delivered)).toBe(false);
		}
	});

	/**
	 * `detail` is the responder's own words, and upstream embeds it in the message. When those
	 * words are a pend-phase aggregate, the message alone would satisfy the text matcher's prefix
	 * and `[block:` token — this pins the typed veto running first.
	 */
	it('never retries a non-final torn write whose detail embeds a pend-phase aggregate', () => {
		for (const delivered of everyDelivery(tornWrite(false, TRANSACTOR_AGGREGATE))) {
			expect(classify(delivered)).toBe(false);
		}
	});

	/**
	 * Upstream documents resubmitting after a spent sync budget as unsafe: the attempt that spent
	 * it may have left its log entry standing. `lastReason` is embedded in the message, so the
	 * aggregate-bearing variant pins the veto against the text matcher again; the stalled-revision
	 * subclass is covered by the same `instanceof`.
	 */
	it('never retries a SyncRetryExhaustedError, whatever its last reason says', () => {
		const exhausted = [
			new SyncRetryExhaustedError(PEER_COLLECTION, 10),
			new SyncRetryExhaustedError(PEER_COLLECTION, 10, TRANSACTOR_AGGREGATE),
			new SyncRevisionStalledError(PEER_COLLECTION, 3, { blockId: 'PaWaynQLVfuwhcw4tGh0uX', rev: 13 }, 13, 12,
				TRANSACTOR_AGGREGATE),
		];
		for (const error of exhausted) {
			for (const delivered of everyDelivery(error)) {
				expect(classify(delivered)).toBe(false);
			}
		}
	});

	it('never retries a partial commit reporting a final torn sibling — another collection landed', () => {
		const partial = new CoordinatorPartialCommitError(['default/cadrecontrol/CadrePeer$PeerIdIndex'],
			[PEER_COLLECTION], tornWrite(true));
		for (const delivered of everyDelivery(partial)) {
			expect(classify(delivered)).toBe(false);
		}
	});

	/**
	 * Both partial-commit errors embed their reason's message (`Underlying failure: …`), so a
	 * pend-phase aggregate from a sibling collection puts the text matcher's prefix and token into
	 * a message that also reports a durable half. Re-running the whole write body would double-apply
	 * that half; upstream's contract says the whole transaction must not be blindly retried.
	 */
	it('never retries a partial commit whose failure is a pend-phase aggregate', () => {
		const partials = [
			new CoordinatorPartialCommitError(['default/cadrecontrol/CadrePeer$PeerIdIndex'], [PEER_COLLECTION],
				new Error(TRANSACTOR_AGGREGATE)),
			new PartialCommitError(['default/cadrecontrol/CadrePeer'], ['default/cadrecontrol/CadrePeer$PeerIdIndex'],
				new Error(TRANSACTOR_AGGREGATE)),
		];
		for (const partial of partials) {
			for (const delivered of everyDelivery(partial)) {
				expect(classify(delivered)).toBe(false);
			}
		}
	});

	/**
	 * Neither partial-commit error chains its reason on `cause` today, so a final torn sibling is
	 * visible only in the text. Hand-assembled so the order is pinned should upstream start
	 * chaining it: the partial commit's veto must still beat the final torn write's claim.
	 */
	it('lets the partial-commit veto beat a final torn write on the same chain', () => {
		const partial = new CoordinatorPartialCommitError(['default/cadrecontrol/CadrePeer$PeerIdIndex'],
			[PEER_COLLECTION], tornWrite(true));
		partial.cause = tornWrite(true);
		expect(classify(viaQuereus(partial))).toBe(false);
	});
});

describe('retryControlWrite', () => {
	it('returns the second attempt\'s value after one transient failure', async () => {
		let runs = 0;
		const result = await retryControlWrite(async () => {
			runs++;
			if (runs === 1) {
				throw nested(TRANSACTOR_AGGREGATE);
			}
			return 'committed';
		}, immediatePacing());

		expect(result).toBe('committed');
		expect(runs).toBe(2);
	});

	it('rethrows the LAST error unchanged after exhausting every attempt', async () => {
		const errors: Error[] = [];
		let runs = 0;
		let caught: unknown;
		try {
			await retryControlWrite(async () => {
				runs++;
				const error = nested(SUPER_MAJORITY_NONE_ANSWERED);
				errors.push(error);
				throw error;
			}, immediatePacing());
		} catch (error) {
			caught = error;
		}

		expect(runs).toBe(CONTROL_WRITE_ATTEMPTS);
		expect(errors).toHaveLength(CONTROL_WRITE_ATTEMPTS);
		// Identity, not message equality: the loop must rethrow the last attempt's error
		// object unchanged, never a wrapper and never an earlier attempt's.
		expect(caught).toBe(errors[errors.length - 1]);
	});

	/**
	 * The degraded-member case: a genuinely silent cohort member fails at ~20 s, past the
	 * 10 s elapsed budget before attempt 1 even returns — so the loop must surface it
	 * immediately. Retry adds ZERO latency to the case where it cannot help.
	 */
	it('stops after one attempt when that attempt alone consumed the budget', async () => {
		let clock = 0;
		let runs = 0;
		let slept = 0;
		const failure = nested(TRANSACTOR_AGGREGATE);
		await expect(retryControlWrite(async () => {
			runs++;
			clock += CONTROL_WRITE_RETRY_BUDGET_MS;
			throw failure;
		}, { now: () => clock, sleep: () => { slept++; return Promise.resolve(); } }))
			.rejects.toBe(failure);

		expect(runs).toBe(1);
		expect(slept).toBe(0);
	});

	/**
	 * `attempts` is caller-supplied, so a value below 1 must not fall straight through the loop
	 * and rethrow the `lastError` nobody set — `throw undefined` would defeat every downstream
	 * `instanceof Error` check and erase the real failure.
	 */
	it('still runs the body once when attempts is below 1', async () => {
		let runs = 0;
		const failure = nested(TRANSACTOR_AGGREGATE);
		await expect(retryControlWrite(async () => {
			runs++;
			throw failure;
		}, immediatePacing({ attempts: 0 }))).rejects.toBe(failure);

		expect(runs).toBe(1);
	});

	it('propagates a non-retriable failure from the first attempt, unretried', async () => {
		let runs = 0;
		const failure = nested('CHECK constraint failed: Authorized');
		await expect(retryControlWrite(async () => {
			runs++;
			throw failure;
		}, immediatePacing())).rejects.toBe(failure);

		expect(runs).toBe(1);
	});

	/**
	 * A final torn write is a lost race against a rival holding the revision the write claimed.
	 * Re-running the body re-reads, so attempt 2 builds on the rival's revision and commits.
	 */
	it('re-runs the body after a final torn write, and not after a non-final one', async () => {
		let runs = 0;
		const result = await retryControlWrite(async () => {
			runs++;
			if (runs === 1) {
				throw viaQuereus(tornWrite(true));
			}
			return 'committed';
		}, immediatePacing());

		expect(result).toBe('committed');
		expect(runs).toBe(2);

		runs = 0;
		const failure = viaQuereus(tornWrite(false));
		await expect(retryControlWrite(async () => {
			runs++;
			throw failure;
		}, immediatePacing())).rejects.toBe(failure);
		expect(runs).toBe(1);
	});

	/**
	 * Default pacing bounds: ±50% jitter on [250, 1000] means the first backoff is
	 * 125–375 ms (the jitter can never floor a delay to zero) and the second is capped at
	 * the largest base, 1000 ms (so a `stop()` racing a backoff is never held long).
	 */
	it('jitters each backoff within its floor and the largest-base cap', async () => {
		const delays: number[] = [];
		let runs = 0;
		await expect(retryControlWrite(async () => {
			runs++;
			throw nested(TRANSACTOR_AGGREGATE);
		}, { now: () => 0, sleep: (ms) => { delays.push(ms); return Promise.resolve(); } }))
			.rejects.toThrow();

		expect(runs).toBe(CONTROL_WRITE_ATTEMPTS);
		expect(delays).toHaveLength(CONTROL_WRITE_ATTEMPTS - 1);
		expect(delays[0]).toBeGreaterThanOrEqual(125);
		expect(delays[0]).toBeLessThanOrEqual(375);
		expect(delays[1]).toBeGreaterThanOrEqual(500);
		expect(delays[1]).toBeLessThanOrEqual(1000);
	});

	/**
	 * The named schema-init policy driven through the loop: its own attempt count, its own
	 * backoff bounds, its own classifier. Bounds are asserted rather than exact values because
	 * every delay is jittered ±50% and capped at the largest base (2000 ms).
	 */
	it('honours SCHEMA_INIT_RETRY_POLICY\'s attempts, backoff and widened classifier', async () => {
		const delays: number[] = [];
		let runs = 0;
		await expect(retryControlWrite(async () => {
			runs++;
			throw nested(ddlFailure(SELF_COORDINATION_IN_MODULE_CREATE));
		}, {
			...SCHEMA_INIT_RETRY_POLICY,
			now: () => 0,
			sleep: (ms) => { delays.push(ms); return Promise.resolve(); },
		})).rejects.toThrow();

		expect(runs).toBe(SCHEMA_INIT_ATTEMPTS);
		expect(delays).toHaveLength(SCHEMA_INIT_ATTEMPTS - 1);
		expect(delays[0]).toBeGreaterThanOrEqual(125);
		expect(delays[0]).toBeLessThanOrEqual(375);
		expect(delays[3]).toBeGreaterThanOrEqual(1_000);
		expect(delays[3]).toBeLessThanOrEqual(2_000);
		// Worst case still fits the shared ceiling, so the budget only ever bites when an
		// ATTEMPT is slow — never on this policy's backoff alone.
		expect(delays.reduce((total, ms) => total + ms, 0)).toBeLessThan(CONTROL_WRITE_RETRY_BUDGET_MS);
	});

	/**
	 * Same failure, default policy: one attempt, no retry. The pair is the proof that the widening
	 * is opt-in per call site rather than a change to what every control write absorbs.
	 */
	it('leaves the DEFAULT policy refusing that same failure after one attempt', async () => {
		let runs = 0;
		const failure = nested(ddlFailure(SELF_COORDINATION_IN_MODULE_CREATE));
		await expect(retryControlWrite(async () => {
			runs++;
			throw failure;
		}, immediatePacing())).rejects.toBe(failure);

		expect(runs).toBe(1);
	});

	/**
	 * The `label` option's whole surface is the debug line — several control writes retry
	 * concurrently in a real party, so an unlabelled line cannot be attributed to a write.
	 * The degraded-cohort scenario asserts on exactly this rendering (it filters the funnel's
	 * lines by `[<label>]`), but that scenario needs a real trio and is intermittently red on
	 * a tracked boot race, so the rendering is pinned here too — a pure string surface should
	 * not depend on a three-node network to notice a change.
	 */
	it('stamps the label into every line it logs, and changes nothing without one', async () => {
		const labelled = await captureRetryLog(() => runOneTransientFailure({ label: 'peer-insert' }));
		const unlabelled = await captureRetryLog(() => runOneTransientFailure({}));

		// Both lines the loop emits on this path carry the tag, right after the subject.
		expect(labelled.some((line) => line.includes('Control write [peer-insert] failed transiently'))).toBe(true);
		expect(labelled.some((line) => line.includes('Control write [peer-insert] committed on attempt 2/3'))).toBe(true);
		// Unlabelled lines are byte-identical to what this loop logged before labels existed.
		expect(unlabelled.some((line) => line.includes('Control write failed transiently'))).toBe(true);
		expect(unlabelled.some((line) => line.includes('Control write committed on attempt 2/3'))).toBe(true);
		// (Only the TAG position matters — the error text these lines carry has brackets of
		// its own, `[block:…]`, which is exactly what the classifier reads.)
		expect(unlabelled.every((line) => !line.includes('Control write ['))).toBe(true);
	});
});

/**
 * The funnel's report that it GAVE UP — the seam that keeps an abandoned write from
 * disappearing. Both give-up exits fire it, a rescued write fires nothing, and a throwing
 * observer may not displace the failure the caller has to see.
 *
 * Why it matters at all: the debug lines these cases' production counterparts emit are off
 * unless something set `DEBUG=`, and a BACKGROUND control write (the self-address republish,
 * the two replication drains in `cadre-node.ts`) is fired unawaited with a `debug`-only catch
 * — so before this hook a permanently-abandoned background write reached nobody. Measured:
 * one run of `control-write-degraded-cohort-member.integration.ts` reported 7 passed while a
 * node's `[self-record-update]` had been abandoned for good during it.
 */
describe('retryControlWrite — abandonment notification', () => {
	/** Collect abandonments, in order, for one run. */
	function recorder(): { seen: ControlRetryAbandonment[]; onAbandon: (a: ControlRetryAbandonment) => void } {
		const seen: ControlRetryAbandonment[] = [];
		return { seen, onAbandon: (a) => { seen.push(a); } };
	}

	/**
	 * The classifier-declined exit — the one the LIVE contention failure takes
	 * ({@link SYNC_RETRY_EXHAUSTED_PENDING_CONFLICT}), on attempt 1 of 3, with no retry.
	 */
	it('reports a declined failure once, naming the attempt it stopped on', async () => {
		const { seen, onAbandon } = recorder();
		const failure = nested(SYNC_RETRY_EXHAUSTED_PENDING_CONFLICT);
		await expect(retryControlWrite(async () => { throw failure; },
			immediatePacing({ label: 'self-record-update', onAbandon }))).rejects.toBe(failure);

		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			label: 'self-record-update',
			attemptsMade: 1,
			attemptsAllowed: CONTROL_WRITE_ATTEMPTS,
			reason: 'declined'
		});
		// Identity, not message equality: the observer gets the object the caller is about to
		// see, so an app can classify it with the same matchers.
		expect(seen[0]!.error).toBe(failure);
	});

	/** The exhausted-attempts exit: every attempt ran, every one failed transiently. */
	it('reports an exhausted retry once, after the last attempt', async () => {
		const { seen, onAbandon } = recorder();
		let runs = 0;
		await expect(retryControlWrite(async () => {
			runs++;
			throw nested(TRANSACTOR_AGGREGATE);
		}, immediatePacing({ label: 'peer-insert', onAbandon }))).rejects.toThrow();

		expect(runs).toBe(CONTROL_WRITE_ATTEMPTS);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			label: 'peer-insert',
			attemptsMade: CONTROL_WRITE_ATTEMPTS,
			attemptsAllowed: CONTROL_WRITE_ATTEMPTS,
			reason: 'attempts'
		});
	});

	/**
	 * The budget exit, told apart from the attempts one. This is the degraded-member case: a
	 * ~20 s first attempt spends the 10 s budget, so the loop stops with attempts to spare —
	 * and the reason has to say `budget`, or an operator reading the report concludes the
	 * write was tried three times when it was tried once.
	 */
	it('distinguishes the budget exit from the attempts exit', async () => {
		const { seen, onAbandon } = recorder();
		let clock = 0;
		await expect(retryControlWrite(async () => {
			clock += CONTROL_WRITE_RETRY_BUDGET_MS;
			throw nested(TRANSACTOR_AGGREGATE);
		}, { now: () => clock, sleep: () => Promise.resolve(), label: 'peer-remove', onAbandon }))
			.rejects.toThrow();

		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			attemptsMade: 1,
			attemptsAllowed: CONTROL_WRITE_ATTEMPTS,
			reason: 'budget',
			elapsedMs: CONTROL_WRITE_RETRY_BUDGET_MS
		});
	});

	/**
	 * A write the retry RESCUED is not an abandonment. Without this the observer would report
	 * every transient blip, and the node's escalation — which is about a write that is
	 * genuinely lost — would fire on writes that committed a second later.
	 */
	it('reports nothing when a retry commits the write', async () => {
		const { seen, onAbandon } = recorder();
		await runOneTransientFailure({ label: 'self-record-update', onAbandon });

		expect(seen).toEqual([]);
	});

	/** An unlabelled call still reports; the label is simply absent. */
	it('reports an unlabelled operation without inventing a label', async () => {
		const { seen, onAbandon } = recorder();
		const failure = nested('CHECK constraint failed: Authorized');
		await expect(retryControlWrite(async () => { throw failure; },
			immediatePacing({ onAbandon }))).rejects.toBe(failure);

		expect(seen).toHaveLength(1);
		expect(seen[0]!.label).toBeUndefined();
	});

	/**
	 * A throwing observer is a bug in the observer, and it must not become the write's
	 * failure: the loop is on its way to rethrowing the real error, and letting a listener's
	 * `TypeError` out instead would erase the very failure it was notified about. Asserted on
	 * BOTH exits — they notify from different places in the loop.
	 */
	it('rethrows the failure the write itself raised when the observer throws', async () => {
		const declined = nested('CHECK constraint failed: Authorized');
		await expect(retryControlWrite(async () => { throw declined; }, immediatePacing({
			onAbandon: () => { throw new Error('observer blew up'); }
		}))).rejects.toBe(declined);

		// Exhaustion rethrows the LAST attempt's error, so the identity check has to be made
		// after the loop finishes rather than against a variable read before it starts.
		const transient: Error[] = [];
		let caught: unknown;
		try {
			await retryControlWrite(async () => {
				const error = nested(TRANSACTOR_AGGREGATE);
				transient.push(error);
				throw error;
			}, immediatePacing({ onAbandon: () => { throw new Error('observer blew up'); } }));
		} catch (error) {
			caught = error;
		}
		expect(transient).toHaveLength(CONTROL_WRITE_ATTEMPTS);
		expect(caught).toBe(transient[transient.length - 1]);
	});
});

/** One transient failure then success, under the given options plus never-sleep pacing. */
async function runOneTransientFailure(options: ControlWriteRetryOptions): Promise<void> {
	let runs = 0;
	await retryControlWrite(async () => {
		runs++;
		if (runs === 1) throw nested(TRANSACTOR_AGGREGATE);
	}, immediatePacing(options));
}

/** The lines `sereus:cadre:control-db` emitted while `body` ran. */
function captureRetryLog(body: () => Promise<void>): Promise<string[]> {
	return captureDebugLog('sereus:cadre:control-db', body);
}

/**
 * Test-only window onto `ControlDatabase.loadSchema` and the two private fields it needs:
 * the `Database` handle `initialize` would have built, and `lockedWithRetry`'s pacing seams.
 * Same cast pattern `control-write-lock.spec.ts` uses for the same seams.
 *
 * Driving `loadSchema` directly (rather than `initialize`) is deliberate: the subject is
 * whether the DDL `exec` is re-presented after a transient cohort failure, and everything
 * `initialize` does before it — plugin registration, libp2p injection, catalog hydration —
 * is irrelevant to that and would cost a real node bring-up to reproduce.
 */
interface SchemaInitHarness {
	db: { exec: (sql: string) => Promise<void> };
	controlWriteRetryPacing: ControlWriteRetryOptions;
	loadSchema: () => Promise<void>;
	/** Public on the real class; named here so the cast can reach it. */
	setControlWriteAbandonedListener: (listener: ((a: ControlRetryAbandonment) => void) | null) => void;
}

/**
 * A `ControlDatabase` with `initialize`'s output faked: `exec` is the supplied stub, pacing
 * never sleeps. The config is never read on this path (`schemaPath` is absent, so
 * `loadSchema` takes the embedded-schema branch), hence the cast rather than a real libp2p
 * node.
 */
function schemaInitHarness(exec: (sql: string) => Promise<void>): SchemaInitHarness {
	const database = new ControlDatabase({ partyId: 'schema-init-spec' } as ControlDatabaseConfig);
	const harness = database as unknown as SchemaInitHarness;
	harness.db = { exec };
	harness.controlWriteRetryPacing = immediatePacing();
	return harness;
}

/**
 * Schema init is a DISTRIBUTED write — every `CadreControl` table is optimystic-backed, so
 * each `create table` needs a super-majority of the party's peers to answer. It used to be
 * the one such write that bypassed the retry, which made a node joining a party that already
 * had two live members die on startup over a single unanswered peer.
 *
 * Re-running the whole `exec` is safe because `apply schema` is a diff, not a replay, and a
 * failed `create table` leaves the catalog clean — so attempt 2 re-emits exactly the failed
 * table and its successors. The reasoning lives at the call site; these cases pin the
 * behaviour.
 *
 * It is also the ONE caller on a non-default policy ({@link SCHEMA_INIT_RETRY_POLICY}): same
 * classifier plus optimystic's self-coordination grace refusal, over more attempts and a longer
 * backoff. That re-run safety argument is why the extra class is safe HERE and nowhere else.
 */
describe('ControlDatabase.loadSchema — transient-failure retry', () => {
	/**
	 * Driven from both faces of the shortfall: the bare sentence, and the pend-phase aggregate
	 * that actually carries it on the wire. The aggregate form is the one that matters — the
	 * bare form would still be retried even if a real joining node never produced it.
	 */
	it('re-presents the whole DDL after a third-node-join super-majority shortfall', async () => {
		for (const causeMessage of [SUPER_MAJORITY_THIRD_NODE_JOIN, SUPER_MAJORITY_IN_PEND_AGGREGATE]) {
			let runs = 0;
			const executed: string[] = [];
			const harness = schemaInitHarness(async (sql) => {
				runs++;
				executed.push(sql);
				if (runs === 1) {
					throw nested(ddlFailure(causeMessage));
				}
			});

			await harness.loadSchema();

			expect(runs).toBe(2);
			// The retry re-presents the SAME schema text: Quereus diffs it against the live
			// catalog, so the tables that landed on attempt 1 emit no DDL the second time.
			expect(executed[1]).toBe(executed[0]);
			expect(executed[0]).toContain('CadreControl');
		}
	});

	/**
	 * The failure that motivated the widened policy: a freshly provisioned node whose connection
	 * blipped mid-DDL, so optimystic refused to let it elect ITSELF coordinator and startup died
	 * on the first `create table` that hit it — never reporting healthy, so whoever provisioned it
	 * timed out waiting.
	 *
	 * Driven through the full wrapper stack a real startup prints, because the classifier only has
	 * TEXT to work with: optimystic's rethrow drops the `cause`, so a match on the error type is
	 * not available at this seam.
	 */
	it('re-presents the whole DDL after a self-coordination grace refusal', async () => {
		let runs = 0;
		const executed: string[] = [];
		const harness = schemaInitHarness(async (sql) => {
			runs++;
			executed.push(sql);
			if (runs === 1) {
				throw nested(ddlFailure(SELF_COORDINATION_IN_MODULE_CREATE));
			}
		});

		await harness.loadSchema();

		expect(runs).toBe(2);
		expect(executed[1]).toBe(executed[0]);
	});

	/**
	 * The failure faces observed from the same joining node that this retry is NOT for. A
	 * commit-phase batch is INDETERMINATE (the write may have landed) whether or not it also
	 * carries a super-majority shortfall, and `Missing block` is durable — it was the ONLY DDL
	 * death seen across twelve scenario runs on 2026-08-02/03. All must reach the caller from
	 * the first attempt: a silent extra ~2 s of retry before the identical error is pure cost.
	 */
	it('never re-presents an indeterminate commit or a durable convergence fault', async () => {
		for (const causeMessage of [
			TRANSACTOR_AGGREGATE_COMMIT_PHASE,
			SUPER_MAJORITY_IN_COMMIT_AGGREGATE,
			MISSING_BLOCK,
			// The self-coordination refusal IS absorbed here, but only for the grace-period
			// reason — a disabled guard or a detected partition still surfaces immediately.
			...SELF_COORDINATION_OTHER_REASONS,
		]) {
			let runs = 0;
			const failure = nested(ddlFailure(causeMessage));
			const harness = schemaInitHarness(async () => {
				runs++;
				throw failure;
			});

			await expect(harness.loadSchema()).rejects.toBe(failure);
			expect(runs).toBe(1);
		}
	});

	/**
	 * The `ControlDatabase` seam, driven through a real `lockedWithRetry` rather than a direct
	 * `retryControlWrite` call: the single settable listener must reach the loop, carry the
	 * call site's own label, and stop being called once cleared.
	 *
	 * Wired this way because the production listener is a `CadreNode` that clears it on
	 * teardown — a listener that kept firing for a database the node no longer owns would
	 * report a dead node's losses as a live node's.
	 */
	it('delivers an abandonment to the ControlDatabase listener, and stops once cleared', async () => {
		const seen: ControlRetryAbandonment[] = [];
		const failure = nested(ddlFailure(MISSING_BLOCK));
		const harness = schemaInitHarness(async () => { throw failure; });
		harness.setControlWriteAbandonedListener((abandonment) => { seen.push(abandonment); });

		await expect(harness.loadSchema()).rejects.toBe(failure);
		expect(seen).toHaveLength(1);
		// `loadSchema`'s own label, not the policy's or the pacing's — it is what attributes
		// the loss among the writes a real party runs concurrently.
		expect(seen[0]).toMatchObject({ label: 'schema-init', reason: 'declined', attemptsMade: 1 });

		harness.setControlWriteAbandonedListener(null);
		await expect(harness.loadSchema()).rejects.toBe(failure);
		expect(seen).toHaveLength(1);
	});

	it('surfaces the last error unchanged once the attempt budget is spent', async () => {
		const thrown: Error[] = [];
		const harness = schemaInitHarness(async () => {
			const failure = nested(ddlFailure(SUPER_MAJORITY_THIRD_NODE_JOIN));
			thrown.push(failure);
			throw failure;
		});

		let caught: unknown;
		try {
			await harness.loadSchema();
		} catch (error) {
			caught = error;
		}

		// Schema init runs on its OWN policy, so the ceiling here is SCHEMA_INIT_ATTEMPTS, not
		// the default control-write count.
		expect(thrown).toHaveLength(SCHEMA_INIT_ATTEMPTS);
		// Identity, not message equality: the LAST attempt's error object, never a wrapper
		// and never an earlier attempt's — startup diagnostics read this text verbatim.
		expect(caught).toBe(thrown[thrown.length - 1]);
	});
});
