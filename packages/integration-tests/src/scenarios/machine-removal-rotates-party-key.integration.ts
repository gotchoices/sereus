/**
 * Removing a machine from a cadre cuts it off a strand the cadre shares with another party
 * (`docs/architecture.md` → "Removing a machine"), proved on a real network and on rows
 * production wrote: the test calls no membership writer.
 *
 * Machines:
 * - **A1**, party A's owner: founds the cadre and the closed strand, and removes A3.
 * - **A2**, an always-on member (`startPinningMember` + `admitMember`, no owner key) that runs the
 *   strand as a storage replica. It is offline through the removal and is restarted on the same
 *   identity, port and raw store. Starting it is the only call the test makes on it afterwards.
 * - **A3**, a second member, with the app. The machine removed.
 * - **B**, party B's one machine, in the strand through the real formation handshake.
 *
 * Reads:
 * - A replica runs without the app, so A2 has no `App.Data` to read. Its convergence on a row is
 *   physical: it holds every block B holds, and the same-store restart keeps that meaningful.
 *   Membership rows are readable there, because every strand carries the `Strand` schema.
 * - Every strand read scans and filters in JavaScript: a where-equality on a primary key is a
 *   point lookup that can miss on a networked strand
 *   (`debt-composite-pk-point-lookup-unreliable-untracked`), and a miss inside a negative
 *   assertion would pass it for the wrong reason.
 * - A cut is asserted in both directions of evidence: the connection that existed before is gone
 *   after, and the cut machine then fails to converge on a row whose paired positive read on a
 *   remaining machine succeeds. Without that read a stalled strand would look like a cut.
 *
 * Timing: revocation enforcement runs the production schedule on every machine, so each cut below
 * is the rows arriving, which is what an app gets. The membership reconciler and the control
 * cohort reconcile run on short intervals through the harness, since their production defaults
 * would put a pass outside the gates.
 *
 * The swap of the control row is deferred here. Once A3 is gone and A2 is offline, A1 can reach no
 * sibling while the party still has a member, so the swap would fork the party's control history
 * if A2 wrote meanwhile. `removeMachine` therefore reports the strand `pending` with the strand's
 * own rows already on the new key, and A1's growth drain finishes the swap when A2 returns.
 *
 * Not proved here: that the removed machine lacks the new key. It receives it over the control
 * network before it is cut off (`removed-machine-receives-new-party-key`), so the cut asserted
 * below is of a client that runs this code, which never uses a pending key without an owner signer.
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_STRAND_CLUSTER_SIZE, generateStrandMemberKey, strandMemberKeyPair } from '@serfab/cadre-core';
import type { CadreNode, OpenInvitation, StrandInstance, StrandRow } from '@serfab/cadre-core';
import type { Database } from '@quereus/quereus';
import {
	admitMember,
	awaitBlockCoverage,
	bootTopology,
	blockCoverageIsComplete,
	captureRawStorage,
	compareBlockCoverage,
	connectStrandNodes,
	createSignedSAppConfig,
	readCohort,
	sameListenAddr,
	sleep,
	startPinningMember,
	waitForCohortOn,
	waitUntil,
	type InviteMember,
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
const INVITATION_TTL_MS = 365 * 24 * 3600_000;

/** The membership reconciler's cadence: keeps its ladder (invite row, redemption, binding) inside {@link GATE} rather than the 30 s default. */
const RECONCILE_POLL_MS = 2_000;
/** The control cohort's reconcile backstop, which caps the redial that brings A1 and the restarted A2 back together. */
const CONTROL_RECONCILE_MS = 2_000;
/** A2's strand watcher backstop: how soon it launches its replica from a `Strand` row it holds. */
const STRAND_WATCH_MS = 1_000;

/** Every positive convergence gate. Sibling scenarios converge in under a second; this is headroom for slow hardware. */
const GATE = { timeoutMs: 60_000, intervalMs: 250 } as const;
/** The strand mesh dials and cohort barrier. */
const MESH_TIMEOUT_MS = 30_000;
/**
 * How long a cut machine is given before "it never converged" is asserted. Its size is the claim:
 * ~10× the measured cross-machine visibility latency on this shape, inherited from
 * `strand-removal-cuts-network.integration.ts`.
 */
const NO_CONVERGENCE_BUDGET_MS = 10_000;
/**
 * A write right after a machine left the strand. Measured in `strand-removal-cuts-network`: three
 * or four failed attempts over 3.5 to 4.3 s while the cohort still lists the unreachable machine.
 * Exceeding this is the genuine "the remaining cohort cannot commit" failure.
 */
const REMAINING_COHORT_WRITE_BUDGET_MS = 90_000;
/** Sized by `harness/topology.ts`'s rule of thumb for 10 libp2p nodes, A2's restart included, plus the gates; measured at 60 to 66 s. */
const TEST_TIMEOUT_MS = 600_000;

/** The harness's knobs for every machine's closed-strand loops. */
const MEMBERSHIP_LOOP = { pollIntervalMs: RECONCILE_POLL_MS } as const;

// NOTE: these handles and read helpers are copied from `strand-removal-cuts-network` and
// `strand-party-removal-via-formation-e2e`, as each of those copied the other. If a fourth scenario
// wants them, move them to the harness.

/** One machine's strand-side handles, named so every failure message says which machine. */
interface StrandMachine {
	label: string;
	node: CadreNode;
	db: Database;
	/** The machine's strand transport peer id: what a `MemberPeer` row binds and what the deny set is keyed by. */
	peerId: string;
	libp2p: NonNullable<StrandInstance['libp2pNode']>;
}

function strandMachine(label: string, node: CadreNode, instance: StrandInstance | undefined): StrandMachine {
	if (!instance?.database || !instance.libp2pNode) {
		throw new Error(`${label}: the strand came up '${instance?.status}' with no database/libp2p node`);
	}
	return { label, node, db: instance.database.getDatabase(), libp2p: instance.libp2pNode, peerId: instance.libp2pNode.peerId.toString() };
}

/** Open connections `from`'s strand node holds to `to`, by named peer id so an unrelated peer cannot move an assertion. */
function strandConnectionsTo(from: StrandMachine, to: StrandMachine): number {
	return from.libp2p.getConnections().filter((c) => c.remotePeer.toString() === to.peerId).length;
}

function expectConnected(from: StrandMachine, to: StrandMachine, why: string): void {
	expect(strandConnectionsTo(from, to), `${from.label} should hold a strand connection to ${to.label}: ${why}`).toBeGreaterThan(0);
}

async function awaitCut(from: StrandMachine, to: StrandMachine, why: string): Promise<void> {
	await waitUntil(() => strandConnectionsTo(from, to) === 0, { ...GATE, description: `${from.label} holds no strand connection to ${to.label}: ${why}` });
}

async function memberKeys(db: Database): Promise<string[]> {
	const keys: string[] = [];
	for await (const row of db.eval('select Key from Strand.Member')) {
		keys.push(row.Key as string);
	}
	return keys;
}

async function managerKeys(db: Database): Promise<string[]> {
	const keys: string[] = [];
	for await (const row of db.eval('select MemberKey from Strand.Manager')) {
		keys.push(row.MemberKey as string);
	}
	return keys;
}

/** Every `Strand.MemberPeer` row as `MemberKey|PeerId`: the pairing is the claim, never the peer id alone. */
async function memberPeerBindings(db: Database): Promise<string[]> {
	const bindings: string[] = [];
	for await (const row of db.eval('select MemberKey, PeerId from Strand.MemberPeer')) {
		bindings.push(`${row.MemberKey as string}|${row.PeerId as string}`);
	}
	return bindings;
}

function binding(memberKey: string, machine: StrandMachine): string {
	return `${memberKey}|${machine.peerId}`;
}

async function dataValue(db: Database, key: string): Promise<string | undefined> {
	for await (const row of db.eval('select Key, Val from App.Data')) {
		if (row.Key === key) return row.Val as string;
	}
	return undefined;
}

async function awaitRowVisible(machine: StrandMachine, key: string, val: string): Promise<void> {
	await waitUntil(async () => (await dataValue(machine.db, key)) === val, { ...GATE, description: `App.Data '${key}' becomes visible on ${machine.label}` });
}

/** `waitUntil` retries through a throwing read, so a read that fails because the machine reaches no coordinator counts as not converged too. Both are the cut. */
async function expectNeverConverges(machine: StrandMachine, key: string, val: string): Promise<void> {
	await expect(
		waitUntil(async () => (await dataValue(machine.db, key)) === val, {
			timeoutMs: NO_CONVERGENCE_BUDGET_MS, intervalMs: 250,
			description: `App.Data '${key}' to reach the cut machine ${machine.label} (it must not)`,
		}),
		`${machine.label} must not converge on '${key}'`,
	).rejects.toThrow(/Timeout waiting/);
}

/** Whether a failed insert's row is there anyway. A read that also fails answers no, logged, so the caller keeps the insert's error. */
async function rowLanded(machine: StrandMachine, key: string, val: string): Promise<boolean> {
	try {
		return (await dataValue(machine.db, key)) === val;
	} catch (readError) {
		console.warn(`[machine-removal-rotation] ${machine.label}: read-back of '${key}' after a failed insert also failed: ${String(readError)}`);
		return false;
	}
}

/** An insert retried across the wobble after a machine leaves ({@link REMAINING_COHORT_WRITE_BUDGET_MS}). */
async function insertWithRetry(machine: StrandMachine, key: string, val: string): Promise<void> {
	const start = Date.now();
	for (let attempt = 1; ; attempt++) {
		try {
			await machine.db.exec('insert into App.Data (Key, Val) values (?, ?)', [key, val]);
			console.log(`[machine-removal-rotation] ${machine.label} committed '${key}' on attempt ${attempt} after ${Date.now() - start} ms`);
			return;
		} catch (error) {
			if (await rowLanded(machine, key, val)) {
				return;
			}
			if (Date.now() - start > REMAINING_COHORT_WRITE_BUDGET_MS) {
				throw new Error(`${machine.label} could not commit '${key}' within ${REMAINING_COHORT_WRITE_BUDGET_MS} ms: ${String(error)}`, { cause: error });
			}
			console.warn(`[machine-removal-rotation] ${machine.label} attempt ${attempt} at '${key}' failed, retrying: ${String(error)}`);
			await sleep(1_000);
		}
	}
}

/** Mint and publish an invitation bound to `strandId`, the reference apps' flow, which makes the responder issue a membership invitation. */
async function publishBoundInvitation(host: CadreNode, strandId: string): Promise<OpenInvitation> {
	const invitation = await host.createOpenInvitation(SAPP_ID, INVITATION_TTL_MS);
	await host.publishFormationInvite(invitation.token, SAPP_ID, { strandId, expiresAtMs: Date.now() + INVITATION_TTL_MS, totalUses: 1 });
	return invitation;
}

async function awaitPartyKey(node: CadreNode, strandId: string, label: string): Promise<string> {
	let key: string | null = null;
	await waitUntil(async () => {
		key = await node.getControlDatabase()!.queryStrandPartyKey(strandId);
		return key !== null;
	}, { ...GATE, description: `${label} holds the party's StrandPartyKey row for the strand` });
	return key!;
}

async function awaitStrandRow(node: CadreNode, strandId: string, label: string): Promise<StrandRow> {
	let row: StrandRow | null = null;
	await waitUntil(async () => {
		row = await node.getControlDatabase()!.queryStrand(strandId);
		return row !== null;
	}, { ...GATE, description: `${label} holds the published Strand row` });
	return row!;
}

/** The replica `node` launches by itself from the `Strand` row, once it holds the Header. */
async function awaitReplica(node: CadreNode, strandId: string, label: string): Promise<StrandMachine> {
	await waitUntil(() => node.getStrand(strandId)?.database !== undefined, { ...GATE, description: `${label} runs a storage replica of the strand` });
	return strandMachine(label, node, node.getStrand(strandId));
}

/**
 * Dial the strand pairs that are not connected. Cross-party discovery from the formation seed
 * alone is `strand-formation-cross-party-seed`'s subject; here the mesh is a precondition.
 */
async function meshStrandNodes(machines: readonly StrandMachine[]): Promise<void> {
	for (let i = 0; i < machines.length; i++) {
		for (let j = i + 1; j < machines.length; j++) {
			const [dialer, target] = [machines[j]!, machines[i]!];
			if (strandConnectionsTo(dialer, target) === 0) {
				await connectStrandNodes(dialer.libp2p, dialer.label, target.libp2p, target.label, MESH_TIMEOUT_MS);
			}
		}
	}
	const want = Math.min(machines.length, DEFAULT_STRAND_CLUSTER_SIZE);
	for (const machine of machines) {
		await waitForCohortOn(machine.libp2p, want, { timeoutMs: MESH_TIMEOUT_MS, label: `strand cohort on ${machine.label}` });
	}
}

/** Whether `node`'s membership reconciler for the strand has latched done. No app has a use for this, so it stays private to the instance manager. */
function membershipLoopDone(node: CadreNode, strandId: string): boolean {
	const { strandManager } = node as unknown as { strandManager: { membershipReconcilers: Map<string, { done: boolean }> } };
	return strandManager.membershipReconcilers.get(strandId)?.done === true;
}

describe('Removing a machine replaces the party key in a strand shared with another party', () => {
	it('cuts the removed machine, keeps the other party and a machine offline through the removal, which rejoins by itself', async () => {
		let topology: Topology | undefined;
		let a2Member: InviteMember | undefined;
		let a3Member: InviteMember | undefined;
		try {
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
			const a1Control = owner.getControlDatabase()!;

			// ── Party A's members, each admitted the owner-online way ───────────────
			const a2Options = {
				hostUnclaimedStrands: true, strandWatchMs: STRAND_WATCH_MS, storageProvider: a2Capture.provider,
				reconcileMs: CONTROL_RECONCILE_MS, membershipReconciliation: MEMBERSHIP_LOOP,
			};
			a2Member = await startPinningMember(party.partyId, party.ownerPublicKey, a2Options);
			await admitMember(owner, a2Member, GATE.timeoutMs);
			const a2MachineId = a2Member.peerId;
			a3Member = await startPinningMember(party.partyId, party.ownerPublicKey, { reconcileMs: CONTROL_RECONCILE_MS, membershipReconciliation: MEMBERSHIP_LOOP });
			await admitMember(owner, a3Member, GATE.timeoutMs);
			const a3Node = a3Member.node;
			const a3MachineId = a3Member.peerId;

			// ── A1 founds the closed strand; A2 hosts it unasked; A3 attaches the app ──
			const strandId = `strand-machine-removal-rotation-${Date.now()}`;
			const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '1.0.0');
			const founded = await owner.foundStrand({ strandId, type: 'c', memberPrivateKey: await generateStrandMemberKey(), sAppConfig: sApp });
			const a1 = strandMachine('A1', owner, founded.instance);
			const oldMemberKey = strandMemberKeyPair(await awaitPartyKey(owner, strandId, 'A1')).publicKeyB64;

			const a2 = await awaitReplica(a2Member.node, strandId, 'A2');
			await awaitPartyKey(a2.node, strandId, 'A2');
			await awaitPartyKey(a3Node, strandId, 'A3');
			const a3 = strandMachine('A3', a3Node, await a3Node.addStrand({ strandRow: await awaitStrandRow(a3Node, strandId, 'A3'), sAppConfig: sApp }));

			// ── B joins over the real handshake ─────────────────────────────────────
			const form = await bNode.formStrand(await publishBoundInvitation(owner, strandId), {
				partyId: bNode.peerId!.toString(), purpose: 'machine removal rotates the party key',
			});
			expect(form.strandId).toBe(strandId);
			const b = strandMachine('B', bNode, await bNode.addStrand({
				strandRow: { Id: strandId, MemberPrivateKey: form.memberPrivateKey!, Type: 'c', FounderOwnerKey: null, FounderPeerId: null },
				sAppConfig: sApp,
			}));
			const bMemberKey = strandMemberKeyPair(await awaitPartyKey(bNode, strandId, 'B')).publicKeyB64;
			await meshStrandNodes([a1, a2, a3, b]);

			// ── 1. All four serve the strand, and production wrote every binding ─────
			// A2's row on A1 is what A1's driver binds A2 from, so it must be here before the removal.
			const statedPeers = [a1.peerId, a2.peerId, a3.peerId];
			await waitUntil(async () => {
				const rows = await a1Control.queryStrandPeers(strandId);
				return statedPeers.every((peerId) => rows.some((row) => row.strandPeerId === peerId));
			}, { ...GATE, description: 'A1 holds a StrandPeer row for each of party A\'s machines' });
			const aBindings = [a1, a2, a3].map((machine) => binding(oldMemberKey, machine));
			await waitUntil(async () => {
				const bindings = await memberPeerBindings(a1.db);
				return aBindings.every((row) => bindings.includes(row)) && bindings.includes(binding(bMemberKey, b));
			}, { ...GATE, description: 'A1 reads a binding under party A\'s key for each of its machines, and B\'s' });
			await waitUntil(async () => (await memberKeys(b.db)).includes(bMemberKey) && (await memberPeerBindings(b.db)).includes(binding(oldMemberKey, a3)), {
				...GATE, description: 'B reads its own member row and A3\'s binding',
			});

			await insertWithRetry(b, 'before-removal', 'everyone can read this');
			await awaitRowVisible(a1, 'before-removal', 'everyone can read this');
			await awaitRowVisible(a3, 'before-removal', 'everyone can read this');
			await awaitBlockCoverage(bCapture.forStrand(strandId), a2Capture.forStrand(strandId), {
				timeoutMs: GATE.timeoutMs, description: 'A2 holds every block B holds, before the removal',
			});
			for (const [from, to] of [[a1, a3], [b, a3], [a3, a1], [a3, b]] as const) {
				expectConnected(from, to, 'the mesh was wired at bring-up, so the cut below is a teardown');
			}

			// ── 2. A2 goes offline ──────────────────────────────────────────────────
			// A background `CadrePeer` write still committing at a stop tears (docs/testing.md).
			expect(await a2.node.registerSelf()).not.toBe('skipped');
			const a2Restart = { ...a2Options, key: a2Member.key, listenAddrs: [sameListenAddr(a2.node)] };
			await a2.node.stop();
			a2Member = undefined;
			for (const live of [a1, a3, b]) {
				await awaitCut(live, a2, 'A2 stopped');
			}
			// `removeMachine` is a control write, and a cohort that still lists A2 fails it.
			await waitUntil(async () => !(await readCohort(owner.getControlNode()!, 'A1')).includes(a2MachineId), {
				...GATE, description: 'A2 leaves A1\'s control cohort',
			});
			// The driver's strand writes must not be the ones that discover A2 is gone.
			await insertWithRetry(a1, 'a2-offline', 'written while A2 is offline');
			await awaitRowVisible(b, 'a2-offline', 'written while A2 is offline');

			// ── 3. A1 removes A3 ────────────────────────────────────────────────────
			const plan = await owner.planMachineRemoval(a3MachineId);
			expect(plan.strands).toEqual([{ strandId, rotation: 'here' }]);
			const removal = await owner.removeMachine(a3MachineId);
			// `pending` and not `rotated`: the swap is deferred while A1 is alone (header). The strand's rows are already on the new key.
			expect(removal).toMatchObject({ removedPeer: true, strands: [{ strandId, outcome: 'pending' }] });
			const pending = await a1Control.queryPendingStrandPartyKey(strandId);
			const newPartyKey = pending!.privateKey;
			const newMemberKey = strandMemberKeyPair(newPartyKey).publicKeyB64;
			expect(newMemberKey).not.toBe(oldMemberKey);
			expect(new Set(await memberKeys(a1.db))).toEqual(new Set([newMemberKey, bMemberKey]));
			expect(await managerKeys(a1.db)).toEqual([newMemberKey]);
			const a1Bindings = await memberPeerBindings(a1.db);
			expect(a1Bindings).toEqual(expect.arrayContaining([binding(newMemberKey, a1), binding(newMemberKey, a2), binding(oldMemberKey, a3)]));
			expect(a1Bindings).not.toContain(binding(newMemberKey, a3));

			// ── 4. The cut, from the rows alone ─────────────────────────────────────
			await awaitCut(a1, a3, 'A1 wrote the old key\'s departure');
			await waitUntil(async () => (await memberKeys(b.db)).includes(newMemberKey) && !(await memberKeys(b.db)).includes(oldMemberKey), {
				...GATE, description: 'B reads the replacement of party A\'s key',
			});
			await awaitCut(b, a3, 'the old key\'s departure replicated to B');

			await insertWithRetry(b, 'after-removal', 'written by the other party');
			await awaitRowVisible(a1, 'after-removal', 'written by the other party');
			expect(await dataValue(b.db, 'after-removal')).toBe('written by the other party');
			await expectNeverConverges(a3, 'after-removal', 'written by the other party');

			// Failing outright and committing only locally are both the cut; the read-back on A3 says which this run was.
			let pushError: unknown;
			await a3.db.exec('insert into App.Data (Key, Val) values (?, ?)', ['pushed-by-removed', 'from the removed machine']).catch((error: unknown) => { pushError = error; });
			console.log(`[machine-removal-rotation] the removed machine's write ${pushError === undefined ? 'committed locally' : `failed: ${String(pushError)}`}`);
			await Promise.all([
				expectNeverConverges(b, 'pushed-by-removed', 'from the removed machine'),
				expectNeverConverges(a1, 'pushed-by-removed', 'from the removed machine'),
			]);

			// Without a gap here the coverage gates below could pass on their first poll.
			expect(
				blockCoverageIsComplete(await compareBlockCoverage(bCapture.forStrand(strandId), a2Capture.forStrand(strandId))),
				'A2, offline, must lack what B wrote after it stopped',
			).toBe(false);

			// ── 5. A2 returns with no owner signer, and nothing else is asked of it ─
			a2Member = await startPinningMember(party.partyId, party.ownerPublicKey, a2Restart);
			const returned = a2Member.node;
			expect(await returned.isOwner()).toBe(false);
			await awaitRotationFinished(owner, strandId, newPartyKey);
			const a2Again = await awaitReplica(returned, strandId, 'A2 (restarted)');
			expect(a2Again.peerId, 'a strand peer id derives from the machine identity, so the binding A1 wrote still names it').toBe(a2.peerId);
			await waitUntil(() => strandConnectionsTo(a2Again, a1) > 0, { ...GATE, description: 'A1 serves the restarted A2: its binding under the new key keeps it off the deny list' });
			await awaitBlockCoverage(bCapture.forStrand(strandId), a2Capture.forStrand(strandId), {
				timeoutMs: GATE.timeoutMs, description: 'the restarted A2 holds B\'s post-removal write',
			});
			await insertWithRetry(b, 'after-return', 'written after A2 returned');
			await awaitBlockCoverage(bCapture.forStrand(strandId), a2Capture.forStrand(strandId), {
				timeoutMs: GATE.timeoutMs, description: 'the restarted A2 holds B\'s later write',
			});
			await waitUntil(async () => membershipLoopDone(returned, strandId) && (await memberPeerBindings(a2Again.db)).includes(binding(newMemberKey, a2Again)), {
				...GATE, description: 'the restarted A2\'s membership loop is done with its binding under the new key',
			});

			// ── 6. The control record, on the machine that was offline ──────────────
			const a2Control = returned.getControlDatabase()!;
			await waitUntil(async () => !(await a2Control.queryCadrePeers()).some((row) => row.peerId === a3MachineId), {
				...GATE, description: 'A3\'s CadrePeer row is gone on A2',
			});
			expect((await a1Control.queryCadrePeers()).some((row) => row.peerId === a3MachineId)).toBe(false);
			await waitUntil(async () => (await a2Control.queryStrandPartyKey(strandId)) === newPartyKey && (await a2Control.queryPendingStrandPartyKey(strandId)) === null, {
				...GATE, description: 'A2 holds the new key in StrandPartyKey and no pending row',
			});
		} finally {
			await Promise.allSettled([a3Member?.node.stop(), a2Member?.node.stop()]);
			await topology?.stop();
		}
	}, TEST_TIMEOUT_MS);
});

/** A1's control record names the new key and the pending row is gone. */
async function awaitRotationFinished(owner: CadreNode, strandId: string, newPartyKey: string): Promise<void> {
	const control = owner.getControlDatabase()!;
	await waitUntil(async () => (await control.queryStrandPartyKey(strandId)) === newPartyKey && (await control.queryPendingStrandPartyKey(strandId)) === null, {
		...GATE, description: 'A1 swaps the control row once A2 is reachable',
	});
}
