/**
 * Reproduction + characterization for `control-sibling-relay-reservation-denied`
 * (reported upstream as gotchoices/Optimystic#12): a control node with no inbound
 * reachability of its own reserves a circuit-relay slot on a sibling control node,
 * and the party is supposed to end up able to dial it.
 *
 * The chain under test, end to end over real WebSocket libp2p nodes:
 *
 *   C listens on `<A>/p2p-circuit`  ->  A grants the reservation
 *     ->  C's `getMultiaddrs()` gains a `/p2p-circuit` address
 *     ->  identify/push carries it into A's peerStore
 *     ->  C republishes its `CadrePeer` row carrying it
 *     ->  B (which never connected to C directly) merges it into its own peerStore
 *
 * Case 1 walks that chain for an AUTHORIZED relay-only node and asserts every link
 * separately, so a failure names the link that broke rather than "the address never
 * showed up". It passes today: the seeding mechanism is sound.
 *
 * Cases 2 and 3 are the discriminating measurement. They boot the same relay-only
 * node while the relay has NOT yet authorized it -- the state a genuine member is in
 * during the window between booting and its `CadrePeer` row replicating to the relay.
 * `CadreNode.admitInboundControlConnection` then has a positive basis to deny, and the
 * reservation dies with it. Both cases assert the CURRENT (defective) behavior on
 * purpose, so the suite stays green while the defect is open.
 *
 * >> WHEN `control-sibling-relay-reservation-denied` LANDS, cases 2 and 3 must be
 * >> FLIPPED to assert success. Each carries a `CHARACTERIZATION` marker at the exact
 * >> assertions to invert. Do not delete them -- inverted, they are the regression
 * >> guard for the fix.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { CadreNode } from '@serfab/cadre-core';
import {
	waitUntil,
	controlNodeConfig,
	makeOwnOwner,
	connectControlNodes,
	peerStoreAddrsFor,
	controlAddrs,
} from '../harness/index.js';

const isCircuit = (addr: string): boolean => addr.includes('/p2p-circuit');

/** A relay-providing control node's first dialable address — what a peer puts in `relayAddrs`. */
function relayDialAddr(relay: CadreNode): string {
	const addr = controlAddrs(relay).find((a) => !isCircuit(a));
	if (!addr) throw new Error('relay node has no direct listen address');
	return addr;
}

describe('E2E relay-only control node circuit address', () => {
	it('reserves through a sibling relay and the address reaches a third party', async () => {
		const partyId = `relay-ctrl-${Date.now()}`;
		let A: CadreNode | undefined;
		let B: CadreNode | undefined;
		let C: CadreNode | undefined;
		try {
			// ── A: owner + relay provider (storage profile runs circuitRelayServer) ──
			const aKey = await generateKeyPair('Ed25519');
			A = new CadreNode(controlNodeConfig({
				partyId, privateKey: aKey, profile: 'storage', enableRelay: true, strandFilter: 'none',
			}));
			await A.start();
			await makeOwnOwner(A, aKey);

			// ── B: an ordinary member, directly reachable, never dials C ────────────
			const bKey = await generateKeyPair('Ed25519');
			B = new CadreNode(controlNodeConfig({ partyId, privateKey: bKey, strandFilter: 'none' }));
			await B.start();
			await A.authorizePeer(B.peerId!.toString());
			await connectControlNodes(B, A);

			// ── C: no listener of its own; its ONLY address is the relay slot ───────
			// Authorized BEFORE it boots: its reservation dial is an inbound connection
			// at A, so an unauthorized C would be judged by A's membership gate. The
			// last case in this file boots exactly that state on purpose.
			const cKey = await generateKeyPair('Ed25519');
			const cPeerId = peerIdFromPrivateKey(cKey).toString();
			await A.authorizePeer(cPeerId);

			C = new CadreNode(controlNodeConfig({
				partyId,
				privateKey: cKey,
				strandFilter: 'none',
				listenAddrs: [],
				relayAddrs: [relayDialAddr(A)],
			}));
			await C.start();

			// ── Link 1: the reservation landed, so C holds a circuit address ────────
			await waitUntil(() => controlAddrs(C!).some(isCircuit), {
				timeoutMs: 20_000,
				intervalMs: 250,
				description: 'relay-only control node holds a /p2p-circuit address',
			});

			// ── Link 2: identify/push carried it into the relay's peerStore ─────────
			await waitUntil(async () => (await peerStoreAddrsFor(A!, cPeerId)).some(isCircuit), {
				timeoutMs: 20_000,
				intervalMs: 250,
				description: "relay node's peerStore holds a circuit address for the relay-only node",
			});

			// ── Link 3: C's own CadrePeer row carries it ────────────────────────────
			await waitUntil(async () => {
				const addrs = await C!.resolvePeerAddrs(cPeerId);
				return addrs.map(String).some(isCircuit);
			}, {
				timeoutMs: 30_000,
				intervalMs: 500,
				description: 'relay-only node publishes a circuit address in its own CadrePeer record',
			});

			// ── Link 4: B — which never dialed C — learns it from the record ────────
			await waitUntil(async () => (await peerStoreAddrsFor(B!, cPeerId)).some(isCircuit), {
				timeoutMs: 60_000,
				intervalMs: 500,
				description: 'third-party member learns the relay-only node\'s circuit address',
			});
		} finally {
			await Promise.allSettled([C?.stop(), B?.stop(), A?.stop()]);
		}
	}, 180_000);

	it('an UNAUTHORIZED relay-only control node cannot reserve through the membership gate', async () => {
		// The negative control that isolates the gate. Same topology, minus the
		// `authorizePeer` — A's anchor is non-empty and its authorized set non-empty,
		// so `admitInboundControlConnection` has a positive basis to deny C, and the
		// configured circuit listener is fail-fast (`relay-addrs.ts`).
		const partyId = `relay-ctrl-denied-${Date.now()}`;
		let A: CadreNode | undefined;
		let C: CadreNode | undefined;
		try {
			const aKey = await generateKeyPair('Ed25519');
			A = new CadreNode(controlNodeConfig({
				partyId, privateKey: aKey, profile: 'storage', enableRelay: true, strandFilter: 'none',
			}));
			await A.start();
			await makeOwnOwner(A, aKey);
			// One member row, so A's authorized set is non-empty and the cold-start
			// admit-everyone carve-out no longer applies.
			const memberKey = await generateKeyPair('Ed25519');
			await A.authorizePeer(peerIdFromPrivateKey(memberKey).toString());

			const cKey = await generateKeyPair('Ed25519');
			const cPeerId = peerIdFromPrivateKey(cKey).toString();
			expect(await A.isAuthorizedMember(cPeerId)).toBe(false);

			C = new CadreNode(controlNodeConfig({
				partyId,
				privateKey: cKey,
				strandFilter: 'none',
				listenAddrs: [],
				relayAddrs: [relayDialAddr(A)],
			}));

			// Record what actually happens rather than asserting a guess: either
			// `start()` throws (fail-fast listener) or the node comes up addressless.
			let startError: unknown;
			await C.start().catch((error: unknown) => { startError = error; });
			const addrs = startError === undefined ? controlAddrs(C) : [];
			console.log('[relay-only-denied] startError=%s addrs=%o',
				startError === undefined ? 'none' : (startError as Error).message, addrs);

			// CHARACTERIZATION -- invert when `control-sibling-relay-reservation-denied`
			// lands: the reservation must then succeed, so this becomes
			//   expect(startError).toBeUndefined();
			//   expect(addrs.some(isCircuit)).toBe(true);
			// Measured today: `start()` rejects with UnsupportedListenAddressesError, whose
			// cause is an UnexpectedEOFError inside `ReservationStore.#createReservation` --
			// the relay killed the connection at the gate mid-reservation-stream.
			expect(startError).toBeDefined();
			expect(addrs.some(isCircuit)).toBe(false);
		} finally {
			await Promise.allSettled([C?.stop(), A?.stop()]);
		}
	}, 180_000);

	it('on the fail-soft search-listener route the same denial leaves a RUNNING node addressless', async () => {
		// The reported shape, exactly. `relayAddrs` is fail-fast (case above: the node
		// refuses to boot, which is loud). The bare `/p2p-circuit` search listener
		// driven by `reserveRelays` is fail-soft by construction, so the same gate
		// denial produces a node that is up, healthy-looking, and permanently
		// undialable — which is what gotchoices/Optimystic#12 observed.
		const partyId = `relay-ctrl-soft-${Date.now()}`;
		let A: CadreNode | undefined;
		let C: CadreNode | undefined;
		try {
			const aKey = await generateKeyPair('Ed25519');
			A = new CadreNode(controlNodeConfig({
				partyId, privateKey: aKey, profile: 'storage', enableRelay: true, strandFilter: 'none',
			}));
			await A.start();
			await makeOwnOwner(A, aKey);
			const memberKey = await generateKeyPair('Ed25519');
			await A.authorizePeer(peerIdFromPrivateKey(memberKey).toString());

			const cKey = await generateKeyPair('Ed25519');
			const cPeerId = peerIdFromPrivateKey(cKey).toString();

			C = new CadreNode(controlNodeConfig({
				partyId,
				privateKey: cKey,
				strandFilter: 'none',
				// Bare search listener: registers a pending reservation, reserves nothing.
				listenAddrs: ['/p2p-circuit'],
			}));
			await C.start();

			const denied = await C.reserveRelays([relayDialAddr(A)]);
			console.log('[relay-only-soft] unauthorized status=%s error=%s addrs=%o',
				denied.status, denied.error, controlAddrs(C));
			expect(await A.isAuthorizedMember(cPeerId)).toBe(false);
			// CHARACTERIZATION -- invert when `control-sibling-relay-reservation-denied`
			// lands: `denied.status` must then be 'reserved' and the node must hold a
			// circuit address. Measured today: status 'retrying', zero addresses, and the
			// supervisor's error is the same reservation-stream EOF as case 2.
			expect(denied.status).not.toBe('reserved');
			expect(controlAddrs(C).some(isCircuit)).toBe(false);

			// Same node, same relay, one authorization later: the reservation lands.
			// That isolates the gate as the cause — nothing else changed.
			await A.authorizePeer(cPeerId);
			await waitUntil(async () => (await C!.reserveRelays([relayDialAddr(A!)])).status === 'reserved', {
				timeoutMs: 60_000,
				intervalMs: 1_000,
				description: 'authorized relay-only node reserves through the same relay',
			});
			expect(controlAddrs(C).some(isCircuit)).toBe(true);
		} finally {
			await Promise.allSettled([C?.stop(), A?.stop()]);
		}
	}, 180_000);
});
