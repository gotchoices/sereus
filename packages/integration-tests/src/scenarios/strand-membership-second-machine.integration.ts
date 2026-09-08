/**
 * Membership actions driven from a party's NON-FOUNDING machine.
 *
 * A closed strand across two parties × two machines (the `bootTopology` +
 * `joinStrandOn` shape of `strand-two-party-two-machine.integration.ts`), with the
 * membership WRITER calls issued from machine index 1 — a machine that neither founded
 * the strand nor is its party's owner. `strand-membership-closed-strand-e2e` already
 * proves every membership action across parties at ONE machine each (its third and
 * fifth tests are joiner-authored), and the permission semantics are settled in
 * cadre-core unit specs — so the new variable here is the MACHINE, not the action, and
 * this is one lean lifecycle pass, not a port of that file's accept/reject breadth.
 *
 * What only this topology can create: a party with TWO `Strand.MemberPeer` rows under
 * ONE member — each of party B's machines registering itself as a device of the same
 * member identity — and a manager whose promotion was authored two machines away from
 * where it then acts. Machine a[1] authors NOTHING in this file and must still
 * converge on all of it.
 *
 * VISIBILITY, NOT PHYSICAL REPLICATION — deliberately. Every gate here is a
 * database-visibility claim: a read on any machine may be served remotely by whichever
 * peer coordinates the block, and that is the property an application observes. The
 * physical story for this exact topology (raw-store coverage, a machine off, catch-up)
 * is `strand-two-party-two-machine.integration.ts`'s job; do not add raw-store gates
 * here — they would double the runtime to restate that file's claims.
 *
 * NOTE: `waitUntil` swallows a throwing condition and retries, so a gate whose read
 * ERRORS on every attempt reports a plain timeout, indistinguishable from rows that
 * never arrived. If a gate here times out, check the harness debug log
 * (`Wait condition threw: …`) before concluding it is a convergence failure. Every
 * gate runs on the shared {@link GATE} budget and names the claim that failed.
 *
 * Rejection floor (inherited from the closed-strand e2e): per the optimystic
 * deferred-constraint-rollback gap, rejected writes assert via `rejects.toThrow()`
 * only, and no count or enumeration assertion may FOLLOW a rejected write — the single
 * rejected write in this file is LAST.
 *
 * Lookup shape (inherited): a where-equality on a full primary key is served by the
 * optimystic module as a point lookup that can MISS on a networked strand
 * (`debt-composite-pk-point-lookup-unreliable-untracked`). Every membership read here
 * scans and filters in JavaScript instead, which depends only on the scan returning a
 * superset of the live rows — including inside gates, where a persistent point-lookup
 * miss would misreport as a convergence timeout.
 */

import { describe, it, expect } from 'vitest';
import {
	generateStrandMemberKey,
	strandMemberKeyPair,
	issueInvite,
	consumeInvite,
	registerMemberPeer,
	listMemberPeers,
	addManager,
	type Ed25519KeyPair,
} from '@serfab/cadre-core';
import type { StrandInstance } from '@serfab/cadre-core';
import type { Database } from '@quereus/quereus';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import {
	bootTopology,
	joinStrandOn,
	createSignedSAppConfig,
	waitUntil,
	type Topology,
} from '../harness/index.js';

/** The one-table key/value sApp several strand scenarios use. Membership lives in the
 *  `Strand.*` tables every strand carries; no App write happens in this file, so the
 *  signed-RBAC fixture the closed-strand e2e loads would buy nothing here. */
const SIMPLE_SCHEMA = `
table Data (
    Key text primary key,
    Val text
);
`;

/**
 * The budget every convergence gate in this file waits on. Sibling-scenario runs put
 * four-machine visibility convergence well under a second; 60 s matches the sibling's
 * budget — headroom for slow hardware, not an expectation.
 */
const GATE = { timeoutMs: 60_000, intervalMs: 250 } as const;

/**
 * Explicit test timeout, per `topology.ts`'s TIME BUDGET rule of thumb: 8 libp2p nodes
 * (4 control + 4 strand) at ~10-15 s each, plus the lifecycle's gates on the worst-case
 * end of {@link GATE}. The sibling core scenario measured ~20 s wall-clock on this
 * shape; this is headroom. Never touch `vitest.config.ts`.
 */
const TEST_TIMEOUT_MS = 360_000;

/** A fresh, unrelated ed25519 keypair in the base64url shape the constraints consume. */
function freshKeyPair(): Ed25519KeyPair {
	const privateKeyB64 = generatePrivateKey('ed25519', 'base64url') as string;
	const publicKeyB64 = getPublicKey(privateKeyB64, 'ed25519', 'base64url', 'base64url') as string;
	return { privateKeyB64, publicKeyB64 };
}

/** The `Strand.*` tables this file reads by name. */
type StrandTable = 'Header' | 'Member' | 'Manager' | 'Invite' | 'ConsumedInvite';

/** Count rows in a `Strand.*` table as seen by one machine's strand DB. */
async function strandCount(db: Database, table: StrandTable): Promise<number> {
	const row = await db.get(`select count(1) as c from Strand.${table}`);
	return (row?.c as number) ?? 0;
}

/** Every value of one column of a `Strand.*` table, via an UNFILTERED scan —
 *  see the lookup-shape note in the file header for why this is never a seek. */
async function scanColumn(db: Database, table: StrandTable, column: string): Promise<string[]> {
	const values: string[] = [];
	for await (const row of db.eval(`select ${column} from Strand.${table}`)) {
		values.push(row[column] as string);
	}
	return values;
}

/** Every `Strand.Member.Key` currently visible. */
async function memberKeys(db: Database): Promise<string[]> {
	return scanColumn(db, 'Member', 'Key');
}

/** Every `Strand.Invite.Key` currently visible. */
async function inviteKeys(db: Database): Promise<string[]> {
	return scanColumn(db, 'Invite', 'Key');
}

/** Every `Strand.Manager.MemberKey` currently visible. */
async function managerKeys(db: Database): Promise<string[]> {
	return scanColumn(db, 'Manager', 'MemberKey');
}

/** The `Strand.ConsumedInvite.MemberKey` recorded for one invite, or `undefined`. */
async function consumedInviteMember(db: Database, inviteKey: string): Promise<string | undefined> {
	for await (const row of db.eval('select InviteKey, MemberKey from Strand.ConsumedInvite')) {
		if (row.InviteKey === inviteKey) return row.MemberKey as string;
	}
	return undefined;
}

/** One manager's `Strand.Manager.Generation`, or `undefined` if it holds no visible row. */
async function managerGeneration(db: Database, memberKey: string): Promise<number | undefined> {
	for await (const row of db.eval('select MemberKey, Generation from Strand.Manager')) {
		if (row.MemberKey === memberKey) return Number(row.Generation);
	}
	return undefined;
}

/** One member's strand handles. Throws with the machine's name rather than surfacing a
 *  launch regression as `Cannot read properties of undefined` mid-lifecycle. */
function strandHandles(label: string, instance: StrandInstance | undefined): { db: Database; peerId: string } {
	if (!instance?.database || !instance.libp2pNode) {
		throw new Error(`${label}: joinStrandOn returned no strand database/libp2p node`);
	}
	return { db: instance.database.getDatabase(), peerId: instance.libp2pNode.peerId.toString() };
}

describe('Closed-strand membership driven from a party\'s second machine (2×2)', () => {
	it('a non-founding, non-owner machine joins, registers devices, and acts as manager', async () => {
		let topology: Topology | undefined;
		try {
			// ── Bring-up: 2×2 topology, one closed strand across all four ────────────
			const bootStart = Date.now();
			topology = await bootTopology({
				tag: 'two-by-two-membership',
				genesis: 'genesis-first', // the default — the production seed-enrollment ordering
				controlMesh: 'full',
				parties: [
					{ name: 'a', machines: [{}, {}] },
					{ name: 'b', machines: [{}, {}] },
				],
			});
			const a0 = topology.machine('a', 0);
			const a1 = topology.machine('a', 1);
			const b0 = topology.machine('b', 0);
			const b1 = topology.machine('b', 1);

			// The shared closed StrandRow: Type 'c' plus a minted MemberPrivateKey, from
			// which a[0]'s `founder: true` bootstrap derives — and seats — the founding
			// Member/Manager/Header rows. The test derives the same keypair to sign with.
			const strandId = `strand-2x2-membership-${Date.now()}`;
			const memberPrivateKey = await generateStrandMemberKey();
			const founderKeyPair = strandMemberKeyPair(memberPrivateKey);
			const instances = await joinStrandOn({
				strandId,
				sAppConfig: createSignedSAppConfig(SIMPLE_SCHEMA, '1.0.0'),
				type: 'c',
				memberPrivateKey,
				members: [a0, a1, b0, b1],
				founder: true,
				mesh: 'full',
			});
			const mA0 = strandHandles('a[0]', instances[0]);
			const mA1 = strandHandles('a[1]', instances[1]);
			const mB0 = strandHandles('b[0]', instances[2]);
			const mB1 = strandHandles('b[1]', instances[3]);
			console.log(`[2x2-membership] bring-up (topology + closed strand at breadth 4) took ${Date.now() - bootStart}ms`);

			// Founder bootstrap seated exactly Header + founding Member + Manager on a[0].
			expect(await strandCount(mA0.db, 'Header')).toBe(1);
			expect(await memberKeys(mA0.db)).toEqual([founderKeyPair.publicKeyB64]);
			expect(await managerKeys(mA0.db)).toEqual([founderKeyPair.publicKeyB64]);

			// GATE: the bootstrap rows become visible on every non-founding machine — the
			// floor everything below stands on.
			for (const [label, db] of [['a[1]', mA1.db], ['b[0]', mB0.db], ['b[1]', mB1.db]] as const) {
				await waitUntil(
					async () =>
						(await strandCount(db, 'Header')) >= 1 &&
						(await strandCount(db, 'Member')) >= 1 &&
						(await strandCount(db, 'Manager')) >= 1,
					{ ...GATE, description: `founder bootstrap rows become visible on ${label}` },
				);
			}

			// ── Phase 1: the join, consumed on b[1] — wrong party AND wrong machine ──
			// The founder issues the invite; the secret travels out of band (handing it
			// straight to b[1] models the real flow). b[1] then consumes it against its
			// OWN database: `ConsumedInvite`'s deferred checks (InviteExists / ValidUsage /
			// NotExpired) must resolve the a[0]-authored Invite row from a machine that is
			// two hops of novelty from anything previously tested. The visibility gate
			// first — leaning on the constraint's own read would fail at commit and read
			// like an authorization bug.
			const phase1Start = Date.now();
			const { inviteKey, invitePrivateKey } = await issueInvite(mA0.db, { managerKeyPair: founderKeyPair });
			await waitUntil(
				async () => (await inviteKeys(mB1.db)).includes(inviteKey),
				{ ...GATE, description: 'the founder-issued invite becomes visible on b[1]' },
			);

			const bMember = freshKeyPair(); // party B's ONE member identity, shared by both its machines
			await consumeInvite(mB1.db, {
				inviteKey,
				invitePrivateKey,
				memberKey: bMember.publicKeyB64,
			});
			// Local and immediate — the writer's transaction committed on b[1], no wait.
			expect(await memberKeys(mB1.db)).toContain(bMember.publicKeyB64);

			// The b[1]-authored membership converges back to the founder.
			await waitUntil(
				async () =>
					(await memberKeys(mA0.db)).includes(bMember.publicKeyB64) &&
					(await consumedInviteMember(mA0.db, inviteKey)) === bMember.publicKeyB64,
				{ ...GATE, description: 'the b[1]-authored Member + ConsumedInvite reach a[0]' },
			);
			console.log(`[2x2-membership] phase 1 (join consumed on b[1]) took ${Date.now() - phase1Start}ms`);

			// ── Phase 2: BOTH of party B's machines register as devices of the ONE member ──
			// Two `MemberPeer` rows under one member is the data shape this topology exists
			// to create and nothing has ever written. Sequential, first gated visible before
			// the second — replication is synchronous per write and concurrent cross-machine
			// writers mutually block (see convergence-stress).
			const phase2Start = Date.now();
			await registerMemberPeer(mB1.db, { memberKeyPair: bMember, peerId: mB1.peerId });
			await waitUntil(
				async () => (await listMemberPeers(mA0.db, bMember.publicKeyB64)).includes(mB1.peerId),
				{ ...GATE, description: "b[1]'s device record reaches a[0]" },
			);

			// b[0]'s registration reads `Strand.Member` for its `MemberExists` check, and
			// bMember's row was authored on b[1] — gate it visible from b[0] first, for the
			// same commit-failure-reads-as-authz-bug reason as the invite gate above.
			await waitUntil(
				async () => (await memberKeys(mB0.db)).includes(bMember.publicKeyB64),
				{ ...GATE, description: "bMember's Member row becomes visible on b[0]" },
			);
			await registerMemberPeer(mB0.db, { memberKeyPair: bMember, peerId: mB0.peerId });

			// Both device rows enumerate from the founder.
			await waitUntil(
				async () => {
					const seen = [...await listMemberPeers(mA0.db, bMember.publicKeyB64)].sort();
					return JSON.stringify(seen) === JSON.stringify([mB0.peerId, mB1.peerId].sort());
				},
				{ ...GATE, description: "both of party B's device records enumerate from a[0]" },
			);
			console.log(`[2x2-membership] phase 2 (two device records under one member) took ${Date.now() - phase2Start}ms`);

			// ── Phase 3: manager rotation, then manager ACTIONS from the second machine ──
			const phase3Start = Date.now();
			await addManager(mA0.db, { byManagerKeyPair: founderKeyPair, newManagerKey: bMember.publicKeyB64 });
			expect(await managerKeys(mA0.db)).toContain(bMember.publicKeyB64);

			// THE ENABLING GATE: the a[0]-authored Manager row visible on b[1] — everything
			// below depends on b[1] resolving it. Generation asserted separately so a later
			// failure is unambiguous: `issueInvite` under a manager whose row b[1] cannot
			// see fails at commit and would read as "the promotion rule is wrong".
			// NOTE: the `1` pins the WRITER's successor policy (authorizer generation + 1),
			// not the schema's, which enforces only strict ordering — relax to
			// `toBeGreaterThan(0)` if `addManager` ever seats successors differently.
			await waitUntil(
				async () => (await managerKeys(mB1.db)).includes(bMember.publicKeyB64),
				{ ...GATE, description: "bMember's Manager row becomes visible on b[1]" },
			);
			expect(await managerGeneration(mB1.db, bMember.publicKeyB64)).toBe(1);

			// The new manager acts FROM b[1]: issues a further invite (`Invite.InviteValid`
			// reads the LIVE Manager table — the row a[0] authored) and admits a third
			// member key by consuming it there (the fifth-test recipe of the closed-strand
			// e2e, run from a machine that is neither party owner nor strand founder).
			const { inviteKey: mInvite, invitePrivateKey: mSecret } =
				await issueInvite(mB1.db, { managerKeyPair: bMember });
			const thirdMember = freshKeyPair();
			await consumeInvite(mB1.db, {
				inviteKey: mInvite,
				invitePrivateKey: mSecret,
				memberKey: thirdMember.publicKeyB64,
			});
			expect(await memberKeys(mB1.db)).toContain(thirdMember.publicKeyB64);

			// The b[1]-authored rows converge to the founder…
			await waitUntil(
				async () =>
					(await inviteKeys(mA0.db)).includes(mInvite) &&
					(await memberKeys(mA0.db)).includes(thirdMember.publicKeyB64) &&
					(await consumedInviteMember(mA0.db, mInvite)) === thirdMember.publicKeyB64,
				{ ...GATE, description: "the manager actions authored on b[1] reach a[0]" },
			);

			// …and to a[1], which authored NONE of this file's writes and must still
			// converge on all of them: the full member set, the rotated manager set, and
			// party B's two device records.
			await waitUntil(
				async () => {
					const seen = await memberKeys(mA1.db);
					return seen.includes(bMember.publicKeyB64) && seen.includes(thirdMember.publicKeyB64);
				},
				{ ...GATE, description: 'a[1] converges on the full member set' },
			);
			await waitUntil(
				async () => (await managerKeys(mA1.db)).includes(bMember.publicKeyB64),
				{ ...GATE, description: "a[1] converges on bMember's Manager row" },
			);
			await waitUntil(
				async () => {
					const seen = [...await listMemberPeers(mA1.db, bMember.publicKeyB64)].sort();
					return JSON.stringify(seen) === JSON.stringify([mB0.peerId, mB1.peerId].sort());
				},
				{ ...GATE, description: "a[1] converges on party B's two device records" },
			);
			console.log(`[2x2-membership] phase 3 (manager rotation + actions from b[1]) took ${Date.now() - phase3Start}ms`);

			// ── Phase 4: LAST — the rejection floor, on b[1] ─────────────────────────
			// One case, not a suite (the breadth lives in the closed-strand e2e): a fresh
			// unadmitted keypair cannot issue an invite from b[1]'s database. Rejection
			// floor: `rejects.toThrow()` only — nothing may follow a rejected write.
			await expect(issueInvite(mB1.db, { managerKeyPair: freshKeyPair() })).rejects.toThrow();
		} finally {
			await topology?.stop();
		}
	}, TEST_TIMEOUT_MS);
});
