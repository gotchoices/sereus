/**
 * End-to-end control-network push-wake over real libp2p.
 *
 * The `hibernation-push-wake` unit tests (cadre-core `strand-wake-protocol.spec.ts`)
 * exercise the wake decision matrix and the framing round-trip with in-memory
 * stream doubles (`wake-stream-helpers.ts`) and a stubbed `dialProtocol` /
 * `resolvePeerAddrs`. This scenario proves the **real wire path** instead:
 *
 *   - a real `node.handle(WAKE_PROTOCOL, …)` dispatch on the receiver (registered
 *     automatically in `CadreNode.start()` — cadre-node.ts:342),
 *   - a real `dialProtocol` stream over a real WebSocket transport,
 *   - libp2p 3.x half-close (`stream.close()` write-EOF, read end open for the ack),
 *   - multi-chunk length-prefixed JSON framing,
 *   - `pushWake`'s composition with `resolvePeerAddrs` (binding + self-sig +
 *     freshness + trust + signaling-first), and
 *   - the circuit-relay (signaling-first) dial to a NAT'd receiver.
 *
 * Four scenarios, each booting fresh nodes in a try/finally:
 *   1. Happy path — direct dial of a hibernating member, wake accepted.
 *   2. NAT'd receiver reachable only via a circuit relay, wake accepted.
 *   3. Non-member sender — receiver rejects, strand stays hibernating.
 *   4. Replication-backed authorization — membership written ONLY on an authority
 *      node converges to the sender and receiver over the live control network, so
 *      the wake passes the `isMember` / `resolvePeerAddrs` gates via REPLICATION,
 *      with no local seeding on the node that consults them.
 *
 * ── Control-DB replication & the single shared authority (READ THIS) ──
 *
 * The wake gate (`isMember`, read on the RECEIVER) and the sender's address resolve
 * (`resolvePeerAddrs`, read on the SENDER) both consult a node's LOCAL control DB.
 * Network-backing the control DB has LANDED (`control-db-network-backed`): the
 * `CadreControl` tables are a party-shared, replicated Optimystic store, so a fact
 * written on one cadre node converges to a connected peer by pull-on-read (proven by
 * `control-db-two-node-convergence.integration.ts`).
 *
 * A direct consequence: two nodes in one party can no longer each self-appoint as
 * genesis authority — the second `AuthorityKey` insert fails the `Authorized`
 * bootstrap CHECK once the first has replicated. So scenarios 1, 2 and 4 each elect
 * ONE authority and make the other nodes plain members; that authority writes the
 * membership facts and they converge to whoever gates on them:
 *   - Scenario 1 (direct): the SENDER S is the sole authority + storage. It writes its
 *     OWN membership (Rx's `isMember(S)` converges) and Rx's address record (S resolves
 *     its own write locally). Direct dial, a 2-node {S, Rx} cohort.
 *   - Scenario 2 (NAT/relay): the RELAY L is the sole authority + storage. It writes
 *     S's membership (Rx converges) and Rx's circuit address record (S converges).
 *     Every write is a 2-node {L, S} commit; Rx joins LAST and only reads.
 *   - Scenario 4 (replication-backed): a DEDICATED authority A — neither sender nor
 *     receiver — writes both facts; S and Rx each read a SIBLING-written row. The
 *     deepest replication proof (full mesh, A the only writer).
 *
 * Scenario 3 is the lone exception: its outsider O is its own authority but never
 * forms a cohort (genesis local-only), so the non-member rejection stays a pure local
 * gate (`isMember(O) === false`; Rx authorized no one). Every byte of the real
 * dial/handle/framing/resolve path is exercised in all four.
 *
 * Scenario 2 — NAT receiver listen address: with
 * `@libp2p/circuit-relay-v2@4.x`, a *discovered* relay reservation is skipped
 * unless a `/p2p-circuit` listen address has populated the pending-reservation
 * queue (reservation-store.ts `HadEnoughRelaysError` guard). So the NAT'd receiver
 * listens on the relay's explicit `…/p2p-circuit` address — it still has no direct
 * dialable address (genuinely NAT'd), but the reservation is deterministic rather
 * than discovery-timing dependent. (The ticket's `listenAddrs: []` never reserves.)
 *
 * Scenario 2 — NAT receiver is NOT hibernated, by design. Scenario 2's unique
 * subject is the SENDER reaching a NAT'd peer: the signaling-first resolve and the
 * relayed dial over a libp2p "limited" (circuit) connection. (That dial used to
 * fail outright with `LimitedConnectionError`; this ticket fixed it — see the
 * `runOnLimitedConnection` change in `strand-wake-protocol.ts`.) The full
 * hibernating→`active` resume is already proven on the direct path (scenario 1)
 * and is the SAME receiver code regardless of transport. Driving a *hibernating*
 * NAT receiver to `active` additionally requires the woken strand's `networked`
 * resume to form its cluster — but over the relay mesh the strand cluster tries to
 * recruit the relay/server peers (which speak the control-network protocol, not
 * the strand-repo protocol) and fails super-majority. That is the known
 * "strand-cohort discovery over the control network is TODO" gap, not a wake-
 * transport defect, so scenario 2 wakes an already-active strand (the "already
 * live → accepted" branch) to keep the assertion about the relay transport, not
 * the strand cluster. See the review handoff for the follow-up this should spawn.
 */

import { describe, it, expect } from 'vitest';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import {
	CadreNode,
	signSchema,
	authorityKeyFromLibp2p,
	signPeerRecord,
	ed25519PublicKeyB64FromPeerId,
} from '@serfab/cadre-core';
import type { CadreNodeConfig, SAppConfig, WakeAck, PeerAddressRecord } from '@serfab/cadre-core';
import { waitUntil, waitForCadrePeerConverged, waitForCrossNodeControlSync } from '../harness/index.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** WebSocket + circuit-relay transports, matching the other e2e scenarios. */
function wsTransports() {
	return [webSockets(), circuitRelayTransport()];
}

/** Minimal hibernation-friendly sApp schema. */
const SIMPLE_SCHEMA = `
table Data (
    Key text primary key,
    Val text
);
`;

/**
 * A properly signed sApp config with a NON-realtime `latencyHint` — realtime
 * strands never hibernate, so `'interactive'` is required for the wake path.
 * (Copied from `strand-formation-e2e.integration.ts`.)
 */
function createSignedSAppConfig(schema: string, version: string): SAppConfig {
	const authorPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
	const authorPublicKey = getPublicKey(authorPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
	const signature = signSchema(schema, version, authorPrivateKey);
	return { id: authorPublicKey, version, schema, signature, latencyHint: 'interactive' as const };
}

interface NodeOpts {
	partyId: string;
	privateKey?: PrivateKey;
	bootstrapNodes?: string[];
	profile?: 'storage' | 'transaction';
	enableRelay?: boolean;
	listenAddrs?: string[];
	hibernation?: boolean;
}

/** Build a `CadreNodeConfig` for one node in the push-wake topology. */
function nodeConfig(opts: NodeOpts): CadreNodeConfig {
	return {
		controlNetwork: { partyId: opts.partyId, bootstrapNodes: opts.bootstrapNodes ?? [] },
		profile: opts.profile ?? 'transaction',
		strandFilter: { mode: 'all' },
		storage: { provider: () => new MemoryRawStorage() },
		...(opts.privateKey ? { privateKey: opts.privateKey } : {}),
		network: {
			transports: wsTransports(),
			listenAddrs: opts.listenAddrs ?? ['/ip4/127.0.0.1/tcp/0/ws'],
			...(opts.enableRelay ? { enableRelay: true } : {}),
		},
		hibernation: { enabled: opts.hibernation ?? false },
	};
}

/** The control node's currently-observed multiaddrs as strings. */
function controlAddrs(node: CadreNode): string[] {
	return node.getControlNode()!.getMultiaddrs().map((ma) => ma.toString());
}

/**
 * Make a freshly-started node its own control authority (genesis): enroll its
 * derived public key in `AuthorityKey` and wire the seed-bootstrap service with
 * the matching private key, so it can authority-sign `CadrePeer` inserts into its
 * own local control DB.
 */
async function makeOwnAuthority(node: CadreNode, key: PrivateKey): Promise<void> {
	const { privateKeyB64, publicKeyB64 } = authorityKeyFromLibp2p(key);
	const db = node.getControlDatabase();
	if (!db) throw new Error('control database missing after start');
	await db.insertAuthorityKey(publicKeyB64);
	node.initializeSeedBootstrap(privateKeyB64);
}

/**
 * Authority-signed INSERT of the receiver's own self-signed `CadrePeer` record
 * into `authorityNode`'s control DB, exactly as the receiver would self-publish —
 * so `authorityNode.resolvePeerAddrs(rxPeerId)` passes its binding + self-sig +
 * freshness gates and dials the supplied addrs (signaling/relay first).
 */
async function seedReceiverRecord(
	authorityNode: CadreNode,
	rxPeerId: string,
	rxKey: PrivateKey,
	rxAddrs: string[],
): Promise<PeerAddressRecord> {
	const { privateKeyB64, publicKeyB64 } = authorityKeyFromLibp2p(rxKey);
	// The binding gate `resolvePeerAddrs` enforces: the record's publicKey MUST be
	// the ed25519 key embedded in the peerId (both derived from rxKey here).
	expect(publicKeyB64).toBe(ed25519PublicKeyB64FromPeerId(rxPeerId));
	const record = signPeerRecord(
		{ peerId: rxPeerId, publicKey: publicKeyB64, addrs: rxAddrs, updatedAt: Date.now() },
		privateKeyB64,
	);
	await authorityNode.getSeedBootstrapService()!.insertSelfPeerRecord(record);
	return record;
}

/**
 * Establish a DIRECT control-network connection from `reader` to `writer` and wait
 * until BOTH sides report it (scoped to this specific peer pair, so the recipe is
 * correct when several readers attach to one writer). This is the test-only
 * stand-in for production control-cohort discovery, proven by
 * `control-db-two-node-convergence.integration.ts`. Both-sides confirmation is a
 * hard precondition of a replicating write: only once each peer sees the connection
 * can the control collection's cohort span them and a commit be non-local-only.
 */
async function connectControlNodes(reader: CadreNode, writer: CadreNode): Promise<void> {
	const readerNode = reader.getControlNode()!;
	const writerNode = writer.getControlNode()!;
	const writerAddrs = writerNode.getMultiaddrs();
	expect(writerAddrs.length).toBeGreaterThan(0);
	const readerPeerId = reader.peerId!.toString();
	const writerPeerId = writer.peerId!.toString();

	await readerNode.dial(writerAddrs[0]!);
	await waitUntil(() => readerNode.getConnections().some((c) => c.remotePeer.toString() === writerPeerId), {
		timeoutMs: 15_000,
		intervalMs: 250,
		description: 'reader control node connects to writer',
	});
	await waitUntil(() => writerNode.getConnections().some((c) => c.remotePeer.toString() === readerPeerId), {
		timeoutMs: 15_000,
		intervalMs: 250,
		description: 'writer control node sees inbound connection from reader',
	});
}

/**
 * Stand up a strand on the receiver and drive it to `hibernating`. Uses
 * `mode: 'bootstrap'` so the strand stands up solo (the wake travels the control
 * network, not the strand network). Asserts `active` then `hibernating` so a
 * silent hibernate no-op (e.g. a realtime latency hint) fails loudly.
 */
async function bringUpHibernatingStrand(Rx: CadreNode, strandId: string): Promise<void> {
	const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '0.1.0');
	const strand = await Rx.addStrand({
		strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' },
		sAppConfig: sApp,
		mode: 'bootstrap',
	});
	expect(strand.status).toBe('active');

	await Rx.hibernateStrand(strandId);
	expect(Rx.getStrand(strandId)?.status).toBe('hibernating');
}

const RESERVATION_WAIT = { timeoutMs: 20_000, intervalMs: 250 } as const;

// ═════════════════════════════════════════════════════════════════════════════

describe('E2E push-wake over the control network', () => {
	// ── 1. Happy path: direct dial of a hibernating member ────────────────────

	it('wakes a hibernating member over a real direct control dial', async () => {
		let S: CadreNode | undefined;
		let Rx: CadreNode | undefined;
		try {
			const partyId = `pushwake-direct-${Date.now()}`;
			const strandId = `strand-direct-${Date.now()}`;

			// SINGLE SHARED AUTHORITY (see file header): S is the party's SOLE authority +
			// storage hub AND the sender; Rx is a plain member that never genesis. S's
			// authority key is enrolled explicitly (independent of its EPHEMERAL node
			// identity — so S never self-publishes an addr-bearing CadrePeer row that would
			// pollute Rx's strand-resume cohort seed, exactly as scenario 4). Genesis ALONE
			// before forming a cohort so the lone AuthorityKey commits with no collision.
			const sKey = await generateKeyPair('Ed25519');
			S = new CadreNode(nodeConfig({ partyId, profile: 'storage' }));
			await S.start();
			await makeOwnAuthority(S, sKey);
			const sPeerId = S.peerId!.toString();

			// Receiver Rx: hibernating plain member — NOT its own authority, so every
			// membership fact it consults must have been written by S and pulled over the wire.
			const rxKey = await generateKeyPair('Ed25519');
			Rx = new CadreNode(nodeConfig({ partyId, privateKey: rxKey, hibernation: true }));
			await Rx.start();
			const rxPeerId = Rx.peerId!.toString();

			// CONNECT BEFORE WRITE: a direct 2-node cohort {S, Rx} (both-sides confirmed),
			// neither NAT'd, so S's writes below commit cohort-wide rather than local-only.
			await connectControlNodes(Rx, S);

			// S — and ONLY S — writes both membership facts as clean {S, Rx} 2-node commits:
			//   • S's own membership row (`authorizePeer`), so Rx's wake gate `isMember(S)` passes.
			//   • Rx's self-signed address record (`seedReceiverRecord`, real direct addr), so
			//     S's `resolvePeerAddrs(Rx)` passes. S reads its OWN write locally; Rx pulls.
			const rxAddrs = controlAddrs(Rx);
			expect(rxAddrs.length).toBeGreaterThan(0);
			await S.authorizePeer(sPeerId);
			await seedReceiverRecord(S, rxPeerId, rxKey, rxAddrs);
			expect((await S.resolvePeerAddrs(rxPeerId)).length).toBeGreaterThan(0);

			// Rx's wake gate recognizes S as a member via REPLICATION — no local seeding.
			await waitForCadrePeerConverged(Rx.getControlDatabase()!, sPeerId, {
				timeoutMs: 30_000,
				description: "Rx observes S's CadrePeer membership row written on S",
			});
			expect(await Rx.isMember(sPeerId)).toBe(true);

			await bringUpHibernatingStrand(Rx, strandId);

			// Real handle/dialProtocol/half-close/framing + pushWake→resolvePeerAddrs→dialWake.
			const ack: WakeAck = await S.pushWake(rxPeerId, strandId, 'test wake');
			expect(ack).toEqual({ accepted: true, status: 'active' });
			expect(Rx.getStrand(strandId)?.status).toBe('active');
		} finally {
			await Rx?.stop();
			await S?.stop();
		}
	}, 90_000);

	// ── 2. NAT'd receiver reachable only via a circuit relay ──────────────────
	//
	// SINGLE SHARED AUTHORITY (see file header). The network-backed `CadreControl`
	// store is party-shared, so two nodes can no longer each self-genesis — the
	// in-memory-era "every node is its own authority" recipe collides on `Authorized`.
	// The relay L is therefore the party's SOLE authority + storage hub (legitimate:
	// it is already dedicated transport infra, mirroring scenario 4's authority+storage
	// `A`). S and Rx are plain members that never genesis.
	//
	// Every control WRITE the assertions hinge on is a clean 2-node `{L, S}` commit
	// (the proven `control-db-two-node-convergence` recipe): L genesises ALONE, then S
	// connects, then L writes both membership facts while only `{L, S}` are linked. Rx
	// joins LAST and writes nothing any assertion waits on (its background `registerSelf`
	// only self-UPDATEs its own already-resolvable row — scenario 4 design note #1) — no
	// 3-node commit, no S↔Rx control link (which over the
	// relay mesh would be the unstable link), no full-mesh-over-relay flakiness. Rx's
	// deterministic circuit address is CONSTRUCTED before it starts, so the
	// address-record write lands inside the `{L, S}` window.
	it("delivers a wake to a NAT'd receiver over a circuit-relay (signaling-first) dial", async () => {
		let L: CadreNode | undefined;
		let S: CadreNode | undefined;
		let Rx: CadreNode | undefined;
		try {
			const partyId = `pushwake-nat-${Date.now()}`;
			const strandId = `strand-nat-${Date.now()}`;

			// Relay L: dedicated transport infra AND the party's SOLE authority + storage
			// hub. Genesis ALONE (cohort {L}, before S/Rx connect) so its lone AuthorityKey
			// commits with no shared-authority collision. Storage profile so it holds the
			// CadrePeer blocks the readers pull.
			const lKey = await generateKeyPair('Ed25519');
			L = new CadreNode(nodeConfig({ partyId, profile: 'storage', enableRelay: true }));
			await L.start();
			await makeOwnAuthority(L, lKey);
			const lAddrs = controlAddrs(L);
			expect(lAddrs.length).toBeGreaterThan(0);
			const lAddr = lAddrs[0]!; // /ip4/127.0.0.1/tcp/<port>/ws/p2p/<L>

			// Server S: a plain MEMBER (never genesis) and the sender. Connecting it to L
			// makes the control cohort exactly {L, S} while the writes below commit, and
			// gives the later relayed wake dial an open connection to route through L.
			const sKey = await generateKeyPair('Ed25519');
			S = new CadreNode(nodeConfig({ partyId, privateKey: sKey }));
			await S.start();
			const sPeerId = S.peerId!.toString();
			await connectControlNodes(S, L);

			// Rx's peerId is derived from its key BEFORE Rx starts, so its deterministic
			// circuit-relay address `<lAddr>/p2p-circuit/p2p/<Rx>` can be CONSTRUCTED now —
			// letting the address-record write land inside the {L, S} 2-node window, before
			// Rx ever joins the cohort.
			const rxKey = await generateKeyPair('Ed25519');
			const rxPeerId = peerIdFromPrivateKey(rxKey).toString();
			const rxCircuitAddr = `${lAddr}/p2p-circuit/p2p/${rxPeerId}`;

			// L — and ONLY L — writes both membership facts, each a clean {L, S} 2-node commit:
			//   • S's membership row (`authorizePeer`), so Rx's wake gate `isMember(S)` passes.
			//   • Rx's self-signed address record (`seedReceiverRecord` — one authority insert
			//     carrying Rx's own `Sig`), so S's `resolvePeerAddrs(Rx)` passes. The synthetic
			//     direct addr is kept so signaling-first ordering (circuit sorts ahead of
			//     direct) stays observable.
			const syntheticDirect = '/ip4/10.255.0.1/tcp/4001/ws';
			await L.authorizePeer(sPeerId);
			await seedReceiverRecord(L, rxPeerId, rxKey, [rxCircuitAddr, syntheticDirect]);

			// Converge S on Rx's sibling-written record (pull-on-read) and assert the circuit
			// addr sorts FIRST — the signaling-first ordering the in-memory unit tests can
			// only stub. This runs BEFORE Rx starts: the record is independent of Rx being live.
			await waitForCrossNodeControlSync(
				S.getControlDatabase()!,
				async () => (await S!.resolvePeerAddrs(rxPeerId)).length > 0,
				{ timeoutMs: 30_000, description: "S resolves Rx's circuit address via replication" },
			);
			const resolved = (await S.resolvePeerAddrs(rxPeerId)).map((m) => m.toString());
			expect(resolved.length).toBeGreaterThan(0);
			expect(resolved[0]).toContain('/p2p-circuit');

			// Start Rx LAST: genuinely NAT'd — no direct listen addr, only a relayed slot on
			// L (explicit `…/p2p-circuit` listen, see header note). It bootstraps to L; it never
			// genesises and writes nothing the assertions hinge on (its background `registerSelf`
			// only self-UPDATEs its own already-resolvable row). (NOT hibernated — see header note.)
			Rx = new CadreNode(nodeConfig({
				partyId,
				privateKey: rxKey,
				bootstrapNodes: [lAddr],
				listenAddrs: [`${lAddr}/p2p-circuit`],
			}));
			await Rx.start();
			expect(Rx.peerId!.toString()).toBe(rxPeerId);

			await waitUntil(() => Rx!.getControlNode()!.getConnections().length > 0, {
				...RESERVATION_WAIT,
				description: 'Rx connects to the relay',
			});

			// Wait for the relay reservation to materialise as a /p2p-circuit addr, so the
			// relay slot the wake dial traverses genuinely exists. Confirm it matches the
			// address record L vouched for (the constructed addr was correct).
			let circuitAddr = '';
			await waitUntil(() => {
				circuitAddr = controlAddrs(Rx!).find((a) => a.includes('/p2p-circuit')) ?? '';
				return circuitAddr.length > 0;
			}, { ...RESERVATION_WAIT, description: "Rx's circuit-relay reservation appears" });
			expect(circuitAddr).toBe(rxCircuitAddr);

			// Converge Rx on S's membership via replication through L — with NO local
			// `Rx.authorizePeer(...)`. The production wake gate passes on a SIBLING-written row.
			await waitForCadrePeerConverged(Rx.getControlDatabase()!, sPeerId, {
				timeoutMs: 30_000,
				description: "Rx observes S's CadrePeer membership row written on L",
			});
			expect(await Rx.isMember(sPeerId)).toBe(true);

			// Active strand: the wake is the "already live → accepted" branch, so the
			// assertion is about the relayed delivery (dial over the limited circuit
			// connection + handler dispatch + multi-chunk framing + membership gate +
			// ack round-trip), NOT the networked strand resume (see header note).
			const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '0.1.0');
			const strand = await Rx.addStrand({
				strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' },
				sAppConfig: sApp,
				mode: 'bootstrap',
			});
			expect(strand.status).toBe('active');

			// The relayed wake dial — the path the in-memory tests cannot prove. It
			// fails entirely without the `runOnLimitedConnection` fix this ticket made.
			const ack: WakeAck = await S.pushWake(rxPeerId, strandId, 'nat wake');
			expect(ack).toEqual({ accepted: true, status: 'active' });
			expect(Rx.getStrand(strandId)?.status).toBe('active');
		} finally {
			await Rx?.stop();
			await S?.stop();
			await L?.stop();
		}
	}, 90_000);

	// ── 3. Non-member sender is rejected (no side effect) ─────────────────────

	it('rejects a wake from a non-member and leaves the strand hibernating', async () => {
		let Rx: CadreNode | undefined;
		let O: CadreNode | undefined;
		try {
			const partyId = `pushwake-nonmember-${Date.now()}`;
			const strandId = `strand-nonmember-${Date.now()}`;

			// Receiver Rx: hibernating. Its control DB recognizes NO members, so any
			// sender is a non-member. (No authority needed — it authorizes no one.)
			const rxKey = await generateKeyPair('Ed25519');
			Rx = new CadreNode(nodeConfig({ partyId, privateKey: rxKey, hibernation: true }));
			await Rx.start();
			const rxPeerId = Rx.peerId!.toString();

			// Outsider O: its own authority so it can seed Rx's record and thus RESOLVE
			// + dial Rx (the default trust policy trusts any peer with a row) — but Rx
			// never authorized O, so the receiver rejects on `isMember(O) === false`.
			const oKey = await generateKeyPair('Ed25519');
			O = new CadreNode(nodeConfig({ partyId, privateKey: oKey }));
			await O.start();
			await makeOwnAuthority(O, oKey);
			const oPeerId = O.peerId!.toString();

			const rxAddrs = controlAddrs(Rx);
			await seedReceiverRecord(O, rxPeerId, rxKey, rxAddrs);
			expect((await O.resolvePeerAddrs(rxPeerId)).length).toBeGreaterThan(0);
			expect(await Rx.isMember(oPeerId)).toBe(false);

			await bringUpHibernatingStrand(Rx, strandId);

			const ack: WakeAck = await O.pushWake(rxPeerId, strandId, 'unauthorized wake');
			expect(ack.accepted).toBe(false);
			// No side effect: the strand is still hibernating (receiver rejected before wake).
			expect(Rx.getStrand(strandId)?.status).toBe('hibernating');
		} finally {
			await O?.stop();
			await Rx?.stop();
		}
	}, 60_000);

	// ── 4. Replication-backed authorization: membership written only on an authority ──
	//
	// The production path: a single party authority writes the membership facts ONCE,
	// they replicate over the live control network, and the consulting node reads a
	// SIBLING-written row — no local seeding on the node that gates on it. This proves
	// the `isMember` (receiver) and `resolvePeerAddrs` (sender) gates pass via
	// convergence, which scenarios 1 & 3 sidestep by seeding locally.
	//
	// Three design choices keep this deterministic against the network-backed control DB
	// (the same store the proven two-node convergence test exercises):
	//
	// 1. ONE WRITER, PURE READERS. The shared `CadreControl` store is optimistically
	//    concurrent — two cadre nodes committing to the same CadrePeer tree block at once
	//    collide (`stale revision` / stream reset), and the transactor does not retry. The
	//    two-node convergence test is clean because ONE node writes and the other only
	//    reads. So here the authority A is the SOLE writer the test depends on: it writes
	//    S's membership (`authorizePeer`) AND vouches Rx's full self-signed address record
	//    (`seedReceiverRecord` → one authority-signed insert carrying Rx's own `Sig`). S
	//    and Rx never write a row the assertions hinge on; they pull A's rows on read.
	//    (Rx's own background `registerSelf` is best-effort and non-fatal — it can only
	//    self-UPDATE its already-resolvable row, never a row the test waits on.)
	//
	// 2. FULL MESH. All three nodes are directly connected (each link both-sides
	//    confirmed). The control collection's cluster for a membership block spans the
	//    cohort, and a 3-member commit needs the cluster members to reach EACH OTHER — a
	//    star (only S→A, Rx→A) leaves S↔Rx unlinked and resets streams it cannot route.
	//    This is the ticket's "ensure all three are connected" precondition.
	//
	// 3. EPHEMERAL NON-AUTHORITY IDENTITIES. Authority A and sender S use EPHEMERAL libp2p
	//    identities (no `privateKey`), so they never self-publish a `CadrePeer` address
	//    row (`registerSelf` skips without an identity key — cadre-node.ts:600-604).
	//    The woken strand's `networked` resume no longer seeds from CadrePeer addrs at all:
	//    `resolveCohortSeed` resolves strand-network addresses on demand via the
	//    `/sereus/strand-addr/1.0.0` RPC over CONNECTED siblings (the
	//    `strand-seed-from-strand-addr-rpc` change that closed the old
	//    `control-network-cohort-discovery` gap — a control addr can no longer be wrongly
	//    recruited into the strand cluster). Here neither A nor S runs the strand, so each
	//    answers the RPC with [] and Rx's resume stands up networked-SOLO exactly as
	//    scenario 1 does, isolating THIS test to replication-backed authorization. A is also
	//    NOT a relay here: with three nodes a relay invites unstable S↔Rx circuit links;
	//    direct WebSocket dials keep the cohort stable. (Only Rx needs a stable key — to
	//    bind the self-signature in the address record A vouches for it.)
	it('wakes a member whose authorization and address were learned by control-DB replication, not local seeding', async () => {
		let A: CadreNode | undefined;  // sole party authority + storage (holds the CadrePeer blocks)
		let S: CadreNode | undefined;  // sender — NOT an authority; learns Rx's address by replication
		let Rx: CadreNode | undefined; // hibernating receiver — NOT an authority; learns S's membership by replication
		try {
			const partyId = `pushwake-repl-${Date.now()}`;
			const strandId = `strand-repl-${Date.now()}`;

			// Authority A: the single genesis authority + sole control-DB writer. Storage
			// profile so it holds the CadrePeer blocks the readers pull. Its authority keypair
			// is enrolled explicitly (independent of the node's ephemeral identity). Genesis
			// BEFORE forming a cohort so its lone AuthorityKey commits without a shared-authority
			// collision. NOT a relay (see the design note) — direct dials keep the cohort stable.
			const aKey = await generateKeyPair('Ed25519');
			A = new CadreNode(nodeConfig({ partyId, profile: 'storage' }));
			await A.start();
			await makeOwnAuthority(A, aKey);

			// Sender S and receiver Rx are plain members — NEITHER is its own authority, so
			// neither can self-insert any control row. Every membership fact they consult must
			// have been written by A and pulled over the wire. S's session peerId is stable.
			S = new CadreNode(nodeConfig({ partyId }));
			await S.start();
			const sPeerId = S.peerId!.toString();

			const rxKey = await generateKeyPair('Ed25519');
			Rx = new CadreNode(nodeConfig({ partyId, privateKey: rxKey, hibernation: true }));
			await Rx.start();
			const rxPeerId = Rx.peerId!.toString();

			// CONNECT BEFORE WRITE, FULL MESH: seat A, S and Rx in one control cohort (each
			// link both-sides confirmed) so A's writes commit cohort-wide, not local-only — the
			// convergence precondition. The mesh is deliberate: the control collection's cluster
			// for a membership block spans all three, and a 3-member commit needs the cluster
			// members to reach EACH OTHER. A star (only S→A, Rx→A) leaves S↔Rx unlinked, so such
			// a commit resets streams it cannot route — the "ensure all three are connected" note.
			await connectControlNodes(S, A);
			await connectControlNodes(Rx, A);
			await connectControlNodes(Rx, S);

			// A — and ONLY A — writes the membership facts the assertions hinge on:
			//   • S's membership row (`authorizePeer`), so Rx's wake gate `isMember(S)` passes.
			//   • Rx's full self-signed address record (`seedReceiverRecord` — one authority
			//     insert carrying Rx's own `Sig`), so S's `resolvePeerAddrs(Rx)` passes.
			// Nothing is seeded on the consulting node itself (no `Rx.authorizePeer`, no
			// `seedReceiverRecord(S, ...)`): each consulting node reads a SIBLING-written row.
			await A.authorizePeer(sPeerId);
			await seedReceiverRecord(A, rxPeerId, rxKey, controlAddrs(Rx));

			// Converge the RECEIVER on S's membership (pull-on-read), then assert the production
			// gate passes via REPLICATION — with NO local `Rx.authorizePeer(...)` anywhere above.
			await waitForCadrePeerConverged(Rx.getControlDatabase()!, sPeerId, {
				timeoutMs: 30_000,
				description: "Rx observes S's CadrePeer membership row written on A",
			});
			expect((await Rx.getControlDatabase()!.queryCadrePeers()).some((p) => p.peerId === sPeerId)).toBe(true);
			expect(await Rx.isMember(sPeerId)).toBe(true);

			// Negative, preserved in the replicated topology: a peer A never authorized never
			// converges anywhere — replication is selective, not "trust everyone once connected".
			const strangerPeerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
			expect(await Rx.isMember(strangerPeerId)).toBe(false);

			// Converge the SENDER on Rx's sibling-written, resolvable record. Poll the real
			// resolve path (binding + self-sig + freshness + trust gates), not just row presence.
			await waitForCrossNodeControlSync(
				S.getControlDatabase()!,
				async () => (await S!.resolvePeerAddrs(rxPeerId)).length > 0,
				{ timeoutMs: 30_000, description: "S resolves Rx's address record via replication" },
			);
			expect((await S.resolvePeerAddrs(rxPeerId)).length).toBeGreaterThan(0);

			await bringUpHibernatingStrand(Rx, strandId);

			// The real wake: pushWake → resolvePeerAddrs (replicated record) → dialWake, and the
			// receiver's `isMember` gate passes on the REPLICATED membership row. Strand wakes.
			const ack: WakeAck = await S.pushWake(rxPeerId, strandId, 'replication-backed wake');
			expect(ack).toEqual({ accepted: true, status: 'active' });
			expect(Rx.getStrand(strandId)?.status).toBe('active');
		} finally {
			await Rx?.stop();
			await S?.stop();
			await A?.stop();
		}
	}, 90_000);
});
