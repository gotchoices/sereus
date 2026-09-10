/**
 * Blind-relay phone-to-phone E2E — the headline product case: two people who
 * each have ONLY a phone form a shared workspace through a neutral relay
 * server, with every byte relayed because neither phone can accept an incoming
 * connection.
 *
 * Topology: two DIFFERENT parties, each a single `CadreNode` with
 * `listenAddrs: []` (cannot listen) and `relayAddrs: [<relay>]`, sharing one
 * DEDICATED relay (`harness/dedicated-relay.ts` — the loopback stand-in for the
 * `ops/docker/libp2p-infra` container). The relay is strictly a relay: no cadre
 * protocols, no membership gate, in no cohort, holding no data. This is the
 * cross-party sibling of `strand-circuit-same-party-e2e.integration.ts` (one
 * party's two machines over the same fixture) — here the two ends are
 * STRANGERS, so formation, not membership, is what carries the introduction.
 *
 * Flow under test (all over the one relay):
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
 *   4. Rows written by A are read by B and vice versa — real strand data over
 *      the circuit in both directions, including B→A where B is a total
 *      stranger to A's party.
 *   5. Every A↔B connection — control and strand — is classified `relayed` by
 *      `summarizeConnectionPaths` (both ends), and a final sweep asserts
 *      neither side holds a direct connection to anything but the relay itself,
 *      so a direct fallback cannot pass for relayed success.
 *   6. The relay's reservation count is measured: 4 (two control + two strand)
 *      — the cross-party confirmation of the per-strand relay-slot cost first
 *      measured same-party: one slot per node per network, so every strand a
 *      NAT'd node joins costs one extra relay slot per node.
 *
 * Delegate admission is a NON-PARTICIPANT here: the dedicated relay speaks no
 * `/sereus/strand-addr/1.0.0` (asserted against its live protocol list), so the
 * delegate-announce half of `resolveCohortSeed` folds to a no-op — the RPC
 * fan-out swallows the unsupported-protocol failure into `[]`
 * (`collectStrandAddrs` → `dialOneSibling`) — and both `foundStrand`/`addStrand`
 * resolving is the proof nothing in the flow blocks on it.
 *
 * ── Out of scope, deliberately ──
 * TWO relays (A and B each reserved on a different relay, so the circuit path
 * crosses relay boundaries) is untested — this scenario proves the one-shared-
 * relay shape only. Reservation loss under a running strand is characterized by
 * the same-party sibling and not repeated here.
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
	ControlFormationUsageRecorder,
	generateStrandMemberKey,
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
	type DedicatedRelay,
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
 * Assert `node` holds NO direct connection to anyone but the relay itself —
 * the "a direct fallback cannot pass for relayed success" sweep. (The direct
 * ws connection to the relay is the reservation keep-alive and is expected.)
 */
function expectOnlyRelayDirect(node: Libp2p, relayPeerId: string, label: string): void {
	for (const path of summarizeConnectionPaths(node.getConnections()).paths) {
		if (path.peerId !== relayPeerId) {
			expect(path.kind, `${label}: non-relay peer ${path.peerId} via ${path.remoteAddr}`).toBe('relayed');
		}
	}
}

// ═════════════════════════════════════════════════════════════════════════════

describe('E2E blind-relay phone-to-phone (two parties, both relay-only, one dedicated relay)', () => {
	it('forms a strand between two strangers through the relay and replicates data both ways', async () => {
		let relay: DedicatedRelay | undefined;
		let A: CadreNode | undefined; // party A: founder/owner, one phone
		let B: CadreNode | undefined; // party B: joiner, one phone, a total stranger to A
		try {
			const runTag = Date.now();
			const strandId = `strand-blind-${runTag}`;
			const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '0.1.0');

			// ── The dedicated relay: ungated, no cadre protocols, no default limit ──
			relay = await startDedicatedRelay();
			// Delegate admission is a non-participant: the relay speaks no
			// strand-addr protocol, so no delegate grant can exist and none is
			// needed — the announce fan-out folds to a no-op (see file header).
			expect(relay.node.getProtocols()).not.toContain(STRAND_ADDR_PROTOCOL);

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
				relayAddrs: [relay.dialAddr],
			}));
			await A.start();
			await makeOwnOwner(A, aKey);
			const aPeerId = A.peerId!.toString();

			// Real DB-backed responder wiring (the production shape): resolves the
			// bound invite to its host strand, and its usage recorder is what holds
			// the connection gate's stranger carve-out open for B's dial. Must be
			// wired BEFORE createOpenInvitation, or the lazy init builds a
			// recorder-less service.
			A.initializeStrandSolicitation({
				formationUsageRecorder: new ControlFormationUsageRecorder(A.getControlDatabase()!),
			});

			// Every address A has is a circuit address — the relay-only posture.
			const aControlAddrList = controlAddrs(A);
			expect(aControlAddrList.length).toBeGreaterThan(0);
			for (const addr of aControlAddrList) {
				expect(addr).toContain('/p2p-circuit');
			}
			expect(A.getRelayReservationState().status).toBe('reserved');
			expect(relay.reservationCount()).toBe(1);

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
			// The strand node's configured-route reservation landed inside
			// libp2p.start(): its announced addrs already include the circuit.
			expect(aStrandNode.getMultiaddrs().map(String).some(isCircuit)).toBe(true);
			expect(relay.reservationCount()).toBe(2);

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
				relayAddrs: [relay.dialAddr],
			}));
			await B.start();
			const bPeerId = B.peerId!.toString();
			for (const addr of controlAddrs(B)) {
				expect(addr).toContain('/p2p-circuit');
			}
			expect(relay.reservationCount()).toBe(3);

			// ── B decodes the invitation and forms — a stranger, over the relay ──
			// This dial is the first-ever exercise of the stranger-open formation
			// protocol across a circuit: B's control node dials A's `/p2p-circuit`
			// bootstrap address through the shared relay, and A's membership gate
			// admits the stranger only because the invitation is outstanding.
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
			expectAllPathsRelayed(B.getControlNode()!, aPeerId, 'B control');
			expectAllPathsRelayed(A.getControlNode()!, bPeerId, 'A control');

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
			const bStrand = await B.addStrand({ strandRow: bStrandRow, sAppConfig: sApp });
			expect(bStrand.status).toBe('active');
			const bStrandNode = bStrand.libp2pNode!;
			const bStrandPeerId = bStrandNode.peerId.toString();
			expect(bStrandNode.getMultiaddrs().map(String).some(isCircuit)).toBe(true);

			await waitUntil(
				() => bStrandNode.getConnections().some((c) => c.remotePeer.toString() === aStrandPeerId),
				{ ...GATE, description: "B's strand node reaches A's strand node through the relay (seeded, no hand-dial)" },
			);
			await waitUntil(
				() => aStrandNode.getConnections().some((c) => c.remotePeer.toString() === bStrandPeerId),
				{ ...GATE, description: "A's strand node accepts the inbound relayed connection from the stranger's strand node" },
			);

			// ── The strand mesh is RELAY-CARRIED and unlimited, both ends ────────
			expectAllPathsRelayed(bStrandNode, aStrandPeerId, 'B strand');
			expectAllPathsRelayed(aStrandNode, bStrandPeerId, 'A strand');

			// ── Per-strand relay-slot cost, cross-party: 2 control + 2 strand ────
			// Same number as the same-party measurement: one reservation per node
			// per network — every strand a NAT'd node joins costs one extra relay
			// slot per node, regardless of whose party the other end is.
			expect(relay.reservationCount()).toBe(4);
			console.log('[blind-relay] relay reservations with one cross-party strand running: %d (2 control + 2 strand)',
				relay.reservationCount());

			// ── The closed strand's founding rows reach the stranger ─────────────
			// A's founder bootstrap seated Strand.Header/Member/Manager; B wrote
			// nothing. Their visibility on B proves layer-2 replication crossed the
			// circuit before the app-data assertions below lean on it.
			const aDb = founded.instance.database!.getDatabase();
			const bDb = bStrand.database!.getDatabase();
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

			// ── Final sweep: nothing direct anywhere, except to the relay ────────
			// Four nodes, one rule: every connection to a non-relay peer is
			// relayed. This is what makes the successes above unable to have been
			// served by a direct fallback path.
			const relayPeerId = relay.peerId;
			expectOnlyRelayDirect(A.getControlNode()!, relayPeerId, 'A control (sweep)');
			expectOnlyRelayDirect(B.getControlNode()!, relayPeerId, 'B control (sweep)');
			expectOnlyRelayDirect(aStrandNode, relayPeerId, 'A strand (sweep)');
			expectOnlyRelayDirect(bStrandNode, relayPeerId, 'B strand (sweep)');
		} finally {
			await Promise.allSettled([B?.stop(), A?.stop()]);
			await relay?.stop();
		}
	}, 300_000);
});
