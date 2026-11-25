/**
 * A machine that runs a closed strand as a CLIENT — it reads and writes through the machines that
 * store the strand and stores none of its blocks — keeps being served after its own party replaces
 * its membership key in that strand (`docs/strands/keys.md` → "Replacing the party's key").
 *
 * This is the end-to-end proof of `client-locked-out-of-closed-strand-after-party-key-replacement`.
 * The defect: a client the replacement driver does not bind under the new key is refused by the
 * serving machines the moment the old key leaves, and cannot write the binding that would recover
 * it. No unit layer reproduces that: the refusal is the revoked-peer gate on the serving machines,
 * derived from replicated membership rows and applied to real libp2p streams.
 *
 * What the run distinguishes, measured in this ticket's review by breaking the fix on a scratch
 * build rather than by inspection:
 *
 * - With this machine's `StrandPeer` row never published at all, the run fails at step 1 — A1 never
 *   holds four rows.
 * - With the row published but the binder blind to it (clients dropped from `PartyStrandPeers.live`),
 *   the run fails at step 3: A4 is missing from the new key's bindings, and its rebuilt membership
 *   loop never latches done, because a client with no binding cannot write its own.
 * - Steps 4 and 5 are then the positive half: a bound client is still served and still writing once
 *   the old key has gone, and the removed machine is not.
 *
 * One correction to how the defect was first filed, since this file is where someone will look it
 * up: a client's row was not missing outright before the fix. Only the bring-up publish was behind
 * the serving role; the membership reconciler's own step 6 publishes the row whatever the role
 * (`strand-membership-reconciler.ts`), so a client's row did arrive — as `role: null`, the only
 * form the row then had — once its first reconciler pass ran. The lockout therefore needed the
 * removal to land before that pass, and the published role is what the offline queue needs besides.
 *
 * ── The machines ──
 *
 * One party, four machines, one closed strand the owner founded, no second party — so the
 * replacement runs every step on the owner, whose old key is the strand's manager and seats the new
 * one itself.
 *
 * - **A1**, the owner: founds the cadre and the closed strand, and removes A3.
 * - **A2**, an always-on serving machine, online throughout: the machine whose refusal of A3 and
 *   service of A4 are what the cut and the survival are read from.
 * - **A3**, a second serving machine, with the app. The machine removed.
 * - **A4**, a `device` with `roles: { strandCohortMember: false }`, with the app. Its strand node is
 *   an Optimystic client, so it is in no cohort and holds no strand store.
 *
 * All four run the same one-table key/value sApp, so every machine's convergence is an `App.Data`
 * read rather than a block-coverage check — a client has no store to compare.
 *
 * ── Why the bring-up is shaped the way it is ──
 *
 * The three serving machines are meshed and barriered at a cohort of three
 * ({@link meshStrandNodes}); A4 is launched after them and hand-dialed to A1 and A2, as
 * `strand-client-node-holds-no-blocks.integration.ts` does, so no claim rides on seed timing. A4 is
 * not dialed at A3 — the machine about to be removed is no use to it — but it finds A3 by itself
 * through the strand's own discovery, which is why step 4 has to deal with A3 in A4's cohort.
 *
 * A4's `StrandPeer` row has to be in A1's control database BEFORE the removal, because that read is
 * what the replacement driver binds from. Gating on it is what makes this run assert the direct
 * path. The recovery path — a sibling's membership loop binding a client whose row arrives after
 * the replacement — is the existing sibling-binding mechanism and is not asserted here.
 *
 * ── What is asserted, in order ──
 *
 *   1. Every machine published a `StrandPeer` row in A1's control database, A4's marked `client`
 *      and the three serving rows carrying no role; every machine is bound under the party's
 *      current key; and a row A4 writes reaches A2.
 *   2. `removeMachine(A3)` reports the strand `rotated`, the control row names a new key, and no
 *      pending row is left.
 *   3. The strand's rows are on the new key: it is the party's one member and its manager, every
 *      remaining machine — A4 included — is bound under it, and A3 is bound only under the old one.
 *      A4's own strand then switches to the new key and its rebuilt membership loop latches done.
 *   4. After the old key's departure has replicated to A1 and A2 (read from their cut of A3), A4 is
 *      still served by one of them, and a second row A4 writes reaches A2: the behaviour the defect
 *      took away. A broken build never reaches this step, failing at 1 or 3 above instead.
 *   5. A3 is cut, in both directions of evidence: no connection from A1 or A2, and it never
 *      converges on the second row while A2's paired read of the same row succeeds.
 *
 * Timing: revocation enforcement runs the production schedule on every machine, so each cut read
 * here is the membership rows arriving, which is what an app gets. The one refresh the run drives
 * is A4's own, after both cuts have been read (see below). The membership reconciler and the
 * control cohort reconcile run on short intervals through the harness, since their production
 * defaults would put a pass outside the gates.
 *
 * NOT asserted here, with reasons:
 *
 * - **A4 refusing A3.** A client stores none of the membership rows, so nothing wakes its own
 *   revoked-peer gate and it reaches a removal made elsewhere only on that gate's 5-minute backstop
 *   (`docs/cadre/node.md`). The run drives the refresh rather than waiting it out, between the two
 *   halves of step 4, because until A4 stops talking to A3 its own writes contend with a removed
 *   machine in every cohort. What is read is A1's and A2's refusal of A3, never A4's.
 * - **The offline queue never waiting for A4.** `getUnreachedStrandMachines` answers empty on a
 *   node that offers no offline mode, so the claim would need A2 rebuilt with a file journal; and
 *   A4 stays connected to A2 throughout, so an unconnected serving machine — the only thing that
 *   list names — could not appear whatever A4's role were. The claim that a client's row is skipped
 *   is pinned where it branches, in `strand-party-machines.spec.ts`.
 *
 * ── Running it ──
 *
 *   yarn workspace @serfab/integration-tests exec vitest run client-survives-party-key-replacement
 */

import { describe, it, expect } from 'vitest';
import { generateStrandMemberKey, strandMemberKeyPair } from '@serfab/cadre-core';
import type { CadreNode, SAppConfig, StrandInstance } from '@serfab/cadre-core';
import {
	awaitBindingsVisible,
	awaitCut,
	awaitPartyKey,
	awaitRowVisible,
	awaitStrandRow,
	awaitSwapOn,
	binding,
	bootTopology,
	connectStrandNodes,
	createSignedSAppConfig,
	dataValue,
	expectConnected,
	expectNeverConverges,
	insertWithRetry,
	managerKeys,
	memberKeys,
	memberPeerBindings,
	membershipLoopDone,
	meshStrandNodes,
	NO_CONVERGENCE_BUDGET_MS,
	readCohort,
	REMAINING_COHORT_WRITE_BUDGET_MS,
	runningPartyKey,
	STRAND_GATE,
	STRAND_MESH_TIMEOUT_MS,
	strandConnectionsTo,
	strandMachine,
	strandPeerRoles,
	waitUntil,
	type StrandMachine,
	type Topology,
} from '../harness/index.js';

/** The one-table key/value sApp the removal scenarios share. No RBAC: what is under test is whether a write reaches a machine, not who may author it. */
const SIMPLE_SCHEMA = `
table Data (
    Key text primary key,
    Val text
);
`;

/** The membership reconciler's cadence: keeps its ladder inside {@link STRAND_GATE} rather than the 30 s default. */
const RECONCILE_POLL_MS = 2_000;
/** The control cohort's reconcile backstop, which is what replicates the swap to the other machines inside the gates. */
const CONTROL_RECONCILE_MS = 2_000;

/** Eight libp2p nodes (a control node and a strand node per machine), sized by `harness/topology.ts`'s rule of thumb with the gates on top; measured at 30 to 50 s. */
const TEST_TIMEOUT_MS = 600_000;

/** The harness's knobs every machine of the party gets. */
const MACHINE = { membershipReconciliation: { pollIntervalMs: RECONCILE_POLL_MS }, reconcileMs: CONTROL_RECONCILE_MS } as const;

/** The party's four machines on the closed strand, with what the removal needs to name A3 and recognize the key it replaces. */
interface PartyOnStrand {
	owner: CadreNode;
	a1: StrandMachine;
	a2: StrandMachine;
	a3: StrandMachine;
	a4: StrandMachine;
	strandId: string;
	oldMemberKey: string;
	/** A3's CONTROL peer id: what `removeMachine` takes. */
	a3MachineId: string;
}

/**
 * The strand instance a machine attaches from the party's published `Strand` row — the path a
 * non-founding machine of the party takes, read key included.
 */
async function attachFromPartyRow(node: CadreNode, strandId: string, label: string, sApp: SAppConfig): Promise<StrandInstance> {
	return await node.addStrand({ strandRow: await awaitStrandRow(node, strandId, label), sAppConfig: sApp });
}

/**
 * A1's control database holds a `StrandPeer` row for every machine of the party, with A4's marked
 * `client` and the serving machines' carrying none. This read is what the replacement driver binds
 * from, so the run gates on it rather than merely checking it.
 */
async function expectStrandPeerRoles({ owner, a1, a2, a3, a4, strandId }: PartyOnStrand): Promise<void> {
	await waitUntil(async () => (await strandPeerRoles(owner, strandId, 'A1')).size >= 4, {
		...STRAND_GATE, description: 'A1 holds a StrandPeer row for each of the party\'s four machines',
	});
	const roles = await strandPeerRoles(owner, strandId, 'A1');
	expect(new Set(roles.keys()), 'the row set is every machine of the party that runs the strand').toEqual(new Set([a1, a2, a3, a4].map((machine) => machine.peerId)));
	expect(roles.get(a4.peerId), 'the client\'s row says it stores none of the strand').toBe('client');
	for (const machine of [a1, a2, a3]) {
		expect(roles.get(machine.peerId), `${machine.label}'s row carries no role, which means it serves`).toBeNull();
	}
}

/**
 * The strand's rows just after the driver ran on A1: the new key is the party's one seat and its
 * manager, every remaining machine is bound under it — the client as much as the servers — and A3
 * is left bound under a key that is no longer a member.
 *
 * NOTE: one read, taken the moment `removeMachine` resolves, with no gate behind it. A broken-fix
 * run in this ticket's review saw A3's binding under the old key missing from it once, which this
 * assertion would report as the removal having cleared a deny record. Two candidates if it ever
 * flakes on an unmodified build: a networked scan of `Strand.MemberPeer` answering from a view
 * older than the rotation's own writes, or the reconciler's step 5 clearing a removed machine's
 * binding in a pass that still runs under the old key after the swap cleared the pending row
 * (`strand-membership-reconciler.ts` → `clearRemovedMachines`). Seven runs on the unmodified build
 * have not reproduced it; gate the read before chasing anything else.
 */
async function expectRowsOnNewKey({ a1, a2, a3, a4, oldMemberKey }: PartyOnStrand, newMemberKey: string): Promise<void> {
	expect(new Set(await memberKeys(a1.db))).toEqual(new Set([newMemberKey]));
	expect(await managerKeys(a1.db)).toEqual([newMemberKey]);
	const bindings = await memberPeerBindings(a1.db);
	expect(bindings).toEqual(expect.arrayContaining([
		binding(newMemberKey, a1), binding(newMemberKey, a2), binding(newMemberKey, a4), binding(oldMemberKey, a3),
	]));
	expect(bindings).not.toContain(binding(newMemberKey, a3));
}

/**
 * At least one serving machine still holds a strand connection to `client`, or throws naming what
 * each of them held. Read from the SERVERS' side because their revoked-peer gate is what hangs up:
 * a client missing from the new key's bindings is swept with the removed machine.
 */
function expectServedByAny(client: StrandMachine, servers: readonly StrandMachine[], why: string): void {
	if (!servers.some((server) => strandConnectionsTo(server, client) > 0)) {
		const held = servers.map((server) => `${server.label}: ${strandConnectionsTo(server, client)}`).join(', ');
		throw new Error(`no serving machine holds a strand connection to ${client.label} (${held}) but one must: ${why}`);
	}
}

/**
 * The machines of the header up, the closed strand on all four, every machine bound under the
 * party's founding key, and a write by A4 on A2 — so a cut after this is a teardown and a write
 * after this is a repeat of one that already worked.
 */
async function bringUpPartyOnStrand(topology: Topology): Promise<PartyOnStrand> {
	const owner = topology.machine('a', 0).node;
	const strandId = `strand-client-survives-rotation-${Date.now()}`;
	const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '1.0.0');

	// ── A1 founds the closed strand; A2 and A3 attach from the published row ──
	const founded = await owner.foundStrand({ strandId, type: 'c', memberPrivateKey: await generateStrandMemberKey(), sAppConfig: sApp });
	const a1 = strandMachine('A1', owner, founded.instance);
	const oldMemberKey = strandMemberKeyPair(await awaitPartyKey(owner, strandId, 'A1')).publicKeyB64;

	const a2Node = topology.machine('a', 1).node;
	const a3Machine = topology.machine('a', 2);
	const a2 = strandMachine('A2', a2Node, await attachFromPartyRow(a2Node, strandId, 'A2', sApp));
	const a3 = strandMachine('A3', a3Machine.node, await attachFromPartyRow(a3Machine.node, strandId, 'A3', sApp));
	await meshStrandNodes([a1, a2, a3]);

	// ── A4 attaches last, so a serving machine is reachable for the schema catalog it writes ──
	// Its strand node exists while the database phase is still deferred, which is what lets the
	// dials below happen before the wait rather than after a retry period.
	const a4Node = topology.machine('a', 3).node;
	const a4Instance = await a4Node.addStrand({ strandRow: await awaitStrandRow(a4Node, strandId, 'A4'), sAppConfig: sApp, awaitFirstSync: false });
	if (!a4Instance.libp2pNode) {
		throw new Error(`A4: the client launch came up '${a4Instance.status}' with no strand node, so it can reach no serving machine`);
	}
	for (const server of [a1, a2]) {
		await connectStrandNodes(a4Instance.libp2pNode, 'A4', server.libp2p, server.label, STRAND_MESH_TIMEOUT_MS);
	}
	await waitUntil(() => a4Instance.database !== undefined, {
		...STRAND_GATE, description: 'A4\'s client launch publishes its database, which it writes the schema catalog through a serving machine to build',
	});
	const a4 = strandMachine('A4', a4Node, a4Instance);
	await awaitPartyKey(a4Node, strandId, 'A4');

	const party: PartyOnStrand = { owner, a1, a2, a3, a4, strandId, oldMemberKey, a3MachineId: a3Machine.peerId };

	// ── Every machine stated its peer id and was bound under the founding key ──
	await expectStrandPeerRoles(party);
	await awaitBindingsVisible([a1, a2], [a1, a2, a3, a4].map((machine) => binding(oldMemberKey, machine)));

	// ── And the client already writes through the serving machines ──
	await insertWithRetry(a4, 'before-removal', 'written by the client', REMAINING_COHORT_WRITE_BUDGET_MS);
	await awaitRowVisible(a2, 'before-removal', 'written by the client');
	for (const server of [a1, a2]) {
		expectConnected(server, a4, 'the client dialed both serving machines at bring-up, so a lost connection below is a teardown');
		expectConnected(server, a3, 'the mesh was wired at bring-up, so the cut below is a teardown');
	}

	return party;
}

describe('A client of a closed strand survives its party replacing the key', () => {
	it('is bound under the new key by the removal itself, and keeps writing through the serving machines', async () => {
		const topology = await bootTopology({
			tag: 'client-survives-rotation',
			parties: [{
				name: 'a',
				machines: [
					{ ...MACHINE, nodeClass: 'server' }, // A1, the owner
					{ ...MACHINE, nodeClass: 'server' }, // A2, online throughout
					{ ...MACHINE, nodeClass: 'server' }, // A3, the machine removed
					{ ...MACHINE, nodeClass: 'device', roles: { strandCohortMember: false } }, // A4, the client
				],
			}],
		});
		try {
			const party = await bringUpPartyOnStrand(topology);
			const { owner, a1, a2, a3, a4, strandId, oldMemberKey, a3MachineId } = party;

			// ── 2. The removal replaces the key here and now: A2 is online, so nothing is deferred ──
			const removal = await owner.removeMachine(a3MachineId);
			expect(removal).toMatchObject({ removedPeer: true, strands: [{ strandId, outcome: 'rotated' }] });
			const a1Control = owner.getControlDatabase()!;
			expect(await a1Control.queryPendingStrandPartyKey(strandId)).toBeNull();
			const newPartyKey = (await a1Control.queryStrandPartyKey(strandId))!;
			const newMemberKey = strandMemberKeyPair(newPartyKey).publicKeyB64;
			expect(newMemberKey).not.toBe(oldMemberKey);

			// ── 3. The client is bound under the new key, and switches to it ──
			await expectRowsOnNewKey(party, newMemberKey);
			await waitUntil(async () => (await memberPeerBindings(a2.db)).includes(binding(newMemberKey, a4)), {
				...STRAND_GATE, description: 'A2, which enforces the gate the client would be refused by, reads the client\'s binding under the new key',
			});
			await awaitSwapOn(a4.node, strandId, newMemberKey, 'A4 reads the swap A1 made');
			await waitUntil(() => runningPartyKey(a4.node, strandId) === newPartyKey && membershipLoopDone(a4.node, strandId), {
				...STRAND_GATE, description: 'A4 runs under the new key, its rebuilt membership loop done',
			});

			// ── 4. The old key has left, and the client is still served and still writing ──
			await awaitCut(a1, a3, 'A1 wrote the old key\'s departure');
			await awaitCut(a2, a3, 'the old key\'s departure replicated to A2');
			expectServedByAny(a4, [a1, a2], 'the client\'s binding under the new key keeps it off the deny list');

			// The client's own gate, driven rather than waited for. A client stores none of the
			// membership rows, so no change wakes its revoked-peer gate and it reaches a removal made
			// elsewhere only on that gate's backstop — five minutes, which is longer than this run
			// (docs/cadre/node.md → "A node that holds no strand blocks"). Until the gate refreshes,
			// A4 keeps A3 connected and in every block's cohort, which is what makes its own writes in
			// that window slow (docs/strands/writes.md → "Limits and accepted tradeoffs"). Driving the
			// refresh brings the backstop forward; A4's refusal of A3 is not a claim made here.
			await a4.node.refreshRevocationEnforcement(strandId);
			await awaitCut(a4, a3, 'the client\'s own gate was refreshed');
			// The cut does not take A3 out of A4's cohort — Optimystic keeps a peer it has seen serve —
			// so the write below still commits by downsizing the cluster to the machines that answer,
			// which is why it is retried. The line says which shape this run had.
			const cohortBeforeWrite = await readCohort(a4.libp2p, 'A4');
			console.log(`[client-survives-rotation] A4 writes against a cohort of ${cohortBeforeWrite.length}, the removed machine ${cohortBeforeWrite.includes(a3.peerId) ? 'still among' : 'no longer among'} them`);
			await insertWithRetry(a4, 'after-removal', 'written by the client after the replacement', REMAINING_COHORT_WRITE_BUDGET_MS);
			await awaitRowVisible(a2, 'after-removal', 'written by the client after the replacement');

			// ── 5. A3 is cut, in both directions of evidence ──
			await expectNeverConverges(a3, 'after-removal', 'written by the client after the replacement', NO_CONVERGENCE_BUDGET_MS);
			expect(await dataValue(a2.db, 'after-removal'), 'A2 still reads what the cut machine never did, so a stalled strand cannot pass the claim above').toBe('written by the client after the replacement');
		} finally {
			await topology.stop();
		}
	}, TEST_TIMEOUT_MS);
});
