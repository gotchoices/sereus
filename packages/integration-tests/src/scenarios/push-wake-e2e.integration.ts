/**
 * End-to-end control-network push-wake over real libp2p.
 *
 * The `hibernation-push-wake` unit tests (cadre-core `strand-wake-protocol.spec.ts`)
 * exercise the wake decision matrix and the framing round-trip with in-memory
 * stream doubles (`wake-stream-helpers.ts`) and a stubbed `dialProtocol` /
 * `resolvePeerAddrs`. This scenario proves the **real wire path** instead:
 *
 *   - a real `node.handle(WAKE_PROTOCOL, …)` dispatch on the receiver (registered
 *     automatically in `CadreNode.start()` — cadre-node.ts:342),
 *   - a real `dialProtocol` stream over a real WebSocket transport,
 *   - libp2p 3.x half-close (`stream.close()` write-EOF, read end open for the ack),
 *   - multi-chunk length-prefixed JSON framing,
 *   - `pushWake`'s composition with `resolvePeerAddrs` (binding + self-sig +
 *     freshness + trust + signaling-first), and
 *   - the circuit-relay (signaling-first) dial to a NAT'd receiver.
 *
 * Three scenarios, each booting fresh nodes in a try/finally:
 *   1. Happy path — direct dial of a hibernating member, wake accepted.
 *   2. NAT'd receiver reachable only via a circuit relay, wake accepted.
 *   3. Non-member sender — receiver rejects, strand stays hibernating.
 *
 * ── Deviation from the source ticket (IMPORTANT — read before reviewing) ──────
 *
 * The ticket assumed the control DB is a *replicating* Optimystic store, so a
 * `registerSelf()` / `insertSelfPeerRecord()` on one node would become visible on
 * another via pull-on-read ("no replication sleep/poll needed; just query after
 * the write"). **That does not hold in this harness.** A diagnostic (two control
 * nodes, a live control connection) showed the receiver never observes the
 * server's `CadrePeer` row even after 24s — cross-node control-DB reads do not
 * converge here, consistent with the "control-network cohort discovery is TODO"
 * note in `strand-formation-e2e.integration.ts`. Strand-level tests work around
 * the same gap by *manually* dialing strand libp2p nodes; the control plane has
 * no equivalent yet.
 *
 * Because the wake **wire path** (the actual subject of this ticket) only needs
 * each node's *local* control DB to hold the membership facts that node consults,
 * we seed those locally instead of relying on replication:
 *   - the DIALER (server / outsider) is its own authority and seeds the target's
 *     self-signed record so `resolvePeerAddrs(target)` passes its gates;
 *   - the RECEIVER is its own authority and `authorizePeer(sender)` so its wake
 *     gate `isMember(sender)` is true (scenario 3 deliberately omits this).
 * This keeps every byte of the real dial/handle/framing/resolve path under test;
 * only the (currently non-functional) cross-node DB propagation is sidestepped.
 * See the review handoff for the follow-up ticket this should spawn.
 *
 * Second deviation — NAT receiver listen address: with
 * `@libp2p/circuit-relay-v2@4.x`, a *discovered* relay reservation is skipped
 * unless a `/p2p-circuit` listen address has populated the pending-reservation
 * queue (reservation-store.ts `HadEnoughRelaysError` guard). So the NAT'd receiver
 * listens on the relay's explicit `…/p2p-circuit` address — it still has no direct
 * dialable address (genuinely NAT'd), but the reservation is deterministic rather
 * than discovery-timing dependent. (The ticket's `listenAddrs: []` never reserves.)
 *
 * Third deviation — NAT receiver is NOT hibernated, by design. Scenario 2's unique
 * subject is the SENDER reaching a NAT'd peer: the signaling-first resolve and the
 * relayed dial over a libp2p "limited" (circuit) connection. (That dial used to
 * fail outright with `LimitedConnectionError`; this ticket fixed it — see the
 * `runOnLimitedConnection` change in `strand-wake-protocol.ts`.) The full
 * hibernating→`active` resume is already proven on the direct path (scenario 1)
 * and is the SAME receiver code regardless of transport. Driving a *hibernating*
 * NAT receiver to `active` additionally requires the woken strand's `networked`
 * resume to form its cluster — but over the relay mesh the strand cluster tries to
 * recruit the relay/server peers (which speak the control-network protocol, not
 * the strand-repo protocol) and fails super-majority. That is the known
 * "strand-cohort discovery over the control network is TODO" gap, not a wake-
 * transport defect, so scenario 2 wakes an already-active strand (the "already
 * live → accepted" branch) to keep the assertion about the relay transport, not
 * the strand cluster. See the review handoff for the follow-up this should spawn.
 */

import { describe, it, expect } from 'vitest';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import {
	CadreNode,
	signSchema,
	authorityKeyFromLibp2p,
	signPeerRecord,
	ed25519PublicKeyB64FromPeerId,
} from '@serfab/cadre-core';
import type { CadreNodeConfig, SAppConfig, WakeAck, PeerAddressRecord } from '@serfab/cadre-core';
import { waitUntil } from '../harness/index.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** WebSocket + circuit-relay transports, matching the other e2e scenarios. */
function wsTransports() {
	return [webSockets(), circuitRelayTransport()];
}

/** Minimal hibernation-friendly sApp schema. */
const SIMPLE_SCHEMA = `
table Data (
    Key text primary key,
    Val text
);
`;

/**
 * A properly signed sApp config with a NON-realtime `latencyHint` — realtime
 * strands never hibernate, so `'interactive'` is required for the wake path.
 * (Copied from `strand-formation-e2e.integration.ts`.)
 */
function createSignedSAppConfig(schema: string, version: string): SAppConfig {
	const authorPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
	const authorPublicKey = getPublicKey(authorPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
	const signature = signSchema(schema, version, authorPrivateKey);
	return { id: authorPublicKey, version, schema, signature, latencyHint: 'interactive' as const };
}

interface NodeOpts {
	partyId: string;
	privateKey?: PrivateKey;
	bootstrapNodes?: string[];
	profile?: 'storage' | 'transaction';
	enableRelay?: boolean;
	listenAddrs?: string[];
	hibernation?: boolean;
}

/** Build a `CadreNodeConfig` for one node in the push-wake topology. */
function nodeConfig(opts: NodeOpts): CadreNodeConfig {
	return {
		controlNetwork: { partyId: opts.partyId, bootstrapNodes: opts.bootstrapNodes ?? [] },
		profile: opts.profile ?? 'transaction',
		strandFilter: { mode: 'all' },
		storage: { provider: () => new MemoryRawStorage() },
		...(opts.privateKey ? { privateKey: opts.privateKey } : {}),
		network: {
			transports: wsTransports(),
			listenAddrs: opts.listenAddrs ?? ['/ip4/127.0.0.1/tcp/0/ws'],
			...(opts.enableRelay ? { enableRelay: true } : {}),
		},
		hibernation: { enabled: opts.hibernation ?? false },
	};
}

/** The control node's currently-observed multiaddrs as strings. */
function controlAddrs(node: CadreNode): string[] {
	return node.getControlNode()!.getMultiaddrs().map((ma) => ma.toString());
}

/**
 * Make a freshly-started node its own control authority (genesis): enroll its
 * derived public key in `AuthorityKey` and wire the seed-bootstrap service with
 * the matching private key, so it can authority-sign `CadrePeer` inserts into its
 * own local control DB.
 */
async function makeOwnAuthority(node: CadreNode, key: PrivateKey): Promise<void> {
	const { privateKeyB64, publicKeyB64 } = authorityKeyFromLibp2p(key);
	const db = node.getControlDatabase();
	if (!db) throw new Error('control database missing after start');
	await db.insertAuthorityKey(publicKeyB64);
	node.initializeSeedBootstrap(privateKeyB64);
}

/**
 * Authority-signed INSERT of the receiver's own self-signed `CadrePeer` record
 * into `authorityNode`'s control DB, exactly as the receiver would self-publish —
 * so `authorityNode.resolvePeerAddrs(rxPeerId)` passes its binding + self-sig +
 * freshness gates and dials the supplied addrs (signaling/relay first).
 */
async function seedReceiverRecord(
	authorityNode: CadreNode,
	rxPeerId: string,
	rxKey: PrivateKey,
	rxAddrs: string[],
): Promise<PeerAddressRecord> {
	const { privateKeyB64, publicKeyB64 } = authorityKeyFromLibp2p(rxKey);
	// The binding gate `resolvePeerAddrs` enforces: the record's publicKey MUST be
	// the ed25519 key embedded in the peerId (both derived from rxKey here).
	expect(publicKeyB64).toBe(ed25519PublicKeyB64FromPeerId(rxPeerId));
	const record = signPeerRecord(
		{ peerId: rxPeerId, publicKey: publicKeyB64, addrs: rxAddrs, updatedAt: Date.now() },
		privateKeyB64,
	);
	await authorityNode.getSeedBootstrapService()!.insertSelfPeerRecord(record);
	return record;
}

/**
 * Stand up a strand on the receiver and drive it to `hibernating`. Uses
 * `mode: 'bootstrap'` so the strand stands up solo (the wake travels the control
 * network, not the strand network). Asserts `active` then `hibernating` so a
 * silent hibernate no-op (e.g. a realtime latency hint) fails loudly.
 */
async function bringUpHibernatingStrand(Rx: CadreNode, strandId: string): Promise<void> {
	const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '0.1.0');
	const strand = await Rx.addStrand({
		strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' },
		sAppConfig: sApp,
		mode: 'bootstrap',
	});
	expect(strand.status).toBe('active');

	await Rx.hibernateStrand(strandId);
	expect(Rx.getStrand(strandId)?.status).toBe('hibernating');
}

const RESERVATION_WAIT = { timeoutMs: 20_000, intervalMs: 250 } as const;

// ═════════════════════════════════════════════════════════════════════════════

describe('E2E push-wake over the control network', () => {
	// ── 1. Happy path: direct dial of a hibernating member ────────────────────

	it('wakes a hibernating member over a real direct control dial', async () => {
		let S: CadreNode | undefined;
		let Rx: CadreNode | undefined;
		try {
			const partyId = `pushwake-direct-${Date.now()}`;
			const strandId = `strand-direct-${Date.now()}`;

			// Server S: the member-recognized sender + its own control authority.
			const sKey = await generateKeyPair('Ed25519');
			S = new CadreNode(nodeConfig({ partyId, privateKey: sKey }));
			await S.start();
			await makeOwnAuthority(S, sKey);
			const sPeerId = S.peerId!.toString();

			// Receiver Rx: hibernating member, its own authority (to record S as a member).
			const rxKey = await generateKeyPair('Ed25519');
			Rx = new CadreNode(nodeConfig({ partyId, privateKey: rxKey, hibernation: true }));
			await Rx.start();
			await makeOwnAuthority(Rx, rxKey);
			const rxPeerId = Rx.peerId!.toString();

			// S can resolve Rx via Rx's seeded self-signed record (real direct addr).
			const rxAddrs = controlAddrs(Rx);
			expect(rxAddrs.length).toBeGreaterThan(0);
			await seedReceiverRecord(S, rxPeerId, rxKey, rxAddrs);
			expect((await S.resolvePeerAddrs(rxPeerId)).length).toBeGreaterThan(0);

			// Rx's wake gate recognizes S as a cadre member.
			await Rx.authorizePeer(sPeerId);
			expect(await Rx.isMember(sPeerId)).toBe(true);

			await bringUpHibernatingStrand(Rx, strandId);

			// Real handle/dialProtocol/half-close/framing + pushWake→resolvePeerAddrs→dialWake.
			const ack: WakeAck = await S.pushWake(rxPeerId, strandId, 'test wake');
			expect(ack).toEqual({ accepted: true, status: 'active' });
			expect(Rx.getStrand(strandId)?.status).toBe('active');
		} finally {
			await Rx?.stop();
			await S?.stop();
		}
	}, 60_000);

	// ── 2. NAT'd receiver reachable only via a circuit relay ──────────────────

	// SKIPPED pending `push-wake-e2e-shared-authority-topology` (fix/). Network-backing
	// the control DB (`control-db-network-backed`) makes the `CadreControl` tables a
	// PARTY-SHARED, replicated store, so two nodes can no longer each self-appoint as
	// genesis authority in the same party: this variant bootstraps both S and Rx to the
	// relay L, so the cohort forms during start and `makeOwnAuthority(Rx)` sees S's
	// already-replicated AuthorityKey — its bootstrap branch `(count(1) from AuthorityKey)
	// <= 1` is now false and the genesis insert fails `Authorized`. That is the CORRECT
	// shared-authority semantic, not a regression; the test's "receiver is its own
	// authority" setup is an in-memory-era assumption. The direct-dial variant above
	// still passes because its nodes genesis BEFORE forming a cohort (no bootstrap link).
	// Re-authoring the receiver's authorization to derive from the party authority over
	// the replicated store is the job of `2-push-wake-replication-backed-authorization`.
	it.skip("delivers a wake to a NAT'd receiver over a circuit-relay (signaling-first) dial", async () => {
		let L: CadreNode | undefined;
		let S: CadreNode | undefined;
		let Rx: CadreNode | undefined;
		try {
			const partyId = `pushwake-nat-${Date.now()}`;
			const strandId = `strand-nat-${Date.now()}`;

			// Relay L: dedicated transport infra — a relay server only, NOT a member.
			L = new CadreNode(nodeConfig({ partyId, profile: 'transaction', enableRelay: true }));
			await L.start();
			const lAddrs = controlAddrs(L);
			expect(lAddrs.length).toBeGreaterThan(0);
			const lAddr = lAddrs[0]!; // /ip4/127.0.0.1/tcp/<port>/ws/p2p/<L>

			// Server S: the sender + its own authority, distinct from the relay so the
			// wake dial genuinely traverses L. Bootstraps to L for relay reachability.
			const sKey = await generateKeyPair('Ed25519');
			S = new CadreNode(nodeConfig({ partyId, privateKey: sKey, bootstrapNodes: [lAddr] }));
			await S.start();
			await makeOwnAuthority(S, sKey);
			const sPeerId = S.peerId!.toString();

			// Receiver Rx: genuinely NAT'd — no direct listen addr, only a relayed slot
			// on L (explicit `…/p2p-circuit` listen, see header note). Its own authority.
			// (NOT hibernated — see the third deviation note in the file header.)
			const rxKey = await generateKeyPair('Ed25519');
			Rx = new CadreNode(nodeConfig({
				partyId,
				privateKey: rxKey,
				bootstrapNodes: [lAddr],
				listenAddrs: [`${lAddr}/p2p-circuit`],
			}));
			await Rx.start();
			await makeOwnAuthority(Rx, rxKey);
			const rxPeerId = Rx.peerId!.toString();

			await waitUntil(() => Rx!.getControlNode()!.getConnections().length > 0, {
				...RESERVATION_WAIT,
				description: 'Rx connects to the relay',
			});

			// Wait for the relay reservation to materialise as a /p2p-circuit addr.
			let circuitAddr = '';
			await waitUntil(() => {
				circuitAddr = controlAddrs(Rx!).find((a) => a.includes('/p2p-circuit')) ?? '';
				return circuitAddr.length > 0;
			}, { ...RESERVATION_WAIT, description: "Rx's circuit-relay reservation appears" });

			// Seed BOTH the circuit addr and a (synthetic) direct addr so signaling-first
			// ordering is observable: the circuit addr must sort ahead of the direct one.
			const syntheticDirect = '/ip4/10.255.0.1/tcp/4001/ws';
			await seedReceiverRecord(S, rxPeerId, rxKey, [circuitAddr, syntheticDirect]);

			// resolvePeerAddrs returns the circuit addr FIRST (the ordering the
			// in-memory unit tests can only stub).
			const resolved = (await S.resolvePeerAddrs(rxPeerId)).map((m) => m.toString());
			expect(resolved.length).toBeGreaterThan(0);
			expect(resolved[0]).toContain('/p2p-circuit');

			// Rx's wake gate recognizes S as a member.
			await Rx.authorizePeer(sPeerId);
			expect(await Rx.isMember(sPeerId)).toBe(true);

			// Active strand: the wake is the "already live → accepted" branch, so the
			// assertion is about the relayed delivery (dial over the limited circuit
			// connection + handler dispatch + multi-chunk framing + membership gate +
			// ack round-trip), NOT the networked strand resume (see header note).
			const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '0.1.0');
			const strand = await Rx.addStrand({
				strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' },
				sAppConfig: sApp,
				mode: 'bootstrap',
			});
			expect(strand.status).toBe('active');

			// The relayed wake dial — the path the in-memory tests cannot prove. It
			// fails entirely without the `runOnLimitedConnection` fix this ticket made.
			const ack: WakeAck = await S.pushWake(rxPeerId, strandId, 'nat wake');
			expect(ack).toEqual({ accepted: true, status: 'active' });
			expect(Rx.getStrand(strandId)?.status).toBe('active');
		} finally {
			await Rx?.stop();
			await S?.stop();
			await L?.stop();
		}
	}, 60_000);

	// ── 3. Non-member sender is rejected (no side effect) ─────────────────────

	it('rejects a wake from a non-member and leaves the strand hibernating', async () => {
		let Rx: CadreNode | undefined;
		let O: CadreNode | undefined;
		try {
			const partyId = `pushwake-nonmember-${Date.now()}`;
			const strandId = `strand-nonmember-${Date.now()}`;

			// Receiver Rx: hibernating. Its control DB recognizes NO members, so any
			// sender is a non-member. (No authority needed — it authorizes no one.)
			const rxKey = await generateKeyPair('Ed25519');
			Rx = new CadreNode(nodeConfig({ partyId, privateKey: rxKey, hibernation: true }));
			await Rx.start();
			const rxPeerId = Rx.peerId!.toString();

			// Outsider O: its own authority so it can seed Rx's record and thus RESOLVE
			// + dial Rx (the default trust policy trusts any peer with a row) — but Rx
			// never authorized O, so the receiver rejects on `isMember(O) === false`.
			const oKey = await generateKeyPair('Ed25519');
			O = new CadreNode(nodeConfig({ partyId, privateKey: oKey }));
			await O.start();
			await makeOwnAuthority(O, oKey);
			const oPeerId = O.peerId!.toString();

			const rxAddrs = controlAddrs(Rx);
			await seedReceiverRecord(O, rxPeerId, rxKey, rxAddrs);
			expect((await O.resolvePeerAddrs(rxPeerId)).length).toBeGreaterThan(0);
			expect(await Rx.isMember(oPeerId)).toBe(false);

			await bringUpHibernatingStrand(Rx, strandId);

			const ack: WakeAck = await O.pushWake(rxPeerId, strandId, 'unauthorized wake');
			expect(ack.accepted).toBe(false);
			// No side effect: the strand is still hibernating (receiver rejected before wake).
			expect(Rx.getStrand(strandId)?.status).toBe('hibernating');
		} finally {
			await O?.stop();
			await Rx?.stop();
		}
	}, 60_000);
});
