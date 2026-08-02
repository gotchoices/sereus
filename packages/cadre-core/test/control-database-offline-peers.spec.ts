import { describe, it, expect } from 'vitest';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { webRTC, webRTCDirect } from '@libp2p/webrtc';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';
import type { Multiaddr } from '@multiformats/multiaddr';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { CadreNode } from '../src/cadre-node.js';
import { InMemoryKeyStore } from '../src/key-store.js';
import { ed25519KeyPairFromLibp2p } from '../src/ed25519-key.js';
import { signPeerRecord } from '../src/peer-record.js';
import {
	controlNodeConfig,
	expectNotListening,
	freshPartyId,
	withinOp
} from './control-db-node-helpers.js';
import type { NetworkConfig, NodeProfile } from '../src/types.js';

/**
 * A cadre of MORE THAN ONE whose known siblings are all unreachable — the
 * normal state of a phone + laptop setup most of the day. Every row this node
 * reads is already in its own local control database, and Optimystic downsizes
 * a cohort it cannot fill, so the required outcome for every control read and
 * write here is **answer locally** — not "fail fast", and certainly not hang.
 * A rejection is a finding, and so is a silently empty read where local rows
 * exist, so contents are asserted, not just settlement.
 *
 * The cadre-of-one shape lives in `control-database-solo.spec.ts` (shared
 * harness: `control-db-node-helpers.ts`). Members that are connected-but-slow
 * are a different question (they DO enter the write cohort) and are not
 * covered here.
 *
 * Two flavours of unreachable:
 *  - **departed** — a real second `CadreNode` whose captured listen address is
 *    dead after `stop()`: the OS refuses the connection immediately, and the
 *    left-behind address is one that was genuinely published.
 *  - **blackhole** — RFC 5737 TEST-NET-1 (`192.0.2.0/24`), guaranteed
 *    unrouted: the connect never gets an answer, which is where a freeze would
 *    live. Only liveness is asserted, never timing — if some CI network
 *    answers TEST-NET-1 the case degrades into the refused flavour, which must
 *    still pass.
 *
 * Anti-vacuity: `authorizePeer` writes `Sig: null` rows that resolve to `[]`,
 * so no dial would ever be attempted against them. Every offline sibling here
 * is minted with a valid self-signed, fresh record, and `resolvePeerAddrs` is
 * asserted non-empty before the operation set runs — that assertion is the
 * guard that the dial path is armed.
 */

/** Per-operation budget. All reads/writes answer from local rows; this only catches hangs. */
const OP_TIMEOUT_MS = 15_000;
/**
 * One reconcile pass deliberately dials dead addresses; js-libp2p's own dial
 * timeout (~10 s per attempt, no override in db-p2p's libp2p config) governs
 * how long each blackhole dial blocks the sequential dial loop.
 */
const RECONCILE_TIMEOUT_MS = 30_000;
/**
 * Three blackhole siblings dialed SEQUENTIALLY ≈ 3 × the ~10 s per-dial
 * timeout, which busts the single-sibling budget — hence the wider one.
 */
const MULTI_RECONCILE_TIMEOUT_MS = 60_000;
/** `start()`/`stop()` bring libp2p up and down — a looser budget, still bounded. */
const LIFECYCLE_TIMEOUT_MS = 30_000;

/** {@link withinOp} scoped to this spec: `offline-peer control op <label> …`. */
function within<T>(label: string, ms: number, op: () => Promise<T>): Promise<T> {
	return withinOp('offline-peer', label, ms, op);
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Abbreviate a peerId for timeout labels. */
const short = (peerId: string) => peerId.slice(-8);

/** Peek the private write-while-alone queue (same cast pattern as `cadre-node-control-cohort.spec.ts`). */
function pendingPeerWrites(node: CadreNode): Map<string, 'authorize'> {
	return (node as unknown as { pendingPeerWrites: Map<string, 'authorize'> }).pendingPeerWrites;
}

/** Peek the private delete-while-alone tombstone queue (keyed by the retired StampId). */
function pendingRevocations(node: CadreNode): Map<string, { tableName: string; rowKey: string; stampId: string }> {
	return (node as unknown as {
		pendingRevocations: Map<string, { tableName: string; rowKey: string; stampId: string }>;
	}).pendingRevocations;
}

interface OwnerNode {
	node: CadreNode;
	ownerPublicKey: string;
	selfPeerId: string;
}

/** Start a node in the non-listening posture and assert it really came up that way. */
async function startControlNode(node: CadreNode): Promise<OwnerNode> {
	await within('node.start()', LIFECYCLE_TIMEOUT_MS, () => node.start());
	expectNotListening(node);
	expect(node.getControlDatabase()).not.toBeNull();
	return {
		node,
		ownerPublicKey: node.getIdentityOwnerKey().publicKeyB64,
		selfPeerId: node.peerId!.toString()
	};
}

/** First boot: anchor the node's own identity as the founding owner, then publish self. */
async function genesisOwner(owner: OwnerNode): Promise<void> {
	const { privateKeyB64, publicKeyB64 } = owner.node.getIdentityOwnerKey();
	const db = owner.node.getControlDatabase()!;
	expect(await within('ensureOwnerKey() (genesis)', OP_TIMEOUT_MS, () => db.ensureOwnerKey(publicKeyB64)))
		.toBe(true);
	owner.node.initializeSeedBootstrap(privateKeyB64);
	expect(await within('registerSelf() (genesis)', OP_TIMEOUT_MS, () => owner.node.registerSelf()))
		.toBe('inserted');
}

/**
 * Warm boot on rows written by a previous run: the owner key must already be
 * there (a re-`ensureOwnerKey` is a no-op), and seed bootstrap is re-wired
 * exactly as an embedding app does on every launch.
 */
async function rejoinOwner(owner: OwnerNode): Promise<void> {
	const { privateKeyB64, publicKeyB64 } = owner.node.getIdentityOwnerKey();
	const db = owner.node.getControlDatabase()!;
	expect(await within('hasOwnerKey() (warm start)', OP_TIMEOUT_MS, () => db.hasOwnerKey())).toBe(true);
	expect(await within('ensureOwnerKey() (warm start)', OP_TIMEOUT_MS, () => db.ensureOwnerKey(publicKeyB64)))
		.toBe(false);
	owner.node.initializeSeedBootstrap(privateKeyB64);
}

/**
 * Boot the node under test as its own owner (genesis exactly as the solo spec
 * does), in the mobile/browser posture: WebSockets-only, no listen address,
 * no bootstrap peers.
 */
async function bootOwnerNode(
	profile: NodeProfile,
	tag: string,
	transports?: NetworkConfig['transports']
): Promise<OwnerNode> {
	const owner = await startControlNode(new CadreNode(controlNodeConfig({
		partyId: freshPartyId(`offline-${tag}`),
		profile,
		keyStore: new InMemoryKeyStore(),
		storage: new MemoryRawStorage(),
		...(transports ? { transports } : {})
	})));
	await genesisOwner(owner);
	return owner;
}

interface OfflinePeer {
	peerId: string;
	addrs: string[];
}

/**
 * Owner-insert a self-signed, fresh `CadrePeer` record for an offline sibling,
 * then assert it RESOLVES — without this the spec is vacuous (an unsigned or
 * stale row resolves to `[]`, the peerStore fallback misses too, and no dial
 * is ever attempted).
 */
async function insertResolvableOfflinePeer(
	owner: OwnerNode,
	key: PrivateKey,
	addrs: string[]
): Promise<OfflinePeer> {
	const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(key);
	const peerId = peerIdFromPrivateKey(key).toString();
	const record = signPeerRecord({ peerId, publicKey: publicKeyB64, addrs, updatedAt: Date.now() }, privateKeyB64);
	await owner.node.getSeedBootstrapService()!.insertSelfPeerRecord(record);

	const resolved = await within(`resolvePeerAddrs(${short(peerId)}) (anti-vacuity)`, OP_TIMEOUT_MS,
		() => owner.node.resolvePeerAddrs(peerId));
	expect(new Set(resolved.map((m) => m.toString()))).toEqual(new Set(addrs));
	return { peerId, addrs };
}

/**
 * Mint a sibling at an RFC 5737 TEST-NET-1 address (guaranteed unrouted — the
 * connect never answers). `n` keeps each sibling's address distinct.
 */
async function mintBlackholePeer(owner: OwnerNode, n: number): Promise<OfflinePeer> {
	const key = await generateKeyPair('Ed25519');
	const peerId = peerIdFromPrivateKey(key).toString();
	return insertResolvableOfflinePeer(owner, key, [`/ip4/192.0.2.${n}/tcp/4001/ws/p2p/${peerId}`]);
}

/**
 * Mint a DEPARTED sibling: a real second `CadreNode` started on a loopback
 * WebSocket listen address, its genuinely-published address captured, then
 * stopped — so the OS refuses the connection immediately.
 */
async function mintDepartedPeer(owner: OwnerNode): Promise<OfflinePeer> {
	const key: PrivateKey = await generateKeyPair('Ed25519');
	const sibling = new CadreNode({
		controlNetwork: {
			partyId: freshPartyId('offline-departed-sibling'),
			bootstrapNodes: []
		},
		profile: 'transaction',
		privateKey: key,
		storage: { provider: () => new MemoryRawStorage() },
		network: {
			transports: [webSockets()],
			listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws']
		}
	});
	let addrs: string[];
	try {
		await within('departed sibling start()', LIFECYCLE_TIMEOUT_MS, () => sibling.start());
		addrs = sibling.getMultiaddrs();
		expect(addrs.length).toBeGreaterThan(0);
	} finally {
		await within('departed sibling stop()', LIFECYCLE_TIMEOUT_MS, () => sibling.stop());
	}
	return insertResolvableOfflinePeer(owner, key, addrs);
}

// ============================================================================
// WebRTC transport shapes
//
// NOTE: `@libp2p/webrtc`'s Node entry point re-exports `node-datachannel`'s
// polyfill, a NATIVE module shipped with prebuilt binaries. On a platform with
// no prebuild it is compiled from source (cmake) at install time, and on a
// platform where the binding cannot load at all the `import` at the top of this
// file fails the WHOLE spec file, not just the WebRTC cases. If that happens in
// CI, the fix is a prebuild/toolchain one — do not delete the coverage.
// ============================================================================

/**
 * An arbitrary sha2-256 multihash (base64url, `u`-prefixed), standing in for a
 * `/webrtc-direct` peer's certificate hash. It is never verified against
 * anything — the connect never gets an answer — but it must be syntactically
 * valid, because `multiaddr()` throws on a malformed certhash and
 * `parseMultiaddrs` then silently DROPS the address, putting the case straight
 * back into vacuity.
 */
const WEBRTC_CERTHASH = 'uEiDriKKtLzKrTdlDsdqSFqCGZ5uV1Sy4rDeYcTNTNKgpJQ';

/**
 * db-p2p's transport-factory element type. The WebRTC factories need the same
 * brand-skew bridge the browser app uses — see the `TransportFactory` comment in
 * `reference-app-web/src/lib/cadre-web.ts` for the full explanation:
 * `@libp2p/webrtc` nests its own physical copy of `@libp2p/interface`, and
 * `transportSymbol` is a `unique symbol`, so the two brands differ by identity
 * while being runtime-identical. `webSockets()` and `circuitRelayTransport()`
 * need no bridge — they resolve to the hoisted copy.
 */
type TransportFactory = NonNullable<NetworkConfig['transports']>[number];

/**
 * The browser reference app's transport list
 * (`reference-app-web/src/lib/cadre-web.ts`). No `rtcConfiguration`: the app
 * passes ICE servers from its runtime manifest, but a test must never reach a
 * STUN/TURN host — host candidates are enough to arm a dial.
 */
const browserTransports = (): NetworkConfig['transports'] => [
	webSockets(),
	circuitRelayTransport(),
	webRTC() as unknown as TransportFactory,
	webRTCDirect() as unknown as TransportFactory
];

/** The phone reference app's transport list (`reference-app-rn/src/cadre-phone.ts`) — no `webRTCDirect`. */
const phoneTransports = (): NetworkConfig['transports'] => [
	webSockets(),
	circuitRelayTransport(),
	webRTC() as unknown as TransportFactory
];

/**
 * The transport libp2p would dial `addr` with, by its `Symbol.toStringTag`
 * (`@libp2p/webrtc`, `@libp2p/webrtc-direct`, `@libp2p/websockets`, …), or null
 * when no configured transport claims it. `components` is not on the public
 * `Libp2p` interface, so this peeks the same way {@link pendingPeerWrites}
 * does; `dialTransportForMultiaddr` is declared on `TransportManager` in
 * `@libp2p/interface-internal`, typed structurally here rather than pulling in
 * that package for one call.
 */
function dialTransportTag(node: CadreNode, addr: Multiaddr): string | null {
	const libp2p = node.getControlNode();
	expect(libp2p).not.toBeNull();
	const transport = (libp2p as unknown as {
		components: {
			transportManager: {
				dialTransportForMultiaddr(ma: Multiaddr): { readonly [Symbol.toStringTag]: string } | undefined;
			};
		};
	}).components.transportManager.dialTransportForMultiaddr(addr);
	return transport ? String(transport[Symbol.toStringTag]) : null;
}

/**
 * Assert libp2p routes each address to the named transport — `null` meaning no
 * configured transport claims it, so libp2p filters it out of a dial entirely.
 *
 * This is the anti-vacuity guard for every WebRTC case. Merely LISTING
 * `webRTC()` in the transports proves nothing: `reconcileControlCohort` dials
 * whatever `resolvePeerAddrs` returns, and a sibling recorded at a `/ws`
 * address is dialed by WebSockets no matter what else is configured — the
 * WebRTC transports would be dead weight and the case a rename of one that
 * already exists.
 */
function expectDialRouting(node: CadreNode, expected: ReadonlyArray<readonly [string, string | null]>): void {
	for (const [addr, tag] of expected) {
		expect([addr, dialTransportTag(node, multiaddr(addr))]).toEqual([addr, tag]);
	}
}

interface WebRtcPeer extends OfflinePeer {
	/** `…/p2p-circuit/webrtc/…` — claimed by `@libp2p/webrtc`. */
	relayedAddr: string;
	/** `…/webrtc-direct/certhash/…` — claimed by `@libp2p/webrtc-direct`, when that transport is configured. */
	directAddr: string;
}

/**
 * Mint an offline sibling recorded at the address shapes the WebRTC transports
 * actually claim, both on RFC 5737 TEST-NET-1 (guaranteed unrouted). `n` keeps
 * each sibling's addresses distinct; the relay hop's peerId is a throwaway key.
 *
 * `withDirect` controls whether the `/webrtc-direct` address goes ON RECORD —
 * the phone shape has no transport that claims it, so recording it there would
 * only exercise libp2p's address filter. It is returned either way so a case
 * can assert the unclaimed routing.
 */
async function mintWebRtcPeer(owner: OwnerNode, n: number, withDirect: boolean): Promise<WebRtcPeer> {
	const key = await generateKeyPair('Ed25519');
	const peerId = peerIdFromPrivateKey(key).toString();
	const relayId = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
	const relayedAddr = `/ip4/192.0.2.${n}/tcp/4001/ws/p2p/${relayId}/p2p-circuit/webrtc/p2p/${peerId}`;
	const directAddr = `/ip4/192.0.2.${n}/udp/4001/webrtc-direct/certhash/${WEBRTC_CERTHASH}/p2p/${peerId}`;
	const peer = await insertResolvableOfflinePeer(owner, key, withDirect ? [relayedAddr, directAddr] : [relayedAddr]);
	return { ...peer, relayedAddr, directAddr };
}

/**
 * The full control read/write table, each operation under its own deadline,
 * contents asserted. Returns the peerId that `authorizePeer` added so callers
 * can re-check membership after a reconcile pass.
 */
async function runControlOperationSet(owner: OwnerNode, offline: OfflinePeer[]): Promise<string> {
	const { node, ownerPublicKey, selfPeerId } = owner;
	const db = node.getControlDatabase()!;

	expect(await within('hasOwnerKey()', OP_TIMEOUT_MS, () => db.hasOwnerKey())).toBe(true);
	expect(await within('getOwnerKeys()', OP_TIMEOUT_MS, () => db.getOwnerKeys()))
		.toEqual(new Set([ownerPublicKey]));

	// queryCadrePeers lists self AND every offline sibling — an empty answer
	// where local rows exist is the same failure class as a hang.
	const expectedMembers = new Set([selfPeerId, ...offline.map((p) => p.peerId)]);
	const peers = await within('queryCadrePeers()', OP_TIMEOUT_MS, () => db.queryCadrePeers());
	expect(new Set(peers.map((p) => p.peerId))).toEqual(expectedMembers);

	for (const peer of offline) {
		const record = await within(`queryPeerRecord(${short(peer.peerId)})`, OP_TIMEOUT_MS,
			() => db.queryPeerRecord(peer.peerId));
		expect(record).not.toBeNull();
		expect(record!.addrs).toEqual(peer.addrs);

		const resolved = await within(`resolvePeerAddrs(${short(peer.peerId)})`, OP_TIMEOUT_MS,
			() => node.resolvePeerAddrs(peer.peerId));
		expect(new Set(resolved.map((m) => m.toString()))).toEqual(new Set(peer.addrs));

		expect(await within(`isMember(${short(peer.peerId)})`, OP_TIMEOUT_MS, () => node.isMember(peer.peerId)))
			.toBe(true);
	}

	const members = await within('listMembers()', OP_TIMEOUT_MS, () => node.listMembers());
	expect(new Set(members.map((m) => m.peerId))).toEqual(expectedMembers);

	// insertSelfPeerRecord persists a full owner voucher and genesis anchored
	// the owner key, so every offline sibling is AUTHORIZED; self is excluded
	// by contract.
	const authorized = await within('listAuthorizedMembers()', OP_TIMEOUT_MS, () => node.listAuthorizedMembers());
	const authorizedIds = new Set(authorized.map((m) => m.peerId));
	for (const peer of offline) {
		expect(authorizedIds.has(peer.peerId)).toBe(true);
	}
	expect(authorizedIds.has(selfPeerId)).toBe(false);

	// Re-publish of the self record: a refresh, still local.
	expect(await within('registerSelf() (re-run)', OP_TIMEOUT_MS, () => node.registerSelf()))
		.toBe('refreshed');

	// Authorize ANOTHER offline peer. No addrs and no self-signature, so no
	// reconcile pass ever dials it (resolvePeerAddrs [] + peerStore miss) —
	// this write must not disturb the dial-budget math of the callers.
	const another = await generateKeyPair('Ed25519');
	const anotherPeerId = peerIdFromPrivateKey(another).toString();
	await within(`authorizePeer(${short(anotherPeerId)})`, OP_TIMEOUT_MS,
		() => node.authorizePeer(anotherPeerId, []));

	// Read-back is a SEPARATE assertion from the write's resolution — a write
	// that resolves but whose read-back is empty is the silent-failure mode
	// this spec exists to catch.
	const afterWrite = await within('queryCadrePeers() (post-authorize)', OP_TIMEOUT_MS, () => db.queryCadrePeers());
	expect(new Set(afterWrite.map((p) => p.peerId))).toEqual(new Set([...expectedMembers, anotherPeerId]));

	// Zero connections ⇒ the write committed alone and queued for later
	// re-replication; queueing must not have changed the returned outcome above.
	expect(pendingPeerWrites(node).get(anotherPeerId)).toBe('authorize');

	await runRemoveWrite(owner, new Set([...expectedMembers, anotherPeerId]));
	return anotherPeerId;
}

/**
 * The OTHER control write: a DELETE. It is a distinct SQL path from the insert
 * (stamp retirement under `CadrePeer.AuthorizedDelete`, not an owner-vouched
 * INSERT), so "reads and writes answer locally" is only half-tested without it.
 * The victim is minted with no addrs and no self-signature, so — like the
 * `authorizePeer` target — no reconcile pass ever dials it.
 *
 * @param expectedAfter - the membership set that must be unchanged once the
 *   removed peer is gone again.
 */
async function runRemoveWrite(owner: OwnerNode, expectedAfter: ReadonlySet<string>): Promise<void> {
	const { node } = owner;
	const db = node.getControlDatabase()!;
	const doomed = await generateKeyPair('Ed25519');
	const doomedPeerId = peerIdFromPrivateKey(doomed).toString();

	await within(`authorizePeer(${short(doomedPeerId)}) (to be removed)`, OP_TIMEOUT_MS,
		() => node.authorizePeer(doomedPeerId, []));
	expect(await within(`isMember(${short(doomedPeerId)}) (pre-remove)`, OP_TIMEOUT_MS,
		() => node.isMember(doomedPeerId))).toBe(true);

	// The stamp the delete will retire — captured BEFORE the row disappears.
	const doomedStampId = await within(`queryCadrePeerStampId(${short(doomedPeerId)})`, OP_TIMEOUT_MS,
		() => db.queryCadrePeerStampId(doomedPeerId));
	expect(doomedStampId).not.toBeNull();

	await within(`removePeer(${short(doomedPeerId)})`, OP_TIMEOUT_MS, () => node.removePeer(doomedPeerId));

	// Read-back is again a separate assertion from the write's resolution.
	const afterRemove = await within('queryCadrePeers() (post-remove)', OP_TIMEOUT_MS, () => db.queryCadrePeers());
	expect(new Set(afterRemove.map((p) => p.peerId))).toEqual(new Set(expectedAfter));
	expect(await within(`isMember(${short(doomedPeerId)}) (post-remove)`, OP_TIMEOUT_MS,
		() => node.isMember(doomedPeerId))).toBe(false);
	// A delete that commits alone queues its re-issuable `Revocation` tombstone
	// (keyed by the retired stamp) via the committed-delete seam
	// (`CadreNode.noteGuardedDelete`) — NOT the peer-write queue, whose remove arm
	// only clears a stale authorize (re-issuing the insert would resurrect the row).
	expect(pendingPeerWrites(node).get(doomedPeerId)).toBeUndefined();
	expect(pendingRevocations(node).get(doomedStampId!)).toEqual({
		tableName: 'CadrePeer',
		rowKey: doomedPeerId,
		stampId: doomedStampId
	});

	// A second remove of an absent peer must also answer locally, not dial —
	// and, being a no-op delete, must not queue a second tombstone.
	const queuedBefore = pendingRevocations(node).size;
	await within(`removePeer(${short(doomedPeerId)}) (already absent)`, OP_TIMEOUT_MS,
		() => node.removePeer(doomedPeerId));
	expect(pendingRevocations(node).size).toBe(queuedBefore);
}

/**
 * Post-reconcile checks shared by the awaited-pass cases: membership rows are
 * untouched and the write-while-alone entry is STILL queued — with zero
 * connections there was no 0→≥1 growth, so no drain may have fired.
 */
async function expectIntactAfterPass(owner: OwnerNode, offline: OfflinePeer[], authorizedPeerId: string): Promise<void> {
	const db = owner.node.getControlDatabase()!;
	const peers = await within('queryCadrePeers() (post-reconcile)', OP_TIMEOUT_MS, () => db.queryCadrePeers());
	expect(new Set(peers.map((p) => p.peerId)))
		.toEqual(new Set([owner.selfPeerId, ...offline.map((p) => p.peerId), authorizedPeerId]));
	expect(pendingPeerWrites(owner.node).get(authorizedPeerId)).toBe('authorize');
}

describe('control database with known-but-offline peers (no listen addr, no bootstrap peers)', () => {
	for (const profile of ['transaction', 'storage'] as const) {
		describe(`${profile} profile`, () => {
			it('serves every control read/write locally with a DEPARTED sibling on record', async () => {
				const owner = await bootOwnerNode(profile, `${profile}-departed`);
				try {
					const departed = await mintDepartedPeer(owner);
					const authorizedPeerId = await runControlOperationSet(owner, [departed]);

					// The pass dials the dead address (refused promptly), swallows the
					// failure by contract, and RESOLVES — it never rejects.
					await within('reconcileControlCohort()', RECONCILE_TIMEOUT_MS,
						() => owner.node.reconcileControlCohort());
					await expectIntactAfterPass(owner, [departed], authorizedPeerId);
				} finally {
					await within('node.stop()', LIFECYCLE_TIMEOUT_MS, () => owner.node.stop());
				}
			}, 120_000);

			it('serves every control read/write locally with a BLACKHOLE sibling on record', async () => {
				const owner = await bootOwnerNode(profile, `${profile}-blackhole`);
				try {
					const blackhole = await mintBlackholePeer(owner, 1);
					const authorizedPeerId = await runControlOperationSet(owner, [blackhole]);

					await within('reconcileControlCohort()', RECONCILE_TIMEOUT_MS,
						() => owner.node.reconcileControlCohort());
					await expectIntactAfterPass(owner, [blackhole], authorizedPeerId);
				} finally {
					await within('node.stop()', LIFECYCLE_TIMEOUT_MS, () => owner.node.stop());
				}
			}, 120_000);
		});
	}

	// The shape an embedding app actually relaunches into: the sibling rows are
	// ALREADY on disk at start(), so the eager reconcile pass start() schedules
	// begins dialing dead addresses while the app issues its first control reads.
	// The cold-boot cases above can never reach this — they start with an empty
	// membership table and only add siblings afterwards.
	it('re-boots on stored rows and still serves every control read/write with a BLACKHOLE sibling', async () => {
		const partyId = freshPartyId('offline-warm-restart');
		// Shared across both runs: same identity slot, same block storage.
		const keyStore = new InMemoryKeyStore();
		const storage = new MemoryRawStorage();
		const config = () => controlNodeConfig({ partyId, profile: 'transaction', keyStore, storage });

		let blackhole: OfflinePeer;
		const first = await startControlNode(new CadreNode(config()));
		try {
			await genesisOwner(first);
			blackhole = await mintBlackholePeer(first, 41);
		} finally {
			await within('first.stop()', LIFECYCLE_TIMEOUT_MS, () => first.node.stop());
		}

		const second = await startControlNode(new CadreNode(config()));
		try {
			// Same key store ⇒ same identity ⇒ the stored rows are this node's own.
			expect(second.selfPeerId).toBe(first.selfPeerId);
			await rejoinOwner(second);

			const authorizedPeerId = await runControlOperationSet(second, [blackhole]);
			await within('reconcileControlCohort()', RECONCILE_TIMEOUT_MS,
				() => second.node.reconcileControlCohort());
			await expectIntactAfterPass(second, [blackhole], authorizedPeerId);
		} finally {
			await within('second.stop()', LIFECYCLE_TIMEOUT_MS, () => second.node.stop());
		}
	}, 180_000);

	// NOTE: this block carries the per-transport-shape cases and is the part of
	// this file that grows — the file is 750 lines (`wc -l`) with the WebRTC
	// shapes added, up from 519. If it gains more than a couple more shapes,
	// split it into its own spec and lift the shared minting / operation-set
	// helpers (`bootOwnerNode`, `insertResolvableOfflinePeer`,
	// `runControlOperationSet`, `expectIntactAfterPass`, `within`) into
	// `control-db-node-helpers.ts`.
	describe('stress and transport shapes (transaction profile)', () => {
		it('three blackhole siblings: the sequential dial loop accumulates cost but the pass stays bounded', async () => {
			const owner = await bootOwnerNode('transaction', 'three-blackhole');
			try {
				const blackholes = [
					await mintBlackholePeer(owner, 1),
					await mintBlackholePeer(owner, 2),
					await mintBlackholePeer(owner, 3)
				];
				const authorizedPeerId = await runControlOperationSet(owner, blackholes);

				await within('reconcileControlCohort() (three siblings)', MULTI_RECONCILE_TIMEOUT_MS,
					() => owner.node.reconcileControlCohort());
				await expectIntactAfterPass(owner, blackholes, authorizedPeerId);
			} finally {
				await within('node.stop()', LIFECYCLE_TIMEOUT_MS, () => owner.node.stop());
			}
		}, 180_000);

		// Named for what is concurrent: the local ops against the pass, NOT the dials
		// against each other — `reconcileControlCohort` dials its siblings one at a time.
		it('a reconcile pass grinding through dead dials cannot block a local read or write', async () => {
			const owner = await bootOwnerNode('transaction', 'dial-storm');
			try {
				const blackholes = [
					await mintBlackholePeer(owner, 11),
					await mintBlackholePeer(owner, 12),
					await mintBlackholePeer(owner, 13)
				];

				// Kick a pass off UNAWAITED, then run the whole read/write set under
				// its normal deadlines while the pass grinds through dead dials. This
				// includes authorizePeer completing (via the control write path) while
				// the in-flight pass runs its read-only membership refreshes.
				const pass = owner.node.reconcileControlCohort();
				const authorizedPeerId = await runControlOperationSet(owner, blackholes);

				// The pass itself must still settle inside its own budget…
				await within('reconcileControlCohort() (storm pass)', MULTI_RECONCILE_TIMEOUT_MS, () => pass);
				// …and with zero connections throughout, the queued write never drained.
				await expectIntactAfterPass(owner, blackholes, authorizedPeerId);
			} finally {
				await within('node.stop()', LIFECYCLE_TIMEOUT_MS, () => owner.node.stop());
			}
		}, 180_000);

		it('stop() resolves inside its budget with a blackhole dial in flight', async () => {
			const owner = await bootOwnerNode('transaction', 'stop-mid-dial');
			try {
				await mintBlackholePeer(owner, 21);

				// Kick a pass and wait until its blackhole dial is actually IN FLIGHT
				// (visible in libp2p's dial queue) — stopping before the pass reaches
				// the dial would test nothing. If the pass somehow settles first (e.g.
				// a network that answers TEST-NET-1), proceed anyway: stop() must be
				// bounded regardless.
				const pass = owner.node.reconcileControlCohort();
				let passSettled = false;
				void pass.then(() => { passSettled = true; }, () => { passSettled = true; });
				await within('dial in flight (dial queue non-empty)', OP_TIMEOUT_MS, async () => {
					while (!passSettled && owner.node.getControlNode()!.getDialQueue().length === 0) {
						await delay(25);
					}
				});

				// Shutdown must not wait on an unanswerable connect…
				await within('node.stop() (dial in flight)', LIFECYCLE_TIMEOUT_MS, () => owner.node.stop());
				// …and the abandoned pass still RESOLVES (per-sibling failures swallowed).
				await within('reconcileControlCohort() (after stop)', MULTI_RECONCILE_TIMEOUT_MS, () => pass);
			} finally {
				// stop() is the subject here, so it is called in the body; this is the
				// leak guard for the paths that never reach it (stop() is idempotent).
				await within('node.stop() (guard)', LIFECYCLE_TIMEOUT_MS, () => owner.node.stop());
			}
		}, 120_000);

		it('serves every control read/write locally with circuit-relay in the transport set', async () => {
			const owner = await bootOwnerNode('transaction', 'relay-transport', [webSockets(), circuitRelayTransport()]);
			try {
				const blackhole = await mintBlackholePeer(owner, 31);
				const authorizedPeerId = await runControlOperationSet(owner, [blackhole]);

				await within('reconcileControlCohort()', RECONCILE_TIMEOUT_MS,
					() => owner.node.reconcileControlCohort());
				await expectIntactAfterPass(owner, [blackhole], authorizedPeerId);
			} finally {
				await within('node.stop()', LIFECYCLE_TIMEOUT_MS, () => owner.node.stop());
			}
		}, 120_000);

		// The two reference apps ship WebRTC, so a freeze that lives only on that
		// transport would reach a user before it reached a test. Both cases below
		// assert WHICH transport libp2p picked before running the operation set —
		// see `expectDialRouting`.
		it('serves every control read/write locally with the BROWSER reference transport list', async () => {
			const owner = await bootOwnerNode('transaction', 'webrtc-browser', browserTransports());
			try {
				const sibling = await mintWebRtcPeer(owner, 51, true);
				expectDialRouting(owner.node, [
					[sibling.relayedAddr, '@libp2p/webrtc'],
					[sibling.directAddr, '@libp2p/webrtc-direct']
				]);

				const authorizedPeerId = await runControlOperationSet(owner, [sibling]);
				await within('reconcileControlCohort()', RECONCILE_TIMEOUT_MS,
					() => owner.node.reconcileControlCohort());
				await expectIntactAfterPass(owner, [sibling], authorizedPeerId);
			} finally {
				await within('node.stop()', LIFECYCLE_TIMEOUT_MS, () => owner.node.stop());
			}
		}, 120_000);

		it('serves every control read/write locally with the PHONE reference transport list', async () => {
			const owner = await bootOwnerNode('transaction', 'webrtc-phone', phoneTransports());
			try {
				const sibling = await mintWebRtcPeer(owner, 52, false);
				expectDialRouting(owner.node, [
					[sibling.relayedAddr, '@libp2p/webrtc'],
					// What makes the phone shape genuinely different from the browser
					// one: with no `webRTCDirect()` configured, NOTHING claims a
					// `/webrtc-direct` address — libp2p filters it out of a dial, so
					// pasting the browser case's address in here would test nothing.
					[sibling.directAddr, null]
				]);

				const authorizedPeerId = await runControlOperationSet(owner, [sibling]);
				await within('reconcileControlCohort()', RECONCILE_TIMEOUT_MS,
					() => owner.node.reconcileControlCohort());
				await expectIntactAfterPass(owner, [sibling], authorizedPeerId);
			} finally {
				await within('node.stop()', LIFECYCLE_TIMEOUT_MS, () => owner.node.stop());
			}
		}, 120_000);

		// The dial-storm case above, under the browser transport list: what is
		// concurrent is the local ops against the pass, not the dials against each
		// other.
		it('a WebRTC reconcile pass grinding through dead dials cannot block a local read or write', async () => {
			const owner = await bootOwnerNode('transaction', 'webrtc-dial-storm', browserTransports());
			try {
				const siblings = [
					await mintWebRtcPeer(owner, 53, true),
					await mintWebRtcPeer(owner, 54, true),
					await mintWebRtcPeer(owner, 55, true)
				];
				for (const sibling of siblings) {
					expectDialRouting(owner.node, [
						[sibling.relayedAddr, '@libp2p/webrtc'],
						[sibling.directAddr, '@libp2p/webrtc-direct']
					]);
				}

				const pass = owner.node.reconcileControlCohort();
				const authorizedPeerId = await runControlOperationSet(owner, siblings);

				await within('reconcileControlCohort() (WebRTC storm pass)', MULTI_RECONCILE_TIMEOUT_MS, () => pass);
				await expectIntactAfterPass(owner, siblings, authorizedPeerId);
			} finally {
				await within('node.stop()', LIFECYCLE_TIMEOUT_MS, () => owner.node.stop());
			}
		}, 180_000);

		it('stop() resolves inside its budget with a WebRTC dial in flight', async () => {
			const owner = await bootOwnerNode('transaction', 'webrtc-stop-mid-dial', browserTransports());
			try {
				const sibling = await mintWebRtcPeer(owner, 56, true);
				expectDialRouting(owner.node, [
					[sibling.relayedAddr, '@libp2p/webrtc'],
					[sibling.directAddr, '@libp2p/webrtc-direct']
				]);

				// Same shape as the blackhole stop-mid-dial case: wait until the dial
				// is actually IN FLIGHT, and if the pass settles first (e.g. a network
				// that answers TEST-NET-1) proceed anyway — stop() must be bounded
				// either way.
				const pass = owner.node.reconcileControlCohort();
				let passSettled = false;
				void pass.then(() => { passSettled = true; }, () => { passSettled = true; });
				await within('WebRTC dial in flight (dial queue non-empty)', OP_TIMEOUT_MS, async () => {
					while (!passSettled && owner.node.getControlNode()!.getDialQueue().length === 0) {
						await delay(25);
					}
				});

				await within('node.stop() (WebRTC dial in flight)', LIFECYCLE_TIMEOUT_MS, () => owner.node.stop());
				await within('reconcileControlCohort() (after stop)', MULTI_RECONCILE_TIMEOUT_MS, () => pass);
			} finally {
				// stop() is the subject here, so it is called in the body; this is the
				// leak guard for the paths that never reach it (stop() is idempotent).
				await within('node.stop() (guard)', LIFECYCLE_TIMEOUT_MS, () => owner.node.stop());
			}
		}, 120_000);
	});
});
