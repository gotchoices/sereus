/**
 * Real-network strand-addr seed convergence: two nodes of one party stand up
 * the SAME strand, the second node learning the founder's strand-network
 * address purely over the control-network strand-addr RPC — no hand-dial of
 * any strand node anywhere in this file, by design. The RPC-resolved seed
 * alone must be enough to form the strand mesh.
 *
 * The strand-addr unit tests (cadre-core `strand-addr-protocol.spec.ts`,
 * `strand-cohort.spec.ts`) exercise the request/response decision matrix with
 * a hand-built `StrandAddrService` over `duplexPair` stream doubles and a
 * stubbed `dialProtocol`. This scenario proves the **real join path** those
 * loopbacks cannot:
 *
 *   - a real `node.handle(STRAND_ADDR_PROTOCOL, …)` dispatch on the founder's
 *     control node (registered automatically in `CadreNode.start()`), answered
 *     from the founder's LIVE strand instance (`getStrandMultiaddrs`),
 *   - a real `dialProtocol` request over a real WebSocket control connection,
 *     gated by the responder's `isAuthorizedMember` predicate on replicated
 *     membership rows,
 *   - `resolveCohortSeed`'s target selection (CadrePeer rows minus self,
 *     intersected with currently-OPEN control connections) feeding the joiner's
 *     `addStrand` with strand-NETWORK addrs — never the control addrs that
 *     seeded the old bug this file regression-guards against,
 *   - `selectStrandMode` row-presence inference flipping the joiner to
 *     `networked` with no explicit mode (observable via the `StrandInstance.mode`
 *     field), while the founder's explicit `bootstrap` sticks,
 *   - libp2p `bootstrap()` discovery + connection-manager auto-dial forming the
 *     strand mesh from the RPC-resolved seed ALONE.
 *
 * ── Topology: one party, ONE owner (READ THIS) ──
 *
 * The network-backed `CadreControl` store is party-shared, so two nodes cannot
 * each self-genesis — the second `OwnerKey` insert fails the bootstrap CHECK
 * once the first replicates (see push-wake-e2e's header). Founder A is the
 * party's SOLE owner + storage hub with a STABLE identity: the same Ed25519 key
 * is its node identity AND its owner signing key (push-wake scenario-3 style),
 * because A's own `CadrePeer` row is both the joiner's RPC target and the row
 * that flips the joiner `networked` — its peerId must be real and stable.
 * Joiner B is a plain member with a stable key and `bootstrapNodes: [A]`, which
 * makes A unconditionally admitted by B's fail-closed control-stream gate once
 * B's authorized-member snapshot goes non-empty. Every gated write is a clean
 * {A, B} 2-node commit made only after the control link is both-sides
 * confirmed.
 *
 * ── What is deliberately NOT asserted ──
 *
 * Data replication between A and B: a `bootstrap`-mode founder commits through
 * a purely LOCAL transactor, so rows written on A never travel the strand mesh
 * this test forms. The claim here is connection + seed content. A data-
 * convergence scenario needs both members `networked` (a third node, or an
 * explicit mode on the founder) — a separate ticket, not this one.
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
	collectStrandAddrs,
	signSchema,
	ed25519KeyPairFromLibp2p,
} from '@serfab/cadre-core';
import type { CadreNodeConfig, SAppConfig } from '@serfab/cadre-core';
import { waitUntil, waitForCadrePeerConverged } from '../harness/index.js';

// ── Helpers ─────────────────────────────────────────────────────────────────
// NOTE: copied verbatim from push-wake-e2e.integration.ts rather than shared —
// extracting these into the harness is tracked in
// `integration-test-harness-helper-consolidation`; copy, don't refactor, until
// that lands.

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

/** Build a `CadreNodeConfig` for one node in the topology. */
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
 * Make a freshly-started node its own control owner (genesis): enroll its
 * derived public key in `OwnerKey` and wire the seed-bootstrap service with
 * the matching private key, so it can owner-sign `CadrePeer` inserts into its
 * own local control DB. Returns the owner PUBLIC key (base64url) — the key an
 * enrollee pins into its node-local trusted-owner anchor (`trustOwnerKeys`) so
 * this owner's membership vouchers pass its authorized-membership predicate.
 */
async function makeOwnOwner(node: CadreNode, key: PrivateKey): Promise<string> {
	const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(key);
	const db = node.getControlDatabase();
	if (!db) throw new Error('control database missing after start');
	await db.insertOwnerKey(publicKeyB64);
	node.initializeSeedBootstrap(privateKeyB64);
	return publicKeyB64;
}

/**
 * Establish a DIRECT control-network connection from `reader` to `writer` and wait
 * until BOTH sides report it (scoped to this specific peer pair, so the recipe is
 * correct when several readers attach to one writer). This is the test-only
 * stand-in for production control-cohort discovery, proven by
 * `control-db-two-node-convergence.integration.ts`. Both-sides confirmation is a
 * hard precondition of a replicating write: only once each peer sees the connection
 * can the control collection's cohort span them and a commit be non-local-only.
 */
async function connectControlNodes(reader: CadreNode, writer: CadreNode): Promise<void> {
	const readerNode = reader.getControlNode()!;
	const writerNode = writer.getControlNode()!;
	const writerAddrs = writerNode.getMultiaddrs();
	expect(writerAddrs.length).toBeGreaterThan(0);
	const readerPeerId = reader.peerId!.toString();
	const writerPeerId = writer.peerId!.toString();

	await readerNode.dial(writerAddrs[0]!);
	await waitUntil(() => readerNode.getConnections().some((c) => c.remotePeer.toString() === writerPeerId), {
		timeoutMs: 15_000,
		intervalMs: 250,
		description: 'reader control node connects to writer',
	});
	await waitUntil(() => writerNode.getConnections().some((c) => c.remotePeer.toString() === readerPeerId), {
		timeoutMs: 15_000,
		intervalMs: 250,
		description: 'writer control node sees inbound connection from reader',
	});
}

// ═════════════════════════════════════════════════════════════════════════════

describe('E2E strand-addr seed convergence', () => {
	it("joins a second node into the founder's strand from the RPC-resolved seed alone", async () => {
		let A: CadreNode | undefined; // founder: sole owner + storage, brings the strand up first
		let B: CadreNode | undefined; // joiner: plain member, seeds its strand mesh via the RPC
		try {
			const partyId = `strand-seed-${Date.now()}`;
			const strandId = `strand-conv-${Date.now()}`;

			// Founder A: the party's SOLE owner + storage hub, with a STABLE identity —
			// the SAME key is its node identity and its owner signing key, because A's
			// own CadrePeer row is B's RPC target and what flips B `networked` (see
			// file header). Genesis ALONE so the lone OwnerKey commits with no collision.
			const aKey = await generateKeyPair('Ed25519');
			A = new CadreNode(nodeConfig({ partyId, privateKey: aKey, profile: 'storage' }));
			await A.start();
			const aOwnerPub = await makeOwnOwner(A, aKey);
			const aPeerId = A.peerId!.toString();
			const aControlAddrList = controlAddrs(A);
			expect(aControlAddrList.length).toBeGreaterThan(0);

			// Joiner B: plain member (never genesis), stable key so its strand transport
			// identity derives deterministically. A rides in `bootstrapNodes`, which makes
			// A unconditionally admitted by B's fail-closed per-stream control-DB gate
			// once B's authorized-member snapshot goes non-empty.
			const bKey = await generateKeyPair('Ed25519');
			B = new CadreNode(nodeConfig({ partyId, privateKey: bKey, bootstrapNodes: [aControlAddrList[0]!] }));
			await B.start();
			const bPeerId = B.peerId!.toString();

			// ENROLLMENT: B was enrolled by A's owner, so it pins that owner key into its
			// node-local trusted-owner anchor (as redeeming a real CadreInvite does). A
			// itself self-anchors its own key with `genesis` provenance inside
			// `initializeSeedBootstrap` — no trustOwnerKeys call needed on A.
			await B.trustOwnerKeys([aOwnerPub], 'invite');

			// CONNECT BEFORE WRITE: both-sides-confirmed {A, B} link, so every gated
			// write below commits cohort-wide rather than local-only.
			await connectControlNodes(B, A);

			// A — and ONLY A — writes both membership rows, each a clean {A, B} 2-node
			// commit: its own row (the RPC target and B's `networked` trigger) and B's
			// row (what lets B pass A's `isAuthorizedMember` gate on the strand-addr RPC).
			await A.authorizePeer(aPeerId);
			await A.authorizePeer(bPeerId);

			// Converge B on A's sibling-written row — the fact that both flips B's mode
			// inference and names B's RPC target.
			await waitForCadrePeerConverged(B.getControlDatabase()!, aPeerId, {
				timeoutMs: 30_000,
				description: "B observes A's CadrePeer membership row written on A",
			});
			expect(await B.isMember(aPeerId)).toBe(true);

			// Both AUTHORIZED gates, asserted explicitly BEFORE any strand work so a
			// failure here reads as a membership-gate failure, not an addr-lookup one:
			// A's gate admits B's inbound RPC; B's gate would admit A symmetrically.
			expect(await A.isAuthorizedMember(bPeerId)).toBe(true);
			expect(await B.isAuthorizedMember(aPeerId)).toBe(true);

			// ── Subject: founder side ────────────────────────────────────────────
			// A stands the strand up solo in explicit `bootstrap` mode (first node of a
			// brand-new strand — no cluster to transact against yet). The Phase-1
			// observable `mode` field must report it, and the instance must have a live
			// strand-network node with dialable addrs for the RPC to answer with.
			const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '0.1.0');
			const aStrand = await A.addStrand({
				strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' },
				sAppConfig: sApp,
				mode: 'bootstrap',
			});
			expect(aStrand.status).toBe('active');
			expect(aStrand.mode).toBe('bootstrap');
			const aStrandNode = aStrand.libp2pNode!;
			expect(aStrandNode).toBeDefined();
			const aStrandAddrs = aStrandNode.getMultiaddrs().map((ma) => ma.toString());
			expect(aStrandAddrs.length).toBeGreaterThan(0);
			const aStrandPeerId = aStrandNode.peerId.toString();
			// The derived per-strand transport identity must NOT collapse into the
			// control identity — if it did, the convergence assertions below would pass
			// vacuously on the already-open CONTROL connection.
			expect(aStrandPeerId).not.toBe(aPeerId);

			// ── Subject: responder half, direct RPC ─────────────────────────────
			// B asks A directly over the real STRAND_ADDR_PROTOCOL dial. Asserted before
			// B's addStrand because `resolveCohortSeed` folds per-peer failure to a
			// SILENT empty seed — this pins responder-side failure before blaming
			// discovery. Every returned addr must be a strand-NETWORK addr of A's live
			// instance, never a control addr (the regression this file guards: the old
			// bug seeded strand meshes with `CadrePeer.Multiaddr` control addrs).
			const seed = await collectStrandAddrs(B.getControlNode()!, [{ peerId: aPeerId }], strandId);
			expect(seed.length).toBeGreaterThan(0);
			const aControlAddrsNow = controlAddrs(A);
			for (const addr of seed) {
				expect(aStrandAddrs).toContain(addr);
				expect(aControlAddrsNow).not.toContain(addr);
				expect(addr).not.toContain(aPeerId);
			}

			// The seed pass RPCs only siblings with an OPEN control connection — a
			// dropped link would silently produce an empty seed. Re-assert it is
			// still up so the joiner assertions below stand on solid ground.
			expect(
				B.getControlNode()!.getConnections().some((c) => c.remotePeer.toString() === aPeerId),
			).toBe(true);

			// ── Subject: requester half ─────────────────────────────────────────
			// B stands up the SAME strand with NO explicit mode: `selectStrandMode`
			// must infer `networked` from A's CadrePeer row (observable via the
			// Phase-1 field), and the internal seed pass must feed B's strand node
			// A's strand addrs — the same union the direct RPC above returned.
			const bStrand = await B.addStrand({
				strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' },
				sAppConfig: sApp,
			});
			expect(bStrand.status).toBe('active');
			expect(bStrand.mode).toBe('networked');
			const bStrandNode = bStrand.libp2pNode!;
			expect(bStrandNode).toBeDefined();
			const bStrandPeerId = bStrandNode.peerId.toString();

			// ── Convergence: the strand mesh forms from the seed alone ──────────
			// The seed becomes libp2p `bootstrap()` peer discovery and the connection
			// manager auto-dials — NO manual dial. Both directions confirmed.
			await waitUntil(
				() => bStrandNode.getConnections().some((c) => c.remotePeer.toString() === aStrandPeerId),
				{
					timeoutMs: 30_000,
					intervalMs: 250,
					description: "B's strand node auto-dials A's strand node from the RPC-resolved seed",
				},
			);
			await waitUntil(
				() => aStrandNode.getConnections().some((c) => c.remotePeer.toString() === bStrandPeerId),
				{
					timeoutMs: 30_000,
					intervalMs: 250,
					description: "A's strand node sees the inbound connection from B's strand node",
				},
			);

			// Negative: every strand-mesh connection B holds is to A's STRAND node —
			// in particular never to A's CONTROL peerId (the seeded-with-control-addrs
			// regression made visible at the connection layer).
			const bStrandRemotes = bStrandNode.getConnections().map((c) => c.remotePeer.toString());
			expect(bStrandRemotes.length).toBeGreaterThan(0);
			for (const remote of bStrandRemotes) {
				expect(remote).toBe(aStrandPeerId);
			}

			// Deliberately NOT asserted: data replication A↔B — the bootstrap-mode
			// founder commits through a purely local transactor (see file header).
		} finally {
			await B?.stop();
			await A?.stop();
		}
	}, 120_000);
});
