/**
 * Control-cohort reconcile as the SOLE connector — a three-node isolation proof.
 *
 * What this proves that the 2-node scenario cannot:
 * `control-cohort-auto-convergence.integration.ts` shows a node reaching
 * end-to-end convergence with no test-side `dial()`, but in a two-node party the
 * first (and only) connection is necessarily made by the cold-start path
 * (`applySeed`'s owner dial). `reconcileControlCohort` can only dial siblings
 * that are ALREADY in the replicated `CadrePeer` table, so in that topology it
 * never has a connection of its own to form. Here it does:
 *
 *         A  (storage, own owner, listens on ws, NO relay)
 *        / \
 *       /   \   both cold-start via applySeed (the production path)
 *      B     C
 *      ^     |
 *      |     |  C listens on ws; C's peerStore holds no dialable addr for B
 *      +-----+  B: listenAddrs: []  → C physically CANNOT dial B
 *         B dials C — the assertion under test
 *
 * B hears about C ONLY because C's signed `CadrePeer` address row replicated to
 * B through A. Nothing hands B a shortcut: B never applies a seed that names C
 * (C did not exist when B's seed was minted — asserted below), and B's libp2p
 * peerStore is checked empty for C right up to the moment of the dial, so the
 * cold-start `peerStoreAddrs` fallback in `resolveControlDialAddrs` cannot be
 * what supplied the address.
 *
 * Why B listens on NOTHING: it is the client-only RN/phone shape, and it makes
 * the direction of the link unambiguous. C cannot dial B (no listen addrs, and
 * B's own `CadrePeer` row therefore carries no address for C to resolve), so any
 * B↔C connection is necessarily one B opened — and `direction === 'outbound'` on
 * B's side is asserted on top of that.
 *
 * Why no relay: three local nodes plus a circuit relay produces unstable relayed
 * links (see the design notes in `push-wake-e2e.integration.ts`); every node here
 * is directly dialable over loopback WebSockets, so no relay is needed.
 *
 * Both cases pre-pin A's owner key into B's and C's NODE-LOCAL trusted-owner
 * anchor (`trustedOwners.pinnedKeys`), which does two things: their seeds are
 * accepted by the DEFAULT anchored trust policy with no per-call override, and
 * their authorized-member predicate (`listAuthorizedMembers`) is REAL rather
 * than riding the empty-anchor fail-open carve-out in
 * `admitInboundControlConnection` — so C admits B's inbound because B's row
 * carries A's verifiable voucher, not because C trusts nobody yet.
 *
 * Neither case contains a test-side `getControlNode().dial()`.
 */

import { describe, it, expect } from 'vitest';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { CadreNode, ed25519KeyPairFromLibp2p } from '@serfab/cadre-core';
import type { CadreNodeConfig } from '@serfab/cadre-core';
import { waitUntil, sleep } from '../harness/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** WebSocket + circuit-relay transports, matching the other e2e scenarios. */
function wsTransports() {
	return [webSockets(), circuitRelayTransport()];
}

interface NodeOpts {
	partyId: string;
	privateKey: PrivateKey;
	profile?: 'storage' | 'transaction';
	listenAddrs?: string[];
	/** Override the proactive control-cohort reconcile cadence (ms). */
	reconcileMs?: number;
	/** Owner keys pinned into the node-local trusted-owner anchor at start(). */
	pinnedOwnerKeys?: string[];
}

/** Build a `CadreNodeConfig` for one control-network node. */
function nodeConfig(opts: NodeOpts): CadreNodeConfig {
	return {
		controlNetwork: { partyId: opts.partyId, bootstrapNodes: [] },
		profile: opts.profile ?? 'transaction',
		strandFilter: { mode: 'all' },
		storage: { provider: () => new MemoryRawStorage() },
		privateKey: opts.privateKey,
		network: {
			transports: wsTransports(),
			listenAddrs: opts.listenAddrs ?? ['/ip4/127.0.0.1/tcp/0/ws'],
			...(opts.reconcileMs ? { controlCohort: { reconcileMs: opts.reconcileMs } } : {})
		},
		...(opts.pinnedOwnerKeys ? { trustedOwners: { pinnedKeys: opts.pinnedOwnerKeys } } : {}),
		hibernation: { enabled: false }
	};
}

/**
 * Make a freshly-started node its own control owner (genesis): enroll its
 * derived public key in `OwnerKey` and wire seed-bootstrap with the matching
 * private key, so it can owner-sign `CadrePeer` inserts and mint seeds.
 */
async function makeOwnOwner(node: CadreNode, key: PrivateKey): Promise<void> {
	const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(key);
	const db = node.getControlDatabase();
	if (!db) throw new Error('control database missing after start');
	await db.insertOwnerKey(publicKeyB64);
	node.initializeSeedBootstrap(privateKeyB64);
}

/** This node's live connections to `remotePeerId`, on the control network. */
function connectionsTo(node: CadreNode, remotePeerId: string) {
	return (node.getControlNode()?.getConnections() ?? [])
		.filter((c) => c.remotePeer.toString() === remotePeerId);
}

/** Does this node hold an OPEN, OUTBOUND control connection to `remotePeerId`? */
function hasOutboundTo(node: CadreNode, remotePeerId: string): boolean {
	return connectionsTo(node, remotePeerId)
		.some((c) => c.direction === 'outbound' && c.status === 'open');
}

/**
 * The libp2p peerStore multiaddrs this node holds for `remotePeerId` — the
 * cold-start fallback source `resolveControlDialAddrs` uses when the signed
 * `CadrePeer` record does not resolve. A missing entry is an empty list; any
 * other failure is rethrown rather than swallowed into a false "empty".
 */
async function peerStoreAddrsFor(node: CadreNode, remotePeerId: string): Promise<string[]> {
	const controlNode = node.getControlNode();
	if (!controlNode) return [];
	try {
		const peer = await controlNode.peerStore.get(peerIdFromString(remotePeerId));
		return peer.addresses.map((a) => a.multiaddr.toString());
	} catch (error) {
		if ((error as { name?: string }).name === 'NotFoundError') return [];
		throw error;
	}
}

/** What a booted trio hands the test body — the two nodes whose link is under test. */
interface Trio {
	B: CadreNode;
	C: CadreNode;
	cPeerId: string;
}

/** Nodes booted so far, in the order they must be stopped (reverse of start). */
interface TrioHandles {
	A?: CadreNode;
	B?: CadreNode;
	C?: CadreNode;
}

/**
 * Stop whatever booted, newest first. A stop() failure is logged and the
 * remaining nodes are still stopped — a throw here would leak the other two
 * nodes' listeners AND mask the test failure that sent us into `finally`.
 */
async function stopTrio(handles: TrioHandles): Promise<void> {
	for (const node of [handles.C, handles.B, handles.A]) {
		await node?.stop().catch((error: unknown) =>
			console.warn('stopTrio: node stop failed during teardown:', error));
	}
}

/**
 * Boot the A/B/C topology in the ONE order that makes the isolation claim true.
 * Each step must precede the next; the proof is an ordering property, not a
 * single assertion:
 *
 *  1. A starts and self-publishes an addressed `CadrePeer` row.
 *  2. B is vouched, cold-starts from A's seed — minted BEFORE C exists.
 *  3. C starts, still unauthorized: B provably knows nothing about it.
 *  4. C is vouched (row written with `Sig` null, empty `Multiaddr` — not yet
 *     resolvable) and cold-starts from its own seed.
 *  5. C self-publishes, turning its row into a signed, addressed record.
 *  6. That record replicates all the way to B.
 *
 * `handles` is filled in as each node boots so the caller's `finally` can stop
 * whatever came up even if a later step throws.
 */
async function bootTrio(opts: { reconcileMsB: number; handles: TrioHandles }): Promise<Trio> {
	const { reconcileMsB, handles } = opts;
	const partyId = `cohort3-${Date.now()}`;

	// C's identity is generated up front (NOT started) purely so the "B's seed
	// cannot name C" assertion below can name a concrete peer id.
	const aKey = await generateKeyPair('Ed25519');
	const bKey = await generateKeyPair('Ed25519');
	const cKey = await generateKeyPair('Ed25519');
	const cPeerId = peerIdFromPrivateKey(cKey).toString();
	const { publicKeyB64: aOwnerKey } = ed25519KeyPairFromLibp2p(aKey);

	// ── 1. A: owner + storage (holds the CadrePeer blocks). No relay: every node
	//        here is directly dialable over loopback ws.
	const A = new CadreNode(nodeConfig({ partyId, privateKey: aKey, profile: 'storage' }));
	handles.A = A;
	await A.start();
	await makeOwnOwner(A, aKey);
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
	// Vouching a moment EARLIER — before B starts — costs nothing and makes step
	// 2b's checkpoint observable: B's own start-time self-registration then has a
	// row to refresh instead of logging "not yet a CadrePeer member" and skipping.
	const bPeerId = peerIdFromPrivateKey(bKey).toString();
	await A.authorizePeer(bPeerId);
	const bVouchedAt = (await A.getControlDatabase()!.queryPeerRecord(bPeerId))!.updatedAt;

	const B = new CadreNode(nodeConfig({
		partyId, privateKey: bKey, profile: 'transaction',
		listenAddrs: [], reconcileMs: reconcileMsB, pinnedOwnerKeys: [aOwnerKey]
	}));
	handles.B = B;
	await B.start();
	expect(B.peerId!.toString()).toBe(bPeerId);

	const seedB = await A.createSeed();
	// C has not been authorized and holds no row, so A's seed CANNOT name it.
	// This is the "no shortcut" precondition: whatever B later knows about C did
	// not arrive in a seed.
	expect(seedB.peers.some((p) => p.peerId === cPeerId)).toBe(false);

	const appliedB = await B.applySeed(seedB);
	expect(appliedB.success).toBe(true);

	// A's gate denies AFTER the dialer's upgrade completes, so a dial can resolve
	// and die moments later — poll for the settled connection, never the return
	// value of the dial.
	await waitUntil(
		() => hasOutboundTo(B, aPeerId),
		{ timeoutMs: 45_000, intervalMs: 250, description: 'B holds an outbound control connection to A' }
	);

	// ── 2b. Drain B's ONE automatic start-time reconcile pass here, while C does
	//        not yet exist, so that pass can never be what forms B↔C later — case
	//        2's negative window rests on that ordering, and without this the pass
	//        lands right on top of it. `scheduleSelfRegistration` runs registerSelf
	//        ~1s after start() and then fires a single eager pass; B's row gaining a
	//        self-signed revision (strictly greater UpdatedAt) is the observable
	//        that the callback has run.
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
	await B.reconcileControlCohort();

	// ── 3. C starts, still unauthorized. At this instant nothing anywhere has told
	//        B that C exists, so this checkpoint is non-racy.
	const C = new CadreNode(nodeConfig({
		partyId, privateKey: cKey, profile: 'transaction', pinnedOwnerKeys: [aOwnerKey]
	}));
	handles.C = C;
	await C.start();
	expect(C.peerId!.toString()).toBe(cPeerId);
	expect(connectionsTo(B, cPeerId)).toHaveLength(0);
	expect(await peerStoreAddrsFor(B, cPeerId)).toHaveLength(0);

	// ── 4. A vouches C. `authorizePeer` writes the row with `Sig` null and an
	//        empty `Multiaddr` — deliberately not yet resolvable by anyone.
	await A.authorizePeer(cPeerId);
	const seedC = await A.createSeed();
	// seedC legitimately names B (createSeed snapshots the whole CadrePeer table).
	// Harmless: B's row carries no address, and applySeed only dials owner peers.
	const appliedC = await C.applySeed(seedC);
	expect(appliedC.success).toBe(true);
	await waitUntil(
		() => hasOutboundTo(C, aPeerId),
		{ timeoutMs: 45_000, intervalMs: 250, description: 'C holds an outbound control connection to A' }
	);

	// ── 5. Drive C's self-publish. C is not its own owner, so `publishSelfRecord`
	//        can only take the `updateSelfPeerRecord` branch, which needs C's row
	//        to have replicated from A first — hence the poll rather than a single
	//        call. `registerSelf()` is the production API (the CLI and the
	//        heartbeat call it); the default heartbeat is 7.5 min, far outside the
	//        test window, which is why the test drives it.
	await waitUntil(
		async () => (await C.registerSelf()) === 'refreshed',
		{ timeoutMs: 45_000, intervalMs: 500, description: "C self-publishes its CadrePeer record (row replicated from A)" }
	);

	// ── 6. C's record becomes resolvable ON B. This gate is the full signed path:
	//        record present, publicKey ↔ peerId binding, self-signature, freshness,
	//        trust policy (CadreNode.resolvePeerAddrs).
	//
	// NOTE: this poll timed out once, on the very first cold run of this scenario,
	// and has resolved in milliseconds on every run since — no cause established.
	// If it recurs, capture DEBUG='sereus:cadre:node' and check whether C's row
	// reached B at all: a genuine A→B replication failure is a product bug and
	// deserves its own ticket rather than a wider timeout here.
	await waitUntil(
		async () => (await B.resolvePeerAddrs(cPeerId)).length > 0,
		{ timeoutMs: 45_000, intervalMs: 250, description: "B resolves C's signed CadrePeer address record" }
	);

	return { B, C, cPeerId };
}

// ═══════════════════════════════════════════════════════════════════════════════

describe('Control-cohort reconcile as sole connector (three nodes, no manual dial)', () => {
	it('B automatically dials C once C\'s record replicates through A', async () => {
		const handles: TrioHandles = {};
		try {
			// Short cadence so the recurring reconcile fires several times inside the
			// window; nothing else in this test drives a pass.
			const { B, C, cPeerId } = await bootTrio({ reconcileMsB: 2_000, handles });

			// THE ASSERTION. B never had an address for C from any source but the
			// replicated record, and B is the only side that can dial.
			await waitUntil(
				() => hasOutboundTo(B, cPeerId),
				{ timeoutMs: 60_000, intervalMs: 250, description: 'B dials C from the replicated record (reconcile timer)' }
			);

			// End-state check that the resulting cohort actually works: C authors a
			// NEW row revision after B↔C formed, and B's view catches up to it.
			// Honest scope: that revision may still reach B via A — this asserts the
			// cohort converges with B↔C in place, it is NOT a proof of the B↔C wire.
			//
			// Polled rather than called once: a 3-member cohort commits on Optimystic's
			// default 0.75 super-majority over a cluster downsized to the 3 peers
			// present — i.e. unanimity — so a single stream reset during the churn of
			// B↔C forming fails the commit outright. Production retries the identical
			// call on the record heartbeat; `waitUntil` logs each throw under the
			// `sereus:integration:wait` debug namespace rather than eating it.
			await waitUntil(
				async () => (await C.registerSelf()) === 'refreshed',
				{ timeoutMs: 60_000, intervalMs: 1_000, description: 'C re-publishes its record into the 3-member cohort' }
			);
			const republished = await C.getControlDatabase()!.queryPeerRecord(cPeerId);
			expect(republished).not.toBeNull();
			const freshUpdatedAt = republished!.updatedAt;
			await waitUntil(
				async () => {
					const seen = await B.getControlDatabase()!.queryPeerRecord(cPeerId);
					return !!seen && seen.updatedAt >= freshUpdatedAt;
				},
				{ timeoutMs: 45_000, intervalMs: 250, description: "B observes C's re-published record revision" }
			);
		} finally {
			await stopTrio(handles);
		}
	}, 120_000);

	it('is load-bearing: without a reconcile pass B never reaches C, and one pass forms the link', async () => {
		const handles: TrioHandles = {};
		try {
			// `reconcileMs` is read once when the refresh timers are wired, so it
			// cannot be changed mid-test — hence a second boot. 10 minutes means the
			// recurring timer provably never fires inside this test.
			const { B, cPeerId } = await bootTrio({ reconcileMsB: 600_000, handles });

			// ── Negative window. For ~5s: B can RESOLVE C (the record is there) but
			//    holds no connection to it and no peerStore address for it. This is
			//    what proves no other subsystem forms the link — FRET stabilization
			//    learns C's peer id from A's announce snapshot, but its
			//    `dialProtocol(peerId)` has no address to use; the cohort topic and
			//    the connection manager are equally addressless here.
			//
			// NOTE: if this window ever fails, the first suspect is a
			// `self:peer:update`-triggered reconcile pass on B (wired in
			// `startRecordRefresh` alongside the interval, so the 10-minute cadence
			// does not suppress it). B listens on nothing, so its libp2p address set
			// should never change mid-test and no run has shown this — but the trigger
			// exists. Diagnose with DEBUG='sereus:cadre:node' and look for
			// "Control-cohort reconcile (self:peer:update)".
			let checkpoints = 0;
			let resolvedCheckpoints = 0;
			for (let elapsed = 0; elapsed < 5_000; elapsed += 250) {
				expect(connectionsTo(B, cPeerId)).toHaveLength(0);
				expect(await peerStoreAddrsFor(B, cPeerId)).toHaveLength(0);
				checkpoints++;
				if ((await B.resolvePeerAddrs(cPeerId)).length > 0) resolvedCheckpoints++;
				await sleep(250);
			}
			// The record stayed resolvable at EVERY checkpoint, so the absence of a
			// connection above is not "B had nothing to dial" — it is "nothing dialed".
			expect(checkpoints).toBeGreaterThan(0);
			expect(resolvedCheckpoints).toBe(checkpoints);

			// Last checkpoint before the dial: the record path is live and the
			// cold-start fallback (`peerStoreAddrs`) is empty, so the address the
			// dial below uses can only have come from the replicated record.
			expect(await peerStoreAddrsFor(B, cPeerId)).toHaveLength(0);
			expect((await B.resolvePeerAddrs(cPeerId)).length).toBeGreaterThan(0);

			// ── The public routine the timer would have called — not a raw dial().
			//    Polled rather than called exactly once: if B's own row has not yet
			//    replicated to C, C's `admitInboundControlConnection` denies and the
			//    connection dies moments after `dial()` resolves, so a single pass can
			//    lose that race. Each iteration is a real production reconcile pass.
			let passes = 0;
			await waitUntil(
				async () => {
					if (hasOutboundTo(B, cPeerId)) return true;
					passes++;
					await B.reconcileControlCohort();
					// The membership gater denies AFTER the dialer's upgrade completes,
					// so a refused dial looks momentarily successful — re-check on the
					// next poll rather than accepting this pass's immediate state.
					return false;
				},
				{ timeoutMs: 60_000, intervalMs: 1_000, description: 'an explicit reconcile pass dials C' }
			);
			expect(passes).toBeGreaterThan(0);
			expect(hasOutboundTo(B, cPeerId)).toBe(true);
		} finally {
			await stopTrio(handles);
		}
	}, 120_000);
});
