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
 *     non-empty) — B knows C's address but has never connected to it.
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
 * here.
 */

import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { ConnectionGater } from '@libp2p/interface';
import { CadreNode } from '@serfab/cadre-core';
import {
	controlNodeConfig, makeOwnOwner, connectionsTo, hasOutboundTo, peerStoreAddrsFor
} from './node-fixtures.js';
import { waitUntil, sleep } from './wait-utils.js';

export interface ControlTrioHandles { A?: CadreNode; B?: CadreNode; C?: CadreNode; }

export interface ControlTrioOptions {
	/** B's `network.controlCohort.reconcileMs`. */
	reconcileMsB: number;
	/** Filled in as each node boots so a caller's `finally` can stop partial state. */
	handles: ControlTrioHandles;
	/**
	 * Test-supplied gater for B (composed under the membership gate, which
	 * preserves every hook except `denyInboundEncryptedConnection`).
	 */
	gaterB?: ConnectionGater;
}

export interface ControlTrio {
	A: CadreNode; B: CadreNode; C: CadreNode;
	aPeerId: string; bPeerId: string; cPeerId: string;
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

/** Boot the A/B/C topology in the order described in the file header. */
export async function bootControlTrio(options: ControlTrioOptions): Promise<ControlTrio> {
	const { reconcileMsB, handles, gaterB } = options;
	const partyId = `ctrl-trio-${Date.now()}`;

	// C's identity is generated up front (NOT started) purely so the "B's seed
	// cannot name C" checkpoint below can name a concrete peer id.
	const aKey = await generateKeyPair('Ed25519');
	const bKey = await generateKeyPair('Ed25519');
	const cKey = await generateKeyPair('Ed25519');
	const cPeerId = peerIdFromPrivateKey(cKey).toString();

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
		...(gaterB ? { connectionGater: gaterB } : {})
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
	// NOTE: this poll timed out once, on the very first cold run of the isolation
	// scenario, and has resolved in milliseconds on every run since — no cause
	// established. If it recurs, capture DEBUG='sereus:cadre:node' and check
	// whether C's row reached B at all: a genuine A→B replication failure is a
	// product bug and deserves its own ticket rather than a wider timeout here.
	await waitUntil(
		async () => (await B.resolvePeerAddrs(cPeerId)).length > 0,
		{ timeoutMs: 45_000, intervalMs: 250, description: "B resolves C's signed CadrePeer address record" }
	);

	return { A, B, C, aPeerId, bPeerId, cPeerId };
}
