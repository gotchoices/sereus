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
 * remote peer), under the transactor's 30 s transaction budget. The predicted
 * outcomes (confirmed/refuted by the assertions below, with the measured
 * wall-clock logged either way):
 *
 *  - no degradation            → write commits;
 *  - 2 s delay (< 10 s bar)    → write commits, paying latency;
 *  - never answers (> 10 s bar)→ clean failure naming
 *    `Failed to get super-majority: 2/3 approvals (needed 3, 0 rejections)`,
 *    landing between the two response-deadline attempts (~20 s) and the
 *    transaction budget's ceiling.
 *
 * A naive three-node test proves nothing here: FRET's routing table stays cold
 * inside a test's lifetime, so real cohort discovery returns self-only cohorts
 * that never reach the super-majority branch. `forceFullCohort` (see
 * `harness/forced-cluster.ts`) replaces cohort DISCOVERY on all three nodes
 * with the full trio while leaving the real cluster clients, deadlines,
 * transports, and members in place — and its call counters back the
 * anti-vacuity assertions that each write really consulted a 3-peer cohort.
 *
 * The batch COORDINATOR is pinned too (`pinCoordinator`, healthy nodes only).
 * Unpinned, FRET draws the coordinator by key-space proximity to the block id
 * — effectively a uniform draw across the trio — and the degraded cases go
 * nondeterministic: when the degraded node itself is drawn, the writer reaches
 * it over the (healthy) repo protocol and its own cluster vote is in-process,
 * so the write COMMITS fast (measured: ~0.5 s) instead of failing (~42 s).
 * That commit-through-the-degraded-coordinator branch is real availability,
 * not a defect — it is documented here and in `docs/architecture.md`, and the
 * pin exists so this suite deterministically measures the OTHER branch, the
 * one where the degradation actually bites.
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
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import type { Stream, Connection } from '@libp2p/interface';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { CadreNode, ed25519KeyPairFromLibp2p } from '@serfab/cadre-core';
import type { CadreNodeConfig } from '@serfab/cadre-core';
import { waitUntil, sleep, forceFullCohort, pinCoordinator } from '../harness/index.js';
import type { ForcedCohortHandle, PinnedCoordinatorHandle } from '../harness/index.js';

const log = debug('sereus:integration:degraded-cohort');

// ── Deadlines ─────────────────────────────────────────────────────────────────

/** Reads and read-backs: all answer from local state; this only catches hangs. */
const READ_TIMEOUT_MS = 15_000;
/** Healthy / under-the-deadline writes: generous, still far below a failure. */
const WRITE_TIMEOUT_MS = 240_000;
/**
 * A write against a never-answering member: the 30 s transaction budget plus
 * the response-deadline attempts that overrun it plus slack. A write that has
 * not settled by here is the hang this scenario exists to catch.
 */
const STALLED_WRITE_TIMEOUT_MS = 240_000;
/**
 * Assertion bounds for the named-failure case (distinct from the deadline
 * above, which only catches hangs). Floor: an INSTANT failure means the
 * response-deadline path was never exercised — an admission rejection or an
 * addressless dial wearing the same error. Ceiling: the 30 s transaction
 * budget plus the in-flight attempt that overruns it plus slack.
 */
const FAILURE_FLOOR_MS = 15_000;
const FAILURE_CEILING_MS = 200_000;
/**
 * Ceiling for the 2 s-delayed COMMIT case. Each cluster-transaction phase pays
 * the delay once per inbound RPC to the degraded member and a control write
 * runs pend + commit, so several delayed rounds are legitimate; measured runs
 * land well under this while a silent escalation into the response-deadline
 * path (≥ ~20 s per transaction) would break it.
 */
const DELAYED_COMMIT_CEILING_MS = 200_000;

/** The delay matrix: under the 10 s response deadline, and past it forever. */
const UNDER_DEADLINE_DELAY_MS = 2_000;

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

// ── Trio boot ─────────────────────────────────────────────────────────────────

function nodeConfig(opts: {
	partyId: string;
	privateKey: PrivateKey;
	profile: 'storage' | 'transaction';
	pinnedOwnerKeys?: string[];
}): CadreNodeConfig {
	return {
		controlNetwork: { partyId: opts.partyId, bootstrapNodes: [] },
		profile: opts.profile,
		strandFilter: { mode: 'all' },
		storage: { provider: () => new MemoryRawStorage() },
		privateKey: opts.privateKey,
		network: {
			transports: [webSockets(), circuitRelayTransport()],
			// Unlike the isolation scenario, ALL THREE nodes listen: cluster fan-out
			// must be able to dial every cohort member directly.
			listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws']
		},
		...(opts.pinnedOwnerKeys ? { trustedOwners: { pinnedKeys: opts.pinnedOwnerKeys } } : {}),
		hibernation: { enabled: false }
	};
}

/** Genesis: enroll the node's derived key in `OwnerKey` and wire seed bootstrap. */
async function makeOwnOwner(node: CadreNode, key: PrivateKey): Promise<void> {
	const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(key);
	const db = node.getControlDatabase();
	if (!db) throw new Error('control database missing after start');
	await db.insertOwnerKey(publicKeyB64);
	node.initializeSeedBootstrap(privateKeyB64);
}

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
	/** Set while a case holds a degradation, so afterAll can clean up a mid-case failure. */
	let activeDegradation: DegradedHandle | null = null;

	beforeAll(async () => {
		const aKey = await generateKeyPair('Ed25519');
		const bKey = await generateKeyPair('Ed25519');
		const cKey = await generateKeyPair('Ed25519');
		const bPeerId = peerIdFromPrivateKey(bKey).toString();
		const cPeerId = peerIdFromPrivateKey(cKey).toString();
		const { publicKeyB64: aOwnerKey } = ed25519KeyPairFromLibp2p(aKey);

		A = new CadreNode(nodeConfig({ partyId, privateKey: aKey, profile: 'storage' }));
		await A.start();
		await makeOwnOwner(A, aKey);
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

		B = new CadreNode(nodeConfig({ partyId, privateKey: bKey, profile: 'transaction', pinnedOwnerKeys: [aOwnerKey] }));
		C = new CadreNode(nodeConfig({ partyId, privateKey: cKey, profile: 'transaction', pinnedOwnerKeys: [aOwnerKey] }));
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

		forced = forceFullCohort([A, B, C]);
		// Healthy candidates only: the degraded cases must exercise the branch
		// where a healthy coordinator has to RPC the degraded member (see header).
		pinned = pinCoordinator([A, B, C], [A, B]);
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

	/** Fresh member key for a case's write target, so cases stay order-tolerant. */
	async function freshTargetPeerId(): Promise<string> {
		return peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
	}

	/** Assert every forced-cohort consultation since `baseline` saw all three peers. */
	function expectThreePeerCohortConsulted(baseline: number): void {
		expect(forced!.callCount(), 'the forced cohort was never consulted — the write bypassed cluster discovery').toBeGreaterThan(baseline);
		expect(forced!.cohortSizes().slice(baseline).every((n) => n === 3)).toBe(true);
	}

	it('commits with a healthy three-member cohort (authorize AND remove)', async () => {
		const target = await freshTargetPeerId();
		const baseline = forced!.callCount();

		await within(`authorizePeer(${target.slice(-8)}) healthy`, WRITE_TIMEOUT_MS, () => A.authorizePeer(target));
		// Read-back is a SEPARATE assertion from the write resolving.
		expect(await within('isMember (post-authorize)', READ_TIMEOUT_MS, () => A.isMember(target))).toBe(true);

		await within(`removePeer(${target.slice(-8)}) healthy`, WRITE_TIMEOUT_MS, () => A.removePeer(target));
		expect(await within('isMember (post-remove)', READ_TIMEOUT_MS, () => A.isMember(target))).toBe(false);

		// Anti-vacuity anchor: these writes consulted a genuinely 3-peer cohort.
		expectThreePeerCohortConsulted(baseline);
		// With a live cohort the write did NOT commit alone, so nothing queued.
		expect(pendingPeerWrites(A).has(target)).toBe(false);
	}, 120_000);

	it('commits with a member delayed under the response deadline', async () => {
		const target = await freshTargetPeerId();
		const baseline = forced!.callCount();
		activeDegradation = await degradeClusterHandler(C, partyId, UNDER_DEADLINE_DELAY_MS);
		try {
			const authorize = await timedSettle(`authorizePeer(${target.slice(-8)}) delayed`, WRITE_TIMEOUT_MS,
				() => A.authorizePeer(target));
			console.log(`[measured] authorize with ${UNDER_DEADLINE_DELAY_MS}ms-delayed member: ${authorize.elapsedMs}ms, error: ${authorize.error === null ? 'none' : errorChainText(authorize.error)}`);
			expect(authorize.error).toBeNull();
			expect(await within('isMember (post-authorize, delayed)', READ_TIMEOUT_MS, () => A.isMember(target))).toBe(true);

			const remove = await timedSettle(`removePeer(${target.slice(-8)}) delayed`, WRITE_TIMEOUT_MS,
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
			await activeDegradation.restore();
			activeDegradation = null;
		}
	}, 300_000);

	it('fails with a named super-majority error when a member stalls past the response deadline', async () => {
		const target = await freshTargetPeerId();
		const baseline = forced!.callCount();
		activeDegradation = await degradeClusterHandler(C, partyId, Infinity);
		try {
			const outcome = await timedSettle(`authorizePeer(${target.slice(-8)}) stalled`, STALLED_WRITE_TIMEOUT_MS,
				() => A.authorizePeer(target));
			console.log(`[measured] authorize with never-answering member: ${outcome.elapsedMs}ms, error: ${outcome.error === null ? 'none (COMMITTED)' : errorChainText(outcome.error)}`);

			expect(outcome.error, 'write against a silent cohort member unexpectedly committed').not.toBeNull();
			const chain = errorChainText(outcome.error);
			expect(chain).toMatch(/Failed to get super-majority: 2\/3 approvals \(needed 3, 0 rejections\)/);
			// If the admission gate bit, the failure has the WRONG cause — fail on that
			// explicitly rather than reporting a super-majority failure that isn't one.
			expect(chain).not.toMatch(/membership-not-admitted/);

			// Lower bound: an instant failure means the response-deadline path was
			// never exercised. Upper bound: the transaction budget held.
			expect(outcome.elapsedMs).toBeGreaterThanOrEqual(FAILURE_FLOOR_MS);
			expect(outcome.elapsedMs).toBeLessThanOrEqual(FAILURE_CEILING_MS);
			expect(activeDegradation.interceptedStreams()).toBeGreaterThan(0);
			expectThreePeerCohortConsulted(baseline);
		} finally {
			await activeDegradation.restore();
			activeDegradation = null;
		}
		// The failed transaction must have rolled back — locally too.
		expect(await within('isMember (post-failure)', READ_TIMEOUT_MS, () => A.isMember(target))).toBe(false);
		// And a FAILED write must not sit in the committed-alone re-replication queue.
		expect(pendingPeerWrites(A).has(target)).toBe(false);
	}, 300_000);

	it('a control read answers locally while a write is stalled', async () => {
		const target = await freshTargetPeerId();
		const bPeerId = B.peerId!.toString();
		activeDegradation = await degradeClusterHandler(C, partyId, Infinity);
		try {
			// Kick the doomed write off UNAWAITED, capturing settlement immediately so
			// it can neither become an unhandled rejection nor race teardown.
			const settled = A.authorizePeer(target).then(() => null, (e: unknown) => e);
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
			await activeDegradation.restore();
			activeDegradation = null;
		}
	}, 300_000);

	it('recovers: a write commits normally once the degraded member is restored', async () => {
		// Every earlier case restored its degradation in `finally`; this case proves
		// the failed writes left neither the coordinator nor the transaction state
		// store wedged.
		const target = await freshTargetPeerId();
		await within(`authorizePeer(${target.slice(-8)}) recovered`, WRITE_TIMEOUT_MS, () => A.authorizePeer(target));
		expect(await within('isMember (post-recovery authorize)', READ_TIMEOUT_MS, () => A.isMember(target))).toBe(true);
		await within(`removePeer(${target.slice(-8)}) recovered`, WRITE_TIMEOUT_MS, () => A.removePeer(target));
		expect(await within('isMember (post-recovery remove)', READ_TIMEOUT_MS, () => A.isMember(target))).toBe(false);
	}, 120_000);

	it('does not queue a failed DELETE for re-replication', async () => {
		// The other write direction: a stamp-retiring DELETE (removePeer), which the
		// offline-peer review found had been missed once already. Authorize the
		// victim while healthy, then fail its removal against a silent member.
		const target = await freshTargetPeerId();
		await within(`authorizePeer(${target.slice(-8)}) setup`, WRITE_TIMEOUT_MS, () => A.authorizePeer(target));
		expect(await within('isMember (setup)', READ_TIMEOUT_MS, () => A.isMember(target))).toBe(true);

		activeDegradation = await degradeClusterHandler(C, partyId, Infinity);
		try {
			const outcome = await timedSettle(`removePeer(${target.slice(-8)}) stalled`, STALLED_WRITE_TIMEOUT_MS,
				() => A.removePeer(target));
			console.log(`[measured] remove with never-answering member: ${outcome.elapsedMs}ms, error: ${outcome.error === null ? 'none (COMMITTED)' : errorChainText(outcome.error)}`);
			expect(outcome.error, 'DELETE against a silent cohort member unexpectedly committed').not.toBeNull();
			expect(errorChainText(outcome.error)).toMatch(/Failed to get super-majority: 2\/3 approvals \(needed 3, 0 rejections\)/);
		} finally {
			await activeDegradation.restore();
			activeDegradation = null;
		}
		// The failed DELETE must not be queued as a committed-alone write…
		expect(pendingPeerWrites(A).has(target)).toBe(false);
		// …and must have rolled back: the victim is still a member.
		expect(await within('isMember (post-failed-remove)', READ_TIMEOUT_MS, () => A.isMember(target))).toBe(true);
	}, 300_000);
});
