/**
 * Regression guard for `control-sibling-relay-reservation-denied` (reported
 * upstream as gotchoices/Optimystic#12): a control node with no inbound
 * reachability of its own reserves a circuit-relay slot on a sibling control
 * node, and the party ends up able to dial it — WHETHER OR NOT the relay has
 * already replicated the reserver's membership row.
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
 * showed up".
 *
 * Cases 2 and 3 boot a relay-only node the relay has NOT authorized — the state
 * a genuine member is in during the window between booting and its `CadrePeer`
 * row replicating to the relay (case 2 uses a different-party reserver for
 * isolation; see its comment). Before the fix, A's membership connection gate
 * killed the reservation stream mid-handshake; both cases originally
 * characterized that failure and were FLIPPED when the relay-reservation seam
 * landed (`membership-connection-gater.ts` → "The relay-reservation seam"): the
 * relay now admits the connection for relay purposes and decides at the
 * reservation hook, where an unplaced peer gets a slot from the bounded
 * unauthorized-reservation budget.
 *
 * Cases 4 and 5 pin the bounds of that admission: an admitted-for-relay
 * stranger still cannot speak any control-DB protocol and is dropped when it
 * takes no reservation (case 4), and the unauthorized budget genuinely caps —
 * the peer past the cap is refused while an authorized member still reserves
 * (case 5).
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromString as libp2pPeerIdFromString } from '@libp2p/peer-id';
import type { Libp2p } from 'libp2p';
import { RepoClient } from '@optimystic/db-p2p';
import { peerIdFromString as repoPeerIdFromString } from '@optimystic/db-core';
import type { IPeerNetwork } from '@optimystic/db-core';
import { CadreNode } from '@serfab/cadre-core';
import {
	waitUntil,
	controlNodeConfig,
	makeOwnOwner,
	connectControlNodes,
	waitForControlConnection,
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

/** Minimal `IPeerNetwork` over a live libp2p node (same shape as control-stream-authz.integration.ts). */
function peerNetworkOver(node: Libp2p): IPeerNetwork {
	return {
		connect: async (peerId, protocol, options) =>
			await node.dialProtocol(libp2pPeerIdFromString(peerId.toString()), protocol, options),
	};
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
			// Authorized BEFORE it boots — the authorized-member reservation path.
			// Cases 2 and 3 boot the unauthorized state.
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

	it('an UNRECOGNIZED relay-only control node still reserves through the membership gate (fail-fast route)', async () => {
		// The relay-side admission decision under test is "a peer I cannot place
		// asks for a reservation over the configured `relayAddrs` route" — before
		// the fix, `start()` rejected with UnsupportedListenAddressesError (the
		// gate killed the reservation stream mid-handshake); now the seam admits
		// the connection and grants the reservation from the unauthorized budget.
		//
		// C is deliberately a DIFFERENT party's node: A cannot place it either way
		// (the admission decision is identical), and a same-party unauthorized C
		// would couple this case to a separate defect downstream of the fixed one —
		// once its connection survives, its control-DB schema hydration enlists A,
		// whose fail-closed per-stream gate refuses it, and `start()` fails with
		// BlockUnavailableError before the circuit address can be asserted. That
		// boot-ordering residual is tracked in
		// `bug-fail-fast-relay-boot-blocked-by-stream-gate`; the same-party window
		// end-to-end (boot solo, reserve unauthorized, then get authorized) is
		// case 3's fail-soft route.
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
				partyId: `${partyId}-outsider`,
				privateKey: cKey,
				strandFilter: 'none',
				listenAddrs: [],
				relayAddrs: [relayDialAddr(A)],
			}));

			let startError: unknown;
			await C.start().catch((error: unknown) => { startError = error; });
			const addrs = startError === undefined ? controlAddrs(C) : [];
			console.log('[relay-only-denied] startError=%s addrs=%o',
				startError === undefined ? 'none' : (startError as Error).message, addrs);

			expect(startError).toBeUndefined();
			expect(addrs.some(isCircuit)).toBe(true);
		} finally {
			await Promise.allSettled([C?.stop(), A?.stop()]);
		}
	}, 180_000);

	it('an UNAUTHORIZED relay-only control node reserves on the fail-soft search-listener route too', async () => {
		// The reported shape from gotchoices/Optimystic#12, exactly: a running
		// node whose only possible address is a relay slot it asks for explicitly
		// (`reserveRelays` over the bare `/p2p-circuit` search listener). Before
		// the fix this yielded `status: 'retrying'`, zero multiaddrs, and a
		// reservation-stream EOF — a healthy-looking node nobody could dial.
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

			expect(await A.isAuthorizedMember(cPeerId)).toBe(false);
			const reserved = await C.reserveRelays([relayDialAddr(A)]);
			console.log('[relay-only-soft] unauthorized status=%s error=%s addrs=%o',
				reserved.status, reserved.error, controlAddrs(C));
			expect(reserved.status).toBe('reserved');
			expect(controlAddrs(C).some(isCircuit)).toBe(true);

			// Authorizing the same peer must not cost it anything: the reservation
			// (and the address that rides on it) survives the row landing.
			await A.authorizePeer(cPeerId);
			expect((await C.reserveRelays([relayDialAddr(A)])).status).toBe('reserved');
			expect(controlAddrs(C).some(isCircuit)).toBe(true);
		} finally {
			await Promise.allSettled([C?.stop(), A?.stop()]);
		}
	}, 180_000);

	it('an admitted-for-relay stranger speaks no control-DB protocol and is dropped when it never reserves', async () => {
		// The two bounds on the relay-only admission (membership-connection-gater.ts
		// → "The relay-reservation seam"): the connection buys identify/ping and the
		// hop protocol only — the fail-closed per-stream gate still refuses the
		// control-DB surface (extending what control-stream-authz.integration.ts
		// proves for enrollment-window and delegate admissions) — and a connection
		// that takes no reservation is aborted at the not-reserving deadline
		// (RELAY_ADMISSION_RESERVE_DEADLINE_MS, 5 s).
		const partyId = `relay-stranger-${Date.now()}`;
		let A: CadreNode | undefined;
		let S: CadreNode | undefined;
		try {
			const aKey = await generateKeyPair('Ed25519');
			A = new CadreNode(controlNodeConfig({
				partyId, privateKey: aKey, profile: 'storage', enableRelay: true, strandFilter: 'none',
			}));
			await A.start();
			await makeOwnOwner(A, aKey);
			await A.authorizePeer(peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString());

			const aAddr = A.getControlNode()!.getMultiaddrs()[0]!;
			const aPeerId = A.peerId!.toString();

			// A different party's node, no relay listener, no reservation intent —
			// pure stranger. Before the fix its connection was denied outright; now
			// it is admitted for relay purposes only.
			S = new CadreNode(controlNodeConfig({ partyId: 'relay-stranger-outsider', strandFilter: 'none' }));
			await S.start();
			const sPeerId = S.peerId!.toString();
			const sNode = S.getControlNode()!;

			await sNode.dial(aAddr);
			await waitForControlConnection(A, sPeerId, 'relay admits the stranger connection (relay-only)');

			// Raw repo pend on the control-DB protocol while the connection lives:
			// the per-stream gate aborts the stream before any frame is decoded, so
			// the call rejects (reset, expiration, or the deadline dropping the
			// connection under it — any of which is a refusal).
			const sClient = RepoClient.create(
				repoPeerIdFromString(aPeerId),
				peerNetworkOver(sNode),
				`/optimystic/control-${partyId}`
			);
			await expect(
				sClient.pend(
					{
						transforms: { inserts: { 'relay-stranger-B1': { header: { id: 'relay-stranger-B1', type: 'TST', collectionId: 'relay-stranger-C1' } } } },
						actionId: 'relay-stranger-act-1',
						policy: 'c'
					},
					{ expiration: Date.now() + 8_000 }
				)
			).rejects.toThrow();

			// No reservation was ever admitted for S, so the not-reserving deadline
			// aborts the connection on both sides.
			await waitUntil(
				() => !sNode.getConnections().some(
					(c) => c.remotePeer.toString() === aPeerId && c.status === 'open'
				),
				{ timeoutMs: 20_000, intervalMs: 250, description: 'not-reserving stranger connection dropped' }
			);
			expect(
				A.getControlNode()!.getConnections().some(
					(c) => c.remotePeer.toString() === sPeerId && c.status === 'open'
				)
			).toBe(false);
		} finally {
			await Promise.allSettled([S?.stop(), A?.stop()]);
		}
	}, 120_000);

	it('the unauthorized-reservation budget bounds: past the cap refused, an authorized member still reserves', async () => {
		// Cap forced to 1 (network.unauthorizedRelayReservationCap) so the bound is
		// provable with two unauthorized reservers instead of
		// MAX_UNAUTHORIZED_RELAY_RESERVATIONS+1 nodes: the first takes the only
		// budget slot, the second is refused at the reservation hook, and an
		// authorized member — never counted against the budget — reserves anyway.
		const partyId = `relay-cap-${Date.now()}`;
		let A: CadreNode | undefined;
		let S1: CadreNode | undefined;
		let S2: CadreNode | undefined;
		let M: CadreNode | undefined;
		try {
			const aKey = await generateKeyPair('Ed25519');
			A = new CadreNode(controlNodeConfig({
				partyId, privateKey: aKey, profile: 'storage', enableRelay: true, strandFilter: 'none',
				unauthorizedRelayReservationCap: 1,
			}));
			await A.start();
			await makeOwnOwner(A, aKey);
			await A.authorizePeer(peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString());
			const relayAddr = relayDialAddr(A);

			// The unplaced reservers are DIFFERENT parties' nodes: A cannot place
			// them either way, and same-party strangers would join A's control
			// cohort (their nodes serve the party's protocols) and destabilize A's
			// own control-DB reads mid-test — observed as `authorizePeer` failing
			// on a peers-unreachable `Revocation` query when a deadline-dropped
			// stranger left the cohort mid-write.
			const searchListenerNode = async (party: string, key?: Awaited<ReturnType<typeof generateKeyPair>>): Promise<CadreNode> => {
				const node = new CadreNode(controlNodeConfig({
					partyId: party,
					...(key ? { privateKey: key } : {}),
					strandFilter: 'none',
					listenAddrs: ['/p2p-circuit'],
				}));
				await node.start();
				return node;
			};

			S1 = await searchListenerNode(`${partyId}-outsider-1`);
			const s1 = await S1.reserveRelays([relayAddr]);
			expect(s1.status).toBe('reserved');

			S2 = await searchListenerNode(`${partyId}-outsider-2`);
			const s2 = await S2.reserveRelays([relayAddr]);
			console.log('[relay-cap] over-cap status=%s error=%s', s2.status, s2.error);
			expect(s2.status).not.toBe('reserved');
			expect(controlAddrs(S2).some(isCircuit)).toBe(false);

			// The authorized member IS this party's node — never counted against
			// the budget, so it reserves with the cap already spent.
			const mKey = await generateKeyPair('Ed25519');
			await A.authorizePeer(peerIdFromPrivateKey(mKey).toString());
			M = await searchListenerNode(partyId, mKey);
			const m = await M.reserveRelays([relayAddr]);
			expect(m.status).toBe('reserved');
			expect(controlAddrs(M).some(isCircuit)).toBe(true);
		} finally {
			await Promise.allSettled([M?.stop(), S2?.stop(), S1?.stop(), A?.stop()]);
		}
	}, 180_000);
});
