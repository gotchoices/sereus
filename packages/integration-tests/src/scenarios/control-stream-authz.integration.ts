/**
 * E2E for the control node's per-stream protocol guard (`control-protocol-guard.ts`
 * — the fail-closed layer behind the fail-open connection gater, which also backs
 * Optimystic's own `authorizeInboundStream` check on the four control-DB protocols).
 *
 * The hole this gate closes: the connection gater admits every stranger's
 * connection — outright while a cadre invitation is live (`createCadreInvitation`
 * — the device dials in before it is authorized), provisionally otherwise — and a
 * connection-level decision cannot say "allow seed, deny repo". So an outsider
 * HOLDS an admitted connection to the owner — and without the stream gate it
 * could speak the four Optimystic control-DB protocols directly. This scenario drives the repo
 * protocol RAW (a `RepoClient` over a minimal `IPeerNetwork` stub), and every
 * other members-only protocol the owner serves, to prove, over real WebSocket
 * libp2p nodes:
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
 *   5. Stranger probe: on EVERY protocol the owner serves that is not declared
 *      stranger-open or libp2p plumbing (read off its live protocol list, so a
 *      members-only protocol added later is probed without editing this file), a
 *      stream from the outsider is reset with zero response bytes, and the delegate
 *      it announced was not granted.
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
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromString as libp2pPeerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import type { Libp2p } from 'libp2p';
import type { PeerId } from '@libp2p/interface';
import { RepoClient } from '@optimystic/db-p2p';
import { peerIdFromString as repoPeerIdFromString } from '@optimystic/db-core';
import type { IPeerNetwork, IBlock } from '@optimystic/db-core';
import { CadreNode, collectStrandAddrs, controlProtocolClasses, relayedRequestBudgetMs } from '@serfab/cadre-core';
import type { CadreNodeConfig } from '@serfab/cadre-core';
import { controlNodeConfig, makeOwnOwner, sleep, waitForControlConnection, waitUntil } from '../harness/index.js';
import type { ControlNodeOpts } from '../harness/index.js';

/** Every node here runs control-only (`strandFilter: 'none'`); nothing else differs. */
function nodeConfig(opts: Omit<ControlNodeOpts, 'strandFilter'>): CadreNodeConfig {
	return controlNodeConfig({ ...opts, strandFilter: 'none' });
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

/** The link the delegate case's relay-owner declares, so its provisional deadline is short enough to wait out. */
const A_LINK_ROUND_TRIP_MS = 100;

/** How long one probe stream may take to be refused before the probe counts it as answered by silence. */
const PROBE_TIMEOUT_MS = 10_000;

/** How a probe stream ended: refused by the remote (at open or after), closed cleanly, or never settled. */
type ProbeEnd = 'reset' | 'eof' | 'timeout';

interface ProbeResult {
	protocol: string;
	end: ProbeEnd;
	responseBytes: number;
	detail: string;
}

/** A 4-byte big-endian length-prefixed JSON frame, the framing of the Sereus control protocols. */
function sereusFrame(body: unknown): Uint8Array {
	const json = new TextEncoder().encode(JSON.stringify(body));
	const frame = new Uint8Array(4 + json.length);
	new DataView(frame.buffer).setUint32(0, json.length, false);
	frame.set(json, 4);
	return frame;
}

/** An unsigned-varint length-prefixed JSON frame, the framing of the Optimystic and FRET protocols. */
function varintFrame(body: unknown): Uint8Array {
	const json = new TextEncoder().encode(JSON.stringify(body));
	const prefix: number[] = [];
	for (let n = json.length; ; n >>>= 7) {
		if (n < 0x80) {
			prefix.push(n);
			break;
		}
		prefix.push((n & 0x7f) | 0x80);
	}
	const frame = new Uint8Array(prefix.length + json.length);
	frame.set(prefix, 0);
	frame.set(json, prefix.length);
	return frame;
}

/**
 * Open `protocol` to `target`, send `frame`, half-close, and read to the end, counting the
 * response bytes. A refused stream ends in a `reset`, at open or on the read; a handler that ran
 * and answered or closed ends in `eof`; one that holds the stream open ends in `timeout`.
 *
 * Bounded by racing a timer rather than by the dial's abort signal alone: once the stream is open,
 * a handler that never closes its side would otherwise hold the read for as long as it likes.
 */
async function probeStream(node: Libp2p, target: PeerId, protocol: string, frame: Uint8Array): Promise<ProbeResult> {
	let stream: Awaited<ReturnType<Libp2p['dialProtocol']>> | undefined;
	let responseBytes = 0;
	const exchange = (async (): Promise<ProbeResult> => {
		try {
			stream = await node.dialProtocol(target, protocol);
			stream.send(frame);
			await stream.close();
			for await (const chunk of stream) {
				responseBytes += chunk.byteLength;
			}
			return { protocol, end: 'eof', responseBytes, detail: 'stream closed cleanly' };
		} catch (error) {
			const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			return { protocol, end: 'reset', responseBytes, detail };
		}
	})();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<ProbeResult>((resolve) => {
		timer = setTimeout(() => resolve({ protocol, end: 'timeout', responseBytes, detail: `no end within ${PROBE_TIMEOUT_MS}ms` }), PROBE_TIMEOUT_MS);
	});
	try {
		return await Promise.race([exchange, timedOut]);
	} finally {
		clearTimeout(timer);
		stream?.abort(new Error('probe finished'));
	}
}

describe('E2E per-stream control-DB stream authorization', () => {
	it('admits a member and refuses an invitation-admitted outsider on the raw repo protocol, without dropping its connection', async () => {
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
			await waitForControlConnection(A, mPeerId, 'owner admits its authorized member');

			// ── Outsider O: a live cadre invitation is held → connection ADMITTED ──
			const { invitation } = await A.createCadreInvitation({ grantsOwner: false });
			expect(invitation.invite.grantsOwner).toBe(false);
			O = new CadreNode(nodeConfig({ partyId: 'stream-authz-outsider' }));
			await O.start();
			const oPeerId = O.peerId!.toString();
			await O.getControlNode()!.dial(aAddr);
			await waitForControlConnection(A, oPeerId, 'owner admits the outsider while an invitation is live');

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

			// ── 5. Stranger probe: every members-only protocol A serves ──────────
			// Read off A's live protocol list. A protocol with no class is guarded as
			// members-only too, so it is probed rather than skipped.
			const classes = controlProtocolClasses(partyId);
			const membersOnly = A.getControlNode()!.getProtocols().filter((protocol) => {
				const protocolClass = classes.get(protocol);
				return protocolClass !== 'stranger-open' && protocolClass !== 'transport';
			});
			expect(membersOnly).toEqual(expect.arrayContaining([
				'/sereus/strand-wake/1.0.0', '/sereus/strand-addr/1.0.0', `${protocolPrefix}/fret/1.0.0/neighbors/announce`
			]));
			// Each frame is one the protocol's handler would act on if it ran: a wake, an
			// address request announcing a delegate, a FRET announce naming the outsider.
			const announcedDelegate = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
			const sereusRequest = sereusFrame({ strandId: 'stream-authz-strand', reason: 'probe', delegatePeerId: announcedDelegate });
			const fretAnnounce = varintFrame({ from: oPeerId, timestamp: Date.now(), successors: [], predecessors: [], sample: [] });
			const aLibp2pId = libp2pPeerIdFromString(aPeerId);
			const oNode = O.getControlNode()!;
			const probes = await Promise.all(membersOnly.map((protocol) => probeStream(
				oNode, aLibp2pId, protocol, protocol.startsWith('/sereus/') ? sereusRequest : fretAnnounce
			)));
			// Sent by the authorized member M instead, these frames draw a reply on every
			// protocol here except repo and block-transfer, whose handlers reset a frame they
			// cannot parse (measured 2026-10-07). So on the others a reset with nothing
			// received is the guard; for repo, the raw pend in step 2 is the proof.
			const answered = probes.filter((probe) => probe.end !== 'reset' || probe.responseBytes > 0);
			expect(answered, JSON.stringify(answered, null, 1)).toEqual([]);

			// The address request's delegate announce did not land.
			expect(A.hasDelegateAdmission(announcedDelegate)).toBe(false);
			// NOTE: not asserted: that A's FRET ring and control-database cohort exclude O. They
			// do not. libp2p records every protocol a peer opens a stream on as one that peer
			// serves, before any handler runs, and FRET and Optimystic count a peer serving the
			// party's protocols as a ring and cohort member, so after this probe O is in the
			// cohort for A's control blocks. Ticket
			// `stranger-joins-the-control-cohort-by-advertising-protocols`.
		} finally {
			await Promise.allSettled([O?.stop(), M?.stop(), A?.stop()]);
		}
	}, 120_000);

	it('closes an un-announced stranger\'s provisional connection at the deadline, admits an announced delegate outright, and still refuses that delegate the repo and strand-addr surfaces', async () => {
		let A: CadreNode | undefined;
		let D: CadreNode | undefined;
		try {
			// ── Relay-owner A: armed gate (anchored, non-empty authorized set, no
			// enrollment window, no outstanding invitation) ───────────────────────
			const partyId = `delegate-admission-${Date.now()}`;
			// A declares a 100 ms link so the provisional deadline it derives from it
			// (`relayedRequestBudgetMs`) is 4.7 s rather than the default declaration's 28.5 s.
			const aKey = await generateKeyPair('Ed25519');
			A = new CadreNode(nodeConfig({
				partyId, privateKey: aKey, profile: 'storage', enableRelay: true, linkRoundTripMs: A_LINK_ROUND_TRIP_MS,
			}));
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

			// ── (a) Un-announced: the connection does not survive ─────────────────
			// A cannot place D, so D is admitted PROVISIONALLY
			// (membership-connection-gater.ts → "Provisional admission") — and since
			// nothing makes D admissible and it never has a reservation admitted, A
			// closes the connection at the provisional deadline. The wait is
			// generous against that deadline: the close lands within a few hundred
			// milliseconds of it.
			await dNode.dial(aAddr).catch(() => undefined);
			await waitUntil(
				() => !dNode.getConnections().some(
					(c) => c.remotePeer.toString() === aPeerId && c.status === 'open'
				),
				{
					timeoutMs: relayedRequestBudgetMs(A_LINK_ROUND_TRIP_MS) + 10_000,
					intervalMs: 250,
					description: 'un-announced stranger connection closed at the provisional deadline',
				}
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
			await waitForControlConnection(A, dPeerId, 'relay-owner admits the announced delegate');

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

			// Strand-addr: the responder's protocol guard refuses a non-member (the
			// grant buys the connection, not the RPC) by resetting the stream, which
			// the asker reports as `unreachable`, with no addresses.
			const refused = await collectStrandAddrs(
				D.getControlNode()!,
				[{ peerId: aPeerId, addrs: [multiaddr(aAddr.toString())] }],
				strandId
			);
			expect(refused.addrs).toEqual([]);
			expect(refused.outcomes.get(aPeerId)).toBe('unreachable');

			// The refused streams did not cost the delegate its connection, and the
			// grant admitted it outright: it outlives the provisional deadline that
			// closed the un-announced connection in (a), so the circuit-relay
			// reservation riding it would survive.
			await sleep(relayedRequestBudgetMs(A_LINK_ROUND_TRIP_MS) + 3_000);
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
