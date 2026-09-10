/**
 * The whole journey, on rows production wrote: form → belong → remove → cut.
 *
 * `strand-removal-cuts-network.integration.ts` already proves that removing a party hangs
 * up its machines on a real four-machine strand — but it hand-registers every membership
 * and device record, because when it was written production wrote none. Three tickets
 * later (`strand-party-member-key` → `strand-formation-membership-invite` →
 * `strand-node-binds-member-peer`) production writes all of them, and this file is the
 * proof: a second party joins through the REAL formation handshake, the runtime seats its
 * membership and binds each of its machines by itself, and the removal then cuts machines
 * the test never registered.
 *
 * ── WHAT THIS FILE DOES NOT CALL, AND WHY THAT IS THE POINT ──────────────────
 * Neither `issueInvite`, `consumeInvite` nor `registerMemberPeer` is called anywhere in
 * this file. Every `Strand.Member` and `Strand.MemberPeer` row asserted below was written
 * by the runtime: the responder issues the joiner's single-use invitation inside the
 * formation approval (`CadreNode.issueStrandMembershipInvite`), the joiner's node stages
 * it and persists its own party identity (`formStrand` → `adoptFormationMembershipInvite`),
 * and each machine's bring-up membership reconciler
 * (`strand-membership-reconciler.ts`) redeems it and registers that machine's own binding.
 * The ONE membership write this file makes is the founder's `revokeMember` — the app-facing
 * action the feature deliberately leaves to the caller — plus, in test 2, the manager-side
 * `addMemberByManager` re-admission whose necessity is that test's subject.
 *
 * ── TWO TESTS ────────────────────────────────────────────────────────────────
 *
 *   1. **The journey** (host party × 2 machines, joiner party × 2 machines, closed strand).
 *      The host founds and publishes a bound formation invitation; the joiner redeems it
 *      over the real handshake, both of the joiner's machines end up bound, and the founder
 *      then removes the joiner party: every connection to both of its machines goes, the
 *      remaining cohort still commits, and the removed party can neither read that write
 *      nor push one back. It closes on a consequence apps have to know about — a removed
 *      party's own two machines also stop talking to EACH OTHER, because each sees the
 *      other's device record as an orphan.
 *   2. **Re-joining after removal** (host × 2 machines, joiner × 1). A fresh formation after the
 *      cut still succeeds — formation runs on the CONTROL network, which strand revocation
 *      does not gate — reuses the party's identity and stages a fresh invitation. But the
 *      invitation cannot be spent: seating the member row is a STRAND write, and the
 *      removed party's machines are exactly the ones being denied. Re-admission therefore
 *      has to be authored by a remaining manager, and this test pins both halves.
 *
 * ── HOW TIMING IS CONTROLLED (read before changing a poll value) ──────────────
 * Two independent per-strand loops poll on the same default cadence, and this file wants
 * them at opposite ends:
 *
 *   • The revoked-peer deny set refreshes every `DEFAULT_REVOCATION_POLL_INTERVAL_MS`
 *     (30 s) and on demand via `CadreNode.refreshRevocationEnforcement`. Every machine
 *     here runs it at {@link SUSPENDED_POLL_MS} — longer than any test — so a machine
 *     refreshes exactly once at strand start (empty deny set: nothing has been removed
 *     yet) and never again on its own. Every cut asserted below is therefore one this
 *     test drove with an awaited refresh.
 *   • The membership reconciler retries on the SAME configured cadence unless told
 *     otherwise, and it must actually run — it is what writes the rows under test. So
 *     every machine also sets {@link RECONCILE_POLL_MS} explicitly. Suspending one loop
 *     without the other is what the harness's
 *     `ControlNodeOpts.membershipReconciliation: { pollIntervalMs }` exists for.
 *
 * Nothing here sleeps and hopes: every row the runtime writes in the background is waited
 * for by visibility, on the machine whose view the next step depends on.
 *
 * ── WHAT IS ASSERTED, AND HOW ────────────────────────────────────────────────
 * Connection claims read the strand libp2p node's own `getConnections()` — the surface the
 * teardown sweep hangs up through — filtered to a named remote peer id, never a bare
 * connection count, so an unrelated peer coming or going cannot move an assertion.
 *
 * A cut is asserted in BOTH directions of evidence: the connection that existed BEFORE the
 * revocation is gone AFTER it (teardown, not merely "a future dial would fail"), and the
 * removed party then fails to converge on a row the remaining cohort commits — bounded by
 * {@link NO_CONVERGENCE_BUDGET_MS} — while a control read of that same row on the other
 * REMAINING machine succeeds. A silent failure to observe something is not evidence on its
 * own; the paired control read is what turns it into evidence.
 *
 * Lookup shape (inherited from the sibling membership scenarios): a where-equality on a
 * full primary key is served by the optimystic module as a point lookup that can MISS on a
 * networked strand (`debt-composite-pk-point-lookup-unreliable-untracked`). Every read here
 * scans and filters in JavaScript, which depends only on the scan returning a superset of
 * the live rows — and a miss inside a NEGATIVE assertion would pass it for the wrong
 * reason, which is the worst failure mode available in this file.
 *
 * ── WHAT THIS FILE DOES NOT PROVE ────────────────────────────────────────────
 * • Every connection is DIRECT. A removed party reached over a `/p2p-circuit` is still
 *   asserted only against a stub — the same gap `strand-removal-cuts-network` records, and
 *   it needs the relay-only fixture of `blind-relay-phone-to-phone-e2e`, not an option on
 *   this topology.
 * • The strand MESH between the four machines is wired by explicit dials after each machine
 *   attaches (see {@link meshStrandNodes}). Cross-party discovery from the formation seed
 *   alone is `strand-formation-cross-party-seed`'s subject and is asserted here only for
 *   the pair formation actually seeds (joiner machine 0 → host machine 0); the mesh is a
 *   precondition of this file's claims, not one of them.
 * • The removed party still holds the strand's shared read key and everything it already
 *   replicated. Nothing here pretends otherwise — that residual is documented in
 *   `docs/strands.md` ("Revocation is forward-looking only"), not fixed by removal.
 */

import { describe, it, expect } from 'vitest';
import {
	ControlFormationUsageRecorder,
	DEFAULT_STRAND_CLUSTER_SIZE,
	MEMBERSHIP_INVITE_UNAVAILABLE_REASON,
	addMemberByManager,
	generateStrandMemberKey,
	revokeMember,
	strandMemberKeyPair,
} from '@serfab/cadre-core';
import type { CadreNode, FormStrandResult, OpenInvitation, StrandInstance, StrandRow } from '@serfab/cadre-core';
import type { Database } from '@quereus/quereus';
import {
	bootTopology,
	connectStrandNodes,
	createSignedSAppConfig,
	waitForCohortOn,
	waitUntil,
	sleep,
	type Topology,
	type TopologyMachine,
} from '../harness/index.js';

/** The one-table key/value sApp several strand scenarios already use. No RBAC: what is
 *  under test is whether a write REACHES a machine, not who was allowed to author it. */
const SIMPLE_SCHEMA = `
table Data (
    Key text primary key,
    Val text
);
`;

/** sApp id carried on the formation invitation. Only identity matters — the strand's real
 *  schema travels in the shared `SAppConfig` every machine attaches with. */
const SAPP_ID = 'sapp-removal-via-formation';

/** Formation invitation lifetime. Long enough that no test here can outlive one. */
const INVITATION_TTL_MS = 365 * 24 * 3600_000;

/** A revocation poll longer than any test in this file — see the timing note in the
 *  header. The enforcer still refreshes once at strand start (empty deny set) and never
 *  again on its own, so every cut below is attributable to an awaited refresh call. */
const SUSPENDED_POLL_MS = 3_600_000;

/** The membership reconciler's explicit cadence. The loop climbs a small ladder across
 *  passes (wait for the host-issued `Strand.Invite` row to replicate → redeem it →
 *  register this machine's binding), so its cadence sets how long the membership gates
 *  below take; 2 s keeps them inside {@link GATE} instead of the 30 s production default. */
const RECONCILE_POLL_MS = 2_000;

/** The budget every POSITIVE convergence gate waits on. Sibling four-machine scenarios
 *  converge well under a second; this is headroom for slow hardware, not an expectation. */
const GATE = { timeoutMs: 60_000, intervalMs: 250 } as const;

/** Budget for the strand mesh dials and the strand cohort barrier. */
const MESH_TIMEOUT_MS = 30_000;

/**
 * How long a cut-off machine is given to converge before "it never did" is asserted.
 *
 * The SIZE is the claim: too short and a merely-slow strand reads as a cut. Ten seconds is
 * ~10× the measured cross-machine visibility latency on this topology, and every negative
 * assertion is paired with a positive control read on a machine that is NOT cut, taken
 * from the same write — so a strand that had simply stalled fails the control read too and
 * the test reports that instead. Inherited verbatim from
 * `strand-removal-cuts-network.integration.ts`, whose measurement it rests on.
 */
const NO_CONVERGENCE_BUDGET_MS = 10_000;

/**
 * Budget for the post-cut write by the remaining cohort.
 *
 * MEASURED on the sibling removal scenario, not hypothetical: the first write after a cut
 * fails several times before it commits (three or four `BlockUnavailableError: … Block …
 * is unavailable (peers-unreachable)` attempts over 3.5-4.3 s), because the cohort still
 * lists the removed party's now-unreachable machines and has to downsize to the live
 * holders. It recovers on its own, which is why {@link insertWithRetry} exists and why the
 * claim is "the remaining cohort still commits", not "commits immediately". Exceeding THIS
 * budget is the genuine "removal broke the remaining strand" failure.
 */
const REMAINING_COHORT_WRITE_BUDGET_MS = 90_000;

/**
 * How long the removed party is watched for a self-service re-admission that must not
 * happen (test 2). Short on purpose: the claim is that nothing moves while the party is
 * cut off, and the paired positive claim — that the manager-side re-admission DOES heal
 * it — runs immediately afterwards on the same fixture, so a strand that had merely
 * stalled fails that instead of passing this.
 */
const NO_SELF_READMISSION_BUDGET_MS = 8_000;

/** Explicit test timeouts, per `harness/topology.ts`'s TIME BUDGET rule of thumb (~10-15 s
 *  per libp2p node), plus this file's formation handshake and negative budgets: test 1
 *  runs 8 nodes (4 control + 4 strand), test 2 runs 4. Never touch `vitest.config.ts`. */
const JOURNEY_TEST_TIMEOUT_MS = 600_000;
const REJOIN_TEST_TIMEOUT_MS = 420_000;

// ═════════════════════════════════════════════════════════════════════════════
// Machine handles and reads
// ═════════════════════════════════════════════════════════════════════════════

/** One machine's strand-side handles, named so every failure message says which machine. */
interface StrandMachine {
	label: string;
	node: CadreNode;
	db: Database;
	/** This machine's STRAND transport peer id — what a `MemberPeer` row binds, and what
	 *  the deny set is keyed by. Distinct from its control-network peer id. */
	peerId: string;
	/** The strand's own libp2p node — captured once, so no call site re-asserts it is there. */
	libp2p: NonNullable<StrandInstance['libp2pNode']>;
}

/**
 * Pair a machine with the strand instance it just launched, throwing by name rather than
 * letting a launch regression surface as `Cannot read properties of undefined` several
 * phases on.
 */
function strandMachine(label: string, node: CadreNode, instance: StrandInstance): StrandMachine {
	if (instance.status !== 'active' || !instance.database || !instance.libp2pNode) {
		throw new Error(
			`${label}: strand came up '${instance.status}'`
			+ (instance.error ? ` (${instance.error})` : '')
			+ ' with no database/libp2p node — nothing can be asserted against it');
	}
	return {
		label, node,
		db: instance.database.getDatabase(),
		libp2p: instance.libp2pNode,
		peerId: instance.libp2pNode.peerId.toString(),
	};
}

/** Open connections `from`'s strand node holds to `to`'s strand peer id — the same surface
 *  the teardown sweep enumerates and hangs up through. */
function strandConnectionsTo(from: StrandMachine, to: StrandMachine): number {
	return from.libp2p.getConnections()
		.filter((c) => c.remotePeer.toString() === to.peerId)
		.length;
}

/** Assert `from` currently holds at least one strand connection to `to`. */
function expectConnected(from: StrandMachine, to: StrandMachine, why: string): void {
	expect(strandConnectionsTo(from, to), `${from.label} should hold a strand connection to ${to.label} — ${why}`)
		.toBeGreaterThan(0);
}

/** Assert `from` currently holds NO strand connection to `to`. */
function expectCut(from: StrandMachine, to: StrandMachine, why: string): void {
	expect(strandConnectionsTo(from, to), `${from.label} should hold NO strand connection to ${to.label} — ${why}`)
		.toBe(0);
}

/** Every `Strand.Member.Key` visible to one machine, via an UNFILTERED scan (header note). */
async function memberKeys(db: Database): Promise<string[]> {
	const keys: string[] = [];
	for await (const row of db.eval('select Key from Strand.Member')) {
		keys.push(row.Key as string);
	}
	return keys;
}

/** Every `Strand.MemberPeer` binding visible to one machine, as `MemberKey|PeerId` strings
 *  — the pairing is the claim (which party a machine belongs to), never the peer id alone. */
async function memberPeerBindings(db: Database): Promise<string[]> {
	const bindings: string[] = [];
	for await (const row of db.eval('select MemberKey, PeerId from Strand.MemberPeer')) {
		bindings.push(`${row.MemberKey as string}|${row.PeerId as string}`);
	}
	return bindings;
}

/** The `MemberKey|PeerId` string a binding of `machine` to `memberKey` would appear as. */
function binding(memberKey: string, machine: StrandMachine): string {
	return `${memberKey}|${machine.peerId}`;
}

/** Every `App.Data` row, scanned and filtered in JavaScript — `Key` is the single-column
 *  primary key, so an equality on it is the point lookup the header warns about, and a
 *  miss inside a negative assertion would pass it for the wrong reason. */
async function dataValue(db: Database, key: string): Promise<string | undefined> {
	for await (const row of db.eval('select Key, Val from App.Data')) {
		if (row.Key === key) return row.Val as string;
	}
	return undefined;
}

/** Gate: `key` becomes visible on `machine` with the expected value. */
async function awaitRowVisible(machine: StrandMachine, key: string, val: string): Promise<void> {
	await waitUntil(
		async () => (await dataValue(machine.db, key)) === val,
		{ ...GATE, description: `App.Data '${key}' becomes visible on ${machine.label}` },
	);
}

/**
 * Assert `machine` NEVER converges on `key` within {@link NO_CONVERGENCE_BUDGET_MS}.
 *
 * `waitUntil` rejects on expiry, so the absence is asserted as a rejection rather than by
 * sleeping and peeking — and it retries through a throwing read, so a machine whose read
 * FAILS because it can no longer reach a coordinator counts as not-converged too. Both are
 * the cut; the header says why that conflation is intended here.
 */
async function expectNeverConverges(machine: StrandMachine, key: string, val: string): Promise<void> {
	await expect(
		waitUntil(
			async () => (await dataValue(machine.db, key)) === val,
			{
				timeoutMs: NO_CONVERGENCE_BUDGET_MS, intervalMs: 250,
				description: `App.Data '${key}' to reach the CUT machine ${machine.label} (it must not)`,
			},
		),
		`${machine.label} is cut off and must not converge on '${key}'`,
	).rejects.toThrow(/Timeout waiting/);
}

/**
 * Whether the row is already there despite the insert having reported failure — asked on
 * the AUTHOR's own database, so it makes no physical claim about any other machine. A read
 * that ITSELF fails answers "not known to have landed" rather than propagating (a throw
 * here would replace the insert error the caller needs to see), and is LOGGED rather than
 * swallowed silently.
 */
async function rowLanded(machine: StrandMachine, key: string, val: string): Promise<boolean> {
	try {
		return (await dataValue(machine.db, key)) === val;
	} catch (readError) {
		console.warn(`[removal-formation] ${machine.label}: read-back of '${key}' after a failed insert also failed: ${String(readError)}`);
		return false;
	}
}

/**
 * Insert with a bounded retry, for the post-cut write only — the retry is LOAD-BEARING
 * rather than defensive here: the first attempts after a cut reliably fail while the
 * cohort still lists the removed party's unreachable machines (see
 * {@link REMAINING_COHORT_WRITE_BUDGET_MS}). Exceeding `budgetMs` is the genuine "the
 * remaining cohort can no longer commit" regression; a handful of failures before a commit
 * is the expected shape.
 */
async function insertWithRetry(machine: StrandMachine, key: string, val: string, budgetMs: number): Promise<void> {
	const start = Date.now();
	for (let attempt = 1; ; attempt++) {
		try {
			await machine.db.exec('insert into App.Data (Key, Val) values (?, ?)', [key, val]);
			console.log(`[removal-formation] ${machine.label}: committed '${key}' on attempt ${attempt} after ${Date.now() - start}ms`);
			return;
		} catch (error) {
			if (await rowLanded(machine, key, val)) {
				console.log(`[removal-formation] ${machine.label}: attempt ${attempt} reported failure but '${key}' landed`);
				return;
			}
			if (Date.now() - start > budgetMs) {
				throw new Error(
					`[removal-formation] ${machine.label}: the REMAINING cohort could not commit '${key}' within ${budgetMs}ms `
					+ `(${attempt} attempt(s)); last error: ${String(error)}`,
					{ cause: error });
			}
			console.warn(`[removal-formation] ${machine.label}: attempt ${attempt} failed, retrying: ${String(error)}`);
			await sleep(1_000);
		}
	}
}

// ═════════════════════════════════════════════════════════════════════════════
// Bring-up
// ═════════════════════════════════════════════════════════════════════════════

/** The per-machine knobs every machine in this file runs with — see the header's timing
 *  note for why the two loops are configured at opposite ends. */
const MACHINE_SPEC = {
	revocationPollMs: SUSPENDED_POLL_MS,
	membershipReconciliation: { pollIntervalMs: RECONCILE_POLL_MS },
} as const;

/**
 * Turn a started `CadreNode` into a formation RESPONDER — the production wiring a host app
 * does. The DB-backed usage recorder is what resolves a bound invitation to its host
 * strand, holds the connection gate's outstanding-invitation carve-out open for a
 * stranger's dial, and records the consent; `initializeStrandSolicitation` force-wires the
 * strand-addr disclosure and the membership-invitation issuer behind it.
 */
function armResponder(host: CadreNode): void {
	host.initializeStrandSolicitation({
		formationUsageRecorder: new ControlFormationUsageRecorder(host.getControlDatabase()!),
	});
}

/** Mint a fresh open invitation and publish it BOUND to `strandId`, the reference apps'
 *  release flow: redeeming it records consent against the existing host strand rather than
 *  minting a new one — which is what makes the responder issue a membership invitation. */
async function publishBoundInvitation(host: CadreNode, strandId: string): Promise<OpenInvitation> {
	const invitation = await host.createOpenInvitation(SAPP_ID, INVITATION_TTL_MS);
	await host.publishFormationInvite(invitation.token, SAPP_ID, {
		strandId,
		expiresAtMs: Date.now() + INVITATION_TTL_MS,
		totalUses: 1,
	});
	return invitation;
}

/**
 * Redeem `invitation`, retrying the whole handshake while the responder rejects it with
 * the retryable {@link MEMBERSHIP_INVITE_UNAVAILABLE_REASON}.
 *
 * MEASURED, not defensive: issuing the joiner's membership invitation is a WRITE into the
 * host strand, so a redemption attempted just after a removal hits the same post-cut
 * wobble {@link REMAINING_COHORT_WRITE_BUDGET_MS} documents — the cohort still lists the
 * removed party's unreachable machines and the insert cannot commit until it downsizes.
 * The runtime is built for exactly this: the responder issues BEFORE it records consent,
 * so this rejection leaves the one-time token unspent and the same invitation can be
 * redeemed again. Any OTHER rejection propagates immediately — only this one is a retry.
 */
async function formStrandWithRetry(
	joiner: CadreNode, invitation: OpenInvitation, purpose: string, budgetMs: number
): Promise<FormStrandResult> {
	const start = Date.now();
	for (let attempt = 1; ; attempt++) {
		try {
			const result = await joiner.formStrand(invitation, {
				partyId: joiner.peerId!.toString(),
				purpose,
			});
			if (attempt > 1) {
				console.log(`[removal-formation] formation '${purpose}' succeeded on attempt ${attempt} after ${Date.now() - start}ms`);
			}
			return result;
		} catch (error) {
			if (!String(error).includes(MEMBERSHIP_INVITE_UNAVAILABLE_REASON)) throw error;
			if (Date.now() - start > budgetMs) {
				throw new Error(
					`[removal-formation] formation '${purpose}' never got past the retryable `
					+ `"${MEMBERSHIP_INVITE_UNAVAILABLE_REASON}" rejection within ${budgetMs}ms (${attempt} attempt(s))`,
					{ cause: error });
			}
			console.warn(`[removal-formation] formation '${purpose}' attempt ${attempt} was told to retry; retrying`);
			await sleep(1_000);
		}
	}
}

/** The party's own membership identity key for this strand, once its `StrandPartyKey`
 *  control row is visible on `machine` — the row the founder's publish mints and a
 *  joiner's `formStrand` persists, and the key every machine of the party signs its
 *  membership writes with. Gated rather than read once: on a non-founding machine it
 *  arrives by control-network replication. */
async function awaitPartyKey(machine: TopologyMachine, strandId: string, label: string): Promise<string> {
	let key: string | null = null;
	await waitUntil(
		async () => {
			key = await machine.node.getControlDatabase()!.queryStrandPartyKey(strandId);
			return key !== null;
		},
		{ ...GATE, description: `${label}: the party's own StrandPartyKey row for ${strandId} becomes visible` },
	);
	return key!;
}

/** The published `Strand` row for `strandId` once it is visible in `machine`'s own control
 *  database — how a party's non-founding machine learns a strand it belongs to, including
 *  the shared read key it must attach with. */
async function awaitPublishedStrandRow(machine: TopologyMachine, strandId: string, label: string): Promise<StrandRow> {
	let row: StrandRow | null = null;
	await waitUntil(
		async () => {
			row = await machine.node.getControlDatabase()!.queryStrand(strandId);
			return row !== null;
		},
		{ ...GATE, description: `${label}: the published Strand row for ${strandId} reaches this machine` },
	);
	return row!;
}

/**
 * Wire every remaining strand pair directly and barrier each node's cohort.
 *
 * Deliberately explicit: cross-party strand DISCOVERY has exactly one automatic path (the
 * addresses formation carries back, which seed only the pair that redeemed — asserted
 * separately in test 1) and `strand-formation-cross-party-seed` is where that path is the
 * subject. Here the mesh is a precondition, so it is dialed rather than waited on.
 * Already-connected pairs are skipped, so the seeded auto-dial is not re-driven.
 */
async function meshStrandNodes(machines: ReadonlyArray<StrandMachine>): Promise<void> {
	for (let i = 0; i < machines.length; i++) {
		for (let j = i + 1; j < machines.length; j++) {
			const dialer = machines[j]!;
			const target = machines[i]!;
			if (strandConnectionsTo(dialer, target) > 0) continue;
			await connectStrandNodes(dialer.libp2p, dialer.label, target.libp2p, target.label, MESH_TIMEOUT_MS);
		}
	}
	// Capped at the strand breadth: a write is offered to at most
	// DEFAULT_STRAND_CLUSTER_SIZE peers however many machines exist.
	const want = Math.min(machines.length, DEFAULT_STRAND_CLUSTER_SIZE);
	for (const machine of machines) {
		await waitForCohortOn(machine.libp2p, want, {
			timeoutMs: MESH_TIMEOUT_MS,
			label: `strand cohort on ${machine.label}`,
		});
	}
}

/** Gate `observers` on seeing every binding in `expected`. The deny set is derived from
 *  these rows, so a machine that cannot see a binding cannot deny the machine it names —
 *  gating here is what makes a later cut mean "chose to" rather than "had nothing to go on". */
async function awaitBindingsVisible(
	observers: ReadonlyArray<StrandMachine>, expected: ReadonlyArray<string>
): Promise<void> {
	for (const observer of observers) {
		await waitUntil(
			async () => {
				const visible = await memberPeerBindings(observer.db);
				return expected.every((b) => visible.includes(b));
			},
			{ ...GATE, description: `all ${expected.length} MemberPeer bindings become visible on ${observer.label}` },
		);
	}
}

/** Gate `observer` on seeing `memberKey` seated as a `Strand.Member`. */
async function awaitMemberSeated(observer: StrandMachine, memberKey: string, whose: string): Promise<void> {
	await waitUntil(
		async () => (await memberKeys(observer.db)).includes(memberKey),
		{ ...GATE, description: `${whose}'s Member row becomes visible on ${observer.label}` },
	);
}

// ═════════════════════════════════════════════════════════════════════════════

describe('Removal cuts a party that joined through the real formation handshake', () => {
	it('seats and binds a second party by itself, then cuts both of its machines when it is removed', async () => {
		let topology: Topology | undefined;
		try {
			// ── Bring-up: two independent parties, two machines each ────────────────
			// The parties share no control network (that is what makes them parties),
			// so everything the joiner learns about the strand comes over the formation
			// handshake below.
			const bootStart = Date.now();
			topology = await bootTopology({
				tag: 'removal-formation',
				genesis: 'genesis-first',
				controlMesh: 'full',
				parties: [
					{ name: 'host', machines: [{ ...MACHINE_SPEC }, { ...MACHINE_SPEC }] },
					{ name: 'join', machines: [{ ...MACHINE_SPEC }, { ...MACHINE_SPEC }] },
				],
			});
			const hostOwner = topology.machine('host', 0);
			const hostSecond = topology.machine('host', 1);
			const joinOwner = topology.machine('join', 0);
			const joinSecond = topology.machine('join', 1);
			console.log(`[removal-formation] two 2-machine parties booted in ${Date.now() - bootStart}ms`);

			const strandId = `strand-removal-formation-${Date.now()}`;
			const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '1.0.0');

			// ── The host founds a CLOSED strand and becomes a formation responder ────
			// `foundStrand` publishes the row cadre-wide AND attaches as founder: the
			// publish mints this party's own membership identity (StrandPartyKey), and
			// the founder bootstrap seats it as the strand's first Member and Manager.
			armResponder(hostOwner.node);
			const founded = await hostOwner.node.foundStrand({
				strandId,
				type: 'c',
				memberPrivateKey: await generateStrandMemberKey(),
				sAppConfig: sApp,
			});
			expect(founded.founded).toBe(true);
			const host0 = strandMachine('host[0]', hostOwner.node, founded.instance);

			const hostPartyKey = await awaitPartyKey(hostOwner, strandId, 'host[0]');
			const founderKeyPair = strandMemberKeyPair(hostPartyKey);

			// The strand's shared read key — a strand-wide secret, deliberately NOT
			// anyone's identity. Read back off the published row so every later attach
			// uses the key that actually landed.
			const publishedRow = founded.strandRow;
			expect(publishedRow.MemberPrivateKey).toBeTruthy();
			const readKeyIdentity = strandMemberKeyPair(publishedRow.MemberPrivateKey!).publicKeyB64;

			// ── The host's SECOND machine joins the strand its party published ───────
			// The row and the party identity both reach it over the party's own control
			// network; nothing about this machine is hand-fed.
			await awaitPartyKey(hostSecond, strandId, 'host[1]');
			const hostSecondRow = await awaitPublishedStrandRow(hostSecond, strandId, 'host[1]');
			expect(hostSecondRow.MemberPrivateKey).toBe(publishedRow.MemberPrivateKey);
			const host1 = strandMachine(
				'host[1]', hostSecond.node,
				await hostSecond.node.addStrand({ strandRow: hostSecondRow, sAppConfig: sApp }));

			// ── The joiner redeems a BOUND invitation over the real handshake ────────
			const invitation = await publishBoundInvitation(hostOwner.node, strandId);
			const formResult = await joinOwner.node.formStrand(invitation, {
				partyId: joinOwner.node.peerId!.toString(),
				purpose: 'party removal via formation, end to end',
			});
			expect(formResult.strandId).toBe(strandId);
			// The three things a closed bound redemption hands back, none of which the
			// test supplied: the strand's read key, this party's own single-use
			// membership invitation, and the host's live strand-network addresses.
			expect(formResult.memberPrivateKey).toBe(publishedRow.MemberPrivateKey);
			expect(formResult.membershipInvite).toBeDefined();
			expect(formResult.strandAddrs.length).toBeGreaterThan(0);
			expect(joinOwner.node.getPendingMembershipInvite(strandId)).toEqual(formResult.membershipInvite);

			// The joiner's node minted and persisted its OWN party identity while
			// adopting the invitation — distinct from the founder's, and distinct from
			// the shared read key.
			const joinPartyKey = await awaitPartyKey(joinOwner, strandId, 'join[0]');
			const joinerMemberKey = strandMemberKeyPair(joinPartyKey).publicKeyB64;
			const founderMemberKey = founderKeyPair.publicKeyB64;
			expect(joinerMemberKey).not.toBe(founderMemberKey);
			expect(joinerMemberKey).not.toBe(readKeyIdentity);
			expect(founderMemberKey).not.toBe(readKeyIdentity);

			// ── Both of the joiner's machines stand the strand up ───────────────────
			// Machine 0 attaches on the formation result. Machine 1 gets the row the
			// ordinary way for a party's second machine — its owner publishes it into
			// the party's own control database, and the sibling reads it back.
			const join0 = strandMachine(
				'join[0]', joinOwner.node,
				await joinOwner.node.addStrand({
					strandRow: {
						Id: strandId,
						MemberPrivateKey: formResult.memberPrivateKey!,
						Type: 'c',
						FounderOwnerKey: null,
					},
					sAppConfig: sApp,
				}));

			// The one discovery claim this file makes: the addresses formation carried
			// back are a working seed, so machine 0 reaches the host with no dial here.
			await waitUntil(
				() => strandConnectionsTo(join0, host0) > 0,
				{ ...GATE, description: "join[0]'s strand node auto-dials host[0] from the formation seed" },
			);

			await joinOwner.node.publishStrand(strandId, 'c', formResult.memberPrivateKey!);
			const joinSecondRow = await awaitPublishedStrandRow(joinSecond, strandId, 'join[1]');
			await awaitPartyKey(joinSecond, strandId, 'join[1]');
			const join1 = strandMachine(
				'join[1]', joinSecond.node,
				await joinSecond.node.addStrand({ strandRow: joinSecondRow, sAppConfig: sApp }));

			const all = [host0, host1, join0, join1];
			await meshStrandNodes(all);

			// ── The membership the pipeline wrote by itself ──────────────────────────
			// Two distinct parties, four machines, and not one `issueInvite`,
			// `consumeInvite` or `registerMemberPeer` call anywhere in this file.
			await awaitMemberSeated(host0, joinerMemberKey, 'the joining party');
			for (const machine of all) {
				await waitUntil(
					async () => {
						const keys = await memberKeys(machine.db);
						return keys.includes(founderMemberKey) && keys.includes(joinerMemberKey);
					},
					{ ...GATE, description: `both parties' Member rows become visible on ${machine.label}` },
				);
				expect(new Set(await memberKeys(machine.db)))
					.toEqual(new Set([founderMemberKey, joinerMemberKey]));
			}

			const expectedBindings = [
				binding(founderMemberKey, host0), binding(founderMemberKey, host1),
				binding(joinerMemberKey, join0), binding(joinerMemberKey, join1),
			];
			await awaitBindingsVisible(all, expectedBindings);
			// Exactly four, on the founder's replica: each machine bound ITSELF once,
			// under its own party's key — no machine bound another's, and nothing is
			// left over from a bring-up retry.
			expect(new Set(await memberPeerBindings(host0.db))).toEqual(new Set(expectedBindings));

			// The spent invitation is un-staged on the joiner. The reconciler owns that
			// invalidation and clears the entry only once the invitation is settled, so
			// its disappearance is what confirms the redemption happened.
			await waitUntil(
				() => joinOwner.node.getPendingMembershipInvite(strandId) === undefined,
				{ ...GATE, description: "join[0]'s staged membership invitation is cleared once redeemed" },
			);

			// ── A row written before the removal, readable by everyone ──────────────
			// The baseline both negative assertions below are measured against: the
			// removed party could read the strand until it was removed.
			await host0.db.exec('insert into App.Data (Key, Val) values (?, ?)', ['before-removal', 'everyone can read this']);
			for (const machine of [host1, join0, join1]) {
				await awaitRowVisible(machine, 'before-removal', 'everyone can read this');
			}

			// ── The connections exist BEFORE the revocation ─────────────────────────
			for (const remaining of [host0, host1]) {
				for (const removed of [join0, join1]) {
					expectConnected(remaining, removed, 'the strand mesh was wired at bring-up');
				}
			}

			// ── The removal ─────────────────────────────────────────────────────────
			// The one membership write this test makes, with the founding party's own
			// keypair — the app-facing action removal deliberately leaves to the caller.
			await revokeMember(host0.db, { managerKeyPair: founderKeyPair, memberKey: joinerMemberKey });
			expect(await memberKeys(host0.db)).toEqual([founderMemberKey]);

			// The joiner's device records SURVIVE the removal and are now orphans — a
			// binding whose member is gone. That orphaning IS the denial: nothing the
			// test wrote, and nothing the removal cleaned up.
			expect(new Set(await memberPeerBindings(host0.db))).toEqual(new Set(expectedBindings));

			// Awaiting the refresh resolves only once the sweep has run, so the cut is
			// synchronous from the caller's point of view.
			await host0.node.refreshRevocationEnforcement(strandId);
			expectCut(host0, join0, 'host[0] refreshed after the revocation and swept the removed party');
			expectCut(host0, join1, "host[0] swept the removed party's SECOND machine in the same pass");

			// Then the removal reaches the host's other machine. Gate on host[1]'s OWN
			// view first: the point is that it cuts once it holds the tombstone, not that
			// a refresh call cuts regardless of what it can see.
			await waitUntil(
				async () => !(await memberKeys(host1.db)).includes(joinerMemberKey),
				{ ...GATE, description: "the removal becomes visible in host[1]'s own database" },
			);
			await host1.node.refreshRevocationEnforcement(strandId);
			expectCut(host1, join0, 'host[1] has now seen the removal and swept it');
			expectCut(host1, join1, "host[1] swept the removed party's second machine too");

			// ── The remaining cohort still commits, and the cut party cannot follow ──
			// The write is the control for both negative assertions: if the strand had
			// stalled, this commit or host[1]'s read of it fails and says so, instead of
			// a stall being reported as a successful cut.
			const cutKey = 'after-removal';
			await insertWithRetry(host0, cutKey, 'written by the remaining party', REMAINING_COHORT_WRITE_BUDGET_MS);
			await awaitRowVisible(host1, cutKey, 'written by the remaining party');
			await expectNeverConverges(join0, cutKey, 'written by the remaining party');
			await expectNeverConverges(join1, cutKey, 'written by the remaining party');

			// ── …and cannot push anything back (gotchoices/sereus#4) ────────────────
			// Two outcomes are legitimate and both are the cut: the removed party's write
			// may fail outright (its remaining reachable peers are its own two machines,
			// below the strand's commit bar) or commit only among themselves. What
			// matters either way is that it never reaches the remaining party — asserted
			// regardless of which happened, with the shape logged for a future reader.
			const pushKey = 'pushed-by-removed-party';
			let pushError: unknown;
			try {
				await join0.db.exec('insert into App.Data (Key, Val) values (?, ?)', [pushKey, 'from the removed party']);
			} catch (error) {
				pushError = error;
			}
			console.log(
				`[removal-formation] removed party's post-cut write ${pushError === undefined ? 'committed locally' : 'failed'}`
				+ `${pushError === undefined ? '' : `: ${String(pushError)}`}`
				+ `; readable back on ${join0.label}: ${await rowLanded(join0, pushKey, 'from the removed party')}`,
			);
			await expectNeverConverges(host0, pushKey, 'from the removed party');
			await expectNeverConverges(host1, pushKey, 'from the removed party');

			// The sessions are still down after all of that — a re-dial by the removed
			// party is refused by the connection gate, not merely swept once.
			for (const remaining of [host0, host1]) {
				for (const removed of [join0, join1]) {
					expectCut(remaining, removed, 'the gate refuses the removed party for as long as it is revoked');
				}
			}

			// ── LAST: the removed party's own machines also stop talking to each other ──
			// Not a side note — a consequence an app has to know about. The deny set is
			// every binding with no live member behind it, minus this node's own peer id,
			// so once removed, each of a party's machines sees its SIBLING's binding as an
			// orphan and refuses it. On a production poll cadence that happens by itself
			// within one interval; here the poll is suspended (header), so the refresh is
			// driven explicitly and the cut is attributable to it. Run last, because it
			// takes the removed party's own local mesh apart.
			expectConnected(join0, join1, "the removed party's machines were still talking to each other");
			await join0.node.refreshRevocationEnforcement(strandId);
			expectCut(join0, join1, 'a removed machine denies its OWN sibling — its binding is orphaned too');
		} finally {
			await topology?.stop();
		}
	}, JOURNEY_TEST_TIMEOUT_MS);

	it('re-forms after removal but cannot re-seat itself, and heals only when a manager re-admits it', async () => {
		let topology: Topology | undefined;
		try {
			// The host keeps TWO machines and the joiner one. The host's second machine is
			// required: every step after the cut writes into the host strand — the
			// re-issued membership invitation, the manager's re-admission, the closing
			// read-back — and a lone remaining machine has no cohort left to commit
			// against once the removed party's machine is denied.
			topology = await bootTopology({
				tag: 'removal-rejoin',
				genesis: 'genesis-first',
				controlMesh: 'full',
				parties: [
					{ name: 'host', machines: [{ ...MACHINE_SPEC }, { ...MACHINE_SPEC }] },
					{ name: 'join', machines: [{ ...MACHINE_SPEC }] },
				],
			});
			const hostOwner = topology.machine('host', 0);
			const hostSecond = topology.machine('host', 1);
			const joinOwner = topology.machine('join', 0);

			const strandId = `strand-removal-rejoin-${Date.now()}`;
			const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '1.0.0');

			armResponder(hostOwner.node);
			const founded = await hostOwner.node.foundStrand({
				strandId,
				type: 'c',
				memberPrivateKey: await generateStrandMemberKey(),
				sAppConfig: sApp,
			});
			const host0 = strandMachine('host[0]', hostOwner.node, founded.instance);
			const founderKeyPair = strandMemberKeyPair(await awaitPartyKey(hostOwner, strandId, 'host[0]'));

			await awaitPartyKey(hostSecond, strandId, 'host[1]');
			const host1 = strandMachine(
				'host[1]', hostSecond.node,
				await hostSecond.node.addStrand({
					strandRow: await awaitPublishedStrandRow(hostSecond, strandId, 'host[1]'),
					sAppConfig: sApp,
				}));

			// ── First formation: the joiner belongs, written entirely by the runtime ──
			const firstInvitation = await publishBoundInvitation(hostOwner.node, strandId);
			const firstForm = await joinOwner.node.formStrand(firstInvitation, {
				partyId: joinOwner.node.peerId!.toString(),
				purpose: 'first join',
			});
			expect(firstForm.membershipInvite).toBeDefined();
			const joinPartyKey = await awaitPartyKey(joinOwner, strandId, 'join[0]');
			const joinerMemberKey = strandMemberKeyPair(joinPartyKey).publicKeyB64;

			const join0 = strandMachine(
				'join[0]', joinOwner.node,
				await joinOwner.node.addStrand({
					strandRow: {
						Id: strandId, MemberPrivateKey: firstForm.memberPrivateKey!, Type: 'c', FounderOwnerKey: null,
					},
					sAppConfig: sApp,
				}));
			await meshStrandNodes([host0, host1, join0]);

			await awaitMemberSeated(host0, joinerMemberKey, 'the joining party');
			await awaitBindingsVisible([host0, host1], [binding(joinerMemberKey, join0)]);
			expectConnected(host0, join0, 'the two parties meshed before the removal');

			// ── The removal, and the cut on BOTH of the host's machines ──────────────
			await revokeMember(host0.db, { managerKeyPair: founderKeyPair, memberKey: joinerMemberKey });
			await host0.node.refreshRevocationEnforcement(strandId);
			await waitUntil(
				async () => !(await memberKeys(host1.db)).includes(joinerMemberKey),
				{ ...GATE, description: "the removal becomes visible in host[1]'s own database" },
			);
			await host1.node.refreshRevocationEnforcement(strandId);
			expectCut(host0, join0, 'the founder swept the removed party after refreshing');
			expectCut(host1, join0, "the host's second machine swept it too");

			// ── A fresh formation still succeeds — on the CONTROL network ────────────
			// Strand revocation gates the strand's own libp2p node; the formation
			// handshake runs between the two parties' CONTROL nodes, which it never
			// touches. So the host can invite the removed party back and the removed
			// party can redeem. (The retry is the post-cut write wobble, not the
			// revocation: issuing the invitation is itself a strand write — see
			// {@link formStrandWithRetry}.)
			const secondInvitation = await publishBoundInvitation(hostOwner.node, strandId);
			const secondForm = await formStrandWithRetry(
				joinOwner.node, secondInvitation, 're-join after removal', REMAINING_COHORT_WRITE_BUDGET_MS);
			expect(secondForm.strandId).toBe(strandId);
			expect(secondForm.membershipInvite).toBeDefined();
			expect(secondForm.membershipInvite).not.toEqual(firstForm.membershipInvite);
			// The party's identity is REUSED, not re-minted: `formStrand` adopts the
			// stored `StrandPartyKey` row, so a re-admitted party is the same member key
			// its leftover device record already names.
			expect(await joinOwner.node.getControlDatabase()!.queryStrandPartyKey(strandId)).toBe(joinPartyKey);
			expect(joinOwner.node.getPendingMembershipInvite(strandId)).toEqual(secondForm.membershipInvite);

			// ── …but the invitation cannot be spent while the party is cut off ───────
			// Seating a `Strand.Member` row is a STRAND write, and the machines that
			// would have to carry it are precisely the ones being denied — the removed
			// party cannot even see the `Strand.Invite` row the responder just issued.
			// So a fresh formation alone does NOT re-admit anyone; it only re-arms the
			// joiner side. Bounded, and paired with the positive claim below on the same
			// fixture: a strand that had merely stalled would fail that instead of
			// passing this.
			await sleep(NO_SELF_READMISSION_BUDGET_MS);
			expect(await memberKeys(host0.db)).not.toContain(joinerMemberKey);
			expectCut(host0, join0, 'a fresh formation changes nothing on the strand plane');

			// ── The re-admission a remaining manager authors DOES heal it ────────────
			// The manager seats the member key directly on its own replica, so the heal
			// never depends on talking to the party being denied. The removed party's
			// device record — never deleted, and still exactly where the reconciler wrote
			// it — stops being an orphan the moment the member row is back, which is what
			// takes its machine out of both host machines' deny sets.
			await addMemberByManager(host0.db, { managerKeyPair: founderKeyPair, memberKey: joinerMemberKey });
			expect(await memberKeys(host0.db)).toContain(joinerMemberKey);
			await awaitMemberSeated(host1, joinerMemberKey, 'the re-admitted party');
			await host0.node.refreshRevocationEnforcement(strandId);
			await host1.node.refreshRevocationEnforcement(strandId);

			// Reachable again: the gate no longer refuses the dial, and a row the host
			// writes after the re-admission reaches the re-admitted party.
			await connectStrandNodes(join0.libp2p, join0.label, host0.libp2p, host0.label, MESH_TIMEOUT_MS);
			await insertWithRetry(host0, 'after-readmission', 'welcome back', REMAINING_COHORT_WRITE_BUDGET_MS);
			await awaitRowVisible(join0, 'after-readmission', 'welcome back');
		} finally {
			await topology?.stop();
		}
	}, REJOIN_TEST_TIMEOUT_MS);
});
