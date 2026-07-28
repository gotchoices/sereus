/**
 * E2E for the control-network inbound connection gate
 * (`membership-connection-gater`, chain step 6 — defense-in-depth).
 *
 * Proves, over real WebSocket libp2p nodes, the three states of
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
 *   3. An un-enrolled node (empty anchor, no members) admits strangers — the
 *      precondition of seed delivery to a brand-new node.
 *
 * No cross-node replication is required anywhere here (all membership rows are
 * written locally on the receiver), so this scenario is untouched by the
 * blocked optimystic convergence issue.
 */

import { describe, it, expect } from 'vitest';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { CadreNode, ed25519KeyPairFromLibp2p } from '@serfab/cadre-core';
import type { CadreNodeConfig } from '@serfab/cadre-core';
import { waitUntil } from '../harness/index.js';

function wsTransports() {
	return [webSockets(), circuitRelayTransport()];
}

function nodeConfig(partyId: string, privateKey?: PrivateKey): CadreNodeConfig {
	return {
		controlNetwork: { partyId, bootstrapNodes: [] },
		profile: 'transaction',
		strandFilter: { mode: 'none' },
		storage: { provider: () => new MemoryRawStorage() },
		...(privateKey ? { privateKey } : {}),
		network: {
			transports: wsTransports(),
			listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws'],
		},
	};
}

/** Genesis: enroll the node's own derived key and wire seed-bootstrap (anchors it). */
async function makeOwnOwner(node: CadreNode, key: PrivateKey): Promise<void> {
	const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(key);
	const db = node.getControlDatabase();
	if (!db) throw new Error('control database missing after start');
	await db.insertOwnerKey(publicKeyB64);
	node.initializeSeedBootstrap(privateKeyB64);
}

/** Wait until `node`'s control node reports a live connection to `peerId`. */
async function waitForConnection(node: CadreNode, peerId: string, description: string): Promise<void> {
	await waitUntil(
		() => node.getControlNode()!.getConnections().some((c) => c.remotePeer.toString() === peerId),
		{ timeoutMs: 15_000, intervalMs: 250, description }
	);
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
			await waitForConnection(Rx, memberPeerId, 'receiver admits its authorized member');
			await waitForConnection(member, rxPeerId, 'member sees the receiver connection');

			// ── 3. Enrollment carve-out: createInvite re-opens the door ────────────
			const { invite } = await Rx.createInvite('gater-invite-token', 60_000);
			expect(invite.token).toBe('gater-invite-token');
			await outsider.getControlNode()!.dial(rxAddr);
			await waitForConnection(Rx, outsiderPeerId, 'receiver admits a stranger during the invite window');
		} finally {
			await Promise.allSettled([outsider?.stop(), member?.stop(), Rx?.stop()]);
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
			await waitForConnection(fresh, strangerPeerId, 'un-enrolled node admits an unknown dialer');
		} finally {
			await Promise.allSettled([stranger?.stop(), fresh?.stop()]);
		}
	}, 60_000);
});
