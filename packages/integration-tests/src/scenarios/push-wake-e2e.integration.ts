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
 *   3. Unanchored sender — receiver rejects the wake AND the strand-addr RPC even
 *      though the sender HAS a CadrePeer row (the self-minted-owner attack).
 *   4. Replication-backed authorization — membership written ONLY on an owner
 *      node converges to the sender and receiver over the live control network, so
 *      the wake passes the `isAuthorizedMember` / `resolvePeerAddrs` gates via
 *      REPLICATION, with no local seeding on the node that consults them.
 *
 * ── Authorized membership: rows replicate, TRUST does not ──
 *
 * The wake and strand-addr gates consult `isAuthorizedMember`: the sender's
 * `CadrePeer` row must carry a voucher (`VouchOwner`/`VouchSig`) that verifies
 * against an owner key in the receiver's NODE-LOCAL trusted-owner anchor
 * (`trustOwnerKeys` — established out of band by enrollment, never from the
 * replicated `OwnerKey` table, which any stranger can genesis-pollute). So every
 * accepted-wake scenario pins the vouching owner's key on the receiver as part of
 * its enrollment setup; scenario 3 proves the rejection when that pin is absent.
 * Address resolution (`resolvePeerAddrs`) and push fan-out stay on the ADDRESSABLE
 * surface (`isMember` — row presence) by design: dialability is not trust.
 *
 * ── Control-DB replication & the single shared owner (READ THIS) ──
 *
 * The wake gate (`isAuthorizedMember`, read on the RECEIVER) and the sender's address
 * resolve (`resolvePeerAddrs`, read on the SENDER) both consult a node's LOCAL control DB.
 * Network-backing the control DB has LANDED (`control-db-network-backed`): the
 * `CadreControl` tables are a party-shared, replicated Optimystic store, so a fact
 * written on one cadre node converges to a connected peer by pull-on-read (proven by
 * `control-db-two-node-convergence.integration.ts`).
 *
 * A direct consequence: two nodes in one party can no longer each self-appoint as
 * genesis owner — the second `OwnerKey` insert fails the `Authorized`
 * bootstrap CHECK once the first has replicated. So scenarios 1, 2 and 4 each elect
 * ONE owner and make the other nodes plain members; that owner writes the
 * membership facts and they converge to whoever gates on them:
 *   - Scenario 1 (direct): the SENDER S is the sole owner + storage. It writes its
 *     OWN membership (Rx's `isMember(S)` converges) and Rx's address record (S resolves
 *     its own write locally). Direct dial, a 2-node {S, Rx} cohort.
 *   - Scenario 2 (NAT/relay): the RELAY L is the sole owner + storage. It writes
 *     S's membership (Rx converges) and Rx's circuit address record (S converges).
 *     Every write is a 2-node {L, S} commit; Rx joins LAST and only reads.
 *   - Scenario 4 (replication-backed): a DEDICATED owner A — neither sender nor
 *     receiver — writes both facts; S and Rx each read a SIBLING-written row. The
 *     deepest replication proof (full mesh, A the only writer).
 *
 * Scenario 3 is the lone exception: its outsider O is its own owner but never
 * forms a cohort (genesis local-only; the attack state is written directly into
 * Rx's DB — see the scenario comment), so the rejection stays a pure local gate:
 * O's row is PRESENT on Rx, but its voucher's owner key is not in Rx's anchor.
 * Every byte of the real dial/handle/framing/resolve path is exercised in all four.
 *
 * Scenario 2 — NAT receiver listen address: with
 * `@libp2p/circuit-relay-v2@4.x`, a *discovered* relay reservation is skipped
 * unless a `/p2p-circuit` listen address has populated the pending-reservation
 * queue (reservation-store.ts `HadEnoughRelaysError` guard). A control node cannot
 * name the relay directly in `listenAddrs` (the CONFIGURED shape) — libp2p would
 * dial it from inside `listen()`, before control-database bring-up accepts any
 * connection (`relay-addrs.ts` → `rejectConfiguredCircuitListenAddrs`). So the
 * NAT'd receiver instead names the relay in `network.relayAddrs` with
 * `listenAddrs: []`: `CadreNode.start()` resolves that to the bare SEARCH listen
 * addr and explicitly drives the reservation once bring-up finishes — it still has
 * no direct dialable address (genuinely NAT'd), and the reservation is
 * deterministic rather than discovery-timing dependent.
 *
 * Scenario 2 — NAT receiver is NOT hibernated, by design. Scenario 2's unique
 * subject is the SENDER reaching a NAT'd peer: the signaling-first resolve and the
 * relayed dial over a libp2p "limited" (circuit) connection. (That dial used to
 * fail outright with `LimitedConnectionError`, until `strand-wake-protocol.ts`
 * started passing `runOnLimitedConnection` on the wake dial.) The full
 * hibernating→`active` resume is already proven on the direct path (scenario 1)
 * and is the SAME receiver code regardless of transport. Driving a *hibernating*
 * NAT receiver to `active` additionally requires the woken strand's `networked`
 * resume to form its cluster — but over the relay mesh the strand cluster tries to
 * recruit the relay/server peers (which speak the control-network protocol, not
 * the strand-repo protocol) and fails super-majority. That is the known
 * "strand-cohort discovery over the control network is TODO" gap, not a wake-
 * transport defect, so scenario 2 wakes an already-active strand (the "already
 * live → accepted" branch) to keep the assertion about the relay transport, not
 * the strand cluster. The follow-up is tracked in
 * `tickets/backlog/strand-network-nat-relay-reachability.md` (§1, per-strand NAT
 * reachability).
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';
import {
	CadreNode,
	SeedBootstrapService,
	collectStrandAddrs,
	ed25519KeyPairFromLibp2p,
	signPeerRecord,
	ed25519PublicKeyB64FromPeerId,
} from '@serfab/cadre-core';
import type { WakeAck, PeerAddressRecord } from '@serfab/cadre-core';
import {
	waitForCadrePeerConverged,
	waitForCrossNodeControlSync,
	createSignedSAppConfig,
	controlNodeConfig,
	makeOwnOwner,
	connectControlNodes,
	controlAddrs,
} from '../harness/index.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal hibernation-friendly sApp schema. */
const SIMPLE_SCHEMA = `
table Data (
    Key text primary key,
    Val text
);
`;

/**
 * Owner-signed INSERT of the receiver's own self-signed `CadrePeer` record
 * into `ownerNode`'s control DB, exactly as the receiver would self-publish —
 * so `ownerNode.resolvePeerAddrs(rxPeerId)` passes its binding + self-sig +
 * freshness gates and dials the supplied addrs (signaling/relay first).
 *
 * This reaches `SeedBootstrapService` DIRECTLY, below every `CadreNode`
 * membership wrapper, and needs NO follow-up gate refresh: the write notifies
 * the control DB's membership hub, which re-materializes the owner's
 * per-stream control-DB gate snapshot before this call resolves. That this
 * scenario passes with no explicit refresh is the end-to-end proof of the
 * automatic path. Were the owner left judging against a snapshot predating this
 * row it would DENY the very receiver it just vouched for until the next timed
 * cohort reconcile ~15s later — not cosmetic: it kills the receiver's own
 * control-DB schema load when the receiver starts inside the window (scenario
 * 2), and costs scenario 4 a burst of denied `db-p2p/sync` pulls that stretch a
 * ~3s run to ~17s.
 */
async function seedReceiverRecord(
	ownerNode: CadreNode,
	rxPeerId: string,
	rxKey: PrivateKey,
	rxAddrs: string[],
): Promise<PeerAddressRecord> {
	const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(rxKey);
	// The binding gate `resolvePeerAddrs` enforces: the record's publicKey MUST be
	// the ed25519 key embedded in the peerId (both derived from rxKey here).
	expect(publicKeyB64).toBe(ed25519PublicKeyB64FromPeerId(rxPeerId));
	const record = signPeerRecord(
		{ peerId: rxPeerId, publicKey: publicKeyB64, addrs: rxAddrs, updatedAt: Date.now() },
		privateKeyB64,
	);
	await ownerNode.getSeedBootstrapService()!.insertSelfPeerRecord(record);
	return record;
}

/**
 * Stand up a strand on the receiver and drive it to `hibernating`. The strand
 * stands up solo (the wake travels the control network, not the strand
 * network). Asserts `active` then `hibernating` so a silent hibernate no-op
 * (e.g. a realtime latency hint) fails loudly.
 */
async function bringUpHibernatingStrand(Rx: CadreNode, strandId: string): Promise<void> {
	const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '0.1.0');
	const strand = await Rx.addStrand({
		strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' },
		sAppConfig: sApp,
	});
	expect(strand.status).toBe('active');

	await Rx.hibernateStrand(strandId);
	expect(Rx.getStrand(strandId)?.status).toBe('hibernating');
}

// ═════════════════════════════════════════════════════════════════════════════

describe('E2E push-wake over the control network', () => {
	// ── 1. Happy path: direct dial of a hibernating member ────────────────────

	it('wakes a hibernating member over a real direct control dial', async () => {
		let S: CadreNode | undefined;
		let Rx: CadreNode | undefined;
		try {
			const partyId = `pushwake-direct-${Date.now()}`;
			const strandId = `strand-direct-${Date.now()}`;

			// SINGLE SHARED OWNER (see file header): S is the party's SOLE owner +
			// storage hub AND the sender; Rx is a plain member that never genesis. S's
			// owner key is enrolled explicitly (independent of its EPHEMERAL node
			// identity — so S never self-publishes an addr-bearing CadrePeer row that would
			// pollute Rx's strand-resume cohort seed, exactly as scenario 4). Genesis ALONE
			// before forming a cohort so the lone OwnerKey commits with no collision.
			const sKey = await generateKeyPair('Ed25519');
			S = new CadreNode(controlNodeConfig({ partyId, profile: 'storage' }));
			await S.start();
			const sOwnerPub = await makeOwnOwner(S, sKey);
			const sPeerId = S.peerId!.toString();

			// Receiver Rx: hibernating plain member — NOT its own owner, so every
			// membership fact it consults must have been written by S and pulled over the wire.
			const rxKey = await generateKeyPair('Ed25519');
			Rx = new CadreNode(controlNodeConfig({ partyId, privateKey: rxKey, hibernation: true }));
			await Rx.start();
			const rxPeerId = Rx.peerId!.toString();

			// ENROLLMENT: Rx was enrolled by S's owner, so it pins that owner key into
			// its node-local trusted-owner anchor (as redeeming a real CadreInvite does).
			// The wake gate is `isAuthorizedMember`: a replicated row alone is NOT
			// membership — its voucher must verify against this anchor.
			await Rx.trustOwnerKeys([sOwnerPub], 'invite');

			// CONNECT BEFORE WRITE: a direct 2-node cohort {S, Rx} (both-sides confirmed),
			// neither NAT'd, so S's writes below commit cohort-wide rather than local-only.
			await connectControlNodes(Rx, S);

			// S — and ONLY S — writes both membership facts as clean {S, Rx} 2-node commits:
			//   • S's own membership row (`authorizePeer`), so Rx's wake gate `isAuthorizedMember(S)` passes.
			//   • Rx's self-signed address record (`seedReceiverRecord`, real direct addr), so
			//     S's `resolvePeerAddrs(Rx)` passes. S reads its OWN write locally; Rx pulls.
			const rxAddrs = controlAddrs(Rx);
			expect(rxAddrs.length).toBeGreaterThan(0);
			await S.authorizePeer(sPeerId);
			await seedReceiverRecord(S, rxPeerId, rxKey, rxAddrs);
			expect((await S.resolvePeerAddrs(rxPeerId)).length).toBeGreaterThan(0);

			// Rx's wake gate recognizes S as a member via REPLICATION — no local seeding.
			// The row converges (addressable), and its voucher — S's owner key, pinned in
			// Rx's anchor above — passes the trust-facing gate the wake actually consults.
			await waitForCadrePeerConverged(Rx.getControlDatabase()!, sPeerId, {
				timeoutMs: 30_000,
				description: "Rx observes S's CadrePeer membership row written on S",
			});
			expect(await Rx.isMember(sPeerId)).toBe(true);
			expect(await Rx.isAuthorizedMember(sPeerId)).toBe(true);

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
	// SINGLE SHARED OWNER (see file header). The network-backed `CadreControl`
	// store is party-shared, so two nodes can no longer each self-genesis — the
	// in-memory-era "every node is its own owner" recipe collides on `Authorized`.
	// The relay L is therefore the party's SOLE owner + storage hub (legitimate:
	// it is already dedicated transport infra, mirroring scenario 4's owner+storage
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

			// Relay L: dedicated transport infra AND the party's SOLE owner + storage
			// hub. Genesis ALONE (cohort {L}, before S/Rx connect) so its lone OwnerKey
			// commits with no shared-owner collision. Storage profile so it holds the
			// CadrePeer blocks the readers pull.
			const lKey = await generateKeyPair('Ed25519');
			L = new CadreNode(controlNodeConfig({ partyId, profile: 'storage', enableRelay: true }));
			await L.start();
			const lOwnerPub = await makeOwnOwner(L, lKey);
			const lAddrs = controlAddrs(L);
			expect(lAddrs.length).toBeGreaterThan(0);
			const lAddr = lAddrs[0]!; // /ip4/127.0.0.1/tcp/<port>/ws/p2p/<L>

			// Server S: a plain MEMBER (never genesis) and the sender. Connecting it to L
			// makes the control cohort exactly {L, S} while the writes below commit, and
			// gives the later relayed wake dial an open connection to route through L.
			const sKey = await generateKeyPair('Ed25519');
			S = new CadreNode(controlNodeConfig({ partyId, privateKey: sKey }));
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
			//   • S's membership row (`authorizePeer`), so Rx's wake gate `isAuthorizedMember(S)` passes.
			//   • Rx's self-signed address record (`seedReceiverRecord` — one owner insert
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
			// L, named via `network.relayAddrs` (see header note) so `Rx.start()` reserves it
			// itself, after control-database bring-up, instead of the rejected CONFIGURED
			// `…/p2p-circuit` listen entry. It bootstraps to L; it never genesises and writes
			// nothing the assertions hinge on (its background `registerSelf` only self-UPDATEs
			// its own already-resolvable row). (NOT hibernated — see header note.)
			Rx = new CadreNode(controlNodeConfig({
				partyId,
				privateKey: rxKey,
				bootstrapNodes: [lAddr],
				listenAddrs: [],
				relayAddrs: [lAddr],
			}));
			await Rx.start();
			expect(Rx.peerId!.toString()).toBe(rxPeerId);

			// `Rx.start()` throws (`RelayReservationFailedError`) unless the circuit
			// reservation lands before it returns, so by this point Rx already holds the
			// slot — confirm it, and that Rx published NO direct address alongside it: the
			// receiver this scenario claims to test is reachable ONLY via the relay.
			const startAddrs = controlAddrs(Rx);
			expect(startAddrs.length).toBeGreaterThan(0);
			expect(startAddrs.every((a) => a.includes('/p2p-circuit'))).toBe(true);

			// ENROLLMENT: Rx was enrolled by L's owner — pin the owner key into Rx's
			// node-local anchor so S's replicated row (vouched by L) passes Rx's
			// `isAuthorizedMember` wake gate.
			await Rx.trustOwnerKeys([lOwnerPub], 'invite');

			// The reservation confirmed right after `Rx.start()` above is the exact slot L
			// vouched for in Rx's address record (the constructed addr was correct) — no
			// extra wait needed, since `start()` already blocked until it landed.
			const circuitAddr = startAddrs.find((a) => a.includes('/p2p-circuit')) ?? '';
			expect(circuitAddr).toBe(rxCircuitAddr);

			// Converge Rx on S's membership via replication through L — with NO local
			// `Rx.authorizePeer(...)`. The production wake gate passes on a SIBLING-written
			// row because its voucher (L's owner key) is pinned in Rx's anchor.
			await waitForCadrePeerConverged(Rx.getControlDatabase()!, sPeerId, {
				timeoutMs: 30_000,
				description: "Rx observes S's CadrePeer membership row written on L",
			});
			expect(await Rx.isMember(sPeerId)).toBe(true);
			expect(await Rx.isAuthorizedMember(sPeerId)).toBe(true);

			// Active strand: the wake is the "already live → accepted" branch, so the
			// assertion is about the relayed delivery (dial over the limited circuit
			// connection + handler dispatch + multi-chunk framing + membership gate +
			// ack round-trip), NOT the networked strand resume (see header note).
			const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '0.1.0');
			const strand = await Rx.addStrand({
				strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' },
				sAppConfig: sApp,
			});
			expect(strand.status).toBe('active');

			// The relayed wake dial — the path the in-memory tests cannot prove. It
			// fails entirely unless the wake dial passes `runOnLimitedConnection`.
			const ack: WakeAck = await S.pushWake(rxPeerId, strandId, 'nat wake');
			expect(ack).toEqual({ accepted: true, status: 'active' });
			expect(Rx.getStrand(strandId)?.status).toBe('active');
		} finally {
			await Rx?.stop();
			await S?.stop();
			await L?.stop();
		}
	}, 90_000);

	// ── 3. Unanchored sender is rejected — even WITH a CadrePeer address row ──
	//
	// THE hole this predicate closes: before it, "is this peer a member?" meant
	// "does a CadrePeer row exist" — and any outsider can make that true, because
	// the replicated `OwnerKey` table admits any FIRST key (genesis bootstrap) and
	// a self-minted owner can then self-vouch its own membership row. This scenario
	// reproduces exactly that post-attack state in Rx's control DB, then proves the
	// wake AND strand-addr gates both reject O because O's self-minted owner key is
	// not in Rx's NODE-LOCAL trusted-owner anchor.
	//
	// The polluted state is written directly into Rx's DB (a throwaway
	// SeedBootstrapService holding O's owner key — byte-identical rows to what live
	// replication of O's genesis writes would converge). Local writes rather than a
	// live {O, Rx} commit because two-node cohort commits are currently rejected
	// upstream (`membership-not-admitted:low-confidence-downsize`, tracked in
	// blocked/control-db-convergence-optimystic-p2p); scenario 4's 3-node cohort
	// proves the wire path. Rx stays connection-free while polluted, so the writes
	// commit local-only.
	it('rejects a wake and strand-addr from a peer whose membership row exists but whose voucher owner is unanchored', async () => {
		let Rx: CadreNode | undefined;
		let O: CadreNode | undefined;
		try {
			const partyId = `pushwake-nonmember-${Date.now()}`;
			const strandId = `strand-nonmember-${Date.now()}`;

			// Receiver Rx: hibernating, empty node-local anchor — it was never enrolled
			// by anyone, so NO owner key is trusted and nobody can be authorized.
			const rxKey = await generateKeyPair('Ed25519');
			Rx = new CadreNode(controlNodeConfig({ partyId, privateKey: rxKey, hibernation: true }));
			await Rx.start();
			const rxPeerId = Rx.peerId!.toString();

			// Outsider O: its own owner so it can seed Rx's record and thus RESOLVE
			// + dial Rx (the default trust policy trusts any peer with a row).
			const oKey = await generateKeyPair('Ed25519');
			const { privateKeyB64: oOwnerPriv, publicKeyB64: oOwnerPub } = ed25519KeyPairFromLibp2p(oKey);
			O = new CadreNode(controlNodeConfig({ partyId, privateKey: oKey }));
			await O.start();
			await makeOwnOwner(O, oKey);
			const oPeerId = O.peerId!.toString();

			const rxAddrs = controlAddrs(Rx);
			await seedReceiverRecord(O, rxPeerId, rxKey, rxAddrs);
			expect((await O.resolvePeerAddrs(rxPeerId)).length).toBeGreaterThan(0);

			// THE ATTACK, as it would land in Rx's REPLICATED control state: O's
			// self-minted owner key enters Rx's `OwnerKey` table (the genesis bootstrap
			// CHECK admits any first key — that is why the replicated table cannot anchor
			// trust), and O's self-vouched CadrePeer row follows, satisfying every
			// replicated-schema constraint. Nothing here touches Rx's node-local anchor.
			await Rx.getControlDatabase()!.insertOwnerKey(oOwnerPub);
			const pollution = new SeedBootstrapService({ partyId, ownerPrivateKey: oOwnerPriv, ownerPublicKey: oOwnerPub });
			pollution.initialize(Rx.getControlNode()!, Rx.getControlDatabase()!, { registerHandler: false });
			await pollution.authorizePeer({ peerId: oPeerId, multiaddrs: controlAddrs(O) });

			// The hole, made visible: O IS addressable on Rx (row present) — and still
			// NOT authorized, because its voucher's owner key is not in Rx's anchor.
			expect(await Rx.isMember(oPeerId)).toBe(true);
			expect(await Rx.isAuthorizedMember(oPeerId)).toBe(false);

			await bringUpHibernatingStrand(Rx, strandId);

			// Wake gate: rejected despite the membership row; the sleeping node cannot
			// be woken by an outsider that merely published rows.
			const ack: WakeAck = await O.pushWake(rxPeerId, strandId, 'unauthorized wake');
			expect(ack.accepted).toBe(false);
			// No side effect: the strand is still hibernating (receiver rejected before wake).
			expect(Rx.getStrand(strandId)?.status).toBe('hibernating');

			// Strand-addr gate mirrors the wake gate. Wake the strand LOCALLY so Rx has
			// live strand multiaddrs to protect, then let O ask for them over the real
			// STRAND_ADDR_PROTOCOL dial: refused (empty) while unanchored.
			await Rx.wakeStrand(strandId);
			expect(Rx.getStrand(strandId)?.status).toBe('active');
			const rxDialTargets = [{ peerId: rxPeerId, addrs: rxAddrs.map((a) => multiaddr(a)) }];
			const refused = await collectStrandAddrs(O.getControlNode()!, rxDialTargets, strandId);
			expect(refused).toEqual([]);

			// POSITIVE CONTROL — same replicated state, one anchor pin: once Rx's
			// operator pins O's owner key, the identical rows flip to authorized and the
			// same strand-addr dial returns live addrs. Proves the empty response above
			// was the membership refusal (not a transport failure or a strand with no
			// addrs), and that the predicate is driven by the anchor alone.
			await Rx.trustOwnerKeys([oOwnerPub], 'operator');
			expect(await Rx.isAuthorizedMember(oPeerId)).toBe(true);
			const granted = await collectStrandAddrs(O.getControlNode()!, rxDialTargets, strandId);
			expect(granted.length).toBeGreaterThan(0);
		} finally {
			await O?.stop();
			await Rx?.stop();
		}
	}, 60_000);

	// ── 4. Replication-backed authorization: membership written only on an owner ──
	//
	// The production path: a single party owner writes the membership facts ONCE,
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
	//    reads. So here the owner A is the SOLE writer the test depends on: it writes
	//    S's membership (`authorizePeer`) AND vouches Rx's full self-signed address record
	//    (`seedReceiverRecord` → one owner-signed insert carrying Rx's own `Sig`). S
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
	// 3. OWNER A IS CONFIGURED CONTROL INFRASTRUCTURE ON S AND Rx. Both plain members
	//    carry A's control multiaddr in `bootstrapNodes`, which is what makes A
	//    unconditionally admitted by their fail-closed per-stream control-DB gate
	//    (`CadreNode.authorizeInboundControlStream` → `admitControlPeerUnconditionally`
	//    → `getBootstrapPeerIds`). Without it this scenario races: the moment Rx
	//    converges S's authorized-member row its snapshot goes non-empty, and from then
	//    on every inbound control-DB stream from a peer NOT in that snapshot is denied —
	//    including A, whose EPHEMERAL identity (note 4) means its peer id is deliberately
	//    never a `CadrePeer` row anywhere. Ownership here is a KEY (`aOwnerPub`), not a
	//    peer id, so the gate has nothing to match A on. Unlike scenarios 1 and 2, A is
	//    both a dial TARGET and a DIALER into the other cluster members (the 3-node commit
	//    in note 2 routes between all three), so it needs an inbound admission path on
	//    them. Scenario 2 already treats relay L this way on Rx; this is the same
	//    already-shipped carve-out for the same reason — configured party infrastructure,
	//    not a cadre member.
	//
	// 4. EPHEMERAL NON-OWNER IDENTITIES. Owner A and sender S use EPHEMERAL libp2p
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
		let A: CadreNode | undefined;  // sole party owner + storage (holds the CadrePeer blocks)
		let S: CadreNode | undefined;  // sender — NOT an owner; learns Rx's address by replication
		let Rx: CadreNode | undefined; // hibernating receiver — NOT an owner; learns S's membership by replication
		try {
			const partyId = `pushwake-repl-${Date.now()}`;
			const strandId = `strand-repl-${Date.now()}`;

			// Owner A: the single genesis owner + sole control-DB writer. Storage
			// profile so it holds the CadrePeer blocks the readers pull. Its owner keypair
			// is enrolled explicitly (independent of the node's ephemeral identity). Genesis
			// BEFORE forming a cohort so its lone OwnerKey commits without a shared-owner
			// collision. NOT a relay (see the design note) — direct dials keep the cohort stable.
			const aKey = await generateKeyPair('Ed25519');
			A = new CadreNode(controlNodeConfig({ partyId, profile: 'storage' }));
			await A.start();
			const aOwnerPub = await makeOwnOwner(A, aKey);
			const aAddrs = controlAddrs(A);
			expect(aAddrs.length).toBeGreaterThan(0);
			const aAddr = aAddrs[0]!; // /ip4/127.0.0.1/tcp/<port>/ws/p2p/<A>

			// Sender S and receiver Rx are plain members — NEITHER is its own owner, so
			// neither can self-insert any control row. Every membership fact they consult must
			// have been written by A and pulled over the wire. S's session peerId is stable.
			// Both configure A as a control bootstrap node so the fail-closed per-stream gate
			// admits A unconditionally once their authorized-member snapshot goes non-empty —
			// A's ephemeral identity is in no `CadrePeer` row (design note 3).
			S = new CadreNode(controlNodeConfig({ partyId, bootstrapNodes: [aAddr] }));
			await S.start();
			const sPeerId = S.peerId!.toString();

			const rxKey = await generateKeyPair('Ed25519');
			Rx = new CadreNode(controlNodeConfig({ partyId, privateKey: rxKey, hibernation: true, bootstrapNodes: [aAddr] }));
			await Rx.start();
			const rxPeerId = Rx.peerId!.toString();

			// ENROLLMENT: S and Rx were enrolled by A's owner — each pins A's owner key
			// into its NODE-LOCAL trusted-owner anchor, exactly as redeeming a real
			// CadreInvite does (the invite carries `ownerKeys`; the enrollee pins them
			// before trusting any replicated fact). Replication delivers the ROWS below;
			// this pin is what lets their vouchers pass the trust-facing predicate —
			// without it, Rx's wake gate `isAuthorizedMember(S)` stays false no matter
			// what converges.
			await S.trustOwnerKeys([aOwnerPub], 'invite');
			await Rx.trustOwnerKeys([aOwnerPub], 'invite');

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
			//   • S's membership row (`authorizePeer`), so Rx's wake gate `isAuthorizedMember(S)` passes.
			//   • Rx's full self-signed address record (`seedReceiverRecord` — one owner
			//     insert carrying Rx's own `Sig`), so S's `resolvePeerAddrs(Rx)` passes.
			// Nothing is seeded on the consulting node itself (no `Rx.authorizePeer`, no
			// `seedReceiverRecord(S, ...)`): each consulting node reads a SIBLING-written row.
			// NOTE: `seedReceiverRecord` reaches A's SeedBootstrapService DIRECTLY, below every
			// `CadreNode` membership wrapper, and relies on the control DB's membership hub to
			// re-materialize A's per-stream gate snapshot — otherwise that snapshot stays {S}
			// (set by the `authorizePeer` above) until the 15s cohort-reconcile refresh, and for
			// that window A denies Rx's own `…/db-p2p/sync/1.0.0` pulls (bursts of
			// `authorizeInboundControlStream: DENYING` under `DEBUG='sereus:cadre:*'`, and
			// runs stretched from ~3s to ~17s). Do NOT instead swap the two writes so
			// `authorizePeer` runs last: that also clears the denials but measured WORSE
			// overall (2/6 vs 4/5 passes), because it perturbs commit ordering into the
			// separate control-DB stale-revision race. Leave the order as is.
			await A.authorizePeer(sPeerId);
			await seedReceiverRecord(A, rxPeerId, rxKey, controlAddrs(Rx));

			// Converge the RECEIVER on S's membership (pull-on-read), then assert the production
			// gate passes via REPLICATION — with NO local `Rx.authorizePeer(...)` anywhere above.
			await waitForCadrePeerConverged(Rx.getControlDatabase()!, sPeerId, {
				timeoutMs: 30_000,
				description: "Rx observes S's CadrePeer membership row written on A",
			});
			// The converged row carries A's voucher intact (owner + signature replicate
			// with the row — a legit member's row is never voucher-less), so the
			// trust-facing gate the wake consults passes off the SIBLING-written row.
			const sRow = (await Rx.getControlDatabase()!.queryCadrePeers()).find((p) => p.peerId === sPeerId);
			expect(sRow).toBeDefined();
			expect(sRow!.vouchOwner).toBe(aOwnerPub);
			expect(sRow!.vouchSig).not.toBeNull();
			expect(await Rx.isMember(sPeerId)).toBe(true);
			expect(await Rx.isAuthorizedMember(sPeerId)).toBe(true);

			// Negative, preserved in the replicated topology: a peer A never authorized never
			// converges anywhere — replication is selective, not "trust everyone once connected".
			const strangerPeerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
			expect(await Rx.isMember(strangerPeerId)).toBe(false);
			expect(await Rx.isAuthorizedMember(strangerPeerId)).toBe(false);

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
