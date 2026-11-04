/**
 * Removing a machine from a cadre cuts it off a strand the cadre shares with another party
 * (`docs/architecture.md` → "Removing a machine"), proved on a real network and on rows
 * production wrote: the test calls no membership writer.
 *
 * Machines:
 * - **A1**, party A's owner: founds the cadre and the closed strand, and removes A3.
 * - **A2**, an always-on member (`startPinningMember` + `admitMember`, no owner key) that runs the
 *   strand as a storage replica. One case keeps it online through the removal. The other stops it
 *   first and restarts it on the same identity, port and raw store; starting it is the only call
 *   that case makes on it afterwards.
 * - **A3**, a second member, with the app. The machine removed.
 * - **B**, party B's one machine, in the strand through the real formation handshake.
 *
 * Reads:
 * - A replica runs without the app, so A2 has no `App.Data` to read. Its convergence on a row is
 *   physical: it holds every block B holds, and the same-store restart keeps that meaningful.
 *   Membership rows are readable there, because every strand carries the `Strand` schema.
 * - The machine handles, the strand reads and the cut claims are the harness's
 *   `strand-machine.ts`, which says why every strand read scans and filters in JavaScript.
 * - A cut is asserted in both directions of evidence: the connection that existed before is gone
 *   after, and the cut machine then fails to converge on a row whose paired positive read on a
 *   remaining machine succeeds. Without that read a stalled strand would look like a cut.
 *
 * Timing: revocation enforcement runs the production schedule on every machine, so each cut below
 * is the rows arriving, which is what an app gets. The membership reconciler and the control
 * cohort reconcile run on short intervals through the harness, since their production defaults
 * would put a pass outside the gates.
 *
 * The swap of the control row has two paths, one per case. With A2 online `removeMachine` reports
 * the strand `rotated`, and A2 re-keys its running strand from the replicated row. With A2 offline
 * and A3 gone, A1 can reach no sibling while the party still has a member, so the swap would fork
 * the party's control history if A2 wrote meanwhile. `removeMachine` then reports the strand
 * `pending` with the strand's own rows already on the new key, and A1's growth drain finishes the
 * swap when A2 returns.
 *
 * The removed machine receives the pending row over the control network before it is cut off, so
 * the new key rides in it sealed to A1 and A2 (`sealed-party-key.ts`). The offline case reads A3's
 * own copy of the row: A3 is not among its recipients, A3's identity key does not open it, and no
 * column carries the key in the clear. Both cases assert, after the cut, that A3's `StrandPartyKey`
 * row still names the old key: the swapped row is in the clear, and A3 could receive it only from
 * a sibling holding the swap but not yet the tombstone (the `NOTE:` at
 * `ControlDatabase.swapStrandPartyKeys`).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ed25519KeyPairFromLibp2p, generateStrandMemberKey, openPartyKey, partyKeyRecipients, strandMemberKeyPair } from '@serfab/cadre-core';
import type { CadreNode, PartyKeyOpener } from '@serfab/cadre-core';
import {
	admitMember,
	awaitBlockCoverage,
	awaitCut,
	awaitPartyKey,
	awaitReplica,
	awaitRowVisible,
	awaitStrandRow,
	awaitSwapOn,
	binding,
	bootTopology,
	blockCoverageIsComplete,
	captureRawStorage,
	compareBlockCoverage,
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
	readCohort,
	REMAINING_COHORT_WRITE_BUDGET_MS,
	runningPartyKey,
	sameListenAddr,
	startPinningMember,
	STRAND_GATE,
	strandConnectionsTo,
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

/** sApp id on the formation invitation; only its identity matters. */
const SAPP_ID = 'sapp-machine-removal-rotation';

/** The membership reconciler's cadence: keeps its ladder (invite row, redemption, binding) inside {@link STRAND_GATE} rather than the 30 s default. */
const RECONCILE_POLL_MS = 2_000;
/** The control cohort's reconcile backstop, which caps the redial that brings A1 and the restarted A2 back together. */
const CONTROL_RECONCILE_MS = 2_000;
/** A2's strand watcher backstop: how soon it launches its replica from a `Strand` row it holds. */
const STRAND_WATCH_MS = 1_000;

/** Sized by `harness/topology.ts`'s rule of thumb for 10 libp2p nodes, A2's restart included, plus the gates; measured at 42 to 67 s per case. */
const TEST_TIMEOUT_MS = 600_000;

/** The harness's knobs for every machine's closed-strand loops. */
const MEMBERSHIP_LOOP = { pollIntervalMs: RECONCILE_POLL_MS } as const;

/** Party A's three machines and party B's one, all serving the closed strand on rows production wrote. */
interface SharedStrand {
	owner: CadreNode;
	a1: StrandMachine;
	a2: StrandMachine;
	a3: StrandMachine;
	b: StrandMachine;
	strandId: string;
	oldMemberKey: string;
	bMemberKey: string;
	a2MachineId: string;
	a3MachineId: string;
	/** A3's control peer id and identity seed: what would open a pending key sealed to it. */
	a3Opener: PartyKeyOpener;
	a2Blocks: StrandBlocks;
	bBlocks: StrandBlocks;
	/** Start A2 again on its identity and store, at `listenAddr` (read while it was up), with no owner signer. */
	restartA2(listenAddr: string): Promise<InviteMember>;
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

/** The machines of the file header up, the strand formed across both parties, and a write by B on every machine, so a cut after this is a teardown. */
async function bringUpSharedStrand(): Promise<SharedStrand> {
	const a2Capture = captureRawStorage();
	const bCapture = captureRawStorage();
	topology = await bootTopology({
		tag: 'machine-removal-rotation',
		parties: [
			{ name: 'a', machines: [{ membershipReconciliation: MEMBERSHIP_LOOP, reconcileMs: CONTROL_RECONCILE_MS }] },
			{ name: 'b', machines: [{ membershipReconciliation: MEMBERSHIP_LOOP, storageProvider: bCapture.provider }] },
		],
	});
	const owner = topology.machine('a').node;
	const bNode = topology.machine('b').node;
	const party = topology.parties.get('a')!;

	// ── Party A's members, each admitted the owner-online way ───────────────
	const a2Options = {
		hostUnclaimedStrands: true, strandWatchMs: STRAND_WATCH_MS, storageProvider: a2Capture.provider,
		reconcileMs: CONTROL_RECONCILE_MS, membershipReconciliation: MEMBERSHIP_LOOP,
	};
	const a2Member = await startMember(party.partyId, party.ownerPublicKey, a2Options);
	await admitMember(owner, a2Member, STRAND_GATE.timeoutMs);
	const a3Member = await startMember(party.partyId, party.ownerPublicKey, { reconcileMs: CONTROL_RECONCILE_MS, membershipReconciliation: MEMBERSHIP_LOOP });
	await admitMember(owner, a3Member, STRAND_GATE.timeoutMs);

	// ── A1 founds the closed strand; A2 hosts it unasked; A3 attaches the app ──
	const strandId = `strand-machine-removal-rotation-${Date.now()}`;
	const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '1.0.0');
	const founded = await owner.foundStrand({ strandId, type: 'c', memberPrivateKey: await generateStrandMemberKey(), sAppConfig: sApp });
	const a1 = strandMachine('A1', owner, founded.instance);
	const oldMemberKey = strandMemberKeyPair(await awaitPartyKey(owner, strandId, 'A1')).publicKeyB64;

	const a2 = await awaitReplica(a2Member.node, strandId, 'A2');
	await awaitPartyKey(a2.node, strandId, 'A2');
	await awaitPartyKey(a3Member.node, strandId, 'A3');
	const a3 = strandMachine('A3', a3Member.node, await a3Member.node.addStrand({ strandRow: await awaitStrandRow(a3Member.node, strandId, 'A3'), sAppConfig: sApp }));

	// ── B joins over the real handshake ─────────────────────────────────────
	const form = await bNode.formStrand(await publishBoundInvitation(owner, strandId, SAPP_ID), {
		partyId: bNode.peerId!.toString(), purpose: 'machine removal rotates the party key',
	});
	expect(form.strandId).toBe(strandId);
	const b = strandMachine('B', bNode, await bNode.addStrand({
		strandRow: { Id: strandId, MemberPrivateKey: form.memberPrivateKey!, Type: 'c', FounderOwnerKey: null, FounderPeerId: null },
		sAppConfig: sApp,
	}));
	const bMemberKey = strandMemberKeyPair(await awaitPartyKey(bNode, strandId, 'B')).publicKeyB64;
	await meshStrandNodes([a1, a2, a3, b]);

	// ── All four serve the strand, and production wrote every binding ───────
	// A2's row on A1 is what A1's driver binds A2 from, so it must be here before a removal.
	const a1Control = owner.getControlDatabase()!;
	const statedPeers = [a1.peerId, a2.peerId, a3.peerId];
	await waitUntil(async () => {
		const rows = await a1Control.queryStrandPeers(strandId);
		return statedPeers.every((peerId) => rows.some((row) => row.strandPeerId === peerId));
	}, { ...STRAND_GATE, description: 'A1 holds a StrandPeer row for each of party A\'s machines' });
	const aBindings = [a1, a2, a3].map((machine) => binding(oldMemberKey, machine));
	await waitUntil(async () => {
		const bindings = await memberPeerBindings(a1.db);
		return aBindings.every((row) => bindings.includes(row)) && bindings.includes(binding(bMemberKey, b));
	}, { ...STRAND_GATE, description: 'A1 reads a binding under party A\'s key for each of its machines, and B\'s' });
	await waitUntil(async () => (await memberKeys(b.db)).includes(bMemberKey) && (await memberPeerBindings(b.db)).includes(binding(oldMemberKey, a3)), {
		...STRAND_GATE, description: 'B reads its own member row and A3\'s binding',
	});

	const a2Blocks = a2Capture.forStrand(strandId);
	const bBlocks = bCapture.forStrand(strandId);
	await insertWithRetry(b, 'before-removal', 'everyone can read this', REMAINING_COHORT_WRITE_BUDGET_MS);
	await awaitRowVisible(a1, 'before-removal', 'everyone can read this');
	await awaitRowVisible(a3, 'before-removal', 'everyone can read this');
	await awaitBlockCoverage(bBlocks, a2Blocks, { timeoutMs: STRAND_GATE.timeoutMs, description: 'A2 holds every block B holds, before the removal' });
	for (const [from, to] of [[a1, a3], [b, a3], [a3, a1], [a3, b]] as const) {
		expectConnected(from, to, 'the mesh was wired at bring-up, so the cut below is a teardown');
	}

	return {
		owner, a1, a2, a3, b, strandId, oldMemberKey, bMemberKey, a2Blocks, bBlocks,
		a2MachineId: a2Member.peerId,
		a3MachineId: a3Member.peerId,
		a3Opener: { peerId: a3Member.peerId, privateKeyB64: ed25519KeyPairFromLibp2p(a3Member.key).privateKeyB64 },
		restartA2: (listenAddr) => startMember(party.partyId, party.ownerPublicKey, { ...a2Options, key: a2Member.key, listenAddrs: [listenAddr] }),
	};
}

/** The strand's rows just after the driver ran on A1: the new key is the party's seat and is bound to A1 and A2, not A3. */
async function expectRowsOnNewKey({ a1, a2, a3, bMemberKey, oldMemberKey }: SharedStrand, newMemberKey: string): Promise<void> {
	expect(new Set(await memberKeys(a1.db))).toEqual(new Set([newMemberKey, bMemberKey]));
	expect(await managerKeys(a1.db)).toEqual([newMemberKey]);
	const bindings = await memberPeerBindings(a1.db);
	expect(bindings).toEqual(expect.arrayContaining([binding(newMemberKey, a1), binding(newMemberKey, a2), binding(oldMemberKey, a3)]));
	expect(bindings).not.toContain(binding(newMemberKey, a3));
}

/** A1 and B cut A3 from the rows alone, B's write reaches A1 and not A3, and A3's write reaches neither. */
async function expectCutFromRows({ a1, a3, b, oldMemberKey }: SharedStrand, newMemberKey: string): Promise<void> {
	await awaitCut(a1, a3, 'A1 wrote the old key\'s departure');
	await waitUntil(async () => {
		const keys = await memberKeys(b.db);
		return keys.includes(newMemberKey) && !keys.includes(oldMemberKey);
	}, { ...STRAND_GATE, description: 'B reads the replacement of party A\'s key' });
	await awaitCut(b, a3, 'the old key\'s departure replicated to B');

	await insertWithRetry(b, 'after-removal', 'written by the other party', REMAINING_COHORT_WRITE_BUDGET_MS);
	await awaitRowVisible(a1, 'after-removal', 'written by the other party');
	expect(await dataValue(b.db, 'after-removal')).toBe('written by the other party');
	await expectNeverConverges(a3, 'after-removal', 'written by the other party', NO_CONVERGENCE_BUDGET_MS);

	// Failing outright and committing only locally are both the cut; the read-back on A3 says which this run was.
	let pushError: unknown;
	await a3.db.exec('insert into App.Data (Key, Val) values (?, ?)', ['pushed-by-removed', 'from the removed machine']).catch((error: unknown) => { pushError = error; });
	console.log(`[machine-removal-rotation] the removed machine's write ${pushError === undefined ? 'committed locally' : `failed: ${String(pushError)}`}`);
	await Promise.all([
		expectNeverConverges(b, 'pushed-by-removed', 'from the removed machine', NO_CONVERGENCE_BUDGET_MS),
		expectNeverConverges(a1, 'pushed-by-removed', 'from the removed machine', NO_CONVERGENCE_BUDGET_MS),
	]);
}

/**
 * A3's own copy of the pending row, read from its store right after the removal (its control
 * connections are already hung up). When the row reached it: the key is sealed to A1 and A2 and
 * not to A3, A3's identity key does not open it, and no column carries the key in the clear.
 */
async function expectSealedAwayFromA3({ owner, a3, a2MachineId, a3MachineId, a3Opener, strandId }: SharedStrand, newMemberKey: string): Promise<void> {
	const row = await a3.node.getControlDatabase()!.queryPendingStrandPartyKey(strandId);
	if (row === null) {
		console.warn('[machine-removal-rotation] A3 holds no pending row: the cut came before the row reached it, so nothing is there to be sealed');
		return;
	}
	expect(row.publicKey).toBe(newMemberKey);
	const recipients = partyKeyRecipients(row.sealedKey);
	expect(recipients).toEqual(expect.arrayContaining([owner.peerId!.toString(), a2MachineId]));
	expect(recipients).not.toContain(a3MachineId);
	expect(openPartyKey(row.sealedKey, strandId, a3Opener), 'the removed machine cannot open the key it received').toBeNull();
	for (const column of [row.publicKey, row.sealedKey, ...row.superseded, row.stampId]) {
		expect(carriesPrivateKeyOf(column, newMemberKey), 'no column of the pending row holds the new key in the clear').toBe(false);
	}
}

/** Whether `value` decodes as a `StrandPartyKey.PrivateKey` whose public half is `memberKey`. A column in any other encoding does not decode, which is the expected answer, not an error. */
function carriesPrivateKeyOf(value: string, memberKey: string): boolean {
	try {
		return strandMemberKeyPair(value).publicKeyB64 === memberKey;
	} catch {
		return false;
	}
}

/** A3's `StrandPartyKey` row, in its own store after the cut, still names the old key: the swapped row, in the clear, never reached it. */
async function expectA3StaysOnOldKey({ a3, strandId, oldMemberKey }: SharedStrand): Promise<void> {
	const partyKey = await a3.node.getControlDatabase()!.queryStrandPartyKey(strandId);
	expect(partyKey, 'A3 keeps the StrandPartyKey row it synced before the removal').not.toBeNull();
	expect(strandMemberKeyPair(partyKey!).publicKeyB64, 'the removed machine stays on the old key').toBe(oldMemberKey);
}

describe('Removing a machine replaces the party key in a strand shared with another party', () => {
	afterEach(async () => {
		await Promise.allSettled(startedMembers.splice(0).map((node) => node.stop()));
		await topology?.stop();
		topology = undefined;
	});

	it('with a sibling online: the swap finishes at once and the sibling re-keys its running strand in place', async () => {
		const shared = await bringUpSharedStrand();
		const { owner, a1, a2, a3, b, strandId, oldMemberKey, a3MachineId, a2Blocks, bBlocks } = shared;

		const removal = await owner.removeMachine(a3MachineId);
		expect(removal).toMatchObject({ removedPeer: true, strands: [{ strandId, outcome: 'rotated' }] });
		const a1Control = owner.getControlDatabase()!;
		expect(await a1Control.queryPendingStrandPartyKey(strandId)).toBeNull();
		const newPartyKey = (await a1Control.queryStrandPartyKey(strandId))!;
		const newMemberKey = strandMemberKeyPair(newPartyKey).publicKeyB64;
		expect(newMemberKey).not.toBe(oldMemberKey);
		await expectRowsOnNewKey(shared, newMemberKey);

		await awaitSwapOn(a2.node, strandId, newMemberKey, 'A2 reads the swap A1 made');
		await waitUntil(async () => runningPartyKey(a2.node, strandId) === newPartyKey && membershipLoopDone(a2.node, strandId) && (await memberPeerBindings(a2.db)).includes(binding(newMemberKey, a2)), {
			...STRAND_GATE, description: 'A2 runs under the new key, its rebuilt membership loop done with its binding',
		});
		expect(a2.node.getStrand(strandId)?.libp2pNode, 'a re-key in place keeps the running strand node').toBe(a2.libp2p);

		await expectCutFromRows(shared, newMemberKey);
		await expectA3StaysOnOldKey(shared);
		await awaitCut(a2, a3, 'the old key\'s departure replicated to A2');
		await awaitBlockCoverage(bBlocks, a2Blocks, { timeoutMs: STRAND_GATE.timeoutMs, description: 'A2 holds B\'s post-removal write' });
		expectConnected(a1, a2, 'A2\'s binding under the new key keeps it served');
		expectConnected(b, a2, 'A2\'s binding under the new key keeps it served');
	}, TEST_TIMEOUT_MS);

	it('with the only sibling offline: the swap waits, and the sibling returns by itself with no owner signer', async () => {
		const shared = await bringUpSharedStrand();
		const { owner, a1, a2, a3, b, strandId, oldMemberKey, a2MachineId, a3MachineId, a2Blocks, bBlocks } = shared;
		const a1Control = owner.getControlDatabase()!;

		// ── A2 goes offline ─────────────────────────────────────────────────────
		// A background `CadrePeer` write still committing at a stop tears (docs/testing.md).
		expect(await a2.node.registerSelf()).not.toBe('skipped');
		const a2ListenAddr = sameListenAddr(a2.node);
		await a2.node.stop();
		for (const live of [a1, a3, b]) {
			await awaitCut(live, a2, 'A2 stopped');
		}
		// `removeMachine` is a control write, and a cohort that still lists A2 fails it.
		await waitUntil(async () => !(await readCohort(owner.getControlNode()!, 'A1')).includes(a2MachineId), {
			...STRAND_GATE, description: 'A2 leaves A1\'s control cohort',
		});
		// The driver's strand writes must not be the ones that discover A2 is gone.
		await insertWithRetry(a1, 'a2-offline', 'written while A2 is offline', REMAINING_COHORT_WRITE_BUDGET_MS);
		await awaitRowVisible(b, 'a2-offline', 'written while A2 is offline');

		// ── A1 removes A3 ───────────────────────────────────────────────────────
		const plan = await owner.planMachineRemoval(a3MachineId);
		expect(plan.strands).toEqual([{ strandId, rotation: 'here' }]);
		const removal = await owner.removeMachine(a3MachineId);
		// `pending` and not `rotated`: the swap is deferred while A1 is alone (header). The strand's rows are already on the new key.
		expect(removal).toMatchObject({ removedPeer: true, strands: [{ strandId, outcome: 'pending' }] });
		const newMemberKey = (await a1Control.queryPendingStrandPartyKey(strandId))!.publicKey;
		expect(newMemberKey).not.toBe(oldMemberKey);
		await expectSealedAwayFromA3(shared, newMemberKey);
		await expectRowsOnNewKey(shared, newMemberKey);

		await expectCutFromRows(shared, newMemberKey);
		await expectA3StaysOnOldKey(shared);

		// Without a gap here the coverage gates below could pass on their first poll.
		expect(blockCoverageIsComplete(await compareBlockCoverage(bBlocks, a2Blocks)), 'A2, offline, must lack what B wrote after it stopped').toBe(false);

		// ── A2 returns with no owner signer, and nothing else is asked of it ────
		const returned = (await shared.restartA2(a2ListenAddr)).node;
		expect(await returned.isOwner()).toBe(false);
		await awaitSwapOn(owner, strandId, newMemberKey, 'A1 swaps the control row once A2 is reachable');
		const newPartyKey = (await a1Control.queryStrandPartyKey(strandId))!;
		const a2Again = await awaitReplica(returned, strandId, 'A2 (restarted)');
		expect(a2Again.peerId, 'a strand peer id derives from the machine identity, so the binding A1 wrote still names it').toBe(a2.peerId);
		await waitUntil(() => strandConnectionsTo(a2Again, a1) > 0, { ...STRAND_GATE, description: 'A1 serves the restarted A2: its binding under the new key keeps it off the deny list' });
		await awaitBlockCoverage(bBlocks, a2Blocks, { timeoutMs: STRAND_GATE.timeoutMs, description: 'the restarted A2 holds B\'s post-removal write' });
		await insertWithRetry(b, 'after-return', 'written after A2 returned', REMAINING_COHORT_WRITE_BUDGET_MS);
		await awaitBlockCoverage(bBlocks, a2Blocks, { timeoutMs: STRAND_GATE.timeoutMs, description: 'the restarted A2 holds B\'s later write' });
		await waitUntil(async () => runningPartyKey(returned, strandId) === newPartyKey && membershipLoopDone(returned, strandId) && (await memberPeerBindings(a2Again.db)).includes(binding(newMemberKey, a2Again)), {
			...STRAND_GATE, description: 'the restarted A2 runs under the new key, its membership loop done with its binding',
		});

		// ── The control record, on the machine that was offline ─────────────────
		const a2Control = returned.getControlDatabase()!;
		await waitUntil(async () => !(await a2Control.queryCadrePeers()).some((row) => row.peerId === a3MachineId), {
			...STRAND_GATE, description: 'A3\'s CadrePeer row is gone on A2',
		});
		expect((await a1Control.queryCadrePeers()).some((row) => row.peerId === a3MachineId)).toBe(false);
		await awaitSwapOn(returned, strandId, newMemberKey, 'A2 holds the new key in StrandPartyKey and no pending row');
	}, TEST_TIMEOUT_MS);
});
