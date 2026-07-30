import { describe, it, expect } from 'vitest';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
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
function pendingPeerWrites(node: CadreNode): Map<string, 'authorize' | 'remove'> {
	return (node as unknown as { pendingPeerWrites: Map<string, 'authorize' | 'remove'> }).pendingPeerWrites;
}

interface OwnerNode {
	node: CadreNode;
	ownerPublicKey: string;
	selfPeerId: string;
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
	const node = new CadreNode(controlNodeConfig({
		partyId: freshPartyId(`offline-${tag}`),
		profile,
		keyStore: new InMemoryKeyStore(),
		storage: new MemoryRawStorage(),
		...(transports ? { transports } : {})
	}));
	await within('node.start()', LIFECYCLE_TIMEOUT_MS, () => node.start());
	expectNotListening(node);

	const { privateKeyB64, publicKeyB64 } = node.getIdentityOwnerKey();
	const db = node.getControlDatabase();
	expect(db).not.toBeNull();
	expect(await within('ensureOwnerKey() (genesis)', OP_TIMEOUT_MS, () => db!.ensureOwnerKey(publicKeyB64)))
		.toBe(true);
	node.initializeSeedBootstrap(privateKeyB64);
	expect(await within('registerSelf() (genesis)', OP_TIMEOUT_MS, () => node.registerSelf()))
		.toBe('inserted');

	return { node, ownerPublicKey: publicKeyB64, selfPeerId: node.peerId!.toString() };
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

	return anotherPeerId;
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

		it('a concurrent dial storm cannot block a local read or write', async () => {
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
	});
});
