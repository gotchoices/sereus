/**
 * One machine's strand-side handles ({@link StrandMachine}) and the claims the removal scenarios
 * make against them: connection claims, `Strand.*` membership scans, `App.Data` convergence
 * gates with their paired negative, the retrying insert, the control-row gates and the strand
 * mesh. Shared by `strand-removal-cuts-network`, `strand-party-removal-via-formation-e2e`,
 * `machine-removal-rotates-party-key` and `party-key-rotation-across-parties`, which each
 * carried a copy until the fourth arrived.
 *
 * Every strand read here scans and filters in JavaScript. A where-equality on a primary key is
 * served as a point lookup that can miss on a networked strand
 * (`debt-composite-pk-point-lookup-unreliable-untracked`), and a miss inside a negative claim
 * would pass it for the wrong reason, the worst failure available to a cut assertion. A scan
 * depends only on returning a superset of the live rows.
 *
 * Connection claims read the strand libp2p node's own `getConnections()`, the surface the
 * teardown sweep hangs up through, filtered to a named remote peer id and never a bare count,
 * so an unrelated peer coming or going cannot move a claim.
 *
 * The `App.Data` helpers assume the one-table key/value sApp these scenarios share
 * (`table Data (Key text primary key, Val text)`), which each scenario still declares itself.
 *
 * Harness module: no `vitest` import, like the rest of the harness. A failed claim throws a
 * plain `Error` naming the machine, which fails the test the same way; what is lost is vitest's
 * diff of two values, which none of these claims (a count against zero, a row seen or not) needs.
 */

import { DEFAULT_STRAND_CLUSTER_SIZE, strandMemberKeyPair } from '@serfab/cadre-core';
import type { CadreNode, OpenInvitation, StrandInstance, StrandRow } from '@serfab/cadre-core';
import type { Database } from '@quereus/quereus';
import { waitForCohortOn } from './control-cohort.js';
import { connectStrandNodes } from './strand-join.js';
import { sleep, waitUntil } from './wait-utils.js';

/** A positive gate's budget and cadence. */
export interface StrandGate {
	timeoutMs: number;
	intervalMs: number;
}

/**
 * The budget every positive convergence gate waits on unless a scenario says otherwise. The
 * four-machine removal scenarios converge in under a second; this is headroom for slow
 * hardware, not an expectation.
 */
export const STRAND_GATE: StrandGate = { timeoutMs: 60_000, intervalMs: 250 };

/**
 * How long a cut machine is given to converge before "it never did" is claimed. Its size is the
 * claim: too short and a merely slow strand reads as a cut. Ten seconds is about ten times the
 * cross-machine visibility latency measured on the four-machine topology of
 * `strand-removal-cuts-network`, and every negative claim is paired with a positive read of the
 * same write on a machine that is not cut, so a strand that stalled fails that read instead.
 */
export const NO_CONVERGENCE_BUDGET_MS = 10_000;

/**
 * The budget of a write by the remaining cohort right after a machine left the strand. Measured
 * on `strand-removal-cuts-network` over four runs, not hypothetical: the first write after a cut
 * failed three or four times over 3.5 to 4.3 s (`BlockUnavailableError … peers-unreachable`)
 * while the cohort still listed the unreachable machines, and committed once it downsized to
 * the live holders (`allowDownsize: true` in `STRAND_CLUSTER_POLICY`). It recovers on its own,
 * which is why {@link insertWithRetry} exists; exceeding this budget is the genuine "the
 * remaining cohort cannot commit" failure. A `cluster-fetch:no-quorum` failure instead is the
 * upstream tripwire recorded at `tearDownRevoked` in `strand-revocation-enforcer.ts`.
 */
export const REMAINING_COHORT_WRITE_BUDGET_MS = 90_000;

/** The strand mesh dials and cohort barrier of {@link meshStrandNodes}. */
export const STRAND_MESH_TIMEOUT_MS = 30_000;

/** A bound formation invitation's lifetime ({@link publishBoundInvitation}): longer than any scenario. */
export const BOUND_INVITATION_TTL_MS = 365 * 24 * 3600_000;

/** One machine's strand-side handles, named so every failure message says which machine. */
export interface StrandMachine {
	label: string;
	node: CadreNode;
	db: Database;
	/**
	 * The machine's strand transport peer id: what a `MemberPeer` row binds and what the deny
	 * set is keyed by. Distinct from its control peer id.
	 */
	peerId: string;
	/** The strand's own libp2p node, captured once so no call site re-asserts it is there. */
	libp2p: NonNullable<StrandInstance['libp2pNode']>;
}

/**
 * Pair a machine with its strand instance, throwing by name rather than letting a launch
 * regression surface as `Cannot read properties of undefined` several phases on.
 */
export function strandMachine(label: string, node: CadreNode, instance: StrandInstance | undefined): StrandMachine {
	if (!instance?.database || !instance.libp2pNode) {
		const error = instance?.error ? ` (${String(instance.error)})` : '';
		throw new Error(`${label}: the strand came up '${instance?.status}'${error} with no database/libp2p node, so nothing can be asserted against it`);
	}
	return { label, node, db: instance.database.getDatabase(), libp2p: instance.libp2pNode, peerId: instance.libp2pNode.peerId.toString() };
}

// ─── Connections ─────────────────────────────────────────────────────────────

/** Open connections `from`'s strand node holds to `to`. */
export function strandConnectionsTo(from: StrandMachine, to: StrandMachine): number {
	return from.libp2p.getConnections().filter((c) => c.remotePeer.toString() === to.peerId).length;
}

/** `from` holds at least one strand connection to `to` now, or throws with `why`. */
export function expectConnected(from: StrandMachine, to: StrandMachine, why: string): void {
	if (strandConnectionsTo(from, to) === 0) {
		throw new Error(`${from.label} holds no strand connection to ${to.label} but should: ${why}`);
	}
}

/** `from` holds no strand connection to `to` now, or throws with `why`. */
export function expectCut(from: StrandMachine, to: StrandMachine, why: string): void {
	const open = strandConnectionsTo(from, to);
	if (open > 0) {
		throw new Error(`${from.label} still holds ${open} strand connection(s) to ${to.label} but should hold none: ${why}`);
	}
}

/** Gate: `from` hangs up every strand connection to `to`, the cut on the production revocation schedule once the rows reach `from`. */
export async function awaitCut(from: StrandMachine, to: StrandMachine, why: string, gate: StrandGate = STRAND_GATE): Promise<void> {
	await waitUntil(() => strandConnectionsTo(from, to) === 0, { ...gate, description: `${from.label} holds no strand connection to ${to.label}: ${why}` });
}

// ─── Membership rows ─────────────────────────────────────────────────────────

/** Every `Strand.Member.Key` visible to one machine. */
export async function memberKeys(db: Database): Promise<string[]> {
	const keys: string[] = [];
	for await (const row of db.eval('select Key from Strand.Member')) {
		keys.push(row.Key as string);
	}
	return keys;
}

/** Every `Strand.Manager.MemberKey` visible to one machine. */
export async function managerKeys(db: Database): Promise<string[]> {
	const keys: string[] = [];
	for await (const row of db.eval('select MemberKey from Strand.Manager')) {
		keys.push(row.MemberKey as string);
	}
	return keys;
}

/** Every `Strand.MemberPeer` row as `MemberKey|PeerId`: the pairing (which party a machine belongs to) is the claim, never the peer id alone. */
export async function memberPeerBindings(db: Database): Promise<string[]> {
	const bindings: string[] = [];
	for await (const row of db.eval('select MemberKey, PeerId from Strand.MemberPeer')) {
		bindings.push(`${row.MemberKey as string}|${row.PeerId as string}`);
	}
	return bindings;
}

/** The `MemberKey|PeerId` string a binding of `machine` under `memberKey` appears as in {@link memberPeerBindings}. */
export function binding(memberKey: string, machine: StrandMachine): string {
	return `${memberKey}|${machine.peerId}`;
}

/** Every spent invitation visible to one machine as `InviteKey|MemberKey`: which credential was spent, against which member. */
export async function consumedInvites(db: Database): Promise<string[]> {
	const spent: string[] = [];
	for await (const row of db.eval('select InviteKey, MemberKey from Strand.ConsumedInvite')) {
		spent.push(`${row.InviteKey as string}|${row.MemberKey as string}`);
	}
	return spent;
}

/** Gate: `observer` reads `memberKey` seated as a `Strand.Member`. */
export async function awaitMemberSeated(observer: StrandMachine, memberKey: string, whose: string, gate: StrandGate = STRAND_GATE): Promise<void> {
	await waitUntil(async () => (await memberKeys(observer.db)).includes(memberKey), { ...gate, description: `${whose}'s Member row becomes visible on ${observer.label}` });
}

/**
 * Gate: every observer reads every binding in `bindings` ({@link binding}). The deny set is
 * derived from these rows, so a machine that cannot read a binding cannot deny the machine it
 * names; gating here is what makes a later cut mean "chose to" rather than "had nothing to go on".
 */
export async function awaitBindingsVisible(observers: readonly StrandMachine[], bindings: readonly string[], gate: StrandGate = STRAND_GATE): Promise<void> {
	for (const observer of observers) {
		await waitUntil(async () => {
			const visible = await memberPeerBindings(observer.db);
			return bindings.every((row) => visible.includes(row));
		}, { ...gate, description: `all ${bindings.length} MemberPeer bindings become visible on ${observer.label}` });
	}
}

// ─── App.Data ────────────────────────────────────────────────────────────────

/** The `App.Data` value under `key` as one machine reads it, or undefined. */
export async function dataValue(db: Database, key: string): Promise<string | undefined> {
	for await (const row of db.eval('select Key, Val from App.Data')) {
		if (row.Key === key) return row.Val as string;
	}
	return undefined;
}

/** Gate: `machine` reads `val` under `key`. */
export async function awaitRowVisible(machine: StrandMachine, key: string, val: string, gate: StrandGate = STRAND_GATE): Promise<void> {
	await waitUntil(async () => (await dataValue(machine.db, key)) === val, { ...gate, description: `App.Data '${key}' becomes visible on ${machine.label}` });
}

/**
 * `machine` never reads `val` under `key` within `budgetMs` ({@link NO_CONVERGENCE_BUDGET_MS}),
 * or throws. `waitUntil` retries through a throwing read, so a machine whose read fails because
 * it reaches no coordinator counts as not converged too; both are the cut. Pair it with a
 * positive read of the same write on a machine that is not cut, which a stalled strand fails.
 */
export async function expectNeverConverges(machine: StrandMachine, key: string, val: string, budgetMs: number): Promise<void> {
	const description = `App.Data '${key}' to reach the cut machine ${machine.label} (it must not)`;
	try {
		await waitUntil(async () => (await dataValue(machine.db, key)) === val, { timeoutMs: budgetMs, intervalMs: 250, description });
	} catch (error) {
		if (String(error).includes('Timeout waiting')) {
			return;
		}
		throw error;
	}
	throw new Error(`${machine.label} converged on App.Data '${key}' within ${budgetMs} ms, but it is cut off and must not`);
}

/**
 * Whether a failed insert's row is there anyway, asked on the author's own database, so it
 * makes no claim about any other machine. A read that itself fails answers no, logged, so the
 * caller keeps the insert's error.
 */
export async function rowLanded(machine: StrandMachine, key: string, val: string): Promise<boolean> {
	try {
		return (await dataValue(machine.db, key)) === val;
	} catch (readError) {
		console.warn(`[strand-machine] ${machine.label}: read-back of '${key}' after a failed insert also failed: ${String(readError)}`);
		return false;
	}
}

/**
 * An insert retried across the wobble after a machine leaves the strand, bounded by `budgetMs`
 * ({@link REMAINING_COHORT_WRITE_BUDGET_MS}). The retry is load-bearing, not defensive: the
 * first attempts after a cut fail while the cohort still lists the unreachable machines, and a
 * handful of failures before a commit is the expected shape.
 */
export async function insertWithRetry(machine: StrandMachine, key: string, val: string, budgetMs: number): Promise<void> {
	const start = Date.now();
	for (let attempt = 1; ; attempt++) {
		try {
			await machine.db.exec('insert into App.Data (Key, Val) values (?, ?)', [key, val]);
			console.log(`[strand-machine] ${machine.label} committed '${key}' on attempt ${attempt} after ${Date.now() - start} ms`);
			return;
		} catch (error) {
			if (await rowLanded(machine, key, val)) {
				console.log(`[strand-machine] ${machine.label} attempt ${attempt} reported failure but '${key}' landed`);
				return;
			}
			if (Date.now() - start > budgetMs) {
				throw new Error(`${machine.label}: the remaining cohort could not commit '${key}' within ${budgetMs} ms (${attempt} attempt(s)); last error: ${String(error)}`, { cause: error });
			}
			console.warn(`[strand-machine] ${machine.label} attempt ${attempt} at '${key}' failed, retrying: ${String(error)}`);
			await sleep(1_000);
		}
	}
}

// ─── Control rows ────────────────────────────────────────────────────────────

/**
 * Mint a fresh open invitation on `host` and publish it bound to `strandId`, the reference
 * apps' flow: redeeming it records consent against the existing host strand rather than
 * minting a new one, which is what makes the responder issue a membership invitation.
 */
export async function publishBoundInvitation(host: CadreNode, strandId: string, sAppId: string, ttlMs: number = BOUND_INVITATION_TTL_MS): Promise<OpenInvitation> {
	const invitation = await host.createOpenInvitation(sAppId, ttlMs);
	await host.publishFormationInvite(invitation.token, sAppId, { strandId, expiresAtMs: Date.now() + ttlMs, totalUses: 1 });
	return invitation;
}

/**
 * The party's `StrandPartyKey.PrivateKey` for the strand once `node` holds the row: the row the
 * founder's publish mints and a joiner's `formStrand` persists, which every machine of the party
 * signs its membership writes with. Gated rather than read once, since a non-founding machine
 * receives it by control replication.
 */
export async function awaitPartyKey(node: CadreNode, strandId: string, label: string, gate: StrandGate = STRAND_GATE): Promise<string> {
	let key: string | null = null;
	await waitUntil(async () => {
		key = await node.getControlDatabase()!.queryStrandPartyKey(strandId);
		return key !== null;
	}, { ...gate, description: `${label} holds the party's StrandPartyKey row for the strand` });
	return key!;
}

/** The party's own published `Strand` row once `node` holds it: how a non-founding machine learns a strand its party founded, read key included. */
export async function awaitStrandRow(node: CadreNode, strandId: string, label: string, gate: StrandGate = STRAND_GATE): Promise<StrandRow> {
	let row: StrandRow | null = null;
	await waitUntil(async () => {
		row = await node.getControlDatabase()!.queryStrand(strandId);
		return row !== null;
	}, { ...gate, description: `${label} holds the published Strand row` });
	return row!;
}

/** The party-wide `JoinedStrand` row once `node` holds it: the joined counterpart of {@link awaitStrandRow}, published by an owner machine's connected reconcile pass. */
export async function awaitJoinedStrandRow(node: CadreNode, strandId: string, label: string, gate: StrandGate = STRAND_GATE): Promise<StrandRow> {
	let row: StrandRow | null = null;
	await waitUntil(async () => {
		row = await node.getControlDatabase()!.queryJoinedStrand(strandId);
		return row !== null;
	}, { ...gate, description: `${label} holds the party-wide JoinedStrand row` });
	return row!;
}

/** The storage replica `node` launches by itself from a `Strand` or `JoinedStrand` row it holds, once it has the strand's Header. */
export async function awaitReplica(node: CadreNode, strandId: string, label: string, gate: StrandGate = STRAND_GATE): Promise<StrandMachine> {
	await waitUntil(() => node.getStrand(strandId)?.database !== undefined, { ...gate, description: `${label} runs a storage replica of the strand` });
	return strandMachine(label, node, node.getStrand(strandId));
}

/** Gate: `node`'s control record names a party key whose public half is `newMemberKey`, with no pending row left. */
export async function awaitSwapOn(node: CadreNode, strandId: string, newMemberKey: string, description: string, gate: StrandGate = STRAND_GATE): Promise<void> {
	const control = node.getControlDatabase()!;
	await waitUntil(async () => {
		const partyKey = await control.queryStrandPartyKey(strandId);
		return partyKey !== null && strandMemberKeyPair(partyKey).publicKeyB64 === newMemberKey && (await control.queryPendingStrandPartyKey(strandId)) === null;
	}, { ...gate, description });
}

// ─── The mesh ────────────────────────────────────────────────────────────────

/**
 * Dial every strand pair that is not connected, then barrier each node's cohort at the strand
 * breadth (a write is offered to at most `DEFAULT_STRAND_CLUSTER_SIZE` peers however many
 * machines exist). Cross-party discovery from the formation seed alone is
 * `strand-formation-cross-party-seed`'s subject; here the mesh is a precondition, so it is dialed
 * rather than waited on, and an already-connected pair (the seeded auto-dial) is not re-driven.
 */
export async function meshStrandNodes(machines: readonly StrandMachine[], timeoutMs: number = STRAND_MESH_TIMEOUT_MS): Promise<void> {
	for (let i = 0; i < machines.length; i++) {
		for (let j = i + 1; j < machines.length; j++) {
			const [dialer, target] = [machines[j]!, machines[i]!];
			if (strandConnectionsTo(dialer, target) === 0) {
				await connectStrandNodes(dialer.libp2p, dialer.label, target.libp2p, target.label, timeoutMs);
			}
		}
	}
	const want = Math.min(machines.length, DEFAULT_STRAND_CLUSTER_SIZE);
	for (const machine of machines) {
		await waitForCohortOn(machine.libp2p, want, { timeoutMs, label: `strand cohort on ${machine.label}` });
	}
}

// ─── The instance manager's per-strand state ─────────────────────────────────

/**
 * The instance manager's per-strand state the loop reads need. No app has a use for it, so it
 * stays private there.
 *
 * NOTE: reached by field name through a cast, so a rename of `membershipReconcilers` or
 * `launchConfigs` in `strand-instance-manager.ts` compiles and makes these reads answer
 * `false`/`undefined`; the gates built on them then time out (60 s) instead of failing fast.
 * If that ever bites, have the manager expose a test-only probe and type it.
 */
interface StrandManagerInternals {
	membershipReconcilers: Map<string, { done: boolean }>;
	launchConfigs: Map<string, { partyMemberPrivateKey?: string }>;
}

function strandManagerOf(node: CadreNode): StrandManagerInternals {
	return (node as unknown as { strandManager: StrandManagerInternals }).strandManager;
}

/** Whether `node`'s membership reconciler for the strand has latched done. */
export function membershipLoopDone(node: CadreNode, strandId: string): boolean {
	return strandManagerOf(node).membershipReconcilers.get(strandId)?.done === true;
}

/** The key `node` runs the strand under; the control row only says which one it should. */
export function runningPartyKey(node: CadreNode, strandId: string): string | undefined {
	return strandManagerOf(node).launchConfigs.get(strandId)?.partyMemberPrivateKey;
}
