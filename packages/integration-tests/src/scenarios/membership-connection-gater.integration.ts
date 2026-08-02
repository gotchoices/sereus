/**
 * E2E for the control-network inbound connection gate
 * (`membership-connection-gater`, chain step 6 — defense-in-depth).
 *
 * Proves, over real WebSocket libp2p nodes, the states of
 * `CadreNode.admitInboundControlConnection`:
 *
 *   1. Fully-established receiver (non-empty node-local trusted-owner anchor
 *      AND ≥1 authorized member): an outsider is refused at the connection
 *      layer while an authorized member's dial succeeds. Deny timing nuance:
 *      noise negotiates the muxer in the security handshake's early data, so
 *      the DIALER's upgrade can complete (dial() resolves) before the
 *      RECEIVER's upgrade reaches the gate — the deny then aborts the
 *      receiver-side upgrade, the receiver never registers the connection,
 *      its muxer is never created (so no protocol can ever be negotiated),
 *      and the dialer sees the connection close moments later. The assertions
 *      below target that real observable: no surviving connection on either
 *      side, and a protocol dial that cannot complete.
 *   2. The enrollment carve-out: `createInvite` opens the window and the same
 *      outsider's dial then succeeds (the invitee must dial in before it is
 *      authorized).
 *   3. The strand-formation carve-out: a REGISTERED responder alone does not
 *      admit anyone; a minted, unexpired open invitation does.
 *   4. An un-enrolled node (empty anchor, no members) admits strangers — the
 *      precondition of seed delivery to a brand-new node.
 *
 * No cross-node replication is required anywhere here (all membership rows are
 * written locally on the receiver), so this scenario is untouched by the
 * blocked optimystic convergence issue.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import { CadreNode } from '@serfab/cadre-core';
import { waitUntil, controlNodeConfig, makeOwnOwner, waitForControlConnection } from '../harness/index.js';

function nodeConfig(partyId: string, privateKey?: PrivateKey) {
	return controlNodeConfig({ partyId, privateKey, strandFilter: 'none' });
}

describe('E2E control-network membership connection gater', () => {
	it('denies an outsider at the connection layer, admits an authorized member, and re-opens for an invite', async () => {
		let Rx: CadreNode | undefined;
		let member: CadreNode | undefined;
		let outsider: CadreNode | undefined;
		try {
			// ── Receiver: founded (genesis anchor) with one authorized member row ──
			const rxKey = await generateKeyPair('Ed25519');
			Rx = new CadreNode(nodeConfig('gater-party', rxKey));
			await Rx.start();
			await makeOwnOwner(Rx, rxKey);

			const memberKey = await generateKeyPair('Ed25519');
			const memberPeerId = peerIdFromPrivateKey(memberKey).toString();
			// Owner-signed local write: the row carries a voucher by Rx's own
			// genesis-anchored key, so Rx's authorized set becomes non-empty and
			// the gate switches from cold-start-admit-all to enforcing.
			await Rx.authorizePeer(memberPeerId);
			expect(await Rx.isAuthorizedMember(memberPeerId)).toBe(true);

			const rxAddr = Rx.getControlNode()!.getMultiaddrs()[0]!;
			const rxPeerId = Rx.peerId!.toString();

			// ── 1. Outsider: denied — no surviving connection, no protocol spoken ──
			outsider = new CadreNode(nodeConfig('outsider-party'));
			await outsider.start();
			const outsiderPeerId = outsider.peerId!.toString();
			const outsiderNode = outsider.getControlNode()!;

			// The dial may resolve optimistically (see header) — what matters is
			// that the receiver kills it: the outsider ends up with no open
			// connection to Rx, and Rx never registers one from the outsider.
			await outsiderNode.dial(rxAddr).catch(() => undefined);
			await waitUntil(
				() => !outsiderNode.getConnections().some(
					(c) => c.remotePeer.toString() === rxPeerId && c.status === 'open'
				),
				{ timeoutMs: 15_000, intervalMs: 100, description: 'receiver aborts the outsider connection' }
			);
			expect(
				Rx.getControlNode()!.getConnections().some((c) => c.remotePeer.toString() === outsiderPeerId)
			).toBe(false);

			// "Not even in the conversation": a protocol dial cannot complete —
			// the receiver's upgrade dies at the gate, so its muxer never exists
			// and stream negotiation can never be answered.
			await expect(
				outsiderNode.dialProtocol(rxAddr, '/sereus/strand-wake/1.0.0')
			).rejects.toThrow();

			// ── 2. Authorized member: admitted ─────────────────────────────────────
			member = new CadreNode(nodeConfig('gater-party', memberKey));
			await member.start();
			await member.getControlNode()!.dial(rxAddr);
			await waitForControlConnection(Rx, memberPeerId, 'receiver admits its authorized member');
			await waitForControlConnection(member, rxPeerId, 'member sees the receiver connection');

			// ── 3. Enrollment carve-out: createInvite re-opens the door ────────────
			const { invite } = await Rx.createInvite('gater-invite-token', 60_000);
			expect(invite.token).toBe('gater-invite-token');
			await outsider.getControlNode()!.dial(rxAddr);
			await waitForControlConnection(Rx, outsiderPeerId, 'receiver admits a stranger during the invite window');
		} finally {
			await Promise.allSettled([outsider?.stop(), member?.stop(), Rx?.stop()]);
		}
	}, 120_000);

	it('the formation carve-out follows the OUTSTANDING INVITATION, not the responder registration', async () => {
		// Wire-level counterpart to the unit coverage in
		// `cadre-core/test/membership-connection-gater.spec.ts`: registering the
		// strand-formation responder (what reference-app-rn does at node bring-up)
		// must NOT disarm the gate, and minting an invitation must re-arm the
		// carve-out over a real dial.
		let Rx: CadreNode | undefined;
		let outsider: CadreNode | undefined;
		try {
			const rxKey = await generateKeyPair('Ed25519');
			Rx = new CadreNode(nodeConfig('formation-gater-party', rxKey));
			await Rx.start();
			await makeOwnOwner(Rx, rxKey);
			await Rx.authorizePeer(peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString());

			// Responder registered, nothing minted — the old carve-out would have
			// admitted everyone from here on.
			Rx.initializeStrandSolicitation();

			const rxAddr = Rx.getControlNode()!.getMultiaddrs()[0]!;
			const rxPeerId = Rx.peerId!.toString();

			outsider = new CadreNode(nodeConfig('formation-outsider-party'));
			await outsider.start();
			const outsiderPeerId = outsider.peerId!.toString();
			const outsiderNode = outsider.getControlNode()!;

			await outsiderNode.dial(rxAddr).catch(() => undefined);
			await waitUntil(
				() => !outsiderNode.getConnections().some(
					(c) => c.remotePeer.toString() === rxPeerId && c.status === 'open'
				),
				{ timeoutMs: 15_000, intervalMs: 100, description: 'responder registered but no invitation: dial refused' }
			);
			expect(
				Rx.getControlNode()!.getConnections().some((c) => c.remotePeer.toString() === outsiderPeerId)
			).toBe(false);

			// Minting an open invitation is what says "I expect a stranger".
			await Rx.createOpenInvitation('gater-formation-sapp', 60_000);
			await outsiderNode.dial(rxAddr);
			await waitForControlConnection(Rx, outsiderPeerId, 'receiver admits a stranger while an invitation is outstanding');
		} finally {
			await Promise.allSettled([outsider?.stop(), Rx?.stop()]);
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
