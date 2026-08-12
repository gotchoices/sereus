/**
 * Control writes with a connected-but-DEGRADED cohort member — the measurement.
 *
 * The control database replicates every block to the whole party
 * (`CONTROL_REPLICATION_BREADTH`), and a control write commits only when a
 * super-majority of the cohort the block was offered to approves. A member that
 * is connected but degraded (slow, or silently never answering) sits INSIDE
 * that cohort and counts against the bar — at three members,
 * `ceil(3 × 0.75) = 3` makes one degraded member decisive. The sibling
 * coverage in `cadre-core`'s `control-database-offline-peers.spec.ts` is about
 * members that never enter the cohort at all; this scenario is about members
 * that do.
 *
 * What bounds a silent member is NOT the coordinator (its promise fan-out is a
 * bare `Promise.all` with no phase deadline) but the per-RPC response deadline
 * in `ClusterClient` (`DEFAULT_RESPONSE_TIMEOUT_MS` = 10 s, two attempts per
 * remote peer), under the transactor's 30 s transaction budget. The measured
 * outcomes (single machine, localhost websockets; the wall-clock is logged on
 * every run, and the bounds in "Deadlines" below are sized off these):
 *
 *  - no degradation            → commits, ~1 s;
 *  - 2 s delay (< 10 s bar)    → commits, ~55 s — the delay is paid serially
 *    across the ~27 inbound cluster RPCs one control write makes, so a small
 *    per-RPC delay becomes a large per-WRITE one;
 *  - never answers (> 10 s bar)→ clean failure at ~20 s (two response-deadline
 *    attempts) naming
 *    `Failed to get super-majority: 2/3 approvals (needed 3, 0 rejections)`.
 *
 * One case here is a standing EXPECTED FAILURE (`it.fails`): control reads on
 * the writing node block behind an in-flight stalled write instead of answering
 * from committed local state. That is a real defect, tracked as
 * `fix/control-reads-blocked-by-stalled-write`, not a property of this harness.
 *
 * A naive three-node test proves nothing here: FRET's routing table stays cold
 * inside a test's lifetime, so real cohort discovery returns self-only cohorts
 * that never reach the super-majority branch. `forceFullCohort` and
 * `pinCoordinator` (see `harness/forced-cluster.ts` for what they patch and
 * why) replace cohort DISCOVERY and coordinator ASSIGNMENT only — the real
 * cluster clients, response deadlines, transports and `ClusterMember`s all stay
 * in place. Their call counters back the anti-vacuity assertions that each write
 * really consulted a 3-peer cohort.
 *
 * The coordinator pin (`pinCoordinator([A])`) decides WHICH branch is measured,
 * not merely how deterministically. When the coordinator is the degraded node
 * itself, the writer reaches it over the (healthy) repo protocol, its own
 * cluster vote is in-process, and its degraded INBOUND cluster handler never
 * sees a stream — so the write COMMITS fast (~0.25–0.5 s in an exploratory run)
 * instead of failing (~42 s). That branch is real availability, not a defect.
 * It is NOT covered here and cannot be, for the reason in the next paragraph:
 * pinning the coordinator to C makes every case fail with `Missing block`
 * before any degradation is reached, writes included (the write path reads
 * through the same seam). `docs/architecture.md` therefore records that branch
 * as observed-not-asserted. Pinning to a healthy node measures the other
 * branch, the one where a healthy coordinator must RPC into the degraded member
 * and the degradation bites.
 *
 * Why A and not B: `findCoordinator` is also the READ path's routing seam
 * (`NetworkTransactor.batchesForPayload`), and only A holds the control trees'
 * genesis-era blocks — A wrote them solo before B and C joined, so a read
 * pinned to B fails with `Missing block`. Pinning to A keeps reads served from
 * the node that has the data while still forcing every write down the
 * degradation-exercising branch: coordinator A must dial INTO C's degraded
 * cluster handler for its cluster vote.
 *
 * The degraded member is a full `CadreNode`: the under-the-deadline case needs
 * a real `ClusterMember` to validate and approve, and the transactor's retry
 * path may re-coordinate through any node, which needs every node serving the
 * repo protocol. Degradation is injected one layer down instead — the node's
 * registered cluster protocol handler is re-registered behind a delay (or a
 * never-answer hold), so everything else about the node stays honest.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import debug from 'debug';
import { format } from 'node:util';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { Stream, Connection } from '@libp2p/interface';
import {
	CadreNode, isRetriableControlWriteFailure, signPeerRecord, ed25519KeyPairFromLibp2p
} from '@serfab/cadre-core';
import type { Ed25519KeyPair } from '@serfab/cadre-core';
import {
	waitUntil, sleep, forceFullCohort, pinCoordinator, controlNodeConfig, makeOwnOwner, randomPeerId
} from '../harness/index.js';
import type { ForcedCohortHandle, PinnedCoordinatorHandle } from '../harness/index.js';

const log = debug('sereus:integration:degraded-cohort');

// ── Deadlines ─────────────────────────────────────────────────────────────────
//
// Every bound below is sized off MEASURED single-machine (localhost websockets)
// runs under the forced cohort + pinned coordinator, with ~2–3× headroom so a
// slower CI box does not flake while a real regression still trips the bound
// (re-measured 2026-08-12 with the control-write retry live under every case):
//
//   healthy authorize+remove ......... ~1.2–2.2 s (both writes, combined)
//   2 s-delayed authorize / remove ... ~55 s      each
//   never-answering member ........... ~20 s or ~40 s to the named failure
//   recovery after a failed write .... ~1.1–1.8 s
//   transient-reset absorb ........... ~0.7 s     (commits on attempt 2)
//
// The ~55 s delayed commit is the 2 s handler delay paid serially across the
// ~27 inbound cluster RPCs a control write makes: a small per-RPC delay becomes
// a large per-WRITE one. The failure is ~20 s per pend round — two 10 s
// `ClusterClient` response-deadline attempts against the silent member — and
// the number of rounds is NOT deterministic even with the coordinator pinned
// (one round in some runs, two in others; see the failure case's assertions).
//
// KNOWN INTERMITTENT (pre-existing, not this suite's defect): the healthy and
// delayed cases sometimes fail with `Failed to get super-majority: 0/3
// approvals (needed 3, 0 rejections)` — nobody votes at all, so those runs
// prove nothing about degradation either way. Struck 3 of 5 full boots on
// 2026-08-12, 2 of 2 on that day's review pass, and 1 of 3 isolated runs of the
// healthy case. Cause settled 2026-08-12 and filed upstream as
// `../optimystic/tickets/fix/lost-conflict-race-abstains-and-orphans-the-block`:
// concurrent writers on one block (this write plus B's and C's ORGANIC
// `[self-record-update]` refreshes) produce a stale-revision rejection whose
// coordinator abandons the pend without telling the members, and the abandoned
// pend then wins the conflict race against every later write for a fixed 2 s —
// during which a losing member returns NO vote, which the coordinator counts as
// zero approvals AND zero rejections. Each blocked attempt leaves a fresh 2 s
// blocker, so all three retry attempts land inside the window. Tracked here by
// `tickets/blocked/control-write-hears-zero-approvals-from-healthy-trio` (listed
// in `tickets/.pre-existing-known.md`). The retry-log capture below prints the
// funnel's decisions when it strikes; to see the mechanism itself, re-run under
// `DEBUG='optimystic:db-p2p:cluster*'` and grep `race-keep-existing` /
// `phase-promising-blocked` / `stale-cleanup`. A red run on THIS fingerprint is
// that tracked class, not a regression of the retry coverage.

/** Reads and read-backs: all answer from local state; this only catches hangs. */
const READ_TIMEOUT_MS = 15_000;
/** Healthy writes (~0.3 s each measured); only catches a hang. */
const WRITE_TIMEOUT_MS = 30_000;
/** The 2 s-delayed writes: ~2× the ~55 s measurement. */
const DELAYED_WRITE_TIMEOUT_MS = 120_000;
/**
 * A write against a never-answering member: ~3× the slower (~40 s, two-round)
 * measured settle. A write that has not settled by here is the hang this
 * scenario exists to catch.
 */
const STALLED_WRITE_TIMEOUT_MS = 120_000;
/**
 * Assertion bounds for the named-failure case (distinct from the deadline
 * above, which only catches hangs). Floor: an INSTANT failure means the
 * response-deadline path was never exercised — an admission rejection or an
 * addressless dial wearing the same error, which would pass the error-text
 * assertion for the wrong reason. Ceiling: ~2× the slower measured variant, so
 * both the one-round (~20 s) and two-round (~40 s) settlements pass while a
 * genuinely unbounded stall does not.
 */
const FAILURE_FLOOR_MS = 15_000;
const FAILURE_CEILING_MS = 90_000;
/**
 * Ceiling for the 2 s-delayed COMMIT case, ~1.8× the ~55 s measurement. Each
 * cluster-transaction phase pays the delay once per inbound RPC to the degraded
 * member and a control write runs pend + commit, so many delayed rounds are
 * legitimate; a silent escalation into the response-deadline path would show up
 * as a MUCH larger number, not a smaller one.
 */
const DELAYED_COMMIT_CEILING_MS = 100_000;

// Each case's per-`it` timeout is set ABOVE the sum of the labelled deadlines it
// can pay, so that on a hang the labelled error — which names the operation —
// wins over vitest's anonymous test timeout. They are ceilings that never fire
// on a green run (slowest measured case: ~110 s).

/** The delay matrix: under the 10 s response deadline, and past it forever. */
const UNDER_DEADLINE_DELAY_MS = 2_000;

/**
 * Injected inbound-stream resets for the transient-reset case, applied to the
 * COORDINATOR's repo protocol (the transactor batch seam — see
 * `resetFirstProtocolStreams` for why not the cluster protocol). Two, so a
 * batch RPC that gets an in-line re-attempt still fails the write's first
 * attempt outright; tuned against real runs.
 */
const TRANSIENT_RESET_COUNT = 2;
/**
 * Ceiling for the reset-absorbed commit. The resets fail instantly (no
 * response-deadline wait), so the cost is the failed first attempt (<1 s), the
 * retry backoffs (jittered ≤375 ms, then ≤1 s if a second retry is needed) and
 * a healthy ~1 s commit — a few seconds end to end. Headroom so a slow box
 * does not flake while an escalation into the 10 s response-deadline path
 * (≥20 s) still trips it.
 */
const TRANSIENT_RESET_COMMIT_CEILING_MS = 15_000;

// ── Labelled deadline ─────────────────────────────────────────────────────────

/**
 * Run `op` under a hard deadline that fails the test NAMING the operation —
 * `degraded-cohort control op <label> timed out after <ms>ms`. A bare await on
 * a hung control call would instead blow vitest's own test timeout, which
 * names no operation. (Same contract as cadre-core's test-side `withinOp`;
 * that helper is not exported from the package, so it is restated here.)
 */
function within<T>(label: string, ms: number, op: () => Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`degraded-cohort control op ${label} timed out after ${ms}ms`)), ms);
		op().then(
			(value) => { clearTimeout(timer); resolve(value); },
			(error: unknown) => { clearTimeout(timer); reject(error); });
	});
}

/** Await `op` and report how long it took alongside its settlement. */
async function timedSettle(label: string, ms: number, op: () => Promise<unknown>):
	Promise<{ error: unknown | null; elapsedMs: number }> {
	const t0 = Date.now();
	const error = await within(label, ms, () => op().then(() => null, (e: unknown) => e));
	return { error, elapsedMs: Date.now() - t0 };
}

/**
 * Flatten an error's `.cause` chain into one searchable string — Quereus may
 * wrap the transactor's failure, so single-message matching under-reports.
 */
function errorChainText(error: unknown): string {
	const parts: string[] = [];
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (current != null && !seen.has(current)) {
		seen.add(current);
		if (current instanceof Error) {
			parts.push(current.message);
			current = current.cause;
		} else {
			parts.push(String(current));
			break;
		}
	}
	return parts.join(' | ');
}

/**
 * Guard on the classifier's phase discriminator, against the LIVE message: when
 * a failure carries the transactor's `Some peers did not complete:` aggregate,
 * that aggregate must name at least one single-block batch (`[block:`) — the
 * token `isRetriableControlWriteFailure` requires before it re-presents a
 * write. The shortfall SENTENCE itself is phase-blind (`cluster-coordinator.ts`
 * raises it identically from pend, cancel and commit), so the batch token is
 * the only segment that decides retriability; an upstream reformat of the
 * per-batch details silently disables the retry, and this turns that into a
 * red assertion here instead. (`/\[block:/` cannot match inside `[blocks:` —
 * the colon position separates the tokens.)
 */
function expectAggregateCarriesBatchToken(chain: string): void {
	if (/Some peers did not complete:/.test(chain)) {
		expect(chain,
			'transactor aggregate carries no [block: batch token — the narrowed classifier would never retry this shape'
		).toMatch(/\[block:/);
	}
}

// ── Control-write retry log capture ───────────────────────────────────────────

interface RetryLogCapture {
	/** Every `sereus:cadre:control-db` line emitted since capture began. */
	lines(): string[];
	/** Put debug's namespace set and sink back. Idempotent. */
	restore(): void;
}

/**
 * Capture cadre-core's control-write retry debug lines
 * (`sereus:cadre:control-db`) for the duration of a case. The retry funnel's
 * decisions — `committed on attempt N`, `retrying in`, `failed after N/M
 * attempt(s)` — are observable ONLY through these lines: the funnel neither
 * wraps the error it rethrows nor exposes an attempt counter, so this is the
 * one seam that can prove the retry ENGAGED (or stayed out of the way) on a
 * real write. debug's sink and enabled-namespace set are process-global, so
 * lines from every node in the trio land in one capture; each assertion below
 * says how it copes with that.
 *
 * NOTE: process-global also means this assumes the cases run SERIALLY (vitest's
 * default within a file). Marking any case in here `it.concurrent` would nest
 * two captures, and the inner `restore()` would hand the sink back to the outer
 * wrapper rather than to debug's own — capture per case first if that day comes.
 */
function captureControlRetryLogs(): RetryLogCapture {
	const captured: string[] = [];
	const previousNamespaces = debug.disable();
	debug.enable(previousNamespaces ? `${previousNamespaces},sereus:cadre:control-db` : 'sereus:cadre:control-db');
	const previousLog = debug.log;
	debug.log = function (this: unknown, ...args: unknown[]): void {
		captured.push(format(...args));
		previousLog.apply(this, args);
	};
	let restored = false;
	return {
		lines: () => [...captured],
		restore: (): void => {
			if (restored) return;
			restored = true;
			debug.log = previousLog;
			debug.disable();
			if (previousNamespaces) debug.enable(previousNamespaces);
		}
	};
}

/**
 * Print the retry funnel's decision lines under a `[retry-log]` prefix — the
 * record a red run needs. In particular, when the intermittent healthy-path
 * `0/3 approvals` failure strikes (tracked as an arm on
 * `control-write-retry-scenario-coverage`), these lines say whether the funnel
 * declined the failure (`not retried here` — a commit-phase veto or classifier
 * miss) or retried and exhausted — the disambiguation that arm is missing.
 */
function printRetryDecisions(caseLabel: string, capture: RetryLogCapture): void {
	for (const line of capture.lines()) {
		// Matches all four funnel messages, labelled (`Control write [x] failed …`)
		// or not; deliberately loose so a message rewording still prints.
		if (line.includes('Control write')) {
			console.log(`[retry-log ${caseLabel}] ${line}`);
		}
	}
}

// ── Degraded cluster handler ──────────────────────────────────────────────────

/** The structural slice of libp2p's internal registrar this injection needs. */
interface RegistrarLike {
	getHandler(protocol: string): { handler: (stream: Stream, connection: Connection) => void | Promise<void>; options: Record<string, unknown> };
	handle(protocol: string, handler: (stream: Stream, connection: Connection) => void | Promise<void>, options?: Record<string, unknown>): Promise<void>;
	unhandle(protocol: string): Promise<void>;
}

interface DegradedHandle {
	/** Put the original handler back and abort every still-held stream. Idempotent. */
	restore(): Promise<void>;
	/** Inbound cluster streams the wrapper has intercepted so far. */
	interceptedStreams(): number;
}

/** Resolve after `ms`, or immediately once `signal` aborts. */
function delayOrAbort(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
		if (signal.aborted) { resolve(); return; }
		const timer = setTimeout(onDone, ms);
		function onDone(): void {
			clearTimeout(timer);
			signal.removeEventListener('abort', onDone);
			resolve();
		}
		signal.addEventListener('abort', onDone);
	});
}

/** Resolve only once `signal` aborts — the never-answer hold. */
function untilAbort(signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
		if (signal.aborted) { resolve(); return; }
		signal.addEventListener('abort', () => resolve(), { once: true });
	});
}

/**
 * Re-register `node`'s control-network cluster protocol handler so every
 * inbound cluster RPC is delayed by `delayMs` — or held open forever when
 * `delayMs` is `Infinity` — before the REAL handler (captured off the
 * registrar, authorization gate and all) runs. The transactor's retry path can
 * hit the degraded member several times per write, so the wrapper tolerates
 * any number of concurrently held streams; `restore()` aborts them all.
 */
async function degradeClusterHandler(node: CadreNode, partyId: string, delayMs: number): Promise<DegradedHandle> {
	const controlNode = node.getControlNode();
	if (!controlNode) throw new Error('degradeClusterHandler: node has no started control node');
	const registrar = (controlNode as unknown as { components: { registrar: RegistrarLike } }).components.registrar;
	const protocol = `/optimystic/control-${partyId}/cluster/1.0.0`;
	// Throws UnhandledProtocolError if the protocol is not registered — a loud
	// failure beats silently degrading nothing.
	const { handler: original, options } = registrar.getHandler(protocol);

	const teardown = new AbortController();
	const pending = new Set<Promise<void>>();
	let intercepted = 0;

	const wrapped = (stream: Stream, connection: Connection): void => {
		intercepted++;
		const work = (async () => {
			await (delayMs === Infinity ? untilAbort(teardown.signal) : delayOrAbort(delayMs, teardown.signal));
			if (teardown.signal.aborted) {
				stream.abort(new Error('degraded cluster handler torn down'));
				return;
			}
			await original(stream, connection);
		})().catch((error: unknown) => {
			// Expected when the caller's response deadline already reset the stream
			// before the delayed delegate ran; logged, never rethrown into libp2p.
			log('degraded wrapper: delegate failed (%s): %o', protocol, error);
			try { stream.abort(new Error('degraded cluster handler delegate failed')); } catch { /* stream already gone */ }
		});
		pending.add(work);
		void work.finally(() => pending.delete(work));
	};

	await registrar.unhandle(protocol);
	await registrar.handle(protocol, wrapped, options);

	let restored = false;
	return {
		restore: async (): Promise<void> => {
			if (restored) return;
			restored = true;
			teardown.abort();
			await registrar.unhandle(protocol);
			await registrar.handle(protocol, original, options);
			await Promise.allSettled([...pending]);
		},
		interceptedStreams: () => intercepted
	};
}

/**
 * The same wrapper with NO degradation — a pure counter of inbound cluster RPCs.
 * The healthy case needs it: a self-only cohort would also commit sub-second, so
 * `forced.callCount()` alone (discovery was consulted) cannot tell the two apart;
 * a non-zero count on the third node proves consensus really fanned out to it.
 */
function observeClusterHandler(node: CadreNode, partyId: string): Promise<DegradedHandle> {
	return degradeClusterHandler(node, partyId, 0);
}

interface ResetHandle extends DegradedHandle {
	/** Streams aborted by the injected-reset budget so far. */
	resetStreams(): number;
	/**
	 * Streams from `fromPeer` (all of them, when unscoped), reset or delegated.
	 * `interceptedStreams` counts a busy seam's background dials from OTHER peers
	 * too, so only this one can say the WRITER re-crossed the seam.
	 */
	fromPeerStreams(): number;
}

/**
 * Re-register one of `node`'s protocol handlers so the FIRST `count` inbound
 * streams are aborted on arrival — the injected equivalent of the observed
 * transient race (`registerSelf()` against a connection still forming, failing
 * with `cause=The stream has been reset`) — and every later stream delegates
 * to the real handler untouched.
 *
 * Takes the FULL protocol id, unlike `degradeClusterHandler`, because which
 * seam the reset hits decides whether the retry can absorb it at all — a
 * lesson measured the hard way (2026-08-12, run 1 of this ticket): resetting
 * the CLUSTER protocol on a member kills that member's promise RPC AFTER the
 * other members already pended the transaction, and the abandoned pend state
 * then starves the retry's next attempts of answers on the same hot block
 * (approvals degraded 2/3 → 1/3 → 0/3 across the three attempts). The starving
 * was inferred there and is now CONFIRMED upstream — an abandoned pend wins the
 * conflict race at every member for a fixed 2 s, and a member that loses that
 * race returns no vote, so the coordinator counts zero of both
 * (`blocked/control-write-hears-zero-approvals-from-healthy-trio`). Either way,
 * the class the retry demonstrably absorbs is a reset on the transactor's
 * REPO-protocol batch stream to the coordinator, which dies before anything
 * pends anywhere.
 *
 * Sibling of `degradeClusterHandler`, deliberately self-contained rather than
 * factored: the two share ~12 lines of registrar plumbing but differ in the
 * whole middle (a reset consumes its budget synchronously and never holds a
 * stream open, so there is no teardown signal and nothing for `restore()` to
 * abort — it only has to drain the DELEGATED handlers still in flight).
 *
 * `fromPeer` narrows the reset budget to streams opened by that peer —
 * necessary on a busy seam like the coordinator's repo protocol, where
 * background dials from OTHER nodes would otherwise consume the budget before
 * the write under test opens its first stream (measured: run 2 of this ticket
 * burned both resets without the writing node's batches ever being touched).
 * Each consumed reset logs who it hit, so a misaimed budget is diagnosable
 * from the run output.
 */
async function resetFirstProtocolStreams(node: CadreNode, protocol: string, count: number, fromPeer?: string): Promise<ResetHandle> {
	const controlNode = node.getControlNode();
	if (!controlNode) throw new Error('resetFirstProtocolStreams: node has no started control node');
	const registrar = (controlNode as unknown as { components: { registrar: RegistrarLike } }).components.registrar;
	// Same loud failure as degradeClusterHandler if the protocol is not registered.
	const { handler: original, options } = registrar.getHandler(protocol);

	const pending = new Set<Promise<void>>();
	let intercepted = 0;
	let fromPeerIntercepted = 0;
	let resets = 0;

	const wrapped = (stream: Stream, connection: Connection): void => {
		intercepted++;
		const remote = connection.remotePeer.toString();
		if (fromPeer === undefined || remote === fromPeer) fromPeerIntercepted++;
		if (resets < count && (fromPeer === undefined || remote === fromPeer)) {
			resets++;
			console.log(`[measured] injected reset ${resets}/${count} on ${protocol.split('/').slice(-2).join('/')} from …${remote.slice(-8)}`);
			stream.abort(new Error('injected transient stream reset'));
			return;
		}
		const work = Promise.resolve(original(stream, connection)).catch((error: unknown) => {
			// Same contract as degradeClusterHandler: logged, never rethrown into libp2p.
			log('reset wrapper: delegate failed (%s): %o', protocol, error);
			try { stream.abort(new Error('reset wrapper delegate failed')); } catch { /* stream already gone */ }
		});
		pending.add(work);
		void work.finally(() => pending.delete(work));
	};

	await registrar.unhandle(protocol);
	await registrar.handle(protocol, wrapped, options);

	let restored = false;
	return {
		restore: async (): Promise<void> => {
			if (restored) return;
			restored = true;
			await registrar.unhandle(protocol);
			await registrar.handle(protocol, original, options);
			await Promise.allSettled([...pending]);
		},
		interceptedStreams: () => intercepted,
		resetStreams: () => resets,
		fromPeerStreams: () => fromPeerIntercepted
	};
}

// ── Trio boot ─────────────────────────────────────────────────────────────────

/** Does this node hold an OPEN control connection to `remotePeerId`? */
function hasOpenConnectionTo(node: CadreNode, remotePeerId: string): boolean {
	return (node.getControlNode()?.getConnections() ?? [])
		.some((c) => c.remotePeer.toString() === remotePeerId && c.status === 'open');
}

/** Peek the private write-while-alone queue (same cast pattern as cadre-core's specs). */
function pendingPeerWrites(node: CadreNode): Map<string, 'authorize' | 'remove'> {
	return (node as unknown as { pendingPeerWrites: Map<string, 'authorize' | 'remove'> }).pendingPeerWrites;
}

/** Vouch + cold-start one member from the owner's seed, and wait for its A-link. */
async function joinMember(owner: CadreNode, member: CadreNode, memberPeerId: string): Promise<void> {
	const ownerPeerId = owner.peerId!.toString();
	await owner.authorizePeer(memberPeerId);
	const seed = await owner.createSeed();
	const applied = await member.applySeed(seed);
	expect(applied.success).toBe(true);
	await waitUntil(
		() => hasOpenConnectionTo(member, ownerPeerId),
		{ timeoutMs: 45_000, intervalMs: 250, description: `member ${memberPeerId.slice(-8)} connects to owner` }
	);
}

// ═══════════════════════════════════════════════════════════════════════════════

describe('control writes with a connected-but-degraded cohort member (forced 3-peer cohort)', () => {
	const partyId = `degraded-${Date.now()}`;
	let A: CadreNode; // owner + storage — issues every write under test
	let B: CadreNode; // healthy member
	let C: CadreNode; // the member each case degrades
	let forced: ForcedCohortHandle | null = null;
	let pinned: PinnedCoordinatorHandle | null = null;
	/** B's signing keypair — the transient-reset case signs B's self-record itself. */
	let bSigningKey: Ed25519KeyPair;
	/** Set while a case holds a degradation, so afterAll can clean up a mid-case failure. */
	let activeDegradation: DegradedHandle | null = null;

	beforeAll(async () => {
		const aKey = await generateKeyPair('Ed25519');
		const bKey = await generateKeyPair('Ed25519');
		const cKey = await generateKeyPair('Ed25519');
		const bPeerId = peerIdFromPrivateKey(bKey).toString();
		const cPeerId = peerIdFromPrivateKey(cKey).toString();
		bSigningKey = ed25519KeyPairFromLibp2p(bKey);

		// Unlike the isolation scenario, ALL THREE nodes listen (the harness default):
		// cluster fan-out must be able to dial every cohort member directly.
		A = new CadreNode(controlNodeConfig({ partyId, privateKey: aKey, profile: 'storage' }));
		await A.start();
		const aOwnerKey = await makeOwnOwner(A, aKey);
		const aPeerId = A.peerId!.toString();

		// A's self-publish rides the ~1 s start timer; the seeds minted below are
		// only useful once A's own row carries a dialable address.
		await waitUntil(
			async () => {
				const rec = await A.getControlDatabase()!.queryPeerRecord(aPeerId);
				return !!rec && rec.addrs.length > 0;
			},
			{ timeoutMs: 20_000, intervalMs: 250, description: 'A self-registers a CadrePeer row with addrs' }
		);

		B = new CadreNode(controlNodeConfig({ partyId, privateKey: bKey, profile: 'transaction', pinnedOwnerKeys: [aOwnerKey] }));
		C = new CadreNode(controlNodeConfig({ partyId, privateKey: cKey, profile: 'transaction', pinnedOwnerKeys: [aOwnerKey] }));
		await B.start();
		await joinMember(A, B, bPeerId);
		await C.start();
		await joinMember(A, C, cPeerId);

		// Both members publish their own signed, addressed CadrePeer rows, so the
		// whole trio is mutually resolvable before the cohort is forced.
		await waitUntil(
			async () => (await B.registerSelf()) === 'refreshed',
			{ timeoutMs: 45_000, intervalMs: 500, description: 'B self-publishes its CadrePeer record' }
		);
		await waitUntil(
			async () => (await C.registerSelf()) === 'refreshed',
			{ timeoutMs: 45_000, intervalMs: 500, description: 'C self-publishes its CadrePeer record' }
		);
		await waitUntil(
			async () => (await B.resolvePeerAddrs(cPeerId)).length > 0,
			{ timeoutMs: 45_000, intervalMs: 250, description: "B resolves C's signed address record" }
		);
		await waitUntil(
			async () => (await C.resolvePeerAddrs(bPeerId)).length > 0,
			{ timeoutMs: 45_000, intervalMs: 250, description: "C resolves B's signed address record" }
		);

		// Close the triangle: the forced cohort entries must be CONNECTED addresses,
		// and the transactor's retry path may fan out B→C directly.
		await waitUntil(
			async () => {
				if (hasOpenConnectionTo(B, cPeerId)) return true;
				await B.reconcileControlCohort();
				return hasOpenConnectionTo(B, cPeerId);
			},
			{ timeoutMs: 60_000, intervalMs: 1_000, description: 'B holds a control connection to C' }
		);

		for (const [name, node] of [['A', A], ['B', B], ['C', C]] as const) {
			expect(node.getControlNode()!.getMultiaddrs().length, `${name} must listen`).toBeGreaterThan(0);
		}

		// Order matters: the pin wraps whatever `findCluster` the force installed.
		forced = forceFullCohort([A, B, C]);
		// Healthy candidate only, and it must be A: the degraded cases need a
		// healthy coordinator that has to RPC the degraded member, and the READ
		// path routes through the same seam — only A holds the genesis-era
		// control blocks (see header).
		pinned = pinCoordinator([A]);
	}, 240_000);

	afterAll(async () => {
		// Mid-case failures can leave a degradation active; teardown restores it
		// first so node.stop() is not stopping a node with held-open streams.
		await activeDegradation?.restore().catch((error: unknown) =>
			console.warn('afterAll: degradation restore failed:', error));
		pinned?.restore();
		forced?.restore();
		// Newest first; a stop() failure is logged and the rest still stop —
		// throwing here would leak the other nodes' listeners AND mask the test
		// failure that sent us into teardown. A failed write's background
		// cancelBatch (5 s budget) may still be in flight; stop() must not wait on it.
		for (const node of [C, B, A]) {
			await node?.stop().catch((error: unknown) =>
				console.warn('afterAll: node stop failed during teardown:', error));
		}
	}, 90_000);

	/** Assert every forced-cohort consultation since `baseline` saw all three peers. */
	function expectThreePeerCohortConsulted(baseline: number): void {
		expect(forced!.callCount(), 'the forced cohort was never consulted — the write bypassed cluster discovery').toBeGreaterThan(baseline);
		expect(forced!.cohortSizes().slice(baseline).every((n) => n === 3),
			'a cohort consultation returned other than 3 peers').toBe(true);
	}

	it('commits with a healthy three-member cohort (authorize AND remove)', async () => {
		const target = await randomPeerId();
		const baseline = forced!.callCount();
		// Counts C's inbound cluster RPCs without degrading them — this is the
		// baseline case, so it is the one that must prove the trio is real.
		const observer = await observeClusterHandler(C, partyId);
		activeDegradation = observer;
		// No assertions on this capture — it exists so a red run records the retry
		// funnel's decisions (see printRetryDecisions and the `0/3 approvals` arm).
		const retryLog = captureControlRetryLogs();
		const t0 = Date.now();
		try {
			await within(`authorizePeer(${target.slice(-8)}) healthy`, WRITE_TIMEOUT_MS, () => A.authorizePeer(target));
			// Read-back is a SEPARATE assertion from the write resolving.
			expect(await within('isMember (post-authorize)', READ_TIMEOUT_MS, () => A.isMember(target))).toBe(true);

			await within(`removePeer(${target.slice(-8)}) healthy`, WRITE_TIMEOUT_MS, () => A.removePeer(target));
			expect(await within('isMember (post-remove)', READ_TIMEOUT_MS, () => A.isMember(target))).toBe(false);
			console.log(`[measured] healthy trio authorize+remove: ${Date.now() - t0}ms`);

			// Anti-vacuity anchors: discovery returned a genuinely 3-peer cohort, AND
			// the consensus fan-out actually reached the third node.
			expectThreePeerCohortConsulted(baseline);
			expect(observer.interceptedStreams(),
				'no inbound cluster RPC reached C — the write committed on a narrower cohort').toBeGreaterThan(0);
			// With a live cohort the write did NOT commit alone, so nothing queued.
			expect(pendingPeerWrites(A).has(target)).toBe(false);
		} finally {
			printRetryDecisions('healthy', retryLog);
			retryLog.restore();
			await observer.restore();
			activeDegradation = null;
		}
	}, 120_000);

	it('commits with a member delayed under the response deadline', async () => {
		const target = await randomPeerId();
		const baseline = forced!.callCount();
		activeDegradation = await degradeClusterHandler(C, partyId, UNDER_DEADLINE_DELAY_MS);
		// Record-only, like the healthy case: this is the other case the
		// intermittent `0/3 approvals` failure has struck.
		const retryLog = captureControlRetryLogs();
		try {
			const authorize = await timedSettle(`authorizePeer(${target.slice(-8)}) delayed`, DELAYED_WRITE_TIMEOUT_MS,
				() => A.authorizePeer(target));
			console.log(`[measured] authorize with ${UNDER_DEADLINE_DELAY_MS}ms-delayed member: ${authorize.elapsedMs}ms, error: ${authorize.error === null ? 'none' : errorChainText(authorize.error)}`);
			expect(authorize.error).toBeNull();
			expect(await within('isMember (post-authorize, delayed)', READ_TIMEOUT_MS, () => A.isMember(target))).toBe(true);

			const remove = await timedSettle(`removePeer(${target.slice(-8)}) delayed`, DELAYED_WRITE_TIMEOUT_MS,
				() => A.removePeer(target));
			console.log(`[measured] remove with ${UNDER_DEADLINE_DELAY_MS}ms-delayed member: ${remove.elapsedMs}ms, error: ${remove.error === null ? 'none' : errorChainText(remove.error)}`);
			expect(remove.error).toBeNull();
			expect(await within('isMember (post-remove, delayed)', READ_TIMEOUT_MS, () => A.isMember(target))).toBe(false);

			// The delay was paid as latency, NOT escalated into the response-deadline
			// path (whose floor is ~20 s per transaction).
			expect(authorize.elapsedMs).toBeLessThan(DELAYED_COMMIT_CEILING_MS);
			expect(remove.elapsedMs).toBeLessThan(DELAYED_COMMIT_CEILING_MS);
			expect(activeDegradation.interceptedStreams(), 'the delay wrapper never saw a stream — nothing was degraded').toBeGreaterThan(0);
			expectThreePeerCohortConsulted(baseline);
		} finally {
			printRetryDecisions('delayed', retryLog);
			retryLog.restore();
			await activeDegradation.restore();
			activeDegradation = null;
		}
		// Two ~55 s delayed writes plus setup: ~110 s measured.
	}, 300_000);

	it('fails with a named super-majority error when a member stalls past the response deadline', async () => {
		const target = await randomPeerId();
		const baseline = forced!.callCount();
		activeDegradation = await degradeClusterHandler(C, partyId, Infinity);
		const retryLog = captureControlRetryLogs();
		try {
			const outcome = await timedSettle(`authorizePeer(${target.slice(-8)}) stalled`, STALLED_WRITE_TIMEOUT_MS,
				() => A.authorizePeer(target));
			console.log(`[measured] authorize with never-answering member: ${outcome.elapsedMs}ms, error: ${outcome.error === null ? 'none (COMMITTED)' : errorChainText(outcome.error)}`);
			printRetryDecisions('stalled-authorize', retryLog);

			expect(outcome.error, 'write against a silent cohort member unexpectedly committed').not.toBeNull();
			const chain = errorChainText(outcome.error);
			// The cohort size (3), the unanimity bar (needed 3) and the ZERO rejections
			// are the claim: the write failed on SILENCE, not on anyone voting no. The
			// approval COUNT floats because the number of pend rounds does — measured
			// `2/3` when the write fails on its first round (~20 s) and `0/3` when a
			// second round runs (~40 s). Pinning the literal to one variant makes this
			// case flake, so it is deliberately `\d+`.
			// NOTE: the second round reports 0 approvals AND 0 rejections even though A
			// and B are healthy — i.e. a retried control write hears nothing from the
			// healthy members either. Benign for this assertion (the write must fail
			// either way). Measured 2026-08-12 (run 1 of the scenario-coverage
			// ticket): a write re-presented right after a failed promise round
			// degraded MONOTONICALLY — 2/3 → 1/3 → 0/3 across three attempts on the
			// same hot block — which is why the transient-reset case injects at the
			// BATCH seam instead of the cluster promise seam. The decline itself is
			// one observation (the review pass measured `0/3` from the first attempt),
			// but the underlying mechanism is settled: an abandoned pend blocks the
			// block for 2 s and the members that lose that race vote nothing. See
			// `blocked/control-write-hears-zero-approvals-from-healthy-trio`.
			expect(chain).toMatch(/Failed to get super-majority: \d+\/3 approvals \(needed 3, 0 rejections\)/);
			// If the admission gate bit, the failure has the WRONG cause — fail on that
			// explicitly rather than reporting a super-majority failure that isn't one.
			expect(chain).not.toMatch(/membership-not-admitted/);
			// The LIVE error object must classify as retriable — this is what the
			// retry would re-present, and a reworded upstream message now fails this
			// scenario instead of silently disabling the retry. (The retry still did
			// not RUN here: the ~20 s first attempt exhausts the 10 s budget, which
			// the log assertions below pin.)
			expect(isRetriableControlWriteFailure(outcome.error),
				'the live degraded-cohort failure no longer classifies as retriable — a reworded upstream message has silently disabled the control-write retry').toBe(true);
			expectAggregateCarriesBatchToken(chain);

			// Lower bound: an instant failure means the response-deadline path was
			// never exercised. Upper bound: the transaction budget held.
			expect(outcome.elapsedMs).toBeGreaterThanOrEqual(FAILURE_FLOOR_MS);
			expect(outcome.elapsedMs).toBeLessThanOrEqual(FAILURE_CEILING_MS);
			expect(activeDegradation.interceptedStreams()).toBeGreaterThan(0);
			expectThreePeerCohortConsulted(baseline);

			// The retry budget's whole rationale: a genuinely silent member fails in
			// the SAME ~20-40 s it failed in before the retry existed, because the
			// ~20 s first attempt exhausts the 10 s budget before any sleep. Wall
			// clock cannot pin this (a one-round failure retried once lands at ~40 s,
			// indistinguishable from a legitimate two-round settle), so the funnel's
			// own log is the assertion surface — scoped by the `peer-insert` label to
			// THIS write, because background writes are NOT all stall victims:
			// measured 2026-08-12 (run 1), a background write fast-failed 3/3 inside
			// this window on the intermittent `0/3 approvals` class, so an unscoped
			// "nothing retried" assertion false-fails.
			const insertLines = retryLog.lines().filter((l) => l.includes('[peer-insert]'));
			expect(insertLines.some((l) => l.includes('retrying in') || /failed after [2-9]\/\d+ attempt\(s\)/.test(l)),
				'the stalled write ran a SECOND attempt — the 10 s retry budget no longer expires before the ~20 s degraded-member failure').toBe(false);
			// Anti-vacuity for the line above: the stalled write's single attempt
			// must itself be visible in the capture — otherwise the negative
			// assertion passes because the capture is dead or the failure bypassed
			// the retry funnel entirely.
			expect(insertLines.some((l) => /failed after 1\/\d+ attempt\(s\)/.test(l)),
				'the stalled write\'s failure never crossed the retry funnel — capture dead, or the funnel is no longer wired under control writes').toBe(true);
		} finally {
			retryLog.restore();
			await activeDegradation.restore();
			activeDegradation = null;
		}
		// The failed transaction must have rolled back — locally too.
		expect(await within('isMember (post-failure)', READ_TIMEOUT_MS, () => A.isMember(target))).toBe(false);
		// And a FAILED write must not sit in the committed-alone re-replication queue.
		expect(pendingPeerWrites(A).has(target)).toBe(false);
	}, 180_000);

	/**
	 * EXPECTED FAILURE — this case is the standing reproducer for the open ticket
	 * `fix/control-reads-blocked-by-stalled-write`: a plain local read on the
	 * writing node does not answer until the stalled write settles, so
	 * `hasOwnerKey (during stall)` blows the 15 s read deadline every run.
	 *
	 * It is `it.fails` and NOT `it.skip` deliberately: vitest still runs the body
	 * and still fails the suite if it ever PASSES, so the day the fix lands this
	 * turns red and whoever lands it promotes this back to a plain `it` (the fix
	 * ticket's "done means" says so). The assertions below are the real ones —
	 * nothing here is weakened to manufacture the failure.
	 */
	it.fails('a control read answers locally while a write is stalled', async () => {
		const target = await randomPeerId();
		const bPeerId = B.peerId!.toString();
		activeDegradation = await degradeClusterHandler(C, partyId, Infinity);
		// Kick the doomed write off UNAWAITED, capturing settlement immediately so it
		// can neither become an unhandled rejection nor race teardown. Declared
		// outside the `try` so the `finally` can always drain it.
		const settled = A.authorizePeer(target).then(() => null, (e: unknown) => e);
		try {
			await sleep(250); // let the write engage the stalled promise phase

			const db = A.getControlDatabase()!;
			expect(await within('hasOwnerKey (during stall)', READ_TIMEOUT_MS, () => db.hasOwnerKey())).toBe(true);
			const peers = await within('queryCadrePeers (during stall)', READ_TIMEOUT_MS, () => db.queryCadrePeers());
			expect(peers.map((p) => p.peerId)).toContain(bPeerId);
			const record = await within('queryPeerRecord(B) (during stall)', READ_TIMEOUT_MS, () => db.queryPeerRecord(bPeerId));
			expect(record).not.toBeNull();
			expect((await within('resolvePeerAddrs(B) (during stall)', READ_TIMEOUT_MS, () => A.resolvePeerAddrs(bPeerId))).length).toBeGreaterThan(0);
			expect(await within('isMember(B) (during stall)', READ_TIMEOUT_MS, () => A.isMember(bPeerId))).toBe(true);

			// Join the stalled write BEFORE restoring the handler, so restore() cannot
			// race its settlement and the case ends with nothing in flight.
			const error = await within('stalled write settles', STALLED_WRITE_TIMEOUT_MS, () => settled);
			console.log(`[measured] stalled-while-reading write settled with error: ${error === null ? 'none (COMMITTED)' : errorChainText(error)}`);
			// Read-back mirrors whichever way the degraded write settled.
			expect(await within('isMember(target) (post-settle)', READ_TIMEOUT_MS, () => A.isMember(target))).toBe(error === null);
		} finally {
			// Restore FIRST (it aborts the held streams, so the doomed write settles
			// promptly), then join it. On the currently-expected failure path the join
			// above is never reached, and without this the write would still be in
			// flight — holding the control write lock — when the next case starts.
			await activeDegradation.restore();
			activeDegradation = null;
			await settled;
		}
	}, 240_000);

	it('recovers: a write commits normally once the degraded member is restored', async () => {
		// Every earlier case restored its degradation in `finally`; this case proves
		// the failed writes left neither the coordinator nor the transaction state
		// store wedged.
		// NOTE: an early exploratory run (before the coordinator was pinned) once showed
		// a write AFTER a failed one also failing, suggesting a failed write could poison
		// later ones. It has not reproduced since — this case commits in ~1 s every run.
		// If a post-failure write ever starts failing here, that old observation is back
		// and the transaction state store, not the degradation, is the place to look.
		const target = await randomPeerId();
		await within(`authorizePeer(${target.slice(-8)}) recovered`, WRITE_TIMEOUT_MS, () => A.authorizePeer(target));
		expect(await within('isMember (post-recovery authorize)', READ_TIMEOUT_MS, () => A.isMember(target))).toBe(true);
		await within(`removePeer(${target.slice(-8)}) recovered`, WRITE_TIMEOUT_MS, () => A.removePeer(target));
		expect(await within('isMember (post-recovery remove)', READ_TIMEOUT_MS, () => A.isMember(target))).toBe(false);
	}, 120_000);

	it('does not queue a failed DELETE for re-replication', async () => {
		// The other write direction: a stamp-retiring DELETE (removePeer), which the
		// offline-peer review found had been missed once already. Authorize the
		// victim while healthy, then fail its removal against a silent member.
		const target = await randomPeerId();
		await within(`authorizePeer(${target.slice(-8)}) setup`, WRITE_TIMEOUT_MS, () => A.authorizePeer(target));
		expect(await within('isMember (setup)', READ_TIMEOUT_MS, () => A.isMember(target))).toBe(true);

		activeDegradation = await degradeClusterHandler(C, partyId, Infinity);
		const retryLog = captureControlRetryLogs();
		try {
			const outcome = await timedSettle(`removePeer(${target.slice(-8)}) stalled`, STALLED_WRITE_TIMEOUT_MS,
				() => A.removePeer(target));
			console.log(`[measured] remove with never-answering member: ${outcome.elapsedMs}ms, error: ${outcome.error === null ? 'none (COMMITTED)' : errorChainText(outcome.error)}`);
			printRetryDecisions('stalled-remove', retryLog);
			expect(outcome.error, 'DELETE against a silent cohort member unexpectedly committed').not.toBeNull();
			const chain = errorChainText(outcome.error);
			// `\d+` for the same reason as the authorize case above.
			expect(chain).toMatch(/Failed to get super-majority: \d+\/3 approvals \(needed 3, 0 rejections\)/);
			// Same classifier + budget guards as the authorize case: the DELETE
			// direction's live failure must classify retriable, and no write may run
			// a second attempt while C stalls (rationale on the authorize case).
			expect(isRetriableControlWriteFailure(outcome.error),
				'the live DELETE failure no longer classifies as retriable — a reworded upstream message has silently disabled the control-write retry').toBe(true);
			expectAggregateCarriesBatchToken(chain);
			// Scoped to the DELETE's own `peer-remove` label — same rationale as the
			// authorize case (background writes can fail fast inside this window).
			const removeLines = retryLog.lines().filter((l) => l.includes('[peer-remove]'));
			expect(removeLines.some((l) => l.includes('retrying in') || /failed after [2-9]\/\d+ attempt\(s\)/.test(l)),
				'the stalled DELETE ran a SECOND attempt — the 10 s retry budget no longer expires before the ~20 s degraded-member failure').toBe(false);
			expect(removeLines.some((l) => /failed after 1\/\d+ attempt\(s\)/.test(l)),
				'the stalled DELETE\'s failure never crossed the retry funnel — capture dead, or the funnel is no longer wired under control writes').toBe(true);
		} finally {
			retryLog.restore();
			await activeDegradation.restore();
			activeDegradation = null;
		}
		// The failed DELETE must not be queued as a committed-alone write…
		expect(pendingPeerWrites(A).has(target)).toBe(false);
		// …and must have rolled back: the victim is still a member.
		expect(await within('isMember (post-failed-remove)', READ_TIMEOUT_MS, () => A.isMember(target))).toBe(true);
	}, 240_000);

	it('absorbs an injected transient stream reset: the write commits on a retry attempt', async () => {
		// The case the retry was BUILT for, and the first observation of its
		// success path at a real call site (every prior proof drove a stub — see
		// the coverage ticket's `verify-ddl-retry-engages` arm). The failure is
		// injected at the seam the OBSERVED wild failure died on: the transactor's
		// repo-protocol batch stream from the writing node to the coordinator.
		// The writer must be B — A's own batches to the pinned coordinator (A)
		// are handled LOCALLY and open no stream (run 4 measured the A-scoped
		// budget matching nothing), so only a non-coordinator writer crosses the
		// seam.
		//
		// The driven write is the WRITE HALF of `registerSelf()` — the very call
		// the wild failure was observed on — invoked directly as
		// `updateSelfPeerRecord` with a record this case signs itself (it holds
		// B's key). Driving whole `registerSelf` instead is NOT viable here, and
		// that is a measured finding, not a shortcut: its PRE-write reads sit
		// outside the write funnel, dial the coordinator on every call (a prior
		// read does not keep them local), and die unprotected on the first reset
		// — 23-28 ms, `Error during query on table 'Revocation' …
		// cause=Cannot write to a stream that is closed`, funnel never consulted
		// (runs 3 and 5). The WRITE's own internal reads run inside the funnel,
		// so this case still exercises reads-under-reset — on the protected side.
		//
		// Second hazard defused below: resets are scoped to streams FROM B,
		// because A's repo protocol also serves background dials whose
		// consumption of an unscoped budget let the write sail through untouched
		// (run 2).
		//
		// Resetting C's CLUSTER streams instead does NOT yield an absorbable
		// failure — the abandoned pend starves later attempts (see
		// `resetFirstProtocolStreams`' header).
		const bPeerId = B.peerId!.toString();
		const bDb = B.getControlDatabase()!;
		const before = await within('queryPeerRecord(B) (pre-reset)', READ_TIMEOUT_MS,
			() => bDb.queryPeerRecord(bPeerId));
		expect(before, 'B has no CadrePeer row to refresh — the case cannot drive a self-update').not.toBeNull();
		// Same shape `CadreNode.signSelfRecord` builds: same addrs, a strictly
		// later `updatedAt` (the monotonic self-update rule), B's own signature.
		const record = signPeerRecord({
			peerId: bPeerId,
			publicKey: bSigningKey.publicKeyB64,
			addrs: before!.addrs,
			updatedAt: Math.max(Date.now(), before!.updatedAt + 1)
		}, bSigningKey.privateKeyB64);

		const baseline = forced!.callCount();
		// Injection FIRST, capture second (it swaps a handler and issues no control write,
		// so nothing is missed): a capture taken before an injection that throws would
		// never be restored, leaving debug's process-global sink hooked for the rest of
		// the file. Every other case degrades before capturing for the same reason.
		const resets = await resetFirstProtocolStreams(A, `/optimystic/control-${partyId}/repo/1.0.0`, TRANSIENT_RESET_COUNT, bPeerId);
		activeDegradation = resets;
		const retryLog = captureControlRetryLogs();
		try {
			const outcome = await timedSettle('updateSelfPeerRecord(B) transient-reset', WRITE_TIMEOUT_MS,
				() => bDb.updateSelfPeerRecord(record));
			console.log(`[measured] B self-record update with ${TRANSIENT_RESET_COUNT} injected repo-stream resets on A: ${outcome.elapsedMs}ms, error: ${outcome.error === null ? 'none' : errorChainText(outcome.error)}`);
			// The record section 1 of the coverage ticket asks for: the REAL
			// transient failure text (aggregate and all), straight from the funnel.
			printRetryDecisions('transient-reset', retryLog);

			expect(outcome.error, 'self-record refresh across the reset seam did not commit — the retry failed to absorb the observed transient class').toBeNull();
			// Read-back: the refresh really landed (the row carries this exact stamp).
			const after = await within('queryPeerRecord(B) (post-reset)', READ_TIMEOUT_MS,
				() => bDb.queryPeerRecord(bPeerId));
			expect(after!.updatedAt, 'B\'s CadrePeer row does not carry the refreshed stamp — the update never committed').toBe(record.updatedAt);

			// Anti-vacuity, three layers. The reset budget was fully consumed
			// (unconsumed resets mean the write's batches never crossed the seam)…
			expect(resets.resetStreams(), 'no injected reset was consumed — B\'s transactor batch stream never crossed the repo seam').toBe(TRANSIENT_RESET_COUNT);
			// …B opened MORE streams on this seam than the budget consumed, so the
			// retry's attempt really re-crossed it rather than routing around it
			// (scoped to B: `interceptedStreams` also counts C's background dials,
			// which would satisfy this for the wrong reason)…
			expect(resets.fromPeerStreams(), 'B opened no post-reset stream on the batch seam — the retry attempt never re-crossed it').toBeGreaterThan(TRANSIENT_RESET_COUNT);
			expectThreePeerCohortConsulted(baseline);

			// …and the funnel itself says the retry ENGAGED on THIS write (the
			// `self-record-update` label scopes the lines to B's refresh): a first
			// attempt failed transiently and a later attempt committed. This is the
			// success-path observation that closes the "never observed at any real
			// call site" gap.
			const refreshLines = retryLog.lines().filter((l) => l.includes('[self-record-update]'));
			expect(refreshLines.some((l) => l.includes('retrying in')),
				'no transient-retry decision was logged for the refresh — its first attempt never failed, so the retry was not exercised').toBe(true);
			expect(refreshLines.some((l) => /committed on attempt [2-9]\/\d+/.test(l)),
				'the refresh never committed on a retry attempt — the retry engaged but did not rescue the write').toBe(true);

			// The absorption stayed inside the retry budget: resets fail instantly,
			// so a settle near the response-deadline path's ~20 s floor means the
			// failure escalated instead of being absorbed.
			expect(outcome.elapsedMs).toBeLessThan(TRANSIENT_RESET_COMMIT_CEILING_MS);
		} finally {
			retryLog.restore();
			await resets.restore();
			activeDegradation = null;
		}
		// Prove the write path is healthy again with the wrapper gone: an
		// owner-side write pair commits normally.
		const target = await randomPeerId();
		await within(`authorizePeer(${target.slice(-8)}) post-reset`, WRITE_TIMEOUT_MS, () => A.authorizePeer(target));
		await within(`removePeer(${target.slice(-8)}) post-reset`, WRITE_TIMEOUT_MS, () => A.removePeer(target));
		expect(await within('isMember (post-reset cleanup)', READ_TIMEOUT_MS, () => A.isMember(target))).toBe(false);
	}, 120_000);
});
