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
 * because A's own `CadrePeer` row is the joiner's RPC target — its peerId must
 * be real and stable.
 * Joiner B is a plain member with a stable key and `bootstrapNodes: [A]`, which
 * makes A unconditionally admitted by B's fail-closed control-stream gate once
 * B's authorized-member snapshot goes non-empty. Every gated write is a clean
 * {A, B} 2-node commit made only after the control link is both-sides
 * confirmed.
 *
 * ── What is deliberately NOT asserted ──
 *
 * Data replication between A and B. Both run the network transactor, so rows
 * MAY now travel the mesh this test forms — but the claim here is connection +
 * seed content, and gating on replication would hang this scenario on the
 * cluster's replication timing rather than on the seed path it pins. A
 * data-convergence scenario is a separate ticket, not this one.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { CadreNode, collectStrandAddrs } from '@serfab/cadre-core';
import {
	waitUntil,
	waitForCadrePeerConverged,
	controlNodeConfig,
	createSignedSAppConfig,
	makeOwnOwner,
	connectControlNodes,
	controlAddrs,
} from '../harness/index.js';

/** Minimal hibernation-friendly sApp schema. */
const SIMPLE_SCHEMA = `
table Data (
    Key text primary key,
    Val text
);
`;

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
			A = new CadreNode(controlNodeConfig({ partyId, privateKey: aKey, profile: 'storage' }));
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
			B = new CadreNode(controlNodeConfig({ partyId, privateKey: bKey, bootstrapNodes: [aControlAddrList[0]!] }));
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
			// A stands the strand up solo (first node of a brand-new strand — the
			// network transactor self-coordinates at a cohort of one). The instance
			// must have a live strand-network node with dialable addrs for the RPC
			// to answer with.
			const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '0.1.0');
			const aStrand = await A.addStrand({
				strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' },
				sAppConfig: sApp,
			});
			expect(aStrand.status).toBe('active');
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
			// B stands up the SAME strand: the internal seed pass must feed B's
			// strand node A's strand addrs — the same union the direct RPC above
			// returned.
			const bStrand = await B.addStrand({
				strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' },
				sAppConfig: sApp,
			});
			expect(bStrand.status).toBe('active');
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

			// Deliberately NOT asserted: data replication A↔B — the subject is the
			// seed path, not replication timing (see file header).
		} finally {
			await B?.stop();
			await A?.stop();
		}
	}, 120_000);
});
