/**
 * E2E for the control-network inbound connection gate
 * (`membership-connection-gater`, provisional admission).
 *
 * Proves, over real WebSocket libp2p nodes, the states of
 * `CadreNode.admitInboundControlConnection` and what the gate does with them:
 *
 *   1. Fully-established receiver (non-empty node-local trusted-owner anchor
 *      AND ≥1 authorized member): an outsider's connection is admitted
 *      PROVISIONALLY — it reaches the receiver, a members-only protocol on it is
 *      refused (the protocol guard), and the receiver closes it at the
 *      provisional deadline. An authorized member's connection is admitted
 *      outright. A live cadre invitation admits the same outsider outright: its
 *      next connection outlives the deadline, and so does the member's.
 *   2. The strand-formation window: a REGISTERED responder alone leaves a
 *      stranger provisional (closed at the deadline); a minted, unexpired open
 *      invitation admits it outright.
 *   3. The deadline's re-check: a stranger admitted provisionally whose
 *      membership row lands before the deadline keeps its connection — the
 *      gate's view of a sibling whose `CadrePeer` row was still replicating when
 *      it connected. Vouched locally here, which is the same row to the gate.
 *   4. An un-enrolled node (empty anchor, no members) admits a stranger outright —
 *      the precondition of seed delivery to a brand-new node.
 *
 * Every node declares a 100 ms link (`network.linkRoundTripMs`), so the
 * provisional deadline each receiver derives from it (`relayedRequestBudgetMs`)
 * is 4.7 s rather than the default declaration's 28.5 s; the waits below are
 * sized from that value. Whether a node runs the relay server does not change
 * any of this (`membership-connection-gater.spec.ts` pins the verdict both
 * ways); the reservation seam is `relay-only-control-addr.integration.ts`'s.
 *
 * No cross-node replication is required anywhere here (all membership rows are
 * written locally on the receiver).
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import type { PrivateKey } from '@libp2p/interface';
import { CadreNode, collectStrandAddrs, relayedRequestBudgetMs } from '@serfab/cadre-core';
import { waitUntil, sleep, controlNodeConfig, makeOwnOwner, waitForControlConnection } from '../harness/index.js';

const LINK_ROUND_TRIP_MS = 100;

/** The provisional-admission deadline every receiver here derives from its declared link. */
const PROVISIONAL_MS = relayedRequestBudgetMs(LINK_ROUND_TRIP_MS);

/** Long enough past the deadline for its re-check and close to have landed, had they been going to. */
const KEEP_WINDOW_MS = PROVISIONAL_MS + 3_000;

/** How long a provisional connection may take to be closed, counted from its admission. */
const CLOSE_WINDOW_MS = PROVISIONAL_MS + 10_000;

function nodeConfig(partyId: string, privateKey?: PrivateKey) {
	return controlNodeConfig({ partyId, privateKey, strandFilter: 'none', linkRoundTripMs: LINK_ROUND_TRIP_MS });
}

/** Does `from` hold an open control connection to `to`? */
function openTo(from: CadreNode, to: CadreNode): boolean {
	const toPeerId = to.peerId!.toString();
	return from.getControlNode()!.getConnections().some(
		(c) => c.remotePeer.toString() === toPeerId && c.status === 'open'
	);
}

/** A founded receiver with one authorized member row (whose node may or may not ever start). */
async function establishedReceiver(partyId: string, memberPeerId: string): Promise<CadreNode> {
	const rxKey = await generateKeyPair('Ed25519');
	const Rx = new CadreNode(nodeConfig(partyId, rxKey));
	await Rx.start();
	await makeOwnOwner(Rx, rxKey);
	// Owner-signed local write: the row carries a voucher by Rx's own genesis-anchored
	// key, so Rx's authorized set becomes non-empty and strangers stop being admitted
	// outright by the cold-start carve-out.
	await Rx.authorizePeer(memberPeerId);
	expect(await Rx.isAuthorizedMember(memberPeerId)).toBe(true);
	return Rx;
}

/** Dial `target` from `dialer` and wait until `target` has registered the connection. */
async function connect(dialer: CadreNode, target: CadreNode, description: string): Promise<void> {
	await dialer.getControlNode()!.dial(target.getControlNode()!.getMultiaddrs()[0]!);
	await waitForControlConnection(target, dialer.peerId!.toString(), description);
}

/** Wait until neither side holds an open control connection to the other. */
async function waitClosed(a: CadreNode, b: CadreNode, description: string): Promise<void> {
	await waitUntil(() => !openTo(a, b) && !openTo(b, a), { timeoutMs: CLOSE_WINDOW_MS, intervalMs: 100, description });
}

/** Wait out the provisional deadline, then require both sides to still hold the connection. */
async function expectKeptPastDeadline(a: CadreNode, b: CadreNode): Promise<void> {
	await sleep(KEEP_WINDOW_MS);
	expect(openTo(a, b)).toBe(true);
	expect(openTo(b, a)).toBe(true);
}

describe('E2E control-network membership connection gater', () => {
	it('admits an outsider provisionally and closes it at the deadline, admits a member outright, and an invitation admits the outsider outright', async () => {
		let Rx: CadreNode | undefined;
		let member: CadreNode | undefined;
		let outsider: CadreNode | undefined;
		try {
			const memberKey = await generateKeyPair('Ed25519');
			Rx = await establishedReceiver('gater-party', peerIdFromPrivateKey(memberKey).toString());
			const rxPeerId = Rx.peerId!.toString();

			// ── 1. Outsider: admitted provisionally, speaks nothing members-only, closed at the deadline ──
			outsider = new CadreNode(nodeConfig('outsider-party'));
			await outsider.start();
			await connect(outsider, Rx, 'receiver admits the outsider provisionally');

			// The protocol guard, not the connection gate, is what refuses a stranger:
			// a members-only request on the admitted connection is reset, which the
			// strand-addr asker reports as `unreachable`, with no addresses.
			const refused = await collectStrandAddrs(
				outsider.getControlNode()!,
				[{ peerId: rxPeerId, addrs: [multiaddr(Rx.getControlNode()!.getMultiaddrs()[0]!.toString())] }],
				'gater-strand'
			);
			expect(refused.addrs).toEqual([]);
			expect(refused.outcomes.get(rxPeerId)).toBe('unreachable');

			await waitClosed(outsider, Rx, 'receiver closes the outsider\'s connection at the provisional deadline');

			// ── 2. Authorized member: admitted outright ────────────────────────────
			member = new CadreNode(nodeConfig('gater-party', memberKey));
			await member.start();
			await connect(member, Rx, 'receiver admits its authorized member');

			// ── 3. A live cadre invitation admits the outsider outright ─────────────
			const { invitation } = await Rx.createCadreInvitation({ grantsOwner: false });
			expect(invitation.partyId).toBe('gater-party');
			await connect(outsider, Rx, 'receiver admits a stranger while an invitation is live');
			await expectKeptPastDeadline(outsider, Rx);
			expect(openTo(member, Rx)).toBe(true);
		} finally {
			await Promise.allSettled([outsider?.stop(), member?.stop(), Rx?.stop()]);
		}
	}, 120_000);

	it('the formation window follows the OUTSTANDING INVITATION, not the responder registration', async () => {
		// Wire-level counterpart to the unit coverage in
		// `cadre-core/test/membership-connection-gater.spec.ts`: registering the
		// strand-formation responder (what reference-app-rn does at node bring-up)
		// must NOT admit strangers outright, and minting an invitation must.
		let Rx: CadreNode | undefined;
		let outsider: CadreNode | undefined;
		try {
			Rx = await establishedReceiver('formation-gater-party', peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString());

			// Responder registered at start, nothing minted: provisional only.
			outsider = new CadreNode(nodeConfig('formation-outsider-party'));
			await outsider.start();
			await connect(outsider, Rx, 'receiver admits the outsider provisionally');
			await waitClosed(outsider, Rx, 'responder registered but no invitation: closed at the deadline');

			// Minting an open invitation is what says "I expect a stranger".
			await Rx.createOpenInvitation('gater-formation-sapp', 60_000);
			await connect(outsider, Rx, 'receiver admits a stranger while an invitation is outstanding');
			await expectKeptPastDeadline(outsider, Rx);
		} finally {
			await Promise.allSettled([outsider?.stop(), Rx?.stop()]);
		}
	}, 120_000);

	it('a provisionally admitted peer whose membership row lands before the deadline keeps its connection', async () => {
		let Rx: CadreNode | undefined;
		let late: CadreNode | undefined;
		try {
			Rx = await establishedReceiver('late-row-party', peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString());

			late = new CadreNode(nodeConfig('late-row-outsider-party'));
			await late.start();
			await connect(late, Rx, 'receiver admits the not-yet-vouched peer provisionally');

			// The row lands while the connection is provisional; the deadline's
			// re-check finds a member and keeps the connection.
			await Rx.authorizePeer(late.peerId!.toString());
			await expectKeptPastDeadline(late, Rx);
		} finally {
			await Promise.allSettled([late?.stop(), Rx?.stop()]);
		}
	}, 120_000);

	it('an un-enrolled node (empty anchor) admits a stranger — the seed-delivery precondition', async () => {
		let fresh: CadreNode | undefined;
		let stranger: CadreNode | undefined;
		try {
			fresh = new CadreNode(nodeConfig('fresh-party'));
			await fresh.start();
			const freshAddr = fresh.getControlNode()!.getMultiaddrs()[0]!;

			stranger = new CadreNode(nodeConfig('stranger-party'));
			await stranger.start();
			const strangerPeerId = stranger.peerId!.toString();

			await stranger.getControlNode()!.dial(freshAddr);
			await waitForControlConnection(fresh, strangerPeerId, 'un-enrolled node admits an unknown dialer');
		} finally {
			await Promise.allSettled([stranger?.stop(), fresh?.stop()]);
		}
	}, 60_000);
});
