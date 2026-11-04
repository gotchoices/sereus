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
import { DEFAULT_STRAND_CLUSTER_SIZE, ed25519KeyPairFromLibp2p, generateStrandMemberKey, openPartyKey, partyKeyRecipients, strandMemberKeyPair } from '@serfab/cadre-core';
import type { CadreNode, OpenInvitation, PartyKeyOpener, StrandInstance, StrandRow } from '@serfab/cadre-core';
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
	type PinningMemberOptions,
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
/** Sized by `harness/topology.ts`'s rule of thumb for 10 libp2p nodes, A2's restart included, plus the gates; measured at 42 to 67 s per case. */
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

/** The instance manager's per-strand state these reads need. No app has a use for it, so it stays private there. */
interface StrandManagerInternals {
	membershipReconcilers: Map<string, { done: boolean }>;
	launchConfigs: Map<string, { partyMemberPrivateKey?: string }>;
}

function strandManagerOf(node: CadreNode): StrandManagerInternals {
	return (node as unknown as { strandManager: StrandManagerInternals }).strandManager;
}

function membershipLoopDone(node: CadreNode, strandId: string): boolean {
	return strandManagerOf(node).membershipReconcilers.get(strandId)?.done === true;
}

/** The key `node` runs the strand under; the control row only says which one it should. */
function runningPartyKey(node: CadreNode, strandId: string): string | undefined {
	return strandManagerOf(node).launchConfigs.get(strandId)?.partyMemberPrivateKey;
}

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
	await admitMember(owner, a2Member, GATE.timeoutMs);
	const a3Member = await startMember(party.partyId, party.ownerPublicKey, { reconcileMs: CONTROL_RECONCILE_MS, membershipReconciliation: MEMBERSHIP_LOOP });
	await admitMember(owner, a3Member, GATE.timeoutMs);

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

	// ── All four serve the strand, and production wrote every binding ───────
	// A2's row on A1 is what A1's driver binds A2 from, so it must be here before a removal.
	const a1Control = owner.getControlDatabase()!;
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

	const a2Blocks = a2Capture.forStrand(strandId);
	const bBlocks = bCapture.forStrand(strandId);
	await insertWithRetry(b, 'before-removal', 'everyone can read this');
	await awaitRowVisible(a1, 'before-removal', 'everyone can read this');
	await awaitRowVisible(a3, 'before-removal', 'everyone can read this');
	await awaitBlockCoverage(bBlocks, a2Blocks, { timeoutMs: GATE.timeoutMs, description: 'A2 holds every block B holds, before the removal' });
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
	}, { ...GATE, description: 'B reads the replacement of party A\'s key' });
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
}

/** `node`'s control record names a key whose public half is `newMemberKey`, with no pending row left. */
async function awaitSwapOn(node: CadreNode, strandId: string, newMemberKey: string, description: string): Promise<void> {
	const control = node.getControlDatabase()!;
	await waitUntil(async () => {
		const partyKey = await control.queryStrandPartyKey(strandId);
		return partyKey !== null && strandMemberKeyPair(partyKey).publicKeyB64 === newMemberKey && (await control.queryPendingStrandPartyKey(strandId)) === null;
	}, { ...GATE, description });
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
			...GATE, description: 'A2 runs under the new key, its rebuilt membership loop done with its binding',
		});
		expect(a2.node.getStrand(strandId)?.libp2pNode, 'a re-key in place keeps the running strand node').toBe(a2.libp2p);

		await expectCutFromRows(shared, newMemberKey);
		await expectA3StaysOnOldKey(shared);
		await awaitCut(a2, a3, 'the old key\'s departure replicated to A2');
		await awaitBlockCoverage(bBlocks, a2Blocks, { timeoutMs: GATE.timeoutMs, description: 'A2 holds B\'s post-removal write' });
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
			...GATE, description: 'A2 leaves A1\'s control cohort',
		});
		// The driver's strand writes must not be the ones that discover A2 is gone.
		await insertWithRetry(a1, 'a2-offline', 'written while A2 is offline');
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
		const a2Again = await awaitReplica(returned, strandId, 'A2 (restarted)');
		expect(a2Again.peerId, 'a strand peer id derives from the machine identity, so the binding A1 wrote still names it').toBe(a2.peerId);
		await waitUntil(() => strandConnectionsTo(a2Again, a1) > 0, { ...GATE, description: 'A1 serves the restarted A2: its binding under the new key keeps it off the deny list' });
		await awaitBlockCoverage(bBlocks, a2Blocks, { timeoutMs: GATE.timeoutMs, description: 'the restarted A2 holds B\'s post-removal write' });
		await insertWithRetry(b, 'after-return', 'written after A2 returned');
		await awaitBlockCoverage(bBlocks, a2Blocks, { timeoutMs: GATE.timeoutMs, description: 'the restarted A2 holds B\'s later write' });
		await waitUntil(async () => membershipLoopDone(returned, strandId) && (await memberPeerBindings(a2Again.db)).includes(binding(newMemberKey, a2Again)), {
			...GATE, description: 'the restarted A2\'s membership loop is done with its binding under the new key',
		});

		// ── The control record, on the machine that was offline ─────────────────
		const a2Control = returned.getControlDatabase()!;
		await waitUntil(async () => !(await a2Control.queryCadrePeers()).some((row) => row.peerId === a3MachineId), {
			...GATE, description: 'A3\'s CadrePeer row is gone on A2',
		});
		expect((await a1Control.queryCadrePeers()).some((row) => row.peerId === a3MachineId)).toBe(false);
		await awaitSwapOn(returned, strandId, newMemberKey, 'A2 holds the new key in StrandPartyKey and no pending row');
	}, TEST_TIMEOUT_MS);
});
