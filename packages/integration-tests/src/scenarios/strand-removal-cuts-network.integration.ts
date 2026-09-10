/**
 * Removal cuts the network, proved on a real strand.
 *
 * The capstone for the plan `removal-must-cut-the-network-not-just-the-row`, whose two
 * implementation tickets landed the per-strand revoked-peer gate
 * (`strand-revocation-enforcer.ts` — refuses new connections, streams, dials and relay
 * reservations from a removed party's machines) and the teardown sweep (hangs up the
 * sessions the removed party already holds, and signals a node that IT was the one
 * removed). Both were asserted at unit level against stubs. This file asserts the same
 * claims against REAL libp2p nodes, real strand databases and real replication, because
 * the product promise an app author has to word — "remove this member and their devices
 * stop being talked to" — is a network claim, not a row claim.
 *
 * THREE independent tests, each with its own topology:
 *
 *   1. **The cut** (2 parties × 2 machines, closed strand). Party B is removed and both
 *      of its machines are hung up by the remaining party's machine that was told, while
 *      the machine that was NOT told keeps serving them — the documented fail-open
 *      direction, asserted deliberately rather than tolerated. Then the second remaining
 *      machine is told, and after that: the remaining cohort still commits, its write is
 *      visible to the other remaining machine, and the removed party can neither see it
 *      nor push anything back.
 *   2. **The removed node is told** (2 parties × 1 machine). The removed party's node
 *      learns from its OWN poll — no explicit refresh call anywhere — that it was
 *      removed, and nothing is torn down on its behalf. This is the only test that
 *      exercises the interval-driven route; test 1 drives every cut explicitly.
 *   3. **An open strand is untouched** (2 parties × 1 machine, one open strand and one
 *      closed strand across the same two nodes). A removal on the closed strand leaves
 *      the open strand's connection and its stranger's writes alone.
 *
 * ── HOW TIMING IS CONTROLLED (read before changing a poll value) ──────────────
 * The deny set refreshes on an interval (`DEFAULT_REVOCATION_POLL_INTERVAL_MS`, 30 s)
 * and on demand via `CadreNode.refreshRevocationEnforcement(strandId)`. Sleeping out a
 * 30 s interval would make every assertion here slow AND racy, so each machine's cadence
 * is set explicitly through the harness's `revocationPollMs`:
 *
 *   • {@link SUSPENDED_POLL_MS} — longer than any test — means the machine never
 *     refreshes on its own after its one refresh at strand start (which sees an empty
 *     deny set, because no member has been removed yet). Every later cut that machine
 *     makes is therefore one the test drove with an awaited
 *     `refreshRevocationEnforcement`, and "this machine has not cut anything yet" is a
 *     fact rather than a hope. Test 1 and test 3 run entirely this way.
 *   • A SHORT poll (test 2's removed node) exercises the interval route, which is what
 *     an app that never calls `refreshRevocationEnforcement` actually gets.
 *
 * ── FIXTURE HONESTY (the most important comment in this file) ─────────────────
 * These tests register `Strand.MemberPeer` rows EXPLICITLY, and production does not yet.
 * A `MemberPeer` row binds a member identity to one of its machines' strand peer ids,
 * and it is the record the deny set is derived from — a removed member's rows become
 * orphans (no live `Member` row), and orphaned rows ARE the denial. On a strand formed
 * the production way today, every party presents the same founding member identity and
 * no device rows are written at all, so the enforcement proved here is not yet reachable
 * from an app. Closing that is `feat-strand-party-identity`. Everything below is a proof
 * of the MACHINERY, on the inputs that machinery is specified against — not a claim that
 * an app can do this today. The registration sites repeat this in one line each.
 *
 * ── WHAT IS ASSERTED, AND HOW ────────────────────────────────────────────────
 * Connection claims read the strand libp2p node's own `getConnections()` — the same
 * surface the sweep hangs up through — filtered to a named remote peer id, never a bare
 * connection count, so an unrelated peer coming or going cannot move an assertion.
 *
 * A cut is asserted in BOTH directions of evidence, because either alone is weak:
 * the connection that existed BEFORE the revocation is gone AFTER it (teardown, not
 * merely "a future dial would fail"), and the removed party then fails to converge on a
 * row the remaining cohort commits — bounded by {@link NO_CONVERGENCE_BUDGET_MS} — while
 * a control read of that same row on the other REMAINING machine succeeds. A silent
 * failure to observe something is not evidence on its own; the paired control read is
 * what turns it into evidence.
 *
 * `waitUntil` swallows a throwing condition and retries, so a gate whose read ERRORS on
 * every attempt reports a plain timeout, indistinguishable from rows that never arrived.
 * That cuts both ways here: it is why a positive gate timing out needs the harness debug
 * log (`Wait condition threw: …`) checked before being called a convergence defect, and
 * it is why the negative assertions are stated as "the removed party does not converge",
 * which is true whether its read failed or simply never saw the row. Both are the cut.
 *
 * Lookup shape (inherited from `strand-membership-closed-strand-e2e.integration.ts`): a
 * where-equality on a full primary key is served by the optimystic module as a point
 * lookup that can MISS on a networked strand
 * (`debt-composite-pk-point-lookup-unreliable-untracked`). Every membership read here
 * scans and filters in JavaScript, which depends only on the scan returning a superset
 * of the live rows — and a miss inside a NEGATIVE assertion would pass it for the wrong
 * reason, which is the worst failure mode available in this file.
 *
 * ── KNOWN GAP, deliberately not covered here ─────────────────────────────────
 * Every connection under test is DIRECT. A removed party reached over a `/p2p-circuit`
 * is the strongest form of test 1 — `hangUp` is documented to close relayed connections
 * and to drop the relay reservation riding them, and that is still asserted only against
 * a stub. Staging it needs the relay-only two-party fixture
 * (`blind-relay-phone-to-phone-e2e.integration.ts`: a dedicated relay, `listenAddrs: []`
 * on both ends, a bound invitation and formation over the circuit), which is a whole
 * second topology rather than an option on this one. Tracked in this ticket's review
 * handoff; do not silently assume it is covered.
 */

import { describe, it, expect } from 'vitest';
import {
	generateStrandMemberKey,
	strandMemberKeyPair,
	issueInvite,
	consumeInvite,
	registerMemberPeer,
	revokeMember,
	type Ed25519KeyPair,
} from '@serfab/cadre-core';
import type { CadreNode, StrandInstance } from '@serfab/cadre-core';
import type { Database } from '@quereus/quereus';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import {
	bootTopology,
	joinStrandOn,
	createSignedSAppConfig,
	waitUntil,
	sleep,
	type Topology,
} from '../harness/index.js';

/** The one-table key/value sApp several strand scenarios already use. No RBAC: what is
 *  under test is whether a write REACHES a machine, not who was allowed to author it. */
const SIMPLE_SCHEMA = `
table Data (
    Key text primary key,
    Val text
);
`;

/**
 * A revocation poll interval longer than any test in this file, which is how a machine
 * is held to exactly the refreshes the test asks for. See the timing note in the header:
 * the enforcer still refreshes once when the strand starts (empty deny set — nothing has
 * been removed yet), and never again on its own.
 */
const SUSPENDED_POLL_MS = 3_600_000;

/** Test 2's removed node: short enough to make the interval-driven cut observable. */
const INTERVAL_POLL_MS = 1_000;

/** The budget every POSITIVE convergence gate waits on. Sibling four-machine scenarios
 *  converge well under a second; this is headroom for slow hardware, not an expectation. */
const GATE = { timeoutMs: 60_000, intervalMs: 250 } as const;

/**
 * How long a cut-off machine is given to converge before "it never did" is asserted.
 *
 * This is the one budget whose SIZE is the claim: too short and a merely-slow strand
 * reads as a cut. Ten seconds is ~10× the measured cross-machine visibility latency on
 * this topology (sub-second in the sibling scenarios), and every negative assertion is
 * paired with a positive control read on a machine that is NOT cut, taken from the same
 * write — so a strand that had simply stalled fails the control read too and the test
 * reports that instead.
 *
 * NOTE: each negative assertion spends this budget in full, and the first test runs four
 * of them SEQUENTIALLY — ~40 s of its ~52 s wall clock is this wait. Fine at four; if a
 * scenario ever adds more negative arms, run them concurrently (they are read-only polls,
 * so unlike writes they do not block each other — see the never-`Promise.all`-writes note
 * in `convergence-stress.integration.ts`) rather than shortening the budget, which is the
 * claim itself.
 */
const NO_CONVERGENCE_BUDGET_MS = 10_000;

/**
 * Budget for the post-cut write by the remaining cohort.
 *
 * MEASURED, not hypothetical: on this fixture the first write after the cut FAILS several
 * times before it commits — three or four failed attempts with `BlockUnavailableError:
 * Block default/Data is unavailable (peers-unreachable)`, committing 3.5-4.3 s in, over
 * four runs.
 * The cohort still lists the removed party's machines, which are now unreachable (and
 * this node refuses to dial them), so the write cannot proceed until the cohort downsizes
 * to the live holders (`allowDownsize: true` in `STRAND_CLUSTER_POLICY`). It recovers on
 * its own, which is why {@link insertWithRetry} exists here and why the claim this test
 * makes is "the remaining cohort still commits", not "commits immediately".
 *
 * Exceeding THIS budget is the genuine "removal broke the remaining strand" failure — and
 * if it ever fails as `cluster-fetch:no-quorum` instead of recovering, that is the
 * upstream tripwire recorded at `tearDownRevoked` in `strand-revocation-enforcer.ts`, not
 * something to work around here.
 */
const REMAINING_COHORT_WRITE_BUDGET_MS = 90_000;

/** Explicit test timeouts, per `harness/topology.ts`'s TIME BUDGET rule of thumb (~10-15 s
 *  per libp2p node): test 1 runs 8 nodes, tests 2 and 3 run 4 and 6. Never touch
 *  `vitest.config.ts`. */
const CUT_TEST_TIMEOUT_MS = 420_000;
const SMALL_TEST_TIMEOUT_MS = 300_000;

/** A fresh, unrelated ed25519 keypair in the base64url shape the constraints consume. */
function freshKeyPair(): Ed25519KeyPair {
	const privateKeyB64 = generatePrivateKey('ed25519', 'base64url') as string;
	const publicKeyB64 = getPublicKey(privateKeyB64, 'ed25519', 'base64url', 'base64url') as string;
	return { privateKeyB64, publicKeyB64 };
}

/** One machine's strand-side handles, named so every failure message says which machine. */
interface StrandMachine {
	label: string;
	node: CadreNode;
	db: Database;
	/** This machine's STRAND transport peer id — what a `MemberPeer` row binds, and what
	 *  the deny set is keyed by. Distinct from its control-network peer id. */
	peerId: string;
	instance: StrandInstance;
	/** The strand's own libp2p node — captured once, so no call site re-asserts it is there. */
	libp2p: NonNullable<StrandInstance['libp2pNode']>;
}

/**
 * Pair a topology machine with its strand instance, throwing by name rather than letting
 * a launch regression surface as `Cannot read properties of undefined` several phases on.
 */
function strandMachine(label: string, node: CadreNode, instance: StrandInstance | undefined): StrandMachine {
	if (!instance?.database || !instance.libp2pNode) {
		throw new Error(`${label}: joinStrandOn returned no strand database/libp2p node (status '${instance?.status}')`);
	}
	return {
		label, node, instance,
		db: instance.database.getDatabase(),
		libp2p: instance.libp2pNode,
		peerId: instance.libp2pNode.peerId.toString(),
	};
}

/** Open connections `from`'s strand node holds to `to`'s strand peer id — the same
 *  surface the teardown sweep enumerates and hangs up through. */
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

/** Every `Strand.MemberPeer.PeerId` visible to one machine, via an UNFILTERED scan. */
async function memberPeerIds(db: Database): Promise<string[]> {
	const peerIds: string[] = [];
	for await (const row of db.eval('select PeerId from Strand.MemberPeer')) {
		peerIds.push(row.PeerId as string);
	}
	return peerIds;
}

/** Every `App.Data` row, via an UNFILTERED scan filtered in JavaScript — `Key` is the
 *  single-column primary key, so an equality on it is the point lookup the header warns
 *  about, and a miss inside a negative assertion would pass it for the wrong reason. */
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
 * FAILS because it can no longer reach a coordinator counts as not-converged too. Both
 * are the cut; the header says why that conflation is intended here.
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
 * the AUTHOR's own database, so it makes no physical claim about any other machine.
 *
 * A read that ITSELF fails answers "not known to have landed" rather than propagating: it
 * runs inside {@link insertWithRetry}'s catch, where a throw would replace the insert
 * error the caller needs to see. It is LOGGED rather than swallowed silently — on this
 * fixture the author is the one machine that must still be able to read, so a read error
 * here is worth seeing next to the insert errors around it.
 */
async function rowLanded(machine: StrandMachine, key: string, val: string): Promise<boolean> {
	try {
		return (await dataValue(machine.db, key)) === val;
	} catch (readError) {
		console.warn(`[removal-cut] ${machine.label}: read-back of '${key}' after a failed insert also failed: ${String(readError)}`);
		return false;
	}
}

/**
 * Insert with a bounded retry, for the post-cut write only — the same shape as the sibling
 * 2×2 scenario's helper, but here the retry is LOAD-BEARING rather than defensive: the
 * first attempts after a cut reliably fail while the cohort still lists the removed
 * party's unreachable machines (see {@link REMAINING_COHORT_WRITE_BUDGET_MS} for the
 * measurement). Exceeding `budgetMs` is the genuine "the remaining cohort can no longer
 * commit" regression; a handful of failures before a commit is the expected shape.
 */
async function insertWithRetry(machine: StrandMachine, key: string, val: string, budgetMs: number): Promise<void> {
	const start = Date.now();
	for (let attempt = 1; ; attempt++) {
		try {
			await machine.db.exec('insert into App.Data (Key, Val) values (?, ?)', [key, val]);
			console.log(`[removal-cut] ${machine.label}: committed '${key}' on attempt ${attempt} after ${Date.now() - start}ms`);
			return;
		} catch (error) {
			if (await rowLanded(machine, key, val)) {
				console.log(`[removal-cut] ${machine.label}: attempt ${attempt} reported failure but '${key}' landed`);
				return;
			}
			if (Date.now() - start > budgetMs) {
				throw new Error(
					`[removal-cut] ${machine.label}: the REMAINING cohort could not commit '${key}' within ${budgetMs}ms `
					+ `(${attempt} attempt(s)); last error: ${String(error)}`,
					{ cause: error });
			}
			console.warn(`[removal-cut] ${machine.label}: attempt ${attempt} failed, retrying: ${String(error)}`);
			await sleep(1_000);
		}
	}
}

/**
 * Admit a second party as its own strand member, through the real invite flow, authored
 * where a real joiner would author it: the founder issues, the JOINER consumes against
 * its own database. Returns the new member's keypair.
 */
async function admitSecondParty(
	founder: StrandMachine,
	founderKeyPair: Ed25519KeyPair,
	joiner: StrandMachine,
): Promise<Ed25519KeyPair> {
	const member = freshKeyPair();
	const { inviteKey, invitePrivateKey } = await issueInvite(founder.db, { managerKeyPair: founderKeyPair });
	await waitUntil(
		async () => {
			for await (const row of joiner.db.eval('select Key from Strand.Invite')) {
				if (row.Key === inviteKey) return true;
			}
			return false;
		},
		{ ...GATE, description: `the founder-issued invite becomes visible on ${joiner.label}` },
	);
	await consumeInvite(joiner.db, { inviteKey, invitePrivateKey, memberKey: member.publicKeyB64 });
	await waitUntil(
		async () => (await memberKeys(founder.db)).includes(member.publicKeyB64),
		{ ...GATE, description: `the joining party's Member row becomes visible on ${founder.label}` },
	);
	return member;
}

/**
 * Gate every machine in `observers` on seeing all of `peerIds` as `Strand.MemberPeer`
 * rows. The deny set is derived from these rows, so a machine that cannot see a binding
 * cannot deny the machine it names — gating here is what makes a later "did not cut"
 * assertion mean "chose not to" rather than "had nothing to go on".
 */
async function awaitBindingsVisible(observers: ReadonlyArray<StrandMachine>, peerIds: ReadonlyArray<string>): Promise<void> {
	for (const observer of observers) {
		await waitUntil(
			async () => {
				const visible = await memberPeerIds(observer.db);
				return peerIds.every((peerId) => visible.includes(peerId));
			},
			{ ...GATE, description: `all ${peerIds.length} MemberPeer bindings become visible on ${observer.label}` },
		);
	}
}

// ═════════════════════════════════════════════════════════════════════════════

describe('Removing a party cuts its machines off the strand', () => {
	it('hangs up every machine of the removed party, only on a machine that has seen the removal', async () => {
		let topology: Topology | undefined;
		try {
			// ── Bring-up: 2 parties × 2 machines, one closed strand across all four ──
			// Every machine's own revocation poll is suspended, so each cut below is
			// attributable to the ONE machine the test refreshed (header timing note).
			const bootStart = Date.now();
			topology = await bootTopology({
				tag: 'removal-cut',
				genesis: 'genesis-first',
				controlMesh: 'full',
				parties: [
					{ name: 'a', machines: [{ revocationPollMs: SUSPENDED_POLL_MS }, { revocationPollMs: SUSPENDED_POLL_MS }] },
					{ name: 'b', machines: [{ revocationPollMs: SUSPENDED_POLL_MS }, { revocationPollMs: SUSPENDED_POLL_MS }] },
				],
			});
			const strandId = `strand-removal-cut-${Date.now()}`;
			const memberPrivateKey = await generateStrandMemberKey();
			const founderKeyPair = strandMemberKeyPair(memberPrivateKey);
			const instances = await joinStrandOn({
				strandId,
				sAppConfig: createSignedSAppConfig(SIMPLE_SCHEMA, '1.0.0'),
				type: 'c',
				memberPrivateKey,
				members: [topology.machine('a', 0), topology.machine('a', 1), topology.machine('b', 0), topology.machine('b', 1)],
				founder: true,
				mesh: 'full',
			});
			const a0 = strandMachine('a[0]', topology.machine('a', 0).node, instances[0]);
			const a1 = strandMachine('a[1]', topology.machine('a', 1).node, instances[1]);
			const b0 = strandMachine('b[0]', topology.machine('b', 0).node, instances[2]);
			const b1 = strandMachine('b[1]', topology.machine('b', 1).node, instances[3]);
			console.log(`[removal-cut] bring-up (2×2 topology + closed strand at breadth 4) took ${Date.now() - bootStart}ms`);

			// ── Party B becomes its own member, distinct from the founding identity ──
			// Without this, both parties present the founder's key and "remove B" has no
			// subject — which is exactly the production state `feat-strand-party-identity`
			// is about (header: FIXTURE HONESTY).
			await waitUntil(
				async () => (await memberKeys(b0.db)).includes(founderKeyPair.publicKeyB64),
				{ ...GATE, description: 'the founder bootstrap rows become visible on b[0]' },
			);
			const memberB = await admitSecondParty(a0, founderKeyPair, b0);

			// ── The device records: each party binds its own machines ────────────────
			// FIXTURE HONESTY: production writes no `MemberPeer` rows today — a strand
			// formed the production way gives every party the same founding member
			// identity and no device bindings, so the deny set is empty there and none of
			// this enforcement is reachable from an app until `feat-strand-party-identity`
			// lands. These rows are the specified INPUT to the enforcement, registered
			// here by hand so the machinery can be proved against them.
			await registerMemberPeer(a0.db, { memberKeyPair: founderKeyPair, peerId: a0.peerId });
			await registerMemberPeer(a0.db, { memberKeyPair: founderKeyPair, peerId: a1.peerId });
			await registerMemberPeer(b0.db, { memberKeyPair: memberB, peerId: b0.peerId });
			await registerMemberPeer(b0.db, { memberKeyPair: memberB, peerId: b1.peerId });

			// Both remaining machines must SEE all four bindings before the removal, so a
			// machine that then declines to cut is declining on a complete view.
			await awaitBindingsVisible([a0, a1], [a0.peerId, a1.peerId, b0.peerId, b1.peerId]);

			// ── The connections exist BEFORE the revocation ──────────────────────────
			// The teardown claim is about closing what is OPEN; without this the test
			// would only prove that a future dial fails.
			for (const remaining of [a0, a1]) {
				for (const removed of [b0, b1]) {
					expectConnected(remaining, removed, 'the strand mesh was wired at bring-up');
				}
			}

			// ── The removal, and the cut on the machine that was told ────────────────
			await revokeMember(a0.db, { managerKeyPair: founderKeyPair, memberKey: memberB.publicKeyB64 });
			expect(await memberKeys(a0.db)).not.toContain(memberB.publicKeyB64);

			// Awaiting the refresh resolves only once the sweep has run, so this is a
			// synchronous cut from the caller's point of view — the thing an app has to
			// call to make removal immediate instead of up to one poll interval later.
			await a0.node.refreshRevocationEnforcement(strandId);

			// BOTH of the removed party's machines are gone from a[0] — the deny set is
			// derived per BINDING, so a party with two devices loses both at once.
			expectCut(a0, b0, "a[0] refreshed after the revocation and swept b[0]'s session");
			expectCut(a0, b1, "a[0] swept the removed party's SECOND machine in the same pass");

			// ── The stale-view arm, asserted deliberately ────────────────────────────
			// a[1] has not refreshed (its own poll is suspended), so it still serves the
			// removed party. That is the chosen fail-open direction — a machine acts only
			// on a revocation it has actually processed, because the opposite error
			// (denying a legitimate member on a view it has not caught up on) partitions
			// someone who did nothing wrong. Enforcement is per-machine and eventually
			// consistent, and this is what that costs.
			//
			// NOTE: read this as "has not PROCESSED the removal", not "has not RECEIVED
			// it" — a[1]'s poll is suspended, so the tombstone may well have replicated
			// to a[1] already (the gate below waits for exactly that). The window this
			// arm pins is between arrival and the refresh that acts on it, which is the
			// one an app can close with `refreshRevocationEnforcement`. Racing
			// replication itself would need a partitioned fixture and pins nothing extra:
			// a machine that has not received the removal is a strict sub-case of one
			// that has not acted on it.
			expectConnected(a1, b0, 'a[1] has not refreshed its deny set yet — the fail-open window');
			expectConnected(a1, b1, 'a[1] has not refreshed its deny set yet — the fail-open window');

			// ── Then the removal reaches a[1], and a[1] cuts too ─────────────────────
			// Gate on a[1]'s OWN view first: the point is that a[1] cuts once it has the
			// tombstone, not that a refresh call cuts regardless of what a[1] can see.
			await waitUntil(
				async () => !(await memberKeys(a1.db)).includes(memberB.publicKeyB64),
				{ ...GATE, description: "the removal becomes visible in a[1]'s own database" },
			);
			await a1.node.refreshRevocationEnforcement(strandId);
			expectCut(a1, b0, 'a[1] has now seen the removal and swept it');
			expectCut(a1, b1, 'a[1] swept the removed party\'s second machine too');

			// ── The remaining cohort still commits, and the cut party cannot follow ───
			// The write is the control for both negative assertions below: if the strand
			// itself had stalled, this commit or a[1]'s read of it fails and says so,
			// instead of a stall being reported as a successful cut.
			const cutKey = 'after-removal';
			await insertWithRetry(a0, cutKey, 'written by the remaining cohort', REMAINING_COHORT_WRITE_BUDGET_MS);
			await awaitRowVisible(a1, cutKey, 'written by the remaining cohort');

			// The removed party can no longer pull it: both of its machines fail to
			// converge within a budget the remaining machine met comfortably.
			await expectNeverConverges(b0, cutKey, 'written by the remaining cohort');
			await expectNeverConverges(b1, cutKey, 'written by the remaining cohort');

			// ── …and cannot push anything back ───────────────────────────────────────
			// Two outcomes are legitimate and both are the cut: the removed party's write
			// may fail outright (its remaining reachable peers are its own two machines,
			// below the strand's commit bar) or commit only among themselves. The
			// assertion that matters either way is that it never reaches the remaining
			// party — asserted below regardless of which happened, with the outcome
			// logged so a future reader knows which shape this machine took.
			const pushKey = 'pushed-by-removed-party';
			let pushError: unknown;
			try {
				await b0.db.exec('insert into App.Data (Key, Val) values (?, ?)', [pushKey, 'from the removed party']);
			} catch (error) {
				pushError = error;
			}
			// The author's own read-back says WHICH shape this run took: a row the removed
			// party can read back locally makes "it never reached a[0]/a[1]" evidence of
			// the cut rather than of a write that never existed. Logged, not asserted —
			// a write that fails outright is equally the cut (see the comment above), so
			// requiring either shape would make this a flake rather than a claim.
			console.log(
				`[removal-cut] removed party's post-cut write ${pushError === undefined ? 'committed locally' : 'failed'}`
				+ `${pushError === undefined ? '' : `: ${String(pushError)}`}`
				+ `; readable back on ${b0.label}: ${await rowLanded(b0, pushKey, 'from the removed party')}`,
			);
			await expectNeverConverges(a0, pushKey, 'from the removed party');
			await expectNeverConverges(a1, pushKey, 'from the removed party');

			// NOTE: nothing here asserts anything about b[0]↔b[1], which stay connected to
			// each other throughout — correctly: a node never hangs ITSELF up (the
			// enforcer excludes its own peer id), and neither removed machine has
			// refreshed against the other's now-orphaned binding. If that pair is ever
			// expected to fall apart on its own, this is the file to say so in.
			//
			// The sessions are still down after all of that — a re-dial by the removed
			// party is refused by the connection gate, not merely swept once.
			for (const remaining of [a0, a1]) {
				for (const removed of [b0, b1]) {
					expectCut(remaining, removed, 'the gate refuses the removed party for as long as it is revoked');
				}
			}
		} finally {
			await topology?.stop();
		}
	}, CUT_TEST_TIMEOUT_MS);

	it('tells a removed node it was removed, on its own poll, and stops nothing on its behalf', async () => {
		let topology: Topology | undefined;
		try {
			// The removed party's machine polls on a short interval and the test never
			// calls `refreshRevocationEnforcement` on it — this is the only place the
			// INTERVAL-driven route is exercised, and it is what an app that never calls
			// the on-demand refresh actually gets. The remaining machine stays suspended
			// so the removed node's own poll is the only thing that can move.
			topology = await bootTopology({
				tag: 'removal-signal',
				genesis: 'genesis-first',
				parties: [
					{ name: 'a', machines: [{ revocationPollMs: SUSPENDED_POLL_MS }] },
					{ name: 'b', machines: [{ revocationPollMs: INTERVAL_POLL_MS }] },
				],
			});
			const strandId = `strand-removal-signal-${Date.now()}`;
			const memberPrivateKey = await generateStrandMemberKey();
			const founderKeyPair = strandMemberKeyPair(memberPrivateKey);
			const instances = await joinStrandOn({
				strandId,
				sAppConfig: createSignedSAppConfig(SIMPLE_SCHEMA, '1.0.0'),
				type: 'c',
				memberPrivateKey,
				members: [topology.machine('a', 0), topology.machine('b', 0)],
				founder: true,
				mesh: 'full',
			});
			const a0 = strandMachine('a[0]', topology.machine('a', 0).node, instances[0]);
			const b0 = strandMachine('b[0]', topology.machine('b', 0).node, instances[1]);

			await waitUntil(
				async () => (await memberKeys(b0.db)).includes(founderKeyPair.publicKeyB64),
				{ ...GATE, description: 'the founder bootstrap rows become visible on b[0]' },
			);
			const memberB = await admitSecondParty(a0, founderKeyPair, b0);

			// FIXTURE HONESTY, again: production writes no device records yet — see the
			// file header. A node with no `MemberPeer` row of its own can never recognize
			// ITSELF in the deny set, so it would never be told; that is a real limitation
			// of the signal, downstream of `feat-strand-party-identity`.
			await registerMemberPeer(a0.db, { memberKeyPair: founderKeyPair, peerId: a0.peerId });
			await registerMemberPeer(b0.db, { memberKeyPair: memberB, peerId: b0.peerId });
			await awaitBindingsVisible([a0, b0], [a0.peerId, b0.peerId]);

			// Subscribed BEFORE the revocation: the event fires once on entry into the
			// revoked set and is not replayed to a late subscriber.
			const revokedOnB: string[] = [];
			const revokedOnA: string[] = [];
			b0.node.on('strand:revoked', ({ strandId: revoked }) => { revokedOnB.push(revoked); });
			a0.node.on('strand:revoked', ({ strandId: revoked }) => { revokedOnA.push(revoked); });

			await revokeMember(a0.db, { managerKeyPair: founderKeyPair, memberKey: memberB.publicKeyB64 });

			// No refresh call anywhere: b[0]'s own interval is what finds it. Best-effort
			// by nature — it can only fire because the tombstone replicated to b[0] while
			// b[0] was still connected, which is the case an app can rely on least and the
			// docs say so.
			await waitUntil(
				() => revokedOnB.length > 0,
				{ ...GATE, description: "b[0] learns from its own poll that it was removed (strand:revoked)" },
			);
			expect(revokedOnB[0]).toBe(strandId);

			// The remaining party is not told it was removed. Asserted here only as a
			// baseline — a[0]'s poll is suspended, so it has derived nothing yet and this
			// could not fire either way. The load-bearing check is after a[0]'s refresh
			// below, where a[0] HAS a deny set holding b[0] and still does not signal.
			expect(revokedOnA).toEqual([]);

			// Nothing is torn down on the removed node's behalf: it still holds the
			// session it had. The other side's gate is what ends the conversation, and
			// a[0] has not refreshed yet.
			expectConnected(b0, a0, 'a removed node stops nothing of its own — it is only told');
			expectConnected(a0, b0, "a[0]'s own poll is suspended, so it has not acted yet");

			// And when the remaining party does act, the session goes.
			await a0.node.refreshRevocationEnforcement(strandId);
			expectCut(a0, b0, 'the remaining party swept the removed node once it refreshed');

			// The meaningful half of the "only the removed node is told" claim: a[0] has
			// now derived a deny set — it just cut b[0] off it — and is still not told it
			// was removed. The signal keys on this node's OWN peer id being denied, not
			// on there being a removal on the strand.
			expect(revokedOnA).toEqual([]);
		} finally {
			await topology?.stop();
		}
	}, SMALL_TEST_TIMEOUT_MS);

	it('leaves an open strand alone when a closed strand on the same nodes removes a party', async () => {
		let topology: Topology | undefined;
		try {
			// Two nodes, TWO strands: one open, one closed. Party b is a stranger on the
			// open strand — no membership anywhere on it — and a member on the closed one.
			topology = await bootTopology({
				tag: 'removal-open-strand',
				genesis: 'genesis-first',
				parties: [
					{ name: 'a', machines: [{ revocationPollMs: SUSPENDED_POLL_MS }] },
					{ name: 'b', machines: [{ revocationPollMs: SUSPENDED_POLL_MS }] },
				],
			});
			const machineA = topology.machine('a', 0);
			const machineB = topology.machine('b', 0);

			const openStrandId = `strand-removal-open-${Date.now()}`;
			const openInstances = await joinStrandOn({
				strandId: openStrandId,
				sAppConfig: createSignedSAppConfig(SIMPLE_SCHEMA, '1.0.0'),
				members: [machineA, machineB],
				mesh: 'full',
			});
			const openA = strandMachine('open a[0]', machineA.node, openInstances[0]);
			const openB = strandMachine('open b[0]', machineB.node, openInstances[1]);

			const closedStrandId = `strand-removal-closed-${Date.now()}`;
			const memberPrivateKey = await generateStrandMemberKey();
			const founderKeyPair = strandMemberKeyPair(memberPrivateKey);
			const closedInstances = await joinStrandOn({
				strandId: closedStrandId,
				sAppConfig: createSignedSAppConfig(SIMPLE_SCHEMA, '1.0.0'),
				type: 'c',
				memberPrivateKey,
				members: [machineA, machineB],
				founder: true,
				mesh: 'full',
			});
			const closedA = strandMachine('closed a[0]', machineA.node, closedInstances[0]);
			const closedB = strandMachine('closed b[0]', machineB.node, closedInstances[1]);

			// The stranger participates on the open strand: it writes, and party a reads
			// it. An open strand admits anyone by design, which is what "unaffected" has
			// to be measured against.
			await openB.db.exec('insert into App.Data (Key, Val) values (?, ?)', ['stranger-before', 'open strands admit anyone']);
			await awaitRowVisible(openA, 'stranger-before', 'open strands admit anyone');

			// ── A removal on the CLOSED strand, in the same two processes ────────────
			await waitUntil(
				async () => (await memberKeys(closedB.db)).includes(founderKeyPair.publicKeyB64),
				{ ...GATE, description: 'the founder bootstrap rows become visible on the closed strand at b[0]' },
			);
			const memberB = await admitSecondParty(closedA, founderKeyPair, closedB);
			await registerMemberPeer(closedA.db, { memberKeyPair: founderKeyPair, peerId: closedA.peerId });
			await registerMemberPeer(closedB.db, { memberKeyPair: memberB, peerId: closedB.peerId });
			await awaitBindingsVisible([closedA], [closedA.peerId, closedB.peerId]);

			await revokeMember(closedA.db, { managerKeyPair: founderKeyPair, memberKey: memberB.publicKeyB64 });
			await closedA.node.refreshRevocationEnforcement(closedStrandId);
			expectCut(closedA, closedB, 'the closed strand cut the removed party');

			// ── The open strand is untouched ─────────────────────────────────────────
			// Each strand runs its OWN libp2p node with its own transport peer id, and the
			// deny gate is composed onto that node's options — so enforcement cannot leak
			// between strands. Asserted as behaviour, not as configuration.
			expectConnected(openA, openB, 'a closed-strand removal must not reach an unrelated open strand');
			expectConnected(openB, openA, 'the stranger keeps its open-strand session');
			await openB.db.exec('insert into App.Data (Key, Val) values (?, ?)', ['stranger-after', 'still participating']);
			await awaitRowVisible(openA, 'stranger-after', 'still participating');

			// Refreshing enforcement for a strand with no armed enforcer is a quiet no-op,
			// not an error — the shape an app hits if it calls the refresh unconditionally
			// after every membership write.
			await expect(machineA.node.refreshRevocationEnforcement(openStrandId)).resolves.toBeUndefined();

			// LAST, per the inherited rejection floor (no count or enumeration assertion
			// may follow a rejected write): an open strand can hold no deny record AT ALL.
			// `Strand.Member` is closed-strand-only (`OnlyClosed`) and `MemberPeer` refuses
			// a binding with no member behind it (`MemberExists`), so the open strand's
			// deny set is empty by construction rather than by policy.
			//
			// This stands in for the options-level "no enforcer is armed on an open
			// strand" assertion the ticket allowed: whether an enforcer object exists is
			// not observable through any public API (`refreshRevocationEnforcement` is
			// deliberately quiet for both an unarmed strand and an unknown one), so the
			// two OBSERVABLE consequences are asserted instead — nothing can be denied,
			// and nothing was.
			await expect(
				registerMemberPeer(openA.db, { memberKeyPair: freshKeyPair(), peerId: openB.peerId }),
			).rejects.toThrow();
		} finally {
			await topology?.stop();
		}
	}, SMALL_TEST_TIMEOUT_MS);
});
