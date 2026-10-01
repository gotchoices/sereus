/**
 * Blind-relay phone-to-phone E2E — the headline product case: two people who
 * each have ONLY a phone form a shared workspace through a neutral relay
 * server, with every byte relayed because neither phone can accept an incoming
 * connection.
 *
 * Topology: two DIFFERENT parties, each a single `CadreNode` with
 * `listenAddrs: []` (cannot listen) and `relayAddrs: [<relay>]`, each on a
 * DEDICATED relay (`harness/dedicated-relay.ts` — the loopback stand-in for the
 * `ops/docker/libp2p-infra` container). A relay is strictly a relay: no cadre
 * protocols, no membership gate, in no cohort, holding no data. This is the
 * cross-party sibling of `strand-circuit-same-party-e2e.integration.ts` (one
 * party's two machines over the same fixture) — here the two ends are
 * STRANGERS, so formation, not membership, is what carries the introduction.
 *
 * Flow under test (described for the shared-relay arms; the per-party arm is
 * the paragraph after this list):
 *
 *   1. Party A boots relay-only, founds a CLOSED strand, and publishes a BOUND
 *      invitation. The invitation's bootstrap addresses are A's control
 *      multiaddrs (`CadreNode.createOpenInvitation` fills them from
 *      `getMultiaddrs()`), which for a relay-only node are all `/p2p-circuit` —
 *      asserted through the encode → decode round trip that models the
 *      out-of-band QR/link delivery.
 *   2. Party B boots the same way, decodes the invitation, and runs
 *      `formStrand` — its control node dials A's circuit address through the
 *      relay. The formation protocol is stranger-open while an unexpired
 *      invitation is outstanding (`membership-connection-gater.ts` →
 *      `STRANGER_OPEN_PROTOCOLS`); this is its first exercise over a circuit.
 *      The formation handler does NOT set `runOnLimitedConnection`, so this
 *      works only because the dedicated relay runs `applyDefaultLimit: false`
 *      (ops-container parity) — asserted live via `connection.limits` being
 *      absent on every relayed connection, not assumed from the fixture.
 *   3. The formation result carries A's strand-network circuit address
 *      (`formation-carries-strand-addrs`) plus the closed strand's membership
 *      secret. B adds the strand; its strand node — holding its own reservation
 *      on the same relay — dials A's strand node through the relay from the
 *      carried seed alone. No hand-dial anywhere in this file.
 *   4. B's join FINISHES on its own: within seconds of the strand becoming
 *      writable, B's membership reconciler has redeemed the staged invitation
 *      (its `Strand.Member` seat) and written its own `Strand.MemberPeer`
 *      binding. This is the only end-to-end gate on that timing at the DEFAULT
 *      cadence — nothing here shortens `revocationPollMs` — so a regression to
 *      "wait for the next poll tick" (30 s) fails here rather than passing
 *      slowly. See `strand-membership-reconciler.ts` for the ladder and
 *      `StrandInstanceManager.publishDatabase` for the kick that starts it.
 *   5. Rows written by A are read by B and vice versa — real strand data over
 *      the circuit in both directions, including B→A where B is a total
 *      stranger to A's party.
 *   6. Every A↔B connection — control and strand — is classified `relayed` by
 *      `summarizeConnectionPaths` (both ends), and a final sweep asserts
 *      neither side holds a direct connection to anything but the relay itself,
 *      so a direct fallback cannot pass for relayed success.
 *   7. The relay's reservation count is measured: 4 (two control + two strand)
 *      — the cross-party confirmation of the per-strand relay-slot cost first
 *      measured same-party: one slot per node per network, so every strand a
 *      NAT'd node joins costs one extra relay slot per node.
 *
 * The same journey runs THREE times, from one body. Twice on one shared relay: once on bare
 * loopback, and once with 10 ms of one-way per-frame delay on every dialed WebSocket
 * (`harness/ws-latency.ts`). That latency arm is the only place in the suite where relayed
 * bring-up meets a link that is not instant, so a change that made formation, seeding or
 * replication far more latency-sensitive fails here instead of shipping. It is NOT a
 * bandwidth or loss model — delay only. `WS_SEND_DELAY_MS` (docs/testing.md) pins the whole
 * process, so setting it runs all three tests in this file at that delay.
 *
 * The third run is the PER-PARTY arm, on loopback: A reserves on relay 1 and B on relay 2, the
 * shape two strangers who each configured their own relay actually have. Every address A
 * publishes names relay 1 and every address B publishes names relay 2, so B's formation dial
 * (and its strand node's seeded dial) goes THROUGH relay 1, where B holds no reservation — B
 * is only a client of that relay's hop — and A reaching B goes through relay 2. Formation is
 * asserted to have crossed: every connection B's control node holds to A's names relay 1 in its
 * remote address. The slot cost is measured per relay and every relay is checked at every
 * checkpoint, including once more after rows have crossed both ways: relay 1 holds 2 (A's
 * control and strand) and relay 2 holds 2 (B's), measured stable over three runs — no node
 * took a slot on a relay it was not configured with, although each dials through the other
 * party's relay. (libp2p's relay discovery can nominate the foreign relay once the dial through
 * it has recorded the hop protocol against it — `relay-reservation.ts` — but
 * `@libp2p/circuit-relay-v2`'s reservation store refuses a discovered relay while no pending
 * reservation is waiting, and each node's is already filled by its own relay.)
 * NOTE: a node that LOST its own reservation re-opens a pending slot that discovery could fill
 * from the foreign relay instead; this arm never loses one. If reservation loss is ever
 * scenarioed in the per-party shape, count reservations per relay there too.
 *
 * Delegate admission is a NON-PARTICIPANT here: no dedicated relay speaks
 * `/sereus/strand-addr/1.0.0` (asserted against each one's live protocol list), so the
 * delegate-announce half of `resolveCohortSeed` folds to a no-op — the RPC
 * fan-out folds the unsupported-protocol failure into an `unreachable` outcome
 * with no addrs (`collectStrandAddrs` → `dialOneSibling`) — and both `foundStrand`/`addStrand`
 * resolving is the proof nothing in the flow blocks on it.
 *
 * ── Out of scope, deliberately ──
 * Reservation loss under a running strand is characterized by the same-party
 * sibling and not repeated here. The per-party arm runs on loopback only: link
 * sensitivity does not depend on which relay each party uses.
 *
 * Lookup shape: App.Data reads scan and filter in JavaScript — a where-equality
 * on the primary key can MISS on a networked strand
 * (`debt-composite-pk-point-lookup-unreliable-untracked`).
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Libp2p } from 'libp2p';
import {
	CadreNode,
	generateStrandMemberKey,
	strandFretPeerAddrs,
	strandMemberKeyPair,
	summarizeConnectionPaths,
	STRAND_ADDR_PROTOCOL,
} from '@serfab/cadre-core';
import type { StrandRow } from '@serfab/cadre-core';
import type { Database } from '@quereus/quereus';
import {
	waitUntil,
	controlNodeConfig,
	createSignedSAppConfig,
	makeOwnOwner,
	controlAddrs,
	startDedicatedRelay,
	installWsLatency,
	type DedicatedRelay,
	type WsLatencyOptions,
} from '../harness/index.js';

/** Minimal one-table sApp schema (the shape several strand scenarios share). */
const SIMPLE_SCHEMA = `
table Data (
    Key text primary key,
    Val text
);
`;

const SAPP_ID = 'sapp-blind-relay';
const YEAR_MS = 365 * 24 * 3600_000;

/** Budget for every convergence gate. Circuit setup is slower than loopback —
 *  headroom, not an expectation. */
const GATE = { timeoutMs: 60_000, intervalMs: 250 } as const;

/** Budget for the joiner's membership rows, measured from the strand becoming writable.
 *  Deliberately BELOW the reconciler's 30 s production poll interval, which this scenario
 *  does not override: generous enough for a circuit, tight enough that "the join waits out
 *  a full interval" is a failure rather than a slow pass. */
const JOIN_FINISH_MS = 20_000;

/** One-way per-frame delay for the latency arm — see that arm's comment for why 10 ms. */
const LINK_LATENCY_MS = 10;

const isCircuit = (addr: string): boolean => addr.includes('/p2p-circuit');

/** Every App.Data row visible on one strand DB, via an unfiltered scan. */
async function readDataRows(db: Database): Promise<Map<string, string>> {
	const rows = new Map<string, string>();
	for await (const row of db.eval('select Key, Val from App.Data')) {
		rows.set(row.Key as string, row.Val as string);
	}
	return rows;
}

/**
 * Assert every connection `node` holds TO `peerId` is a relayed circuit path —
 * and UNLIMITED. The limits check is the live half of the fixture's
 * `applyDefaultLimit: false` parity contract with `ops/docker/libp2p-infra`: a
 * limited relayed connection would refuse db-p2p's database protocols (they do
 * not set `runOnLimitedConnection`), so an ops config regression is caught here
 * by name rather than as a mysterious replication timeout.
 */
function expectAllPathsRelayed(node: Libp2p, peerId: string, label: string): void {
	const summary = summarizeConnectionPaths(node.getConnections());
	const toPeer = summary.paths.filter((p) => p.peerId === peerId);
	expect(toPeer.length, `${label}: no connection to ${peerId}`).toBeGreaterThan(0);
	for (const path of toPeer) {
		expect(path.kind, `${label}: ${path.remoteAddr}`).toBe('relayed');
		expect(path.transport, `${label}: ${path.remoteAddr}`).toBe('circuit-relay');
	}
	for (const conn of node.getConnections().filter((c) => c.remotePeer.toString() === peerId)) {
		expect(conn.limits, `${label}: relayed connection to ${peerId} is flagged limited`).toBeUndefined();
	}
}

/**
 * Assert `node` holds NO direct connection to anyone but a configured relay —
 * the "a direct fallback cannot pass for relayed success" sweep. (A direct ws
 * connection to a relay is either the reservation keep-alive or, in the
 * per-party arm, the hop-client link to the OTHER party's relay; both expected.)
 */
function expectOnlyRelayDirect(node: Libp2p, relayPeerIds: ReadonlySet<string>, label: string): void {
	for (const path of summarizeConnectionPaths(node.getConnections()).paths) {
		if (!relayPeerIds.has(path.peerId)) {
			expect(path.kind, `${label}: non-relay peer ${path.peerId} via ${path.remoteAddr}`).toBe('relayed');
		}
	}
}

/**
 * Expected reservation counts, per relay. `reserved(relay, label)` records one
 * more slot on `relay` and then checks EVERY relay against its tally — checking
 * them all at each step is what catches a node taking a slot on a relay it was
 * never configured with. `check(label)` re-asserts without recording one.
 */
function reservationTally(relays: readonly DedicatedRelay[]) {
	const expected = new Map<DedicatedRelay, number>(relays.map((r) => [r, 0]));
	const check = (label: string): void => {
		for (const [relay, n] of expected) {
			expect(relay.reservationCount(), `${label}: reservations on relay ${relay.peerId}`).toBe(n);
		}
	};
	return {
		reserved(on: DedicatedRelay, label: string): void {
			expected.set(on, expected.get(on)! + 1);
			check(label);
		},
		check,
	};
}

// ═════════════════════════════════════════════════════════════════════════════

interface BlindRelayRunOptions {
	/** Holds every outbound WebSocket frame in the process this long — the slow-link arm. */
	latency?: WsLatencyOptions;
	/** `shared`: both parties reserve on one relay. `per-party`: each reserves on its own. */
	relays: 'shared' | 'per-party';
}

/**
 * The whole scenario, run once. `latency`, when given, holds every outbound WebSocket frame
 * in the process for that long before it leaves the dialing node (`harness/ws-latency.ts`),
 * which is what turns this loopback topology into a slow-link one. `relays` picks whether B
 * reserves on A's relay or on its own; every difference between those shapes follows from
 * `relayA` / `relayB`. Everything else — the gates, the assertions, the teardown — is
 * identical between the arms on purpose: an arm adds a condition, not a different test.
 */
async function runBlindRelayPhoneToPhone(opts: BlindRelayRunOptions): Promise<void> {
	// Before any node is constructed: the shim swaps the global WebSocket constructor, and a
	// node dials its relay during start().
	const link = opts.latency === undefined ? undefined : installWsLatency(opts.latency);
	let relayA: DedicatedRelay | undefined; // the relay A reserves on
	let relayB: DedicatedRelay | undefined; // the relay B reserves on — relayA itself when shared
	let A: CadreNode | undefined; // party A: founder/owner, one phone
	let B: CadreNode | undefined; // party B: joiner, one phone, a total stranger to A
	try {
		const runTag = Date.now();
		const strandId = `strand-blind-${runTag}`;
		const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '0.1.0');

		// ── The dedicated relay(s): ungated, no cadre protocols, no default limit ──
		relayA = await startDedicatedRelay();
		relayB = opts.relays === 'per-party' ? await startDedicatedRelay() : relayA;
		const relays = [...new Set([relayA, relayB])];
		const relayPeerIds: ReadonlySet<string> = new Set(relays.map((r) => r.peerId));
		const tally = reservationTally(relays);
		// Delegate admission is a non-participant: no relay speaks the
		// strand-addr protocol, so no delegate grant can exist and none is
		// needed — the announce fan-out folds to a no-op (see file header).
		for (const relay of relays) {
			expect(relay.node.getProtocols()).not.toContain(STRAND_ADDR_PROTOCOL);
		}

		// ── Party A: one phone — relay-only, no relay server of its own ─────
		// `relayAddrs` is fail-fast, so a resolved start() means the control
		// reservation landed. `enableRelay: false` because a phone relays for
		// nobody (the storage-profile default would switch it on).
		const aKey = await generateKeyPair('Ed25519');
		A = new CadreNode(controlNodeConfig({
			partyId: `blind-a-${runTag}`,
			privateKey: aKey,
			profile: 'storage',
			enableRelay: false,
			listenAddrs: [],
			relayAddrs: [relayA.dialAddr],
		}));
		await A.start();
		await makeOwnOwner(A, aKey);
		const aPeerId = A.peerId!.toString();

		// Every address A has is a circuit address — the relay-only posture.
		const aControlAddrList = controlAddrs(A);
		expect(aControlAddrList.length).toBeGreaterThan(0);
		for (const addr of aControlAddrList) {
			expect(addr).toContain('/p2p-circuit');
		}
		expect(A.getRelayReservationState().status).toBe('reserved');
		tally.reserved(relayA, 'after A control start');

		// ── A founds the CLOSED strand, live BEFORE the invite is published ──
		// Bound-invite formation replies with the host strand's addresses and
		// membership secret only if the strand is running at redemption time —
		// founding first is the ordering the feature depends on.
		const memberPrivateKey = await generateStrandMemberKey();
		const founded = await A.foundStrand({ strandId, type: 'c', memberPrivateKey, sAppConfig: sApp });
		expect(founded.founded).toBe(true);
		const aStrandNode = founded.instance.libp2pNode!;
		const aStrandPeerId = aStrandNode.peerId.toString();
		expect(aStrandPeerId).not.toBe(aPeerId);
		// The strand node's per-relay reservation supervisor landed its first attempt
		// before foundStrand resolved: its announced addrs already include the circuit.
		expect(aStrandNode.getMultiaddrs().map(String).some(isCircuit)).toBe(true);
		tally.reserved(relayA, 'after A founds the strand');

		// ── The bound invitation, delivered out-of-band (encode → decode) ────
		const invitation = await A.createOpenInvitation(SAPP_ID, YEAR_MS);
		await A.publishFormationInvite(invitation.token, SAPP_ID, {
			strandId,
			expiresAtMs: Date.now() + YEAR_MS,
			totalUses: 1,
		});
		// The encoded invitation is B's ONLY knowledge of A — its bootstrap
		// addresses must carry A's `/p2p-circuit` control address or a
		// relay-only host is unreachable by construction.
		const encoded = A.encodeInvitation(invitation);
		expect(invitation.bootstrap.length).toBeGreaterThan(0);
		for (const addr of invitation.bootstrap) {
			expect(addr).toContain('/p2p-circuit');
			expect(addr).toContain(aPeerId);
		}

		// ── Party B: the other phone — a DIFFERENT party, also relay-only ────
		const bKey = await generateKeyPair('Ed25519');
		B = new CadreNode(controlNodeConfig({
			partyId: `blind-b-${runTag}`,
			privateKey: bKey,
			listenAddrs: [],
			relayAddrs: [relayB.dialAddr],
		}));
		await B.start();
		// B is a REAL party, not a bare node: a closed-strand formation makes the
		// joiner persist its OWN membership identity (`StrandPartyKey`) into its own
		// control DB, which is an owner-signed write. Without genesis that insert is
		// refused and `formStrand` fails the whole join.
		await makeOwnOwner(B, bKey);
		const bPeerId = B.peerId!.toString();
		for (const addr of controlAddrs(B)) {
			expect(addr).toContain('/p2p-circuit');
		}
		tally.reserved(relayB, 'after B control start');

		// ── B decodes the invitation and forms — a stranger, over the relay ──
		// This dial is the first-ever exercise of the stranger-open formation
		// protocol across a circuit: B's control node dials A's `/p2p-circuit`
		// bootstrap address through A's relay — in the per-party arm a relay B
		// holds no reservation on — and A's membership gate admits the stranger
		// only because the invitation is outstanding.
		const decoded = B.decodeInvitation(encoded);
		expect(decoded.token).toBe(invitation.token);
		expect(decoded.expiration.getTime()).toBe(invitation.expiration.getTime());
		expect(decoded.bootstrap).toEqual(invitation.bootstrap);

		const formResult = await B.formStrand(decoded, {
			partyId: `blind-b-${runTag}`,
			purpose: 'blind-relay phone-to-phone e2e',
		});
		expect(formResult.strandId).toBe(strandId);
		// The closed strand's membership secret crossed the circuit intact —
		// the whole point of binding the invite to a closed strand.
		expect(formResult.memberPrivateKey).toBe(memberPrivateKey);
		// So did B's own single-use membership invitation, and B's node adopted it:
		// its own party identity persisted, the invitation staged for bring-up. This
		// is the only RELAY-ROUTED exercise of that field.
		expect(formResult.membershipInvite).toBeDefined();
		expect(await B.getControlDatabase()!.queryStrandPartyKey(strandId)).not.toBeNull();
		expect(B.getPendingMembershipInvite(strandId)).toEqual(formResult.membershipInvite);

		// The formation-carried seed is a RELAY-ROUTED strand address: every
		// entry is a live announced addr of A's STRAND node (sampled now, not
		// from a stale snapshot), circuit-routed, and never a control address.
		expect(formResult.strandAddrs.length).toBeGreaterThan(0);
		const aStrandAddrsNow = aStrandNode.getMultiaddrs().map(String);
		const aControlAddrsNow = controlAddrs(A);
		for (const addr of formResult.strandAddrs) {
			expect(addr).toContain('/p2p-circuit');
			expect(addr).toContain(aStrandPeerId);
			expect(aStrandAddrsNow).toContain(addr);
			expect(aControlAddrsNow).not.toContain(addr);
		}

		// The control link the formation rode is relay-carried and unlimited,
		// on BOTH ends — classified, not assumed.
		// NOTE: this samples the formation connection immediately after
		// `formStrand` resolves, so it assumes libp2p still holds it open.
		// True today (stable over 8 consecutive runs); if a future libp2p —
		// or a cadre-side change — ever closes formation connections eagerly,
		// this goes FLAKY rather than wrong: re-express it as a gate that
		// captures the classification while the stream is live.
		expectAllPathsRelayed(B.getControlNode()!, aPeerId, 'B control');
		expectAllPathsRelayed(A.getControlNode()!, bPeerId, 'A control');
		// ...and it rode A's relay, the one the invitation names: in the per-party arm
		// this is the proof the dial crossed relays. Pinned on B's outbound side only —
		// the shape of the inbound side's remoteAddr is libp2p's business.
		const viaRelayA = `/p2p/${relayA.peerId}/p2p-circuit`;
		const bDialsToA = B.getControlNode()!.getConnections()
			.filter((c) => c.remotePeer.toString() === aPeerId && c.direction === 'outbound');
		expect(bDialsToA.length, 'B control holds its formation dial to A').toBeGreaterThan(0);
		for (const conn of bDialsToA) {
			expect(conn.remoteAddr.toString(), 'B control reached A through relay A').toContain(viaRelayA);
		}

		// ── B launches the strand from the carried seed alone ────────────────
		// FounderOwnerKey stays null, so B attaches as a joiner; the carried
		// addresses become the strand's discovery seed and the connection
		// manager auto-dials A's strand node through the relay. No hand-dial.
		const bStrandRow: StrandRow = {
			Id: strandId,
			// `?? null` is unreachable — the equality assertion above pinned the
			// delivered secret — but StrandRow's column is `string | null`.
			MemberPrivateKey: formResult.memberPrivateKey ?? null,
			Type: 'c',
			FounderOwnerKey: null,
		};
		// Launched without waiting for B's first sync, so the relayed connection is
		// asserted on its own terms below before the Header's arrival is waited for.
		const bStrand = await B.addStrand({ strandRow: bStrandRow, sAppConfig: sApp, awaitFirstSync: false });
		const bStrandNode = bStrand.libp2pNode!;
		const bStrandPeerId = bStrandNode.peerId.toString();
		expect(bStrandNode.getMultiaddrs().map(String).some(isCircuit)).toBe(true);
		tally.reserved(relayB, 'after B strand node reserves');

		await waitUntil(
			() => bStrandNode.getConnections().some((c) => c.remotePeer.toString() === aStrandPeerId),
			{ ...GATE, description: "B's strand node reaches A's strand node through the relay (seeded, no hand-dial)" },
		);
		await waitUntil(
			() => aStrandNode.getConnections().some((c) => c.remotePeer.toString() === bStrandPeerId),
			{ ...GATE, description: "A's strand node accepts the inbound relayed connection from the stranger's strand node" },
		);
		// B's first sync over the circuit: the closed strand's Header reaches the stranger
		// and its database is published (a joiner's is withheld until then).
		await B.whenStrandWritable(strandId, { timeoutMs: GATE.timeoutMs });
		expect(bStrand.status).toBe('active');
		const bDb = bStrand.database!.getDatabase();

		// ── B's join finishes WITH the strand becoming writable ──────────────
		// The membership reconciler's own first pass ran while the first-sync gate
		// still withheld B's database and found none; `publishDatabase` kicks it the
		// moment the database is handed over, and an unfinished join then retries on a
		// short doubling ladder rather than the 30 s poll interval. Both rows —
		// the `Strand.Member` seat redeeming the staged invitation, and this machine's
		// own `Strand.MemberPeer` binding — are written by bring-up alone: no
		// consumeInvite or registerMemberPeer call appears anywhere in this file.
		const bMemberKey = strandMemberKeyPair(
			(await B.getControlDatabase()!.queryStrandPartyKey(strandId))!).publicKeyB64;
		await waitUntil(
			async () => {
				let seated = false;
				for await (const row of bDb.eval('select Key from Strand.Member')) {
					if (row.Key === bMemberKey) seated = true;
				}
				if (!seated) return false;
				for await (const row of bDb.eval('select MemberKey, PeerId from Strand.MemberPeer')) {
					if (row.MemberKey === bMemberKey && row.PeerId === bStrandPeerId) return true;
				}
				return false;
			},
			{
				timeoutMs: JOIN_FINISH_MS,
				intervalMs: 250,
				description: "B's Member seat and its own MemberPeer binding land within "
					+ `${JOIN_FINISH_MS} ms of the strand becoming writable (default reconciler cadence)`,
			},
		);
		// The invitation is spent, so the staged copy is dropped — the reconciler owns
		// that invalidation.
		expect(B.getPendingMembershipInvite(strandId)).toBeUndefined();

		// ── The strand mesh is RELAY-CARRIED and unlimited, both ends ────────
		expectAllPathsRelayed(bStrandNode, aStrandPeerId, 'B strand');
		expectAllPathsRelayed(aStrandNode, bStrandPeerId, 'A strand');

		// ── Each side's signed address record crossed the circuit ────────────
		// The only path between the two strand nodes is relayed. Each node's FRET table
		// must still end up holding the other side's signed address record — what the
		// address refresh keeps dialable and what a restart re-imports — with every
		// address in it circuit-routed and bound to that peer's strand transport id.
		const recordedAddrs = async (node: Libp2p, peerId: string): Promise<string[]> =>
			((await strandFretPeerAddrs(node)).peers.get(peerId) ?? []).map(String);
		await waitUntil(
			async () => (await recordedAddrs(aStrandNode, bStrandPeerId)).length > 0
				&& (await recordedAddrs(bStrandNode, aStrandPeerId)).length > 0,
			{ ...GATE, description: "both strand nodes' FRET tables hold the other side's signed address record, learned over the circuit" },
		);
		for (const [node, peerId] of [[aStrandNode, bStrandPeerId], [bStrandNode, aStrandPeerId]] as const) {
			for (const addr of await recordedAddrs(node, peerId)) {
				expect(isCircuit(addr), addr).toBe(true);
				expect(addr.endsWith(`/p2p/${peerId}`), addr).toBe(true);
			}
		}

		// ── Per-strand relay-slot cost, cross-party: 2 control + 2 strand ────
		// Same number as the same-party measurement: one reservation per node
		// per network — every strand a NAT'd node joins costs one extra relay
		// slot per node, regardless of whose party the other end is. Per relay
		// in the per-party arm: 2 on each, none on the relay a node only dials
		// through (the strand mesh has formed by now).
		tally.check('with the strand meshed');
		console.log('[blind-relay] reservations with one cross-party strand running (2 control + 2 strand): %s',
			relays.map((r, i) => `relay ${i + 1}: ${r.reservationCount()}`).join(', '));

		// ── The closed strand's founding rows reach the stranger ─────────────
		// A's founder bootstrap seated Strand.Header/Member/Manager; B wrote
		// nothing. Their visibility on B proves layer-2 replication crossed the
		// circuit before the app-data assertions below lean on it.
		const aDb = founded.instance.database!.getDatabase();
		await waitUntil(
			async () => ((await bDb.get('select count(1) as c from Strand.Header'))?.c as number) >= 1,
			{ ...GATE, description: "the closed strand's Header row becomes visible on B over the circuit" },
		);

		// ── Data BOTH ways across the circuit ────────────────────────────────
		await aDb.exec("insert into App.Data (Key, Val) values ('from-a', 'written-on-A')");
		await waitUntil(
			async () => (await readDataRows(bDb)).get('from-a') === 'written-on-A',
			{ ...GATE, description: 'the row written on A is readable on B over the circuit' },
		);
		// B→A: the total stranger writes into the shared workspace.
		await bDb.exec("insert into App.Data (Key, Val) values ('from-b', 'written-on-B')");
		await waitUntil(
			async () => (await readDataRows(aDb)).get('from-b') === 'written-on-B',
			{ ...GATE, description: 'the row written on B is readable on A over the circuit' },
		);

		// ── Final sweep: nothing direct anywhere, except to a relay ──────────
		// Four nodes, one rule: every connection to a non-relay peer is
		// relayed. This is what makes the successes above unable to have been
		// served by a direct fallback path. Every node gets every relay id: in
		// the per-party arm a node may hold a direct hop-client link to the
		// other party's relay, which is how it dialled through it.
		expectOnlyRelayDirect(A.getControlNode()!, relayPeerIds, 'A control (sweep)');
		expectOnlyRelayDirect(B.getControlNode()!, relayPeerIds, 'B control (sweep)');
		expectOnlyRelayDirect(aStrandNode, relayPeerIds, 'A strand (sweep)');
		expectOnlyRelayDirect(bStrandNode, relayPeerIds, 'B strand (sweep)');
		// Rows have now crossed both ways, so every dial through the other
		// party's relay has run — a slot taken there on the node's own
		// initiative (relay discovery) would show here if nowhere earlier.
		tally.check('final sweep');
	} finally {
		await Promise.allSettled([B?.stop(), A?.stop()]);
		// Deduplicated: in the shared arm relayA and relayB are the same relay. Settled, so
		// one relay failing to stop neither leaks the other nor skips the restore below.
		await Promise.allSettled([...new Set([relayA, relayB])].map((relay) => relay?.stop()));
		// After the nodes are down, so this arm's frame summary counts only its own traffic —
		// and in the `finally`, so a failing arm still hands the next one a clean constructor
		// instead of burying its error under "already installed".
		link?.restore();
	}
}

describe('E2E blind-relay phone-to-phone (two parties, both relay-only, on a shared relay or one each)', () => {
	it('forms a strand between two strangers through the relay and replicates data both ways', async () => {
		await runBlindRelayPhoneToPhone({ relays: 'shared' });
	}, 300_000);

	// The same journey with a real link condition. 10 ms of one-way per-frame delay ran
	// 9.3-12.4 s over four runs against gates of 60 s and 20 s, so the arm costs about ten
	// seconds and keeps real margin on slower hardware; 50 ms also passes but at 25-32 s
	// against the 60 s gate, which is too thin to commit. `pipelined` is the honest latency
	// model — `serial` in the same fixture is a frame-RATE cap and fails this scenario at
	// 1 ms, which is what made gotchoices/sereus#13 look like a 10 ms breaking point. Never
	// quote one mode's number for the other; docs/testing.md holds the full sweep.
	// NOTE: those durations are a developer machine's. The binding gate on this arm is the
	// 20 s `JOIN_FINISH_MS` one, which 100 ms of delay already misses; if CI hardware turns
	// out slower enough to make 10 ms flaky here, lower `LINK_LATENCY_MS` rather than
	// loosening that gate — the gate asserts a product claim about join latency, whereas the
	// delay is only this arm's chosen link condition.
	it(`forms the same strand and replicates both ways over a link with ${LINK_LATENCY_MS} ms of latency`, async () => {
		await runBlindRelayPhoneToPhone({ latency: { delayMs: LINK_LATENCY_MS, mode: 'pipelined' }, relays: 'shared' });
	}, 300_000);

	it('forms the strand when each stranger reserves on a DIFFERENT relay, and replicates both ways', async () => {
		await runBlindRelayPhoneToPhone({ relays: 'per-party' });
	}, 300_000);
});
