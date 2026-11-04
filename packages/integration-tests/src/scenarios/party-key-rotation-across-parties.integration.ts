/**
 * Removing a machine from a cadre cuts it off a strand its party does NOT manage
 * (`docs/architecture.md` → "Removing a machine"; `docs/strands.md` → "The host's re-invitation
 * seats the new key"), proved on a real network and on rows production wrote: the test calls no
 * membership writer.
 *
 * `machine-removal-rotates-party-key` proves the replacement in a strand the party founded, where
 * the party's key holds a manager seat and seats its successor itself. Here the strand is party
 * B's: party A joined it through formation, holds no manager seat there, and cannot seat its new
 * key. The removal reports `needs-another-party` and leaves the strand's rows untouched; B's owner
 * then publishes an ordinary fresh invitation, A's owner redeems it, and A's membership reconciler
 * redeems it under the pending key rather than the current one. The replacement driver finishes
 * from that seat (the remaining machines bound under the new key, the old key's self-signed leave,
 * the control swap), and the removed machine, bound under the old key alone, is denied by B and
 * by its former siblings from the rows alone.
 *
 * Machines:
 * - **B1**, party B's owner: founds the cadre and the closed strand, the strand's only manager,
 *   and publishes both invitations.
 * - **A1**, party A's owner: joins B's strand through the real formation handshake, removes A3,
 *   and redeems B's second invitation.
 * - **A2**, an always-on member of A (`startPinningMember` + `admitMember`, no owner key) that
 *   runs the strand as a storage replica, launched by its watcher from the party-wide
 *   `JoinedStrand` row A1's connected owner reconcile pass publishes. Nothing is called on it
 *   after bring-up.
 * - **A3**, a second member of A with the app, attached from the same `JoinedStrand` row read on
 *   it. The machine removed.
 *
 * Reads: the handles, the strand reads and the cut claims are the harness's `strand-machine.ts`.
 * A replica runs without the app, so A2's convergence on a row is physical: it holds every block
 * B1 holds. Every cut happens on the production revocation schedule, as the rows reach each
 * machine; the membership reconciler and the control cohort reconcile run on short intervals
 * through the harness, since their production defaults would put a pass outside the gates.
 *
 * One case. The offline-sibling path of the control swap is proved by the sibling scenario and
 * does not depend on who admits the key.
 *
 * Wall clock on loopback: the two runs behind this file took 47 s and 44 s of test time, 60 s each of file wall clock.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { generateStrandMemberKey, strandMemberKeyPair } from '@serfab/cadre-core';
import type { CadreNode, CadreNodeEvents } from '@serfab/cadre-core';
import {
	admitMember,
	awaitBlockCoverage,
	awaitCut,
	awaitJoinedStrandRow,
	awaitPartyKey,
	awaitReplica,
	awaitRowVisible,
	awaitSwapOn,
	binding,
	bootTopology,
	captureRawStorage,
	consumedInvites,
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
	publishBoundInvitation,
	REMAINING_COHORT_WRITE_BUDGET_MS,
	runningPartyKey,
	startPinningMember,
	STRAND_GATE,
	strandMachine,
	waitUntil,
	type InviteMember,
	type PinningMemberOptions,
	type StrandMachine,
	type Topology,
} from '../harness/index.js';

/** The one-table key/value sApp the sibling removal scenarios use. No RBAC: what is under test is whether a write reaches a machine, not who may author it. */
const SIMPLE_SCHEMA = `
table Data (
    Key text primary key,
    Val text
);
`;

/** sApp id on both formation invitations; only its identity matters. */
const SAPP_ID = 'sapp-party-key-rotation-across-parties';

/** The membership reconciler's cadence: keeps its ladder (invite row, redemption, binding) inside {@link STRAND_GATE} rather than the 30 s default. */
const RECONCILE_POLL_MS = 2_000;
/** The control cohort's reconcile backstop: on A1 the pass that publishes the `JoinedStrand` row, which A2 and A3 launch from. */
const CONTROL_RECONCILE_MS = 2_000;
/** A2's strand watcher backstop: how soon it launches its replica from a `JoinedStrand` row it holds. */
const STRAND_WATCH_MS = 1_000;
/** Sized by `harness/topology.ts`'s rule of thumb for 8 libp2p nodes plus two formations, the gates and three negative budgets; measured at 44 to 47 s of test time. */
const TEST_TIMEOUT_MS = 600_000;

/** The harness's knobs for every machine's closed-strand loops. */
const MEMBERSHIP_LOOP = { pollIntervalMs: RECONCILE_POLL_MS } as const;

/** Party A's three machines and party B's one, all serving B's closed strand on rows production wrote. */
interface JoinedStrand {
	b1: StrandMachine;
	a1: StrandMachine;
	a2: StrandMachine;
	a3: StrandMachine;
	strandId: string;
	/** Party A's key K as the formation seated it, public half. */
	oldMemberKey: string;
	/** Party B's key, the strand's only manager, public half. */
	bMemberKey: string;
	/** A3's control peer id: what `removeMachine` is given. */
	a3MachineId: string;
	a2Blocks: StrandBlocks;
	b1Blocks: StrandBlocks;
}

/** What the coverage gates compare: one machine's raw blocks for the strand. */
type StrandBlocks = ReturnType<ReturnType<typeof captureRawStorage>['forStrand']>;

// Module-level so `afterEach` stops whatever a failed bring-up had started.
let topology: Topology | undefined;
const startedMembers: CadreNode[] = [];

async function startMember(partyId: string, ownerKey: string, options: PinningMemberOptions): Promise<InviteMember> {
	const member = await startPinningMember(partyId, ownerKey, options);
	startedMembers.push(member.node);
	return member;
}

/** The machines of the file header up, A joined to B's strand, production having written every binding, and a B1 write on every machine, so a cut after this is a teardown. */
async function bringUpJoinedStrand(): Promise<JoinedStrand> {
	const a2Capture = captureRawStorage();
	const b1Capture = captureRawStorage();
	topology = await bootTopology({
		tag: 'party-key-rotation-across-parties',
		parties: [
			{ name: 'a', machines: [{ membershipReconciliation: MEMBERSHIP_LOOP, reconcileMs: CONTROL_RECONCILE_MS }] },
			{ name: 'b', machines: [{ membershipReconciliation: MEMBERSHIP_LOOP, storageProvider: b1Capture.provider }] },
		],
	});
	const a1Node = topology.machine('a').node;
	const b1Node = topology.machine('b').node;
	const partyA = topology.parties.get('a')!;

	// ── Party A's members, each admitted the owner-online way ───────────────
	const a2Member = await startMember(partyA.partyId, partyA.ownerPublicKey, {
		hostUnclaimedStrands: true, strandWatchMs: STRAND_WATCH_MS, storageProvider: a2Capture.provider,
		reconcileMs: CONTROL_RECONCILE_MS, membershipReconciliation: MEMBERSHIP_LOOP,
	});
	await admitMember(a1Node, a2Member, STRAND_GATE.timeoutMs);
	const a3Member = await startMember(partyA.partyId, partyA.ownerPublicKey, { reconcileMs: CONTROL_RECONCILE_MS, membershipReconciliation: MEMBERSHIP_LOOP });
	await admitMember(a1Node, a3Member, STRAND_GATE.timeoutMs);

	// ── B1 founds the closed strand; A1 joins it over the real handshake ────
	const strandId = `strand-party-key-rotation-across-parties-${Date.now()}`;
	const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '1.0.0');
	const founded = await b1Node.foundStrand({ strandId, type: 'c', memberPrivateKey: await generateStrandMemberKey(), sAppConfig: sApp });
	const b1 = strandMachine('B1', b1Node, founded.instance);
	const bMemberKey = strandMemberKeyPair(await awaitPartyKey(b1Node, strandId, 'B1')).publicKeyB64;

	const form = await a1Node.formStrand(await publishBoundInvitation(b1Node, strandId, SAPP_ID), {
		partyId: a1Node.peerId!.toString(), purpose: 'party key rotation across parties',
	});
	expect(form.strandId).toBe(strandId);
	expect(form.membershipInvite).toBeDefined();
	const a1 = strandMachine('A1', a1Node, await a1Node.addStrand({
		strandRow: { Id: strandId, MemberPrivateKey: form.memberPrivateKey!, Type: 'c', FounderOwnerKey: null, FounderPeerId: null },
		sAppConfig: sApp,
	}));
	const oldMemberKey = strandMemberKeyPair(await awaitPartyKey(a1Node, strandId, 'A1')).publicKeyB64;
	expect(oldMemberKey).not.toBe(bMemberKey);

	// ── A2 hosts the party-wide join unasked; A3 attaches the app from the same row ──
	const a2 = await awaitReplica(a2Member.node, strandId, 'A2');
	await awaitPartyKey(a2.node, strandId, 'A2');
	await awaitPartyKey(a3Member.node, strandId, 'A3');
	const a3 = strandMachine('A3', a3Member.node, await a3Member.node.addStrand({ strandRow: await awaitJoinedStrandRow(a3Member.node, strandId, 'A3'), sAppConfig: sApp }));
	await meshStrandNodes([b1, a1, a2, a3]);

	// ── Production wrote every binding ──────────────────────────────────────
	// A2's and A3's rows on A1 are what A1's driver binds the remaining machines from.
	const a1Control = a1Node.getControlDatabase()!;
	const statedPeers = [a1.peerId, a2.peerId, a3.peerId];
	await waitUntil(async () => {
		const rows = await a1Control.queryStrandPeers(strandId);
		return statedPeers.every((peerId) => rows.some((row) => row.strandPeerId === peerId));
	}, { ...STRAND_GATE, description: 'A1 holds a StrandPeer row for each of party A\'s machines' });
	const aBindings = [a1, a2, a3].map((machine) => binding(oldMemberKey, machine));
	await waitUntil(async () => {
		const bindings = await memberPeerBindings(b1.db);
		return (await memberKeys(b1.db)).includes(oldMemberKey) && aBindings.every((row) => bindings.includes(row)) && bindings.includes(binding(bMemberKey, b1));
	}, { ...STRAND_GATE, description: 'B1 reads party A\'s seat, a binding under A\'s key for each of its machines, and its own binding' });
	expect(await managerKeys(b1.db), 'B holds the only manager seat; A\'s key is a plain member').toEqual([bMemberKey]);
	await waitUntil(() => a1Node.getPendingMembershipInvite(strandId) === undefined, { ...STRAND_GATE, description: 'A1 settled the formation\'s invitation' });

	const a2Blocks = a2Capture.forStrand(strandId);
	const b1Blocks = b1Capture.forStrand(strandId);
	await insertWithRetry(b1, 'before-removal', 'everyone can read this', REMAINING_COHORT_WRITE_BUDGET_MS);
	await awaitRowVisible(a1, 'before-removal', 'everyone can read this');
	await awaitRowVisible(a3, 'before-removal', 'everyone can read this');
	await awaitBlockCoverage(b1Blocks, a2Blocks, { timeoutMs: STRAND_GATE.timeoutMs, description: 'A2 holds every block B1 holds, before the removal' });
	for (const [from, to] of [[a1, a3], [a2, a3], [b1, a3], [a3, a1], [a3, b1]] as const) {
		expectConnected(from, to, 'the mesh was wired at bring-up, so the cut below is a teardown');
	}

	return { b1, a1, a2, a3, strandId, oldMemberKey, bMemberKey, a3MachineId: a3Member.peerId, a2Blocks, b1Blocks };
}

describe('A removed machine is cut from a strand its party does not manage', () => {
	afterEach(async () => {
		await Promise.allSettled(startedMembers.splice(0).map((node) => node.stop()));
		await topology?.stop();
		topology = undefined;
	});

	it('is denied by the host and by its former sibling once the host re-invites the party', async () => {
		const { b1, a1, a2, a3, strandId, oldMemberKey, bMemberKey, a3MachineId, a2Blocks, b1Blocks } = await bringUpJoinedStrand();
		const a1Control = a1.node.getControlDatabase()!;
		// Subscribed before the removal: each report fires once per pending stamp and is not replayed.
		const blocked: CadreNodeEvents['strand:party-key-rotation-blocked'][] = [];
		const rotated: string[] = [];
		a1.node.on('strand:party-key-rotation-blocked', (report) => { blocked.push(report); });
		a1.node.on('strand:party-key-rotated', ({ strandId: id }) => { rotated.push(id); });

		// ── Step 1: the removal stops at the seat A cannot write ────────────────
		expect((await a1.node.planMachineRemoval(a3MachineId)).strands).toEqual([{ strandId, rotation: 'another-party' }]);
		const removal = await a1.node.removeMachine(a3MachineId);
		expect(removal).toMatchObject({ removedPeer: true, strands: [{ strandId, outcome: 'needs-another-party' }] });
		expect(blocked).toEqual([{ strandId, reason: 'needs-another-party' }]);
		// `removeMachine` drives inside the call, so the listing is read after it, never concurrently.
		const pending = await a1.node.listPendingPartyKeyRotations();
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({ strandId, superseded: [], waitingOn: 'another-party' });
		const newMemberKey = pending[0]!.publicKey;
		expect(newMemberKey).not.toBe(oldMemberKey);
		expect(newMemberKey).toBe((await a1Control.queryPendingStrandPartyKey(strandId))!.publicKey);
		// The strand's rows are untouched: A's current key is still its member and nothing was seated.
		expect(new Set(await memberKeys(b1.db))).toEqual(new Set([oldMemberKey, bMemberKey]));
		expect(await managerKeys(b1.db)).toEqual([bMemberKey]);
		expect(await memberPeerBindings(b1.db)).not.toContain(binding(newMemberKey, a1));
		// A3 is still served, so the cut below is the invitation's doing, not the removal's.
		await insertWithRetry(b1, 'after-removal', 'written while A3 is still a member', REMAINING_COHORT_WRITE_BUDGET_MS);
		await awaitRowVisible(a3, 'after-removal', 'written while A3 is still a member');
		await awaitRowVisible(a1, 'after-removal', 'written while A3 is still a member');
		expectConnected(b1, a3, 'the removal changed nothing on the strand');
		expectConnected(a2, a3, 'the removal changed nothing on the strand');

		// ── Step 2: the host's fresh invitation seats the pending key ───────────
		const second = await a1.node.formStrand(await publishBoundInvitation(b1.node, strandId, SAPP_ID), {
			partyId: a1.node.peerId!.toString(), purpose: 'the host re-invites the party after a machine removal',
		});
		expect(second.strandId).toBe(strandId);
		expect(second.membershipInvite).toBeDefined();
		// Gated on the outcome, not on the first pass: the host's `Invite` row may reach A1 after the formation returns.
		await waitUntil(() => rotated.includes(strandId), { ...STRAND_GATE, description: 'A1 reports the party key rotated (strand:party-key-rotated)' });
		await awaitSwapOn(a1.node, strandId, newMemberKey, 'A1\'s control record names the key it listed, with no pending row left');
		const newPartyKey = (await a1Control.queryStrandPartyKey(strandId))!;
		expect(await a1.node.listPendingPartyKeyRotations()).toEqual([]);
		expect(rotated).toEqual([strandId]);
		expect(blocked, 'the blocked report is once per pending key').toHaveLength(1);
		await waitUntil(async () => {
			const keys = await memberKeys(b1.db);
			return keys.includes(newMemberKey) && !keys.includes(oldMemberKey);
		}, { ...STRAND_GATE, description: 'B1 reads the replacement of party A\'s key' });
		expect(await managerKeys(b1.db), 'the host keeps the only manager seat').toEqual([bMemberKey]);
		expect(await consumedInvites(b1.db), 'the second invitation was spent against the new key').toContain(`${second.membershipInvite!.inviteKey}|${newMemberKey}`);
		const bindingsOnB1 = await memberPeerBindings(b1.db);
		expect(bindingsOnB1).toEqual(expect.arrayContaining([binding(newMemberKey, a1), binding(newMemberKey, a2), binding(oldMemberKey, a3)]));
		expect(bindingsOnB1).not.toContain(binding(newMemberKey, a3));
		await waitUntil(() => a1.node.getPendingMembershipInvite(strandId) === undefined, { ...STRAND_GATE, description: 'A1 settled the second invitation' });

		// ── Step 3: the cut, from the rows alone ────────────────────────────────
		await awaitCut(a1, a3, 'A1 wrote the old key\'s departure');
		await awaitCut(b1, a3, 'the old key\'s departure replicated to B1');
		await awaitCut(a2, a3, 'the old key\'s departure replicated to A2');
		await insertWithRetry(b1, 'after-rotation', 'written by the host party', REMAINING_COHORT_WRITE_BUDGET_MS);
		await awaitRowVisible(a1, 'after-rotation', 'written by the host party');
		await awaitBlockCoverage(b1Blocks, a2Blocks, { timeoutMs: STRAND_GATE.timeoutMs, description: 'A2 holds B1\'s post-rotation write' });
		expect(await dataValue(b1.db, 'after-rotation')).toBe('written by the host party');
		await expectNeverConverges(a3, 'after-rotation', 'written by the host party', NO_CONVERGENCE_BUDGET_MS);
		// Failing outright and committing only locally are both the cut; the log says which this run was.
		let pushError: unknown;
		await a3.db.exec('insert into App.Data (Key, Val) values (?, ?)', ['pushed-by-removed', 'from the removed machine']).catch((error: unknown) => { pushError = error; });
		console.log(`[rotation-across-parties] the removed machine's write ${pushError === undefined ? 'committed locally' : `failed: ${String(pushError)}`}`);
		await Promise.all([
			expectNeverConverges(b1, 'pushed-by-removed', 'from the removed machine', NO_CONVERGENCE_BUDGET_MS),
			expectNeverConverges(a1, 'pushed-by-removed', 'from the removed machine', NO_CONVERGENCE_BUDGET_MS),
		]);

		// ── Step 4: A2 followed the control record with nothing asked of it ─────
		await awaitSwapOn(a2.node, strandId, newMemberKey, 'A2 reads the swap A1 made');
		await waitUntil(async () => runningPartyKey(a2.node, strandId) === newPartyKey && membershipLoopDone(a2.node, strandId) && (await memberPeerBindings(a2.db)).includes(binding(newMemberKey, a2)), {
			...STRAND_GATE, description: 'A2 runs under the new key, its rebuilt membership loop done with its binding',
		});
		expect(a2.node.getStrand(strandId)?.libp2pNode, 'a re-key in place keeps the running strand node').toBe(a2.libp2p);
		// The old key is gone and only a manager could clear the orphan, so it stays: the record the deny gate works from.
		expect(await memberPeerBindings(a2.db)).toContain(binding(oldMemberKey, a3));
		expectConnected(a1, a2, 'A2\'s binding under the new key keeps it served');
		expectConnected(b1, a2, 'A2\'s binding under the new key keeps it served');
		await waitUntil(() => membershipLoopDone(a1.node, strandId), { ...STRAND_GATE, description: 'A1\'s rebuilt membership loop is done' });
	}, TEST_TIMEOUT_MS);
});
