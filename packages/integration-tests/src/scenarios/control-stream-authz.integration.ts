/**
 * E2E for the per-stream control-DB authorization gate
 * (`CadreNode.authorizeInboundControlStream` — the fail-closed layer wired as
 * `authorizeInboundStream` on the control node, behind the fail-open
 * connection gater).
 *
 * The hole this gate closes: the connection gater must admit strangers while
 * an enrollment window is open (`createInvite` — the invitee dials in before
 * it is authorized), and a connection-level decision cannot say "allow seed,
 * deny repo". So during that window an outsider HOLDS an admitted connection
 * to the owner — and without the stream gate it could speak the four
 * Optimystic control-DB protocols directly. This scenario drives the repo
 * protocol RAW (a `RepoClient` over a minimal `IPeerNetwork` stub) to prove,
 * over real WebSocket libp2p nodes:
 *
 *   1. Positive control: an authorized member's raw pend+commit against the
 *      owner's control repo succeeds (the gate admits members).
 *   2. Denial: the admitted-but-unauthorized outsider's raw pend on the very
 *      same protocol is refused. Upstream (`inbound-authorization.ts` in
 *      @optimystic/db-p2p) aborts the stream BEFORE any frame is decoded; the
 *      outsider observes only a stream reset (deliberately no error frame),
 *      so the client call rejects — with the reset error or its own
 *      expiration timeout, hence the generic `rejects.toThrow()`.
 *   3. Not-written probe: the member's `get` shows the outsider's block id
 *      absent from the owner's repo (and the member's own committed block
 *      present, proving the probe observes real writes).
 *   4. The outsider's CONNECTION survives the denied stream — connection
 *      admitted, stream refused: the two layers are genuinely distinct.
 *
 * Redirect robustness: `responsibilityK` defaults to 1 and the party's only
 * repo-serving cluster here is {owner, member}, so the owner is always in the
 * cluster for any block key and answers locally (no redirect). Even if a
 * redirect ever occurred, the denial is unaffected (the gate fires before the
 * service's redirect check) and "absent wherever the get lands" still means
 * not written.
 *
 * The outsider deliberately belongs to a DIFFERENT party: making it a second
 * owner of the SAME party would fork the control collection's history and
 * prove nothing about stream authorization. Party membership also keeps it
 * out of the owner's cluster cohort (network-membership scoping in
 * `libp2p-key-network.ts` drops peers that don't serve the party's
 * protocols), so it never participates in consensus either.
 */

import { describe, it, expect } from 'vitest';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromString as libp2pPeerIdFromString } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';
import type { Libp2p } from 'libp2p';
import { MemoryRawStorage, RepoClient } from '@optimystic/db-p2p';
import { peerIdFromString as repoPeerIdFromString } from '@optimystic/db-core';
import type { IPeerNetwork, IBlock } from '@optimystic/db-core';
import { CadreNode, ed25519KeyPairFromLibp2p, collectStrandAddrs } from '@serfab/cadre-core';
import type { CadreNodeConfig } from '@serfab/cadre-core';
import { waitUntil } from '../harness/index.js';

function wsTransports() {
	return [webSockets(), circuitRelayTransport()];
}

interface NodeOpts {
	partyId: string;
	privateKey?: PrivateKey;
	profile?: 'storage' | 'transaction';
	enableRelay?: boolean;
}

function nodeConfig(opts: NodeOpts): CadreNodeConfig {
	return {
		controlNetwork: { partyId: opts.partyId, bootstrapNodes: [] },
		profile: opts.profile ?? 'transaction',
		strandFilter: { mode: 'none' },
		storage: { provider: () => new MemoryRawStorage() },
		...(opts.privateKey ? { privateKey: opts.privateKey } : {}),
		network: {
			transports: wsTransports(),
			listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws'],
			...(opts.enableRelay ? { enableRelay: true } : {}),
		},
		hibernation: { enabled: false },
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

/**
 * Minimal `IPeerNetwork` over a live libp2p node — the only member
 * `ProtocolClient.processMessage` uses is `connect(peerId, protocol, opts)`.
 * The target must already be in the dialer's peerstore (guaranteed here by
 * the prior connection-level `dial(multiaddr)`), so `dialProtocol` by peer id
 * suffices. Re-parse the id because `RepoClient` hands back db-core's
 * structural PeerId, not a libp2p one.
 */
function peerNetworkOver(node: Libp2p): IPeerNetwork {
	return {
		connect: async (peerId, protocol, options) =>
			await node.dialProtocol(libp2pPeerIdFromString(peerId.toString()), protocol, options),
	};
}

describe('E2E per-stream control-DB stream authorization', () => {
	it('admits a member and refuses an enrollment-window outsider on the raw repo protocol, without dropping its connection', async () => {
		let A: CadreNode | undefined;
		let M: CadreNode | undefined;
		let O: CadreNode | undefined;
		try {
			// ── Owner A: founded (genesis anchor), holds the control-DB blocks ────
			const partyId = `stream-authz-${Date.now()}`;
			const aKey = await generateKeyPair('Ed25519');
			A = new CadreNode(nodeConfig({ partyId, privateKey: aKey, profile: 'storage', enableRelay: true }));
			await A.start();
			await makeOwnOwner(A, aKey);

			// Authorize M BEFORE it dials: `authorizePeer` refreshes the stream
			// gate's materialized snapshot inline, so both gates know M at once —
			// and the non-empty snapshot ARMS the stream gate (cold-start
			// carve-out closed) before the outsider ever shows up.
			const mKey = await generateKeyPair('Ed25519');
			const mPeerId = peerIdFromPrivateKey(mKey).toString();
			await A.authorizePeer(mPeerId);
			expect(await A.isAuthorizedMember(mPeerId)).toBe(true);

			const aAddr = A.getControlNode()!.getMultiaddrs()[0]!;
			const aPeerId = A.peerId!.toString();

			// ── Member M: same party, admitted at both layers ─────────────────────
			M = new CadreNode(nodeConfig({ partyId, privateKey: mKey }));
			await M.start();
			await M.getControlNode()!.dial(aAddr);
			await waitForConnection(A, mPeerId, 'owner admits its authorized member');

			// ── Outsider O: enrollment window open → connection ADMITTED ──────────
			const { invite } = await A.createInvite('stream-authz-invite', 60_000);
			expect(invite.token).toBe('stream-authz-invite');
			O = new CadreNode(nodeConfig({ partyId: 'stream-authz-outsider' }));
			await O.start();
			const oPeerId = O.peerId!.toString();
			await O.getControlNode()!.dial(aAddr);
			await waitForConnection(A, oPeerId, 'owner admits the outsider during the invite window');

			// ── Raw repo-protocol clients (bypass every cadre-core surface) ───────
			const protocolPrefix = `/optimystic/control-${partyId}`;
			const aRepoId = repoPeerIdFromString(aPeerId);
			const mClient = RepoClient.create(aRepoId, peerNetworkOver(M.getControlNode()!), protocolPrefix);
			const oClient = RepoClient.create(aRepoId, peerNetworkOver(O.getControlNode()!), protocolPrefix);

			const B1 = 'stream-authz-B1';
			const B2 = 'stream-authz-B2';
			const block = (id: string): IBlock => ({ header: { id, type: 'TST', collectionId: 'stream-authz-C1' } });

			// ── 1. Positive control: member's raw pend+commit succeeds ────────────
			const pend = await mClient.pend(
				{ transforms: { inserts: { [B1]: block(B1) } }, actionId: 'stream-authz-act-1', policy: 'c' },
				{ expiration: Date.now() + 20_000 }
			);
			expect(pend.success).toBe(true);
			const commit = await mClient.commit(
				{ blockIds: [B1], tailId: B1, actionId: 'stream-authz-act-1', rev: 1 },
				{ expiration: Date.now() + 20_000 }
			);
			expect(commit.success).toBe(true);

			// ── 2. Denial: outsider's identically-shaped pend is refused ──────────
			// The gate aborts the stream before decoding; the client sees a reset
			// or its own expiration — either way the call rejects.
			await expect(
				oClient.pend(
					{ transforms: { inserts: { [B2]: block(B2) } }, actionId: 'stream-authz-act-2', policy: 'c' },
					{ expiration: Date.now() + 10_000 }
				)
			).rejects.toThrow();

			// ── 3. Probe: nothing was written for the outsider ────────────────────
			// Served with skipClusterFetch (a local read of A's repo): B2 absent
			// proves the denied pend never reached the repo; B1 present proves
			// this same probe DOES observe real writes.
			const probe = await mClient.get(
				{ blockIds: [B1, B2] },
				{ expiration: Date.now() + 20_000 }
			);
			expect(probe[B1]?.block?.header.id).toBe(B1);
			expect(probe[B2]?.block).toBeUndefined();

			// ── 4. The outsider's CONNECTION survived the denied stream ───────────
			expect(
				O.getControlNode()!.getConnections().some(
					(c) => c.remotePeer.toString() === aPeerId && c.status === 'open'
				)
			).toBe(true);
			expect(
				A.getControlNode()!.getConnections().some(
					(c) => c.remotePeer.toString() === oPeerId && c.status === 'open'
				)
			).toBe(true);
		} finally {
			await Promise.allSettled([O?.stop(), M?.stop(), A?.stop()]);
		}
	}, 120_000);

	it('denies an un-announced stranger connection, admits an announced delegate, and still refuses that delegate the repo and strand-addr surfaces', async () => {
		let A: CadreNode | undefined;
		let D: CadreNode | undefined;
		try {
			// ── Relay-owner A: armed gate (anchored, non-empty authorized set, no
			// enrollment window, no outstanding invitation) ───────────────────────
			const partyId = `delegate-admission-${Date.now()}`;
			const aKey = await generateKeyPair('Ed25519');
			A = new CadreNode(nodeConfig({ partyId, privateKey: aKey, profile: 'storage', enableRelay: true }));
			await A.start();
			await makeOwnOwner(A, aKey);

			// The announcing member exists only as an authorized peerId — the grant
			// path needs an announcer identity, not a live sibling node.
			const mKey = await generateKeyPair('Ed25519');
			const mPeerId = peerIdFromPrivateKey(mKey).toString();
			await A.authorizePeer(mPeerId);

			const aAddr = A.getControlNode()!.getMultiaddrs()[0]!;
			const aPeerId = A.peerId!.toString();

			// ── Delegate node D: a different party's node standing in for a strand
			// node's derived transport identity — unknown to A's membership ───────
			D = new CadreNode(nodeConfig({ partyId: 'delegate-admission-outsider' }));
			await D.start();
			const dPeerId = D.peerId!.toString();
			const dNode = D.getControlNode()!;

			// ── (a) Un-announced: the inbound connection is DENIED ────────────────
			// The deny fires on A's side of the upgrade (after noise), so D's dial()
			// may resolve before A aborts — D then sees its connection close moments
			// later, and A never registers one (membership-connection-gater.ts).
			await dNode.dial(aAddr).catch(() => undefined);
			await waitUntil(
				() => !dNode.getConnections().some(
					(c) => c.remotePeer.toString() === aPeerId && c.status === 'open'
				),
				{ timeoutMs: 15_000, intervalMs: 250, description: 'stranger connection torn down by the gate' }
			);
			expect(
				A.getControlNode()!.getConnections().some(
					(c) => c.remotePeer.toString() === dPeerId && c.status === 'open'
				)
			).toBe(false);

			// ── (b) Announced: the same peerId, admitted by the grant alone ───────
			const strandId = 'delegate-admission-strand';
			A.grantDelegateAdmission(mPeerId, strandId, dPeerId);
			expect(A.hasDelegateAdmission(dPeerId)).toBe(true);
			await D.getControlNode()!.dial(aAddr);
			await waitForConnection(A, dPeerId, 'relay-owner admits the announced delegate');

			// ── (c) The admitted delegate still gets NOTHING above the connection ─
			// Raw repo pend on the control-DB protocol: the fail-closed per-stream
			// gate never honors a delegate grant, so the stream is aborted before
			// any frame is decoded and the call rejects.
			const dClient = RepoClient.create(
				repoPeerIdFromString(aPeerId),
				peerNetworkOver(D.getControlNode()!),
				`/optimystic/control-${partyId}`
			);
			const B3 = 'delegate-admission-B3';
			await expect(
				dClient.pend(
					{
						transforms: { inserts: { [B3]: { header: { id: B3, type: 'TST', collectionId: 'delegate-admission-C1' } } } },
						actionId: 'delegate-admission-act-1',
						policy: 'c'
					},
					{ expiration: Date.now() + 10_000 }
				)
			).rejects.toThrow();

			// Strand-addr: the responder's own isAuthorizedMember gate refuses a
			// non-member (the grant buys the connection, not the RPC) — refusal is
			// an empty address list by protocol design.
			const refused = await collectStrandAddrs(
				D.getControlNode()!,
				[{ peerId: aPeerId, addrs: [multiaddr(aAddr.toString())] }],
				strandId
			);
			expect(refused).toEqual([]);

			// The refused streams did not cost the delegate its connection — the
			// circuit-relay reservation riding it would survive.
			expect(
				A.getControlNode()!.getConnections().some(
					(c) => c.remotePeer.toString() === dPeerId && c.status === 'open'
				)
			).toBe(true);
		} finally {
			await Promise.allSettled([D?.stop(), A?.stop()]);
		}
	}, 120_000);
});
