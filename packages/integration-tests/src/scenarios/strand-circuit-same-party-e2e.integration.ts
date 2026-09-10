/**
 * Strand data over a circuit relay, same party, BOTH ends relay-only — the
 * first scenario in which workspace (strand) bytes actually cross a
 * `/p2p-circuit` hop rather than a direct loopback socket, and the first in
 * which neither control node is directly dialable at all.
 *
 * Topology: one DEDICATED, ungated relay (`harness/dedicated-relay.ts` — the
 * loopback stand-in for the `ops/docker/libp2p-infra` container) plus two
 * `CadreNode`s of one party, each with `listenAddrs: []` and
 * `relayAddrs: [<relay>]` — the two-phones shape. Everything both machines
 * exchange, control and strand alike, is carried by the relay:
 *
 *   - the CONTROL mesh forms over the relay: each control node reserves via the
 *     search route (`relay-addrs.ts` → bare `/p2p-circuit` + the explicit drive
 *     at the end of `start()`), and B dials A's circuit address;
 *   - A founds a strand and B launches the same strand with NO hand-dial: the
 *     seed is resolved over the control mesh via the strand-addr RPC
 *     (`/sereus/strand-addr/1.0.0`), exactly as in
 *     `strand-addr-seed-convergence.integration.ts` — but here the RPC itself
 *     rides a relayed control connection and every address it can answer with
 *     is a `/p2p-circuit` address;
 *   - each STRAND node inherits the configured `<relay>/p2p-circuit` listener
 *     (`strand-network-config.ts`) and reserves its own slot from inside
 *     `libp2p.start()`;
 *   - the strand mesh connection is asserted `relayed` by
 *     `summarizeConnectionPaths` — a direct fallback cannot pass for relayed
 *     success (neither end has a direct listener, and the classifier proves it);
 *   - App rows written on A are read on B and vice versa, across the circuit —
 *     possible only because the dedicated relay sets `applyDefaultLimit: false`
 *     (db-p2p's database protocols do not run on "limited" connections);
 *   - the relay's reservation count is measured: 2 control + 2 strand = 4 —
 *     the first measurement of the per-strand relay-slot cost.
 *
 * The final phase characterizes RESERVATION LOSS (the relay restarts while the
 * strand runs): the CONTROL nodes recover on their own (the
 * `superviseRelayReservation` loop re-drives), while the STRAND nodes do NOT —
 * `@libp2p/circuit-relay-v2` re-drives a lost CONFIGURED reservation nowhere
 * (`connection:close` → `#removeReservation` → the listener clears its
 * addresses, and nothing ever calls `addRelay` again), and cadre-core runs no
 * supervisor for strand nodes. The inverted gate below (expecting the wait to
 * time out) pins today's behaviour and doubles as a tripwire: if a libp2p
 * upgrade or a strand-side supervisor ever makes strand reservations recover,
 * that assertion fails and `backlog/bug-strand-relay-reservation-not-resupervised`
 * is obsolete.
 *
 * ── Topology: one party, ONE owner ──
 * Same single-owner shape as `strand-addr-seed-convergence.integration.ts` (see
 * its header for why two nodes cannot each self-genesis): founder A is the
 * party's sole owner with a stable identity (same key as node identity), joiner
 * B is a plain member with A's circuit address in `bootstrapNodes`.
 *
 * Lookup shape: App.Data reads scan and filter in JavaScript — a where-equality
 * on the primary key can MISS on a networked strand
 * (`debt-composite-pk-point-lookup-unreliable-untracked`).
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Libp2p } from 'libp2p';
import { CadreNode, collectStrandAddrs, summarizeConnectionPaths } from '@serfab/cadre-core';
import type { Database } from '@quereus/quereus';
import {
	waitUntil,
	waitForCadrePeerConverged,
	controlNodeConfig,
	createSignedSAppConfig,
	makeOwnOwner,
	connectControlNodes,
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

/** Assert every connection `node` holds TO `peerId` is a relayed circuit path. */
function expectAllPathsRelayed(node: Libp2p, peerId: string, label: string): void {
	const summary = summarizeConnectionPaths(node.getConnections());
	const toPeer = summary.paths.filter((p) => p.peerId === peerId);
	expect(toPeer.length, `${label}: no connection to ${peerId}`).toBeGreaterThan(0);
	for (const path of toPeer) {
		expect(path.kind, `${label}: ${path.remoteAddr}`).toBe('relayed');
		expect(path.transport, `${label}: ${path.remoteAddr}`).toBe('circuit-relay');
	}
}

// ═════════════════════════════════════════════════════════════════════════════

describe('E2E same-party strand over a dedicated circuit relay (both ends relay-only)', () => {
	it('forms control + strand meshes through the relay, replicates data both ways, and survives as designed', async () => {
		let relay: DedicatedRelay | undefined;
		let A: CadreNode | undefined; // founder: sole owner + storage, relay-only
		let B: CadreNode | undefined; // joiner: plain member, relay-only
		try {
			const partyId = `strand-circuit-${Date.now()}`;
			const strandId = `strand-circ-${Date.now()}`;

			// ── The dedicated relay: ungated, no cadre protocols, no default limit ──
			relay = await startDedicatedRelay();

			// ── A: founder/owner, storage profile, RELAY-ONLY ────────────────────
			// `listenAddrs: []` models a machine that cannot accept inbound
			// connections; `relayAddrs` is fail-fast, so a resolved start() means
			// the search-route reservation landed.
			const aKey = await generateKeyPair('Ed25519');
			A = new CadreNode(controlNodeConfig({
				partyId,
				privateKey: aKey,
				profile: 'storage',
				listenAddrs: [],
				relayAddrs: [relay.dialAddr],
			}));
			await A.start();
			const aOwnerPub = await makeOwnOwner(A, aKey);
			const aPeerId = A.peerId!.toString();

			// Every address A has is a circuit address — the relay-only posture.
			const aControlAddrList = controlAddrs(A);
			expect(aControlAddrList.length).toBeGreaterThan(0);
			for (const addr of aControlAddrList) {
				expect(addr).toContain('/p2p-circuit');
			}
			expect(A.getRelayReservationState().status).toBe('reserved');

			// ── B: joiner, RELAY-ONLY too — no existing test covers this shape ──
			// A's circuit addr rides in `bootstrapNodes` (admits A unconditionally
			// at B's fail-closed control-stream gate, as in the seed-convergence
			// scenario).
			const bKey = await generateKeyPair('Ed25519');
			B = new CadreNode(controlNodeConfig({
				partyId,
				privateKey: bKey,
				listenAddrs: [],
				relayAddrs: [relay.dialAddr],
				bootstrapNodes: [aControlAddrList[0]!],
			}));
			await B.start();
			const bPeerId = B.peerId!.toString();
			for (const addr of controlAddrs(B)) {
				expect(addr).toContain('/p2p-circuit');
			}

			// Both control reservations held at the relay.
			expect(relay.reservationCount()).toBe(2);

			// ── Control mesh over the relay ──────────────────────────────────────
			await B.trustOwnerKeys([aOwnerPub], 'invite');
			await connectControlNodes(B, A);
			// The control link is genuinely relay-carried — classified, not assumed.
			expectAllPathsRelayed(B.getControlNode()!, aPeerId, 'B control');
			expectAllPathsRelayed(A.getControlNode()!, bPeerId, 'A control');

			// Membership rows: {A, B} 2-node commits (same recipe and reasoning as
			// strand-addr-seed-convergence).
			await A.authorizePeer(aPeerId);
			await A.authorizePeer(bPeerId);
			await waitForCadrePeerConverged(B.getControlDatabase()!, aPeerId, {
				timeoutMs: GATE.timeoutMs,
				description: "B observes A's CadrePeer membership row over the relayed control mesh",
			});
			expect(await A.isAuthorizedMember(bPeerId)).toBe(true);
			expect(await B.isAuthorizedMember(aPeerId)).toBe(true);

			// ── Founder strand: the configured-route reservation actually lands ──
			const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '0.1.0');
			const aStrand = await A.addStrand({
				strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null },
				sAppConfig: sApp,
			});
			expect(aStrand.status).toBe('active');
			const aStrandNode = aStrand.libp2pNode!;
			const aStrandPeerId = aStrandNode.peerId.toString();
			expect(aStrandPeerId).not.toBe(aPeerId);
			const aStrandAddrs = aStrandNode.getMultiaddrs().map(String);
			expect(aStrandAddrs.length).toBeGreaterThan(0);
			expect(aStrandAddrs.some(isCircuit)).toBe(true);

			// ── The strand-addr RPC answer is dialable BY THE ASKER ──────────────
			// Asked over the real relayed control connection. Signaling-first
			// ordering must put a `/p2p-circuit` entry first — for a relay-only
			// responder it is the only kind of entry there is, and the asker (also
			// relay-only) can dial it through the shared relay.
			const seed = await collectStrandAddrs(B.getControlNode()!, [{ peerId: aPeerId }], strandId);
			expect(seed.length).toBeGreaterThan(0);
			expect(seed[0]!).toContain('/p2p-circuit');
			for (const addr of seed) {
				expect(aStrandAddrs).toContain(addr);
				expect(addr).not.toContain(aPeerId);
			}

			// The seed pass RPCs only siblings with an OPEN control connection —
			// re-assert the relayed link is still up before blaming discovery.
			expect(
				B.getControlNode()!.getConnections().some((c) => c.remotePeer.toString() === aPeerId),
			).toBe(true);

			// ── Joiner strand: RPC-resolved seed alone, no hand-dial anywhere ────
			const bStrand = await B.addStrand({
				strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null },
				sAppConfig: sApp,
			});
			expect(bStrand.status).toBe('active');
			const bStrandNode = bStrand.libp2pNode!;
			const bStrandPeerId = bStrandNode.peerId.toString();
			expect(bStrandNode.getMultiaddrs().map(String).some(isCircuit)).toBe(true);

			await waitUntil(
				() => bStrandNode.getConnections().some((c) => c.remotePeer.toString() === aStrandPeerId),
				{ ...GATE, description: "B's strand node reaches A's strand node through the relay" },
			);
			await waitUntil(
				() => aStrandNode.getConnections().some((c) => c.remotePeer.toString() === bStrandPeerId),
				{ ...GATE, description: "A's strand node sees the inbound relayed strand connection" },
			);

			// ── The strand mesh is RELAY-CARRIED, per the canonical classifier ───
			// (Each strand node also holds a DIRECT ws connection to the relay
			// itself — the reservation keep-alive — so the assertion is per-peer,
			// not "zero direct connections".)
			expectAllPathsRelayed(bStrandNode, aStrandPeerId, 'B strand');
			expectAllPathsRelayed(aStrandNode, bStrandPeerId, 'A strand');

			// ── Per-strand relay-slot cost: 2 control + 2 strand ─────────────────
			expect(relay.reservationCount()).toBe(4);
			console.log('[strand-circuit] relay reservations with one strand running: %d (2 control + 2 strand)',
				relay.reservationCount());

			// ── Data BOTH ways across the circuit ────────────────────────────────
			const aDb = aStrand.database!.getDatabase();
			const bDb = bStrand.database!.getDatabase();
			await aDb.exec("insert into App.Data (Key, Val) values ('from-a', 'written-on-A')");
			await waitUntil(
				async () => (await readDataRows(bDb)).get('from-a') === 'written-on-A',
				{ ...GATE, description: 'the row written on A is readable on B over the circuit' },
			);
			await bDb.exec("insert into App.Data (Key, Val) values ('from-b', 'written-on-B')");
			await waitUntil(
				async () => (await readDataRows(aDb)).get('from-b') === 'written-on-B',
				{ ...GATE, description: 'the row written on B is readable on A over the circuit' },
			);

			// ── Reservation loss: the relay restarts under a running strand ──────
			// Same identity, same port — every reservation and relayed connection
			// is gone; the configured addresses still name a live relay.
			await relay.restart();

			// FIRST gate on the loss being OBSERVED: the circuit listener clears
			// its addresses when the relay connection closes, and sampling before
			// those close events dispatch would make every recovery assertion
			// below pass vacuously (seen in practice on a fast run). The strand
			// side is the right place to watch — its loss is permanent, so this
			// gate cannot race a recovery.
			const strandCircuitAddrs = (node: Libp2p) => node.getMultiaddrs().map(String).filter(isCircuit);
			await waitUntil(
				() => strandCircuitAddrs(aStrandNode).length === 0 && strandCircuitAddrs(bStrandNode).length === 0,
				{ ...GATE, description: 'both strand nodes observe the lost reservation (circuit addrs withdrawn)' },
			);

			// CONTROL nodes recover on their own: the reservation supervisor
			// notices the lost circuit addr (5 s liveness cadence) and re-drives.
			// Gated on the RELAY's view first — the restarted instance starts at
			// zero reservations, so reaching 2 is unambiguous recovery — then on
			// the clients republishing their circuit addrs.
			await waitUntil(
				() => relay!.reservationCount() === 2,
				{ ...GATE, description: 'both control nodes re-reserve on the restarted relay (supervisor)' },
			);
			await waitUntil(
				() => controlAddrs(A!).some(isCircuit) && controlAddrs(B!).some(isCircuit),
				{ ...GATE, description: 'both control nodes republish a circuit address after the restart' },
			);

			// STRAND nodes do NOT: nothing re-drives a configured-route reservation
			// (see the file header). The inverted gate pins that — and fails the
			// day recovery starts working, flagging the backlog ticket obsolete.
			const strandRecovered = () =>
				strandCircuitAddrs(aStrandNode).length > 0 || strandCircuitAddrs(bStrandNode).length > 0;
			await expect(
				waitUntil(strandRecovered, {
					timeoutMs: 15_000,
					intervalMs: 500,
					description: 'a strand node re-reserves after the relay restart (NOT expected today)',
				}),
			).rejects.toThrow(/Timeout/);

			// Only the two control reservations came back.
			expect(relay.reservationCount()).toBe(2);
			console.log('[strand-circuit] relay reservations after restart: %d (control only — strand reservations did not recover)',
				relay.reservationCount());
		} finally {
			await Promise.allSettled([B?.stop(), A?.stop()]);
			await relay?.stop();
		}
	}, 300_000);
});
