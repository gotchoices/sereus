/**
 * Boot the A/B/C control-network trio the "reconcile as sole connector"
 * scenarios share:
 *
 *         A  (storage profile, own owner, listens on ws, NO relay)
 *        / \
 *       /   \   B and C both cold-start via applySeed (the production path)
 *      B     C  C listens on ws
 *      ^     |
 *      |     |  B: listenAddrs: []  → nobody can dial B, ever; the only link
 *      +-----+  B can ever have is one B itself opened
 *
 * The boot is the ONE order that makes the isolation claim true. Each step must
 * precede the next; the proof is an ordering property, not a single assertion:
 *
 *  1. A starts and self-publishes an addressed `CadrePeer` row.
 *  2. B is vouched BEFORE it starts, cold-starts from A's seed — minted before
 *     C exists, so the seed provably cannot name C. B's one automatic
 *     start-time reconcile pass is then drained (self-registration lands,
 *     `sleep(1_000)`, join the pass) BEFORE C starts, so that pass can never be
 *     what later forms B↔C.
 *  3. C starts, still unauthorized: at that instant B holds zero connections to
 *     C and zero peerStore addresses for it.
 *  4. A vouches C (row written with `Sig` null, empty `Multiaddr` — not yet
 *     resolvable) and C cold-starts from its own seed.
 *  5. C self-publishes (polled `registerSelf() === 'refreshed'`), turning its
 *     row into a signed, addressed record.
 *  6. That record replicates all the way to B (`B.resolvePeerAddrs(cPeerId)`
 *     non-empty) — B knows C's address but has never connected to it, because
 *     B's dial gate (below) has denied every dial B made to C since B started.
 *
 * B'S DIAL GATE. B boots with a harness-owned connection gater
 * ({@link ControlTrio.gateB}) that denies every dial to C from the moment B
 * starts. A test lets B reach C only around the reconcile passes it runs
 * ({@link DialsToC.reconcile}), then asks which pass opened the link
 * ({@link DialsToC.openingPass}). An empty address book cannot stand in for the
 * gate, because two production paths put C's address in front of B's dialers
 * without any reconcile pass:
 *
 *  - Optimystic learns cohort addresses from cluster records. When A coordinates
 *    a control write whose cohort includes C, the `update` it sends B names C's
 *    address, and `ClusterService.learnPeerAddresses` merges it into B's
 *    peerStore (`../optimystic/packages/db-p2p/src/cluster/service.ts`). Whether
 *    a given run's record carries the address depends on timing.
 *  - FRET dials addressed ring members it is not connected to: when a neighbour
 *    departs (`announceOnDeparture` — the edge scenario's sever of A triggers it
 *    within a millisecond), when new peers appear, after bootstrap, and on
 *    stabilization (`../Fret/packages/fret/src/service/fret-service.ts`).
 *
 * Both are intended; in production B SHOULD reach C through them. Measured
 * 2026-09-16 with a dial stack logged in B's gater: 3 of 9 edge-scenario runs
 * opened B→C from FRET's departure announce, and no B→C dial came from a
 * reconcile pass the test had not run.
 *
 * Which is why the gate alone does not settle WHO dialled. A window is open for
 * a whole pass, not for its dial, and the pass's own address-book warm hands C's
 * verified address to those same two dialers partway through — so either can open
 * B→C inside the window, ahead of the pass's dial step. The pass then skips C as
 * already connected. {@link DialsToC.openingPass} therefore credits a pass only
 * when the pass's own `dialed` names C, and {@link DialsToC.reconcile} closes a
 * link left by a pass that did not dial C, so the next pass starts from the same
 * disconnected state and can dial it itself.
 *
 * Both B and C pre-pin A's owner key into their node-local trusted-owner anchor
 * (`trustedOwners.pinnedKeys`), so their seeds are accepted by the DEFAULT
 * anchored trust policy and their authorized-member predicate is real rather
 * than riding the empty-anchor fail-open carve-out.
 *
 * Harness module: no `vitest` import. Every ordering checkpoint that the
 * original scenario asserted with `expect(...)` throws an explicit `Error`
 * naming what was violated — the checkpoints are the proof, not decoration.
 *
 * Shared by `control-cohort-three-node-isolation.integration.ts`, which
 * originated this boot sequence as a private `bootTrio` before it was ported
 * here, and `control-cohort-edge-carries-data.integration.ts`.
 */

import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { CadreNode } from '@serfab/cadre-core';
import type { ControlCohortReconcileResult } from '@serfab/cadre-core';
import {
	controlNodeConfig, makeOwnOwner, connectionsTo, hasOutboundTo, peerStoreAddrsFor
} from './node-fixtures.js';
import { peerDialGate } from './peer-dial-gate.js';
import type { PeerDialGate } from './peer-dial-gate.js';
import { waitUntil, sleep } from './wait-utils.js';

export interface ControlTrioHandles { A?: CadreNode; B?: CadreNode; C?: CadreNode; }

export interface ControlTrioOptions {
	/** B's `network.controlCohort.reconcileMs`. */
	reconcileMsB: number;
	/** Filled in as each node boots so a caller's `finally` can stop partial state. */
	handles: ControlTrioHandles;
}

/** One reconcile pass run through {@link DialsToC.reconcile}. */
export interface GatedReconcilePass {
	/** The peers the pass reported dialling (`ControlCohortReconcileResult.dialed`). */
	dialed: string[];
	/** Ids of B's open outbound connections to C as the pass returned, taken before the gate closed again. */
	outboundToC: string[];
}

/**
 * B's dials to C, denied from B's start (file header, B'S DIAL GATE). A test
 * allows them only around the reconcile passes it runs.
 */
export interface DialsToC {
	/**
	 * Run `fn` with B's dials to C allowed. The gate closes again once `fn`
	 * settles and no other `allowDuring` call is still running.
	 */
	allowDuring<T>(fn: () => Promise<T>): Promise<T>;
	/**
	 * Run one reconcile pass on B with dials to C allowed, and record it. Calls
	 * the `reconcileControlCohort` B had at boot, so a test can route B's own
	 * triggers (the recurring timer) through here by assigning this over
	 * `B.reconcileControlCohort`.
	 *
	 * A pass that ends WITHOUT having dialled C leaves behind whatever connection
	 * to C another subsystem opened inside its window, and that connection is
	 * evidence of nothing (see {@link openingPass}). Such a pass therefore closes
	 * those connections before returning, with the gate shut again so nothing can
	 * re-open them, leaving the next pass the same disconnected start this one
	 * had. Once {@link openingPass} has named a pass — the evidence the caller is
	 * polling for — no pass closes anything again, so the link the test goes on to
	 * read the cohort over is never torn down under it.
	 */
	reconcile(): Promise<ControlCohortReconcileResult>;
	/** Every pass {@link reconcile} has run, oldest first. */
	passes(): readonly GatedReconcilePass[];
	/**
	 * The first recorded pass that BOTH reported dialling C and whose snapshot
	 * holds B's CURRENT open outbound connection to C — the pass whose own dial
	 * opened the link B holds now. `undefined` when B holds no such connection, or
	 * when no recorded pass dialled the one it holds.
	 *
	 * Both halves are load-bearing, and the `dialed` half is why this cannot be a
	 * connection-id match alone. The gate is closed between passes, so a
	 * connection to C did form during SOME pass's window — but the window is open
	 * for the whole pass, including the address-book warm that hands C's verified
	 * address to every other dialer in B, so FRET or the transactor can open the
	 * link before the pass reaches its own dial step. The pass then skips C as
	 * already connected and returns `dialed: []` while still holding that
	 * connection in its snapshot. Matching on the snapshot alone named such a pass
	 * the opener, and the callers' `expect(openingPass()?.dialed).toContain(c)`
	 * failed with `expected [] to include …`: a B→C link no reconcile pass dialled,
	 * reported as one a pass did. {@link reconcile} clears those connections so a
	 * later pass can dial C itself.
	 *
	 * NOTE: one ordering still reads as the pass's own dial. If another
	 * subsystem's dial to C starts inside the pass AFTER the pass listed its live
	 * connections, libp2p hands the pass's dial that connection (or joins that
	 * in-flight dial) and the pass reports C. That needs a FRET or transactor dial
	 * to land in the milliseconds between the pass's connection snapshot and its
	 * own dial; if a run ever shows it, log dial stacks in `gateB` to tell them
	 * apart.
	 */
	openingPass(): GatedReconcilePass | undefined;
	/** Gater checks for C denied so far (see {@link PeerDialGate.deniedCount}). */
	deniedCount(): number;
}

export interface ControlTrio {
	A: CadreNode; B: CadreNode; C: CadreNode;
	aPeerId: string; bPeerId: string; cPeerId: string;
	/**
	 * B's harness-owned dial gate; C is denied on it from B's start. A test may
	 * deny further peers on it (the edge scenario severs A this way). Let B reach
	 * C through {@link dialsToC}, not `gateB.allow`.
	 */
	gateB: PeerDialGate;
	dialsToC: DialsToC;
}

/**
 * Run `body`, re-throwing any failure tagged with the boot step it came from.
 * The polls below carry a `description` that lands in their timeout message; the
 * STRAIGHT-LINE calls carried nothing, so a transactor error thrown by one of
 * them reached the test naming no stage at all — and every one of them touches
 * the control DB, so that is the shape a replication failure actually takes.
 */
async function atStage<T>(stage: string, body: () => Promise<T>): Promise<T> {
	try {
		return await body();
	} catch (error) {
		throw new Error(`bootControlTrio[${stage}]: ${String(error)}`, { cause: error });
	}
}

/**
 * Stop whatever booted, newest first. A stop() failure is logged and the
 * remaining nodes are still stopped — a throw here would leak the other two
 * nodes' listeners AND mask the test failure that sent us into `finally`.
 */
export async function stopControlTrio(handles: ControlTrioHandles): Promise<void> {
	for (const node of [handles.C, handles.B, handles.A]) {
		await node?.stop().catch((error: unknown) =>
			console.warn('stopControlTrio: node stop failed during teardown:', error));
	}
}

/** The {@link DialsToC} view of `gateB`, bound to the reconcile method B has now. */
function dialsToCFor(B: CadreNode, gateB: PeerDialGate, cPeerId: string): DialsToC {
	const reconcileB = B.reconcileControlCohort.bind(B);
	const passes: GatedReconcilePass[] = [];
	let openers = 0;
	const outboundToC = (): string[] => connectionsTo(B, cPeerId)
		.filter((c) => c.direction === 'outbound' && c.status === 'open')
		.map((c) => c.id);
	/** Did a recorded pass that reported dialling C hold this connection when it returned? */
	const dialedByAPass = (id: string): boolean =>
		passes.some((pass) => pass.dialed.includes(cPeerId) && pass.outboundToC.includes(id));
	const openingPass = (): GatedReconcilePass | undefined => {
		const current = outboundToC();
		return passes.find((pass) =>
			pass.dialed.includes(cPeerId) && pass.outboundToC.some((id) => current.includes(id)));
	};
	/**
	 * Has a pass's own dial been seen holding the live link? Latched, because it is
	 * what {@link dropUnattributed} is hunting for: once a caller can have read it,
	 * the harness stops closing anything, and the cohort B→C carries is left alone
	 * for the rest of the test.
	 */
	let linkCredited = false;
	const allowDuring = async <T>(fn: () => Promise<T>): Promise<T> => {
		if (openers++ === 0) gateB.allow(cPeerId);
		try {
			return await fn();
		} finally {
			if (--openers === 0) gateB.deny(cPeerId);
		}
	};
	/**
	 * Close B's connections to C that no pass's own dial accounts for, so the next
	 * pass finds C disconnected and dials it itself.
	 *
	 * Called after a pass that leaves {@link openingPass} empty, and only with every
	 * window shut (`openers === 0`) so the gate denies the re-dial that closing
	 * invites. A close that fails is logged and the rest are still closed: the
	 * caller is a test's polling loop, and a throw here would surface as that loop's
	 * timeout instead of as what went wrong.
	 */
	const dropUnattributed = async (): Promise<void> => {
		if (openers > 0) return;
		for (const conn of connectionsTo(B, cPeerId)) {
			if (dialedByAPass(conn.id)) continue;
			await conn.close().catch((error: unknown) =>
				console.warn('dialsToC: closing a connection to C that no reconcile pass dialled failed:', error));
		}
	};
	return {
		allowDuring,
		reconcile: async () => {
			const result = await allowDuring(async () => {
				const passResult = await reconcileB();
				passes.push({ dialed: passResult.dialed, outboundToC: outboundToC() });
				return passResult;
			});
			linkCredited ||= openingPass() !== undefined;
			if (!linkCredited) {
				await dropUnattributed();
			}
			return result;
		},
		passes: () => passes,
		openingPass,
		deniedCount: () => gateB.deniedCount(cPeerId)
	};
}

/** Boot the A/B/C topology in the order described in the file header. */
export async function bootControlTrio(options: ControlTrioOptions): Promise<ControlTrio> {
	const { reconcileMsB, handles } = options;
	const partyId = `ctrl-trio-${Date.now()}`;

	// C's identity is generated up front (NOT started) so B's dial gate and the
	// "B's seed cannot name C" checkpoint below can name a concrete peer id.
	const aKey = await generateKeyPair('Ed25519');
	const bKey = await generateKeyPair('Ed25519');
	const cKey = await generateKeyPair('Ed25519');
	const cPeerId = peerIdFromPrivateKey(cKey).toString();
	const gateB = peerDialGate();
	gateB.deny(cPeerId);

	// ── 1. A: owner + storage (holds the CadrePeer blocks). No relay: every node
	//        here is directly dialable over loopback ws.
	const A = new CadreNode(controlNodeConfig({ partyId, privateKey: aKey, profile: 'storage' }));
	handles.A = A;
	await atStage('A starts', () => A.start());
	const aOwnerKey = await atStage('A becomes its own owner', () => makeOwnOwner(A, aKey));
	const aPeerId = A.peerId!.toString();

	// A's self-publish rides the ~1s start timer; the seeds minted below are only
	// useful once A's own row carries a dialable address.
	await waitUntil(
		async () => {
			const rec = await A.getControlDatabase()!.queryPeerRecord(aPeerId);
			return !!rec && rec.addrs.length > 0;
		},
		{ timeoutMs: 20_000, intervalMs: 250, description: 'A self-registers a CadrePeer row with addrs' }
	);

	// ── 2. B: client-only (listens on nothing), pinning A's owner key so the
	//        DEFAULT anchored seed policy accepts A's seed and B's own
	//        authorized-member predicate is real.
	//
	// Production onboarding vouches before seeding (addDrone / acceptPhone in
	// seed-bootstrap.ts); without it A's inbound gate refuses B's cold-start dial.
	// Vouching a moment EARLIER — before B starts — costs nothing and makes the
	// drain checkpoint below observable: B's own start-time self-registration then
	// has a row to refresh instead of logging "not yet a CadrePeer member".
	const bPeerId = peerIdFromPrivateKey(bKey).toString();
	await atStage('A vouches B', () => A.authorizePeer(bPeerId));
	const bVouchedAt = (await atStage('read B\'s vouched row on A',
		() => A.getControlDatabase()!.queryPeerRecord(bPeerId)))!.updatedAt;

	const B = new CadreNode(controlNodeConfig({
		partyId, privateKey: bKey, profile: 'transaction',
		listenAddrs: [], reconcileMs: reconcileMsB, pinnedOwnerKeys: [aOwnerKey],
		connectionGater: gateB.gater
	}));
	handles.B = B;
	await atStage('B starts', () => B.start());
	if (B.peerId!.toString() !== bPeerId) {
		throw new Error(`bootControlTrio: B started with peer id ${B.peerId!.toString()}, expected ${bPeerId}`);
	}

	const seedB = await atStage('A mints B\'s seed', () => A.createSeed());
	// C has not been authorized and holds no row, so A's seed CANNOT name it.
	// This is the "no shortcut" precondition: whatever B later knows about C did
	// not arrive in a seed.
	if (seedB.peers.some((p) => p.peerId === cPeerId)) {
		throw new Error("bootControlTrio: A's seed for B names C — the no-shortcut precondition is broken");
	}

	const appliedB = await atStage('B applies A\'s seed', () => B.applySeed(seedB));
	if (!appliedB.success) {
		throw new Error(`bootControlTrio: B failed to apply A's seed: ${JSON.stringify(appliedB)}`);
	}

	// A's gate denies AFTER the dialer's upgrade completes, so a dial can resolve
	// and die moments later — poll for the settled connection, never the return
	// value of the dial.
	await waitUntil(
		() => hasOutboundTo(B, aPeerId),
		{ timeoutMs: 45_000, intervalMs: 250, description: 'B holds an outbound control connection to A' }
	);

	// ── 2b. Drain B's ONE automatic start-time reconcile pass here, while C does
	//        not yet exist, so that pass can never be what forms B↔C later.
	//        `scheduleSelfRegistration` runs registerSelf ~1s after start() and
	//        then fires a single eager pass; B's row gaining a self-signed
	//        revision (strictly greater UpdatedAt) is the observable that the
	//        callback has run.
	await waitUntil(
		async () => {
			const row = await B.getControlDatabase()!.queryPeerRecord(bPeerId);
			return !!row && row.updatedAt > bVouchedAt;
		},
		{ timeoutMs: 45_000, intervalMs: 250, description: "B's start-time self-registration lands" }
	);
	// The eager pass is fired unawaited immediately after that registration, so the
	// checkpoint above can observe the write a beat before the pass is even issued:
	// wait it out, then join the pass. `reconcileControlCohort` hands back the
	// in-flight pass, so this resolves only once no pass is running on B.
	await sleep(1_000);
	await atStage("B's start-time reconcile pass drains", () => B.reconcileControlCohort());

	// ── 3. C starts, still unauthorized. At this instant nothing anywhere has told
	//        B that C exists, so this checkpoint is non-racy.
	const C = new CadreNode(controlNodeConfig({
		partyId, privateKey: cKey, profile: 'transaction', pinnedOwnerKeys: [aOwnerKey]
	}));
	handles.C = C;
	await atStage('C starts', () => C.start());
	if (C.peerId!.toString() !== cPeerId) {
		throw new Error(`bootControlTrio: C started with peer id ${C.peerId!.toString()}, expected ${cPeerId}`);
	}
	if (connectionsTo(B, cPeerId).length !== 0) {
		throw new Error('bootControlTrio: B already holds a connection to C before C was even vouched');
	}
	const preVouchAddrs = await peerStoreAddrsFor(B, cPeerId);
	if (preVouchAddrs.length !== 0) {
		throw new Error(`bootControlTrio: B's peerStore already holds addresses for C before C was vouched: ${preVouchAddrs.join(', ')}`);
	}

	// ── 4. A vouches C. `authorizePeer` writes the row with `Sig` null and an
	//        empty `Multiaddr` — deliberately not yet resolvable by anyone.
	await atStage('A vouches C', () => A.authorizePeer(cPeerId));
	const seedC = await atStage('A mints C\'s seed', () => A.createSeed());
	// seedC legitimately names B (createSeed snapshots the whole CadrePeer table).
	// Harmless: B's row carries no address, and applySeed only dials owner peers.
	const appliedC = await atStage('C applies A\'s seed', () => C.applySeed(seedC));
	if (!appliedC.success) {
		throw new Error(`bootControlTrio: C failed to apply A's seed: ${JSON.stringify(appliedC)}`);
	}
	await waitUntil(
		() => hasOutboundTo(C, aPeerId),
		{ timeoutMs: 45_000, intervalMs: 250, description: 'C holds an outbound control connection to A' }
	);

	// ── 5. Drive C's self-publish. C is not its own owner, so `publishSelfRecord`
	//        can only take the `updateSelfPeerRecord` branch, which needs C's row
	//        to have replicated from A first — hence the poll rather than a single
	//        call. `registerSelf()` is the production API (the CLI and the
	//        heartbeat call it); the default heartbeat is 7.5 min, far outside any
	//        test window, which is why callers drive it.
	await waitUntil(
		async () => (await C.registerSelf()) === 'refreshed',
		{ timeoutMs: 45_000, intervalMs: 500, description: "C self-publishes its CadrePeer record (row replicated from A)" }
	);

	// ── 6. C's record becomes resolvable ON B. This gate is the full signed path:
	//        record present, publicKey ↔ peerId binding, self-signature, freshness,
	//        trust policy (CadreNode.resolvePeerAddrs).
	//
	// What this proves beyond the signature checks: C cannot reach B, so C's
	// address revisions commit on C and A only, and B must learn from another
	// machine that the row changed and then obtain content at least that new.
	// Optimystic once let B satisfy that read from its own older replica and keep
	// the result in memory indefinitely (fixed in optimystic 03ffadc4). A timeout
	// here on a later build is a regression to report, not a known intermittent.
	// Do not widen the timeout — the wait measures propagation.
	await waitUntil(
		async () => (await B.resolvePeerAddrs(cPeerId)).length > 0,
		{ timeoutMs: 45_000, intervalMs: 250, description: "B resolves C's signed CadrePeer address record" }
	);

	return { A, B, C, aPeerId, bPeerId, cPeerId, gateB, dialsToC: dialsToCFor(B, gateB, cPeerId) };
}
