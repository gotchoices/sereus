/**
 * Self-test for the topology builder (`harness/topology.ts`): N parties × M machines
 * of real `CadreNode`s, plus the strand-join step.
 *
 * These tests are about the BUILDER's claims, not about replication mechanics (other
 * suites own those): every shape the builder promises must come up, its readiness
 * barriers must mean what they say, its named validation throws must fire before any
 * node starts, and its failure path must stop everything it started.
 *
 * Timeouts are explicit and generous per the builder's sizing rule of thumb
 * (~10-15 s per machine; a strand member is a second libp2p node). See the
 * `topology.ts` module header before adding shapes here.
 */

import { describe, it, expect } from 'vitest';
import type { Database } from '@quereus/quereus';
import type { CadreNode } from '@serfab/cadre-core';
import { generateStrandMemberKey, strandMemberKeyPair } from '@serfab/cadre-core';
import {
	bootTopology,
	joinStrandOn,
	createSignedSAppConfig,
	captureRawStorage,
	BlockStoreProbeError,
	readCohort,
	randomPeerId,
	waitUntil,
} from '../harness/index.js';
import type { Topology } from '../harness/index.js';

/** The one-table sApp several other strand scenarios already use. */
const SIMPLE_SCHEMA = `
table Data (
    Key text primary key,
    Val text
);
`;

/** One shared budget for every post-boot convergence wait below. */
const CONVERGE_BUDGET_MS = 30_000;

/**
 * Every `App.Data` row, via an UNFILTERED scan filtered in JavaScript — a where-equality
 * point lookup can MISS on the networked optimystic module (the lookup-shape note in
 * `strand-membership-closed-strand-e2e`).
 */
async function readDataRows(db: Database): Promise<Map<string, string>> {
	const rows = new Map<string, string>();
	for await (const row of db.eval('select Key, Val from App.Data')) {
		rows.set(row.Key as string, row.Val as string);
	}
	return rows;
}

/** Row count of one `Strand.*` table, for the founder-bootstrap assertions. */
async function strandCount(db: Database, table: 'Header' | 'Member' | 'Manager'): Promise<number> {
	const row = await db.get(`select count(1) as c from Strand.${table}`);
	return (row?.c as number) ?? 0;
}

/** Peer ids of every OPEN control connection `node` currently holds. */
function controlConnectionPeers(node: CadreNode): string[] {
	return (node.getControlNode()?.getConnections() ?? []).map((c) => c.remotePeer.toString());
}

describe('Topology builder harness', () => {
	it('rejects a malformed topology spec by name, before starting anything', async () => {
		await expect(bootTopology({ tag: 'topo-bad', parties: [] }))
			.rejects.toThrow(/spec\.parties is empty/);
		await expect(bootTopology({
			tag: 'topo-bad',
			parties: [
				{ name: 'twin', machines: [{}] },
				{ name: 'twin', machines: [{}] },
			],
		})).rejects.toThrow(/duplicate party name 'twin'/);
		await expect(bootTopology({
			tag: 'topo-bad',
			parties: [{ name: 'hollow', machines: [] }],
		})).rejects.toThrow(/party 'hollow' has an empty machines list/);
	}, 30_000);

	it('degenerate 1 party × 1 machine: the bootPair-A owner surface, and named lookup/join throws', async () => {
		let topo: Topology | undefined;
		try {
			topo = await bootTopology({ tag: 'topo-solo', parties: [{ name: 'solo', machines: [{}] }] });

			// The owner handle, by every lookup shape the interface promises.
			const owner = topo.machine('solo');
			expect(topo.machine('solo', 0)).toBe(owner);
			expect(topo.nodes()).toEqual([owner.node]);
			expect(owner.index).toBe(0);
			expect(owner.party).toBe('solo');
			expect(owner.node.isRunning).toBe(true);

			// Alone: nobody to connect to, and the cohort is exactly self.
			expect(controlConnectionPeers(owner.node)).toEqual([]);
			expect(await readCohort(owner.node.getControlNode()!, 'solo owner')).toEqual([owner.peerId]);

			// Owner-genesis surface intact, as bootPair's A-side has it: it can mint a seed
			// (seed bootstrap initialized, own row in it)…
			const seed = await owner.node.createSeed();
			expect(seed.peers.some((p) => p.peerId === owner.peerId)).toBe(true);
			// …and write an owner-signed control row.
			const vouchee = await randomPeerId();
			await owner.node.authorizePeer(vouchee);
			expect(await owner.node.getControlDatabase()!.queryPeerRecord(vouchee)).not.toBeNull();

			// Named lookup throws — never an undefined dereference downstream.
			expect(() => topo!.machine('nope')).toThrow(/unknown party 'nope'/);
			expect(() => topo!.machine('solo', 5)).toThrow(/index 5 is out of range/);

			// Contradictory join specs throw by name, before any addStrand runs.
			const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '1.0.0');
			await expect(joinStrandOn({ strandId: 's', sAppConfig: sApp, members: [] }))
				.rejects.toThrow(/empty members list/);
			await expect(joinStrandOn({
				strandId: 's', sAppConfig: sApp, members: [owner], mesh: 'none', barrier: true,
			})).rejects.toThrow(/mesh 'none' AND barrier true/);
			// A non-owner members[0] with publish: only index/party are read before the throw,
			// so a reshaped copy of the real machine exercises the check without a second boot.
			await expect(joinStrandOn({
				strandId: 's', sAppConfig: sApp, members: [{ ...owner, index: 1 }], publish: true,
			})).rejects.toThrow(/publish requires members\[0\] to be its party's owner/);
			await expect(joinStrandOn({ strandId: 's', sAppConfig: sApp, members: [owner, owner] }))
				.rejects.toThrow(/listed twice/);
			await expect(joinStrandOn({ strandId: 's', sAppConfig: sApp, members: [owner], type: 'c' }))
				.rejects.toThrow(/needs a memberPrivateKey/);
			await expect(joinStrandOn({
				strandId: 's', sAppConfig: sApp, members: [owner], memberPrivateKey: 'k',
			})).rejects.toThrow(/memberPrivateKey with type 'o'/);

			// stop() is idempotent.
			await topo.stop();
			await topo.stop();
			expect(owner.node.isRunning).toBe(false);
		} finally {
			await topo?.stop();
		}
	}, 90_000);

	it('genesis-first, asymmetric 3+1: every machine of the trio reaches a 3-cohort, membership holds both ways', async () => {
		let topo: Topology | undefined;
		try {
			// Asymmetric on purpose: the spec is per-party lists, and a 3-machine party is
			// the shape TestParty's star-wired drones can never reach (their cohort caps at 2).
			topo = await bootTopology({
				tag: 'topo-first',
				parties: [
					{ name: 'trio', machines: [{}, {}, {}] },
					{ name: 'lone', machines: [{}] },
				],
			});

			const trio = [topo.machine('trio', 0), topo.machine('trio', 1), topo.machine('trio', 2)];
			const lone = topo.machine('lone');

			// The builder's barrier already waited for this; assert it as this test's own
			// claim rather than trusting the barrier tested itself.
			for (const machine of trio) {
				const cohort = await readCohort(machine.node.getControlNode()!, `trio[${machine.index}]`);
				expect([...cohort].sort()).toEqual(trio.map((m) => m.peerId).sort());
			}
			expect(await readCohort(lone.node.getControlNode()!, 'lone')).toEqual([lone.peerId]);

			// Membership both ways for every ordered machine pair: row presence AND the
			// anchored-trust predicate. Rows land at different moments on different machines
			// (seed vs replication), so converge first, then assert each pair by name.
			await waitUntil(async () => {
				for (const a of trio) {
					for (const b of trio) {
						if (a === b) continue;
						if (!(await a.node.isMember(b.peerId))) return false;
						if (!(await a.node.isAuthorizedMember(b.peerId))) return false;
					}
				}
				return true;
			}, {
				timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 500,
				description: 'every trio machine holds every sibling as an authorized member',
			});
			for (const a of trio) {
				for (const b of trio) {
					if (a === b) continue;
					expect(await a.node.isMember(b.peerId), `trio[${a.index}] isMember trio[${b.index}]`).toBe(true);
					expect(await a.node.isAuthorizedMember(b.peerId), `trio[${a.index}] isAuthorizedMember trio[${b.index}]`).toBe(true);
				}
			}

			// Parties are mutually independent: no control link crosses the party line.
			const trioPeerIds = new Set(trio.map((m) => m.peerId));
			expect(controlConnectionPeers(lone.node).filter((p) => trioPeerIds.has(p))).toEqual([]);
			for (const machine of trio) {
				expect(
					controlConnectionPeers(machine.node).includes(lone.peerId),
					`trio[${machine.index}] holds no control connection to the lone party`,
				).toBe(false);
			}
		} finally {
			await topo?.stop();
		}
	}, 180_000);

	it('genesis-after-cohort at M=3: rows written after the 3-cohort formed read back on members', async () => {
		let topo: Topology | undefined;
		try {
			topo = await bootTopology({
				tag: 'topo-after',
				genesis: 'genesis-after-cohort',
				parties: [{ name: 'gamma', machines: [{}, {}, {}] }],
			});

			const machines = [topo.machine('gamma', 0), topo.machine('gamma', 1), topo.machine('gamma', 2)];
			const owner = machines[0]!;

			for (const machine of machines) {
				const cohort = await readCohort(machine.node.getControlNode()!, `gamma[${machine.index}]`);
				expect(cohort.length).toBeGreaterThanOrEqual(3);
			}

			// Every genesis-era row was committed AFTER the cohort spanned the party, so it
			// must be readable on the members — the property bootConnectedPair buys at M=2,
			// and the reason this ordering exists (see control-db-cross-node-convergence-halted
			// for what write-while-alone genesis does instead).
			for (const member of machines.slice(1)) {
				await waitUntil(async () => {
					const rec = await member.node.getControlDatabase()!.queryPeerRecord(owner.peerId);
					return !!rec && rec.addrs.length > 0;
				}, {
					timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 500,
					description: `gamma[${member.index}] reads the owner's addressed CadrePeer row back`,
				});
			}

			// And a fresh post-boot owner write lands the same way.
			const vouchee = await randomPeerId();
			await owner.node.authorizePeer(vouchee);
			for (const member of machines.slice(1)) {
				await waitUntil(
					async () => !!(await member.node.getControlDatabase()!.queryPeerRecord(vouchee)),
					{
						timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 500,
						description: `gamma[${member.index}] reads the post-boot vouch row back`,
					});
			}
		} finally {
			await topo?.stop();
		}
	}, 180_000);

	it('two 2-machine parties share one strand across 3 of the 4 machines', async () => {
		// Measured wall-clock 2026-09-08: ~5 s (4 control nodes + 3 strand nodes, loopback).
		// The 240 s budget is deliberate headroom, not an expectation.
		const leftOutCapture = captureRawStorage();
		let topo: Topology | undefined;
		try {
			topo = await bootTopology({
				tag: 'topo-share',
				parties: [
					{ name: 'alpha', machines: [{}, {}] },
					// beta[1] is the machine the strand must never touch; its raw storage is
					// captured so "no strand-scoped store" is a physical claim.
					{ name: 'beta', machines: [{}, { storageProvider: leftOutCapture.provider }] },
				],
			});

			const members = [topo.machine('alpha', 0), topo.machine('alpha', 1), topo.machine('beta', 0)];
			const leftOut = topo.machine('beta', 1);

			const strandId = `topo-share-strand-${Date.now()}`;
			const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '1.0.0');
			const instances = await joinStrandOn({ strandId, sAppConfig: sApp, members });
			expect(instances).toHaveLength(3);

			// The strand mesh is its own libp2p plane: each member's strand peer id differs
			// from its control peer id, so nothing below can ride the control connections.
			for (let i = 0; i < members.length; i++) {
				expect(instances[i]!.libp2pNode!.peerId.toString()).not.toBe(members[i]!.peerId);
			}

			// A write on members[0] is readable on BOTH other members — including beta[0],
			// which shares no control network with the writer.
			const writerDb = instances[0]!.database!.getDatabase();
			await writerDb.exec("insert into App.Data (Key, Val) values ('shared-key', 'shared-val')");
			for (let i = 1; i < instances.length; i++) {
				const db = instances[i]!.database!.getDatabase();
				await waitUntil(async () => (await readDataRows(db)).get('shared-key') === 'shared-val', {
					timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 500,
					description: `member ${i} reads the shared strand row back`,
				});
			}

			// The left-out machine never saw addStrand: no instance, no strand-scoped store.
			expect(leftOut.node.getStrands().size).toBe(0);
			const scopes = leftOutCapture.scopes();
			expect(scopes).not.toContain(strandId);
			expect(() => leftOutCapture.forStrand(strandId)).toThrow(BlockStoreProbeError);

			// No cross-party CONTROL links exist — the strand is the only shared plane.
			const alphaPeerIds = new Set([members[0]!.peerId, members[1]!.peerId]);
			const betaPeerIds = new Set([members[2]!.peerId, leftOut.peerId]);
			for (const machine of [members[0]!, members[1]!]) {
				expect(
					controlConnectionPeers(machine.node).filter((p) => betaPeerIds.has(p)),
					`alpha[${machine.index}] control connections into beta`,
				).toEqual([]);
			}
			for (const machine of [members[2]!, leftOut]) {
				expect(
					controlConnectionPeers(machine.node).filter((p) => alphaPeerIds.has(p)),
					`beta[${machine.index}] control connections into alpha`,
				).toEqual([]);
			}
		} finally {
			await topo?.stop();
		}
	}, 240_000);

	it("controlMesh 'star' plus the strand knobs the mesh cases never drive: mesh 'none', publish, closed founder", async () => {
		let topo: Topology | undefined;
		try {
			topo = await bootTopology({
				tag: 'topo-star',
				controlMesh: 'star',
				parties: [{ name: 'star', machines: [{}, {}, {}] }],
			});
			const owner = topo.machine('star', 0);
			const spoke1 = topo.machine('star', 1);
			const spoke2 = topo.machine('star', 2);

			// Star wiring: the owner reaches every machine, and each spoke holds exactly
			// ONE control connection — to the owner. That is the whole difference from
			// 'full', and the reason 'star' barriers on the owner alone.
			const ownerCohort = await readCohort(owner.node.getControlNode()!, 'star owner');
			expect(ownerCohort.length).toBeGreaterThanOrEqual(3);
			for (const spoke of [spoke1, spoke2]) {
				expect(controlConnectionPeers(spoke.node), `star[${spoke.index}] spoke links`)
					.toEqual([owner.peerId]);
			}

			const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '1.0.0');

			// mesh 'none' + publish: the builder wires nothing and runs no barrier (both
			// members still come up active), and the owner-signed Strand row lands in the
			// party's control DB where a watcher would find it.
			const openId = `topo-star-open-${Date.now()}`;
			const openInstances = await joinStrandOn({
				strandId: openId, sAppConfig: sApp, members: [owner, spoke1], mesh: 'none', publish: true,
			});
			expect(openInstances.map((i) => i.status)).toEqual(['active', 'active']);
			const published = (await owner.node.getControlDatabase()!.queryStrands())
				.find((row) => row.Id === openId);
			// FounderOwnerKey records the publishing machine's owner key (owner-signed insert).
			expect(published).toEqual({
				Id: openId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: expect.any(String),
			});

			// Closed strand: the founder derives its Member/Manager keypair from the
			// PARTY's own identity key (never from the shared MemberPrivateKey), so the
			// bootstrap rows prove the injected party key reached the bootstrap.
			const memberPrivateKey = await generateStrandMemberKey();
			const partyMemberPrivateKey = await generateStrandMemberKey();
			const founderKeyPair = strandMemberKeyPair(partyMemberPrivateKey);
			const closedId = `topo-star-closed-${Date.now()}`;
			const [closed] = await joinStrandOn({
				strandId: closedId, sAppConfig: sApp, members: [spoke2],
				type: 'c', memberPrivateKey, partyMemberPrivateKey, founder: true, mesh: 'none',
			});
			const closedDb = closed!.database!.getDatabase();
			expect(await strandCount(closedDb, 'Header')).toBe(1);
			expect(await strandCount(closedDb, 'Member')).toBe(1);
			expect(await strandCount(closedDb, 'Manager')).toBe(1);
			expect((await closedDb.get('select Type from Strand.Header'))?.Type).toBe('c');
			expect((await closedDb.get('select Key from Strand.Member'))?.Key)
				.toBe(founderKeyPair.publicKeyB64);
		} finally {
			await topo?.stop();
		}
	}, 180_000);

	it('a machine that fails to start stops everything already started before the throw', async () => {
		const started: CadreNode[] = [];
		// machine 2's listen addr cannot parse, so its start() throws DETERMINISTICALLY —
		// after the owner and machine 1 are already up.
		await expect(bootTopology({
			tag: 'topo-fail',
			started,
			parties: [{ name: 'omega', machines: [{}, {}, { listenAddrs: ['not-a-multiaddr'] }] }],
		})).rejects.toThrow(/party omega machine 2: member starts/);

		// Exactly the nodes that STARTED are mirrored — the failed machine never joined —
		// and each of them was stopped before the error propagated.
		expect(started).toHaveLength(2);
		for (const node of started) {
			expect(node.isRunning).toBe(false);
		}
	}, 120_000);
});
