/**
 * Cross-party strand discovery from the formation handshake alone.
 *
 * Two DIFFERENT parties end up meshed on one strand with **no hand-dial anywhere in
 * this file** — the joiner's strand node learns where the host's strand node lives
 * purely from the addresses the formation result carried back.
 *
 * ── Why this scenario exists ──
 *
 * A strand's bootstrap addresses are normally resolved over the control-network
 * strand-addr RPC (`strand-addr-seed-convergence.integration.ts` is the same-party proof
 * of that path). That RPC is membership-gated: it answers CO-CADRE siblings only, and
 * explicitly declares cross-party out of scope. So between two parties there was no
 * production discovery path at all — every cross-party scenario in this repo reached the
 * mesh by dialing one strand node at the other by hand.
 *
 * The formation handshake is the one moment the two parties are already talking, already
 * authenticated, and already agreeing on a strand id. So the responder now discloses its
 * live strand-network multiaddrs on the formation result (after token + disclosure
 * validation, alongside its party id and cadre addresses), the joiner records them, and
 * they become that strand's discovery seed when the joiner launches it.
 *
 * ── Topology ──
 *
 *   HOST   — its own party, sole owner + storage. Pre-creates and FOUNDS the strand, so
 *            it is live and dialable at the moment the invite is redeemed, then publishes
 *            an invite BOUND to it (the reference apps' release flow: mint the invitation,
 *            publish a `FormationInvite` naming the host strand).
 *   JOINER — a different party, one node, no cadre siblings of its own. It dials the host
 *            only to redeem, then stands the SAME strand up locally.
 *
 * The joiner having NO siblings is the point: its strand-addr RPC fan-out is empty by
 * construction, so anything that reaches the mesh had to come from the formation result.
 *
 * ── What is asserted ──
 *
 *   1. `formStrand` returns the host's live STRAND-network addrs (never its control ones).
 *   2. The joiner's strand node connects to the host's strand node with no manual dial,
 *      and the host sees the inbound connection.
 *   3. Rows written on the host reach the joiner over that mesh — the mesh is real, not
 *      merely a socket.
 *
 * ── Known limit, deliberately not covered here ──
 *
 * The carried addresses are held IN MEMORY and never re-resolved (see `docs/strands.md`).
 * A joiner restart loses them; a host relay reservation that rotates before the joiner
 * dials leaves a dead entry. Durability is `backlog/feat-cross-party-strand-addr-durability`.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import {
	CadreNode,
	ControlFormationUsageRecorder,
	generateStrandMemberKey,
	strandMemberKeyPair,
} from '@serfab/cadre-core';
import type { OpenInvitation, StrandRow } from '@serfab/cadre-core';
import {
	controlNodeConfig,
	createSignedSAppConfig,
	makeOwnOwner,
	controlAddrs,
	waitUntil,
} from '../harness/index.js';

/** Minimal sApp schema — one table, enough to prove a row crossed the mesh. */
const SIMPLE_SCHEMA = `
table Data (
    Key text primary key,
    Val text
);
`;

const SAPP_ID = 'sapp-cross-party-seed';
const YEAR_MS = 365 * 24 * 3600_000;
/** Budget for each mesh/replication wait; the wait's own timeout is the failure. */
const CONVERGE_MS = 30_000;

// ═════════════════════════════════════════════════════════════════════════════

describe('Cross-party strand seed carried by formation', () => {
	it('meshes two parties on one strand from the formation result alone', async () => {
		let host: CadreNode | undefined;
		let joiner: CadreNode | undefined;
		try {
			const runTag = Date.now();
			const strandId = `strand-cross-party-${runTag}`;
			const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '0.1.0');

			// ── HOST: sole owner of its own party, storage profile so it can relay ──
			const hostKey = await generateKeyPair('Ed25519');
			host = new CadreNode(controlNodeConfig({
				partyId: `host-${runTag}`,
				privateKey: hostKey,
				profile: 'storage',
				enableRelay: true,
			}));
			await host.start();
			await makeOwnOwner(host, hostKey);

			// Real DB-backed responder wiring (the production shape): it is what resolves a
			// bound invite to its host strand and what holds the connection gate's
			// outstanding-invitation carve-out open for a stranger's dial.
			host.initializeStrandSolicitation({
				formationUsageRecorder: new ControlFormationUsageRecorder(host.getControlDatabase()!),
			});

			// The host strand is founded BEFORE the invite is published, so it is live and
			// dialable at redemption time. This is the whole precondition for the feature:
			// a responder with no running strand node discloses no addresses (asserted by
			// the cadre-core unit suite, not re-proved here).
			const founded = await host.foundStrand({ strandId, type: 'o', sAppConfig: sApp });
			expect(founded.founded).toBe(true);
			const hostStrandNode = founded.instance.libp2pNode!;
			expect(hostStrandNode).toBeDefined();
			const hostStrandPeerId = hostStrandNode.peerId.toString();
			const hostStrandAddrs = hostStrandNode.getMultiaddrs().map((ma) => ma.toString());
			expect(hostStrandAddrs.length).toBeGreaterThan(0);
			// The per-strand transport identity must NOT collapse into the control identity,
			// or every connection assertion below would pass on the CONTROL link instead.
			expect(hostStrandPeerId).not.toBe(host.peerId!.toString());

			// An invite BOUND to that strand: redeeming it records consent against the
			// existing strand rather than minting a new one.
			const invitation: OpenInvitation = await host.createOpenInvitation(SAPP_ID, YEAR_MS);
			await host.publishFormationInvite(invitation.token, SAPP_ID, {
				strandId,
				expiresAtMs: Date.now() + YEAR_MS,
				totalUses: 1,
			});

			// ── JOINER: a DIFFERENT party, alone — no cadre sibling can answer a
			//    strand-addr RPC for it, so the formation result is its only seed.
			joiner = new CadreNode(controlNodeConfig({
				partyId: `joiner-${runTag}`,
				bootstrapNodes: controlAddrs(host),
			}));
			await joiner.start();

			// ── Subject 1: the formation result carries the host's STRAND addrs ──
			const formResult = await joiner.formStrand(invitation, {
				partyId: `joiner-${runTag}`,
				purpose: 'cross-party strand seed',
			});
			expect(formResult.strandId).toBe(strandId);
			expect(formResult.strandAddrs.length).toBeGreaterThan(0);
			const hostControlAddrsNow = controlAddrs(host);
			for (const addr of formResult.strandAddrs) {
				// Every carried addr is one the host's live STRAND node actually announces,
				// names the strand transport peer, and is NOT a control address (the whole
				// class of bug this seed path has to avoid).
				expect(hostStrandAddrs).toContain(addr);
				expect(addr).toContain(hostStrandPeerId);
				expect(hostControlAddrsNow).not.toContain(addr);
			}

			// ── Subject 2: the joiner stands the strand up — NO manual dial ──
			const joinerRow: StrandRow = {
				Id: strandId,
				MemberPrivateKey: null,
				Type: 'o',
				FounderOwnerKey: null,
			};
			const joinerStrand = await joiner.addStrand({ strandRow: joinerRow, sAppConfig: sApp });
			expect(joinerStrand.status).toBe('active');
			const joinerStrandNode = joinerStrand.libp2pNode!;
			expect(joinerStrandNode).toBeDefined();
			const joinerStrandPeerId = joinerStrandNode.peerId.toString();

			// The seed becomes libp2p bootstrap discovery and the connection manager
			// auto-dials it. Both directions confirmed.
			await waitUntil(
				() => joinerStrandNode.getConnections().some((c) => c.remotePeer.toString() === hostStrandPeerId),
				{
					timeoutMs: CONVERGE_MS,
					intervalMs: 250,
					description: "joiner's strand node auto-dials the host's strand node from the carried seed",
				},
			);
			await waitUntil(
				() => hostStrandNode.getConnections().some((c) => c.remotePeer.toString() === joinerStrandPeerId),
				{
					timeoutMs: CONVERGE_MS,
					intervalMs: 250,
					description: "host's strand node sees the inbound connection from the joiner",
				},
			);

			// Negative: every strand-mesh connection the joiner holds is to the host's
			// STRAND node — never to its CONTROL peer id.
			const joinerRemotes = joinerStrandNode.getConnections().map((c) => c.remotePeer.toString());
			expect(joinerRemotes.length).toBeGreaterThan(0);
			for (const remote of joinerRemotes) {
				expect(remote).toBe(hostStrandPeerId);
			}

			// ── Subject 3: the mesh actually carries data ──
			const hostDb = founded.instance.database!.getDatabase();
			await hostDb.exec("insert into App.Data (Key, Val) values ('k1', 'hello from the host')");
			const joinerDb = joinerStrand.database!.getDatabase();
			await waitUntil(
				async () => (await joinerDb.get("select Val from App.Data where Key = 'k1'"))?.Val === 'hello from the host',
				{
					timeoutMs: CONVERGE_MS,
					intervalMs: 250,
					description: 'the host row replicates to the joiner over the seeded mesh',
				},
			);
		} finally {
			await joiner?.stop();
			await host?.stop();
		}
	}, 180_000);

	/**
	 * CLOSED-strand variant (`strand-formation-membership-invite` +
	 * `strand-node-binds-member-peer`): the formation result also carries the joiner's own
	 * single-use `Strand.Invite`, the joiner's node persists its own party identity
	 * (`StrandPartyKey`) and stages the invitation — and standing the strand up is ALL it
	 * takes from there. The bring-up membership reconciler redeems the invitation
	 * automatically once the host-issued `Strand.Invite` row replicates over the seeded
	 * mesh (seating a `Strand.Member` row under the JOINER's key, distinct from the
	 * founder's) and registers each machine's own `Strand.MemberPeer` binding. No
	 * hand-rolled `consumeInvite`/`registerMemberPeer` anywhere in this test — that
	 * absence is the assertion.
	 */
	it('redeems the carried membership invitation automatically at strand bring-up', async () => {
		let host: CadreNode | undefined;
		let joiner: CadreNode | undefined;
		try {
			const runTag = Date.now();
			const strandId = `strand-closed-membership-${runTag}`;
			const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '0.1.0');

			const hostKey = await generateKeyPair('Ed25519');
			host = new CadreNode(controlNodeConfig({
				partyId: `host-c-${runTag}`,
				privateKey: hostKey,
				profile: 'storage',
				enableRelay: true,
			}));
			await host.start();
			await makeOwnOwner(host, hostKey);
			host.initializeStrandSolicitation({
				formationUsageRecorder: new ControlFormationUsageRecorder(host.getControlDatabase()!),
			});

			// Found the CLOSED host strand: the shared read secret gates attach; the
			// founder's own identity (StrandPartyKey, minted by publish) signs the
			// membership invitation the redemption below issues.
			const founded = await host.foundStrand({
				strandId,
				type: 'c',
				memberPrivateKey: await generateStrandMemberKey(),
				sAppConfig: sApp,
			});
			expect(founded.founded).toBe(true);
			const founderPartyKey = await host.getControlDatabase()!.queryStrandPartyKey(strandId);
			expect(founderPartyKey).not.toBeNull();
			const founderMemberKey = strandMemberKeyPair(founderPartyKey!).publicKeyB64;

			const invitation: OpenInvitation = await host.createOpenInvitation(SAPP_ID, YEAR_MS);
			await host.publishFormationInvite(invitation.token, SAPP_ID, {
				strandId,
				expiresAtMs: Date.now() + YEAR_MS,
				totalUses: 1,
			});

			// The joiner is a REAL party: its own identity key, its own owner genesis —
			// persisting the formation-issued StrandPartyKey identity is an owner-signed
			// write into the joiner's OWN control DB (formStrand throws without it).
			const joinerKey = await generateKeyPair('Ed25519');
			joiner = new CadreNode(controlNodeConfig({
				partyId: `joiner-c-${runTag}`,
				privateKey: joinerKey,
				bootstrapNodes: controlAddrs(host),
				// The membership reconciler mirrors this cadence: a fast retry keeps the
				// "invite row not replicated yet → retry next pass" ladder inside the wait
				// budget instead of the 30 s production default.
				revocationPollMs: 2_000,
			}));
			await joiner.start();
			await makeOwnOwner(joiner, joinerKey);

			// ── The formation result carries the read secret AND the membership invitation ──
			const formResult = await joiner.formStrand(invitation, {
				partyId: `joiner-c-${runTag}`,
				purpose: 'closed-strand membership',
			});
			expect(formResult.strandId).toBe(strandId);
			expect(formResult.memberPrivateKey).toBeTruthy();
			expect(formResult.membershipInvite).toBeDefined();
			const invite = formResult.membershipInvite!;

			// The joiner's node persisted its OWN party identity and staged the invitation.
			const joinerPartyKey = await joiner.getControlDatabase()!.queryStrandPartyKey(strandId);
			expect(joinerPartyKey).not.toBeNull();
			expect(joinerPartyKey).not.toBe(founderPartyKey);
			const joinerMemberKey = strandMemberKeyPair(joinerPartyKey!).publicKeyB64;
			expect(joinerMemberKey).not.toBe(founderMemberKey);
			expect(joiner.getPendingMembershipInvite(strandId)).toEqual(invite);

			// ── Stand the strand up on the joiner: bring-up finishes the join on its own ──
			const joinerStrand = await joiner.addStrand({
				strandRow: {
					Id: strandId,
					MemberPrivateKey: formResult.memberPrivateKey!,
					Type: 'c',
					FounderOwnerKey: null,
				},
				sAppConfig: sApp,
			});
			const joinerDb = joinerStrand.database!.getDatabase();
			const joinerStrandPeerId = joinerStrand.libp2pNode!.peerId.toString();

			// The reconciler waits out the host-issued Strand.Invite row replicating over
			// the seeded mesh, then redeems it: a real Strand.Member row lands under the
			// JOINER's own party key with no explicit consumeInvite anywhere in this test.
			await waitUntil(
				async () => {
					for await (const row of joinerDb.eval('select Key from Strand.Member')) {
						if (row.Key === joinerMemberKey) return true;
					}
					return false;
				},
				{
					timeoutMs: CONVERGE_MS,
					intervalMs: 500,
					description: "bring-up redeems the staged invitation — the joiner's own Member row appears",
				},
			);
			const memberKeys = new Set<string>();
			for await (const row of joinerDb.eval('select Key from Strand.Member')) {
				memberKeys.add(row.Key as string);
			}
			expect(memberKeys.has(joinerMemberKey)).toBe(true);
			expect(memberKeys.has(founderMemberKey)).toBe(true);

			// The spent invitation is un-staged, and the joiner machine bound ITSELF: the
			// durable machine→party record revocation enforcement keys on, written with no
			// registerMemberPeer call here either.
			await waitUntil(
				async () => {
					if (joiner!.getPendingMembershipInvite(strandId) !== undefined) return false;
					for await (const row of joinerDb.eval('select MemberKey, PeerId from Strand.MemberPeer')) {
						if (row.MemberKey === joinerMemberKey && row.PeerId === joinerStrandPeerId) return true;
					}
					return false;
				},
				{
					timeoutMs: CONVERGE_MS,
					intervalMs: 500,
					description: "the joiner machine's own MemberPeer binding lands and the invitation is un-staged",
				},
			);

			// And the admission converges back to the FOUNDER's replica — the joiner is a
			// member of the shared strand, not of a local fork. The founder machine's own
			// reconciler bound it too, so BOTH parties' bindings are visible there.
			const hostDb = founded.instance.database!.getDatabase();
			const hostStrandPeer = founded.instance.libp2pNode!.peerId.toString();
			await waitUntil(
				async () => {
					let joinerMemberSeen = false;
					for await (const row of hostDb.eval('select Key from Strand.Member')) {
						if (row.Key === joinerMemberKey) joinerMemberSeen = true;
					}
					if (!joinerMemberSeen) return false;
					const bindings = new Set<string>();
					for await (const row of hostDb.eval('select MemberKey, PeerId from Strand.MemberPeer')) {
						bindings.add(`${row.MemberKey}|${row.PeerId}`);
					}
					return bindings.has(`${founderMemberKey}|${hostStrandPeer}`)
						&& bindings.has(`${joinerMemberKey}|${joinerStrandPeerId}`);
				},
				{
					timeoutMs: CONVERGE_MS,
					intervalMs: 500,
					description: "the joiner's Member row and both machines' bindings replicate to the host",
				},
			);
		} finally {
			await joiner?.stop();
			await host?.stop();
		}
	}, 180_000);
});
