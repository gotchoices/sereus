/**
 * Two parties × two machines, one strand across all four machines.
 *
 * The first scenario to run a strand at FOUR machines — the designed operating point of
 * `DEFAULT_STRAND_CLUSTER_SIZE = 4` (`quereus-plugin-sereus/src/cluster-size.ts`) — and
 * the first topology that can lose a machine and keep committing: a write commits on
 * `ceil(4 × 0.75) = 3` approvals, so exactly one holder may be away. Every cross-party
 * strand test before this gives each party one machine; every multi-machine strand stays
 * inside one party. One narrative test, phased, because later phases depend on earlier
 * state (a stopped machine, a restart) and each bring-up of this shape costs ~80-120 s
 * (8 libp2p nodes: 4 control + 4 strand — the `TIME BUDGET` rule in
 * `harness/topology.ts`).
 *
 * Phases:
 *   1. A write from the founding party's owner reaches every machine — physically
 *      (raw-store coverage gated BEFORE any cross-machine database read), then visibly.
 *   2. A write from the joining party's SECOND machine (b[1]) — a non-founding machine
 *      of a party that did not form the strand, a path nothing else exercises.
 *   3. Both parties writing: rapid-sequential bursts with read-then-write interleaving,
 *      converging to identical row sets on all four databases. NEVER `Promise.all`
 *      across machines — Optimystic replication is synchronous per write, so truly
 *      simultaneous writers mutually block, and that block is not a defect (see
 *      `convergence-stress.integration.ts`).
 *   4. One machine off (a[1], the whole `CadreNode`), the strand still commits: a write
 *      from b[0] lands on 3-of-4 approvals. Impossible to assert below four machines —
 *      at three, every holder must vote.
 *   5. The machine returns — a NEW `CadreNode` with the SAME identity and the SAME
 *      storage capture — and the write it missed physically lands in its own store
 *      (peer-join backfill is the delivery mechanism under test, deliberately enabled),
 *      then reads back through its database.
 *
 * PROBE RULE (from `harness/block-store-probe.ts`): every physical claim gates on raw
 * stores before any read through the target machine's database — a read through a node
 * can itself pull blocks into that node's store and mask a replication gap. At exactly
 * four machines and replication breadth four, FULL coverage is the expected steady
 * state, so every physical gate is `awaitBlockCoverage` and never a block count
 * (counting is `debt-replication-proof-above-cohort-size` territory, and the peer-join
 * backfill makes counts meaningless anyway — for a coverage claim it only helps).
 *
 * NON-ISSUE, by construction: machines disagreeing about their party's size cannot
 * touch a strand commit. Strand nodes declare no repair yardstick —
 * `strandClusterPolicy`'s unknown path is the production path (see `cluster-size.ts`) —
 * so control-plane machine-count divergence (the subject of
 * `control-divergent-repair-yardstick.integration.ts`) never reaches the strand plane.
 * Asserted nowhere in this file on purpose.
 */

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CadreNode } from '@serfab/cadre-core';
import type { StrandInstance, StrandRow } from '@serfab/cadre-core';
import type { IRawStorage } from '@optimystic/db-p2p';
import type { Database } from '@quereus/quereus';
import {
	bootTopology,
	joinStrandOn,
	connectStrandNodes,
	captureRawStorage,
	awaitBlockCoverage,
	controlNodeConfig,
	createSignedSAppConfig,
	hasOutboundTo,
	waitUntil,
	sleep,
	type Topology,
	type RawStorageCapture,
} from '../harness/index.js';

/** The one-table key/value sApp several other strand scenarios already use. */
const SIMPLE_SCHEMA = `
table Data (
    Key text primary key,
    Val text
);
`;

/** One shared budget for coverage gates, visibility convergence, and settle waits. */
const CONVERGE_BUDGET_MS = 60_000;

/**
 * Phase 4's degraded-write budget. The live cohort may still include the dead peer, so
 * the first write after the stop can pay ~2 × 10 s ClusterClient response deadlines
 * before committing on 3-of-4 approvals — slow (~20 s) or one retry is expected;
 * exceeding THIS budget is the genuine cannot-commit-degraded failure.
 */
const DEGRADED_WRITE_BUDGET_MS = 90_000;

/** Phase 3 burst size per machine — modest on purpose; volume is convergence-stress's job. */
const BURST_ROUNDS = 5;

/**
 * Explicit test timeout: ~10-15 s per machine of bring-up × 8 libp2p nodes, plus the
 * degraded-write budget and a restart, with headroom. Never touch `vitest.config.ts`.
 */
const TEST_TIMEOUT_MS = 420_000;

/** One strand member's handles, so phases can address machines uniformly. */
interface StrandMachine {
	label: string;
	store: IRawStorage;
	db: Database;
	instance: StrandInstance;
}

/**
 * Every `App.Data` row, via an UNFILTERED scan filtered in JavaScript. `Key` is the
 * single-column primary key, so a where-equality on it is a full-PK point lookup the
 * networked optimystic module can MISS — a scan depends only on returning a superset of
 * the live rows (the lookup-shape note in `strand-membership-closed-strand-e2e`).
 */
async function readDataRows(db: Database): Promise<Map<string, string>> {
	const rows = new Map<string, string>();
	for await (const row of db.eval('select Key, Val from App.Data')) {
		rows.set(row.Key as string, row.Val as string);
	}
	return rows;
}

/**
 * Poll until every machine's row set EQUALS `expected` — same size, same values — and
 * return the wall-clock it took, logged by callers so future re-budgeting has numbers.
 */
async function waitForRowConvergence(
	machines: ReadonlyArray<StrandMachine>,
	expected: ReadonlyMap<string, string>,
	description: string,
): Promise<number> {
	const start = Date.now();
	await waitUntil(async () => {
		for (const machine of machines) {
			const rows = await readDataRows(machine.db);
			if (rows.size !== expected.size) return false;
			for (const [key, val] of expected) {
				if (rows.get(key) !== val) return false;
			}
		}
		return true;
	}, {
		timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 500,
		description: `${description}: ${machines.map((m) => m.label).join(', ')} converge to the ${expected.size}-row set`,
	});
	return Date.now() - start;
}

/**
 * Insert with a bounded retry, for the degraded phase only. The upstream lost-conflict
 * race (`../optimystic/tickets/fix/lost-conflict-race-abstains-and-orphans-the-block`)
 * can orphan a pend — a failed insert that never committed — and a retry is what tells
 * that known flake apart from a genuine cannot-commit-degraded regression (exceeding
 * `budgetMs`). Each failure reads back through the AUTHOR before retrying, so a write
 * that reported failure but actually landed is not re-inserted into a primary-key
 * conflict; the author-side read makes no physical claim about any other machine.
 */
async function insertWithRetry(
	db: Database, key: string, val: string, budgetMs: number, label: string,
): Promise<void> {
	const start = Date.now();
	for (let attempt = 1; ; attempt++) {
		try {
			await db.exec('insert into App.Data (Key, Val) values (?, ?)', [key, val]);
			console.log(`[2x2] ${label}: committed on attempt ${attempt} after ${Date.now() - start}ms`);
			return;
		} catch (error) {
			if ((await readDataRows(db)).get(key) === val) {
				console.log(`[2x2] ${label}: attempt ${attempt} reported failure but the row landed (${Date.now() - start}ms)`);
				return;
			}
			if (Date.now() - start > budgetMs) {
				throw new Error(
					`[2x2] ${label}: no commit within ${budgetMs}ms (${attempt} attempt(s)); last error: ${String(error)}`,
					{ cause: error });
			}
			console.warn(`[2x2] ${label}: attempt ${attempt} failed, retrying: ${String(error)}`);
			await sleep(1_000);
		}
	}
}

describe('Two parties × two machines, one strand across all four', () => {
	it('replicates from any machine, commits with one machine off, and catches the returner up', async () => {
		// Per-machine raw-storage captures, so every physical claim can read the store
		// a machine is actually writing to. Declared OUTSIDE the topology spec because
		// phase 5 reuses a1's capture across the restart — `captureRawStorage` memoizes
		// per scope, so the restarted runtime reaches the SAME durable backend, which is
		// what keeps the catch-up claim from being vacuous.
		const captures: Record<'a0' | 'a1' | 'b0' | 'b1', RawStorageCapture> = {
			a0: captureRawStorage(), a1: captureRawStorage(),
			b0: captureRawStorage(), b1: captureRawStorage(),
		};
		let topology: Topology | undefined;
		// Phase 5's node lives OUTSIDE the topology's started list (the LateJoinHandles
		// pattern) — the `finally` must stop it itself.
		let restarted: CadreNode | undefined;
		try {
			const bootStart = Date.now();
			topology = await bootTopology({
				tag: 'two-by-two',
				genesis: 'genesis-first', // the default — the production seed-enrollment ordering
				controlMesh: 'full',
				parties: [
					{ name: 'a', machines: [{ storageProvider: captures.a0.provider }, { storageProvider: captures.a1.provider }] },
					{ name: 'b', machines: [{ storageProvider: captures.b0.provider }, { storageProvider: captures.b1.provider }] },
				],
			});
			const a0 = topology.machine('a', 0);
			const a1 = topology.machine('a', 1);
			const b0 = topology.machine('b', 0);
			const b1 = topology.machine('b', 1);
			const partyA = topology.parties.get('a')!;

			const strandId = `strand-2x2-${Date.now()}`;
			const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '1.0.0');
			// Open strand: this scenario is about replication and availability, not
			// membership — the membership variant is `scenario-two-by-two-strand-membership`.
			const strandRow: StrandRow = { Id: strandId, MemberPrivateKey: null, Type: 'o' };

			// a0 founds; the default barrier waits for a strand cohort of
			// min(4, DEFAULT_STRAND_CLUSTER_SIZE) = 4 on every member — the first time any
			// test barriers a strand at the full replication breadth.
			const instances = await joinStrandOn({
				strandId, sAppConfig: sApp,
				members: [a0, a1, b0, b1],
				mesh: 'full',
			});
			console.log(`[2x2] bring-up (topology + strand at breadth 4) took ${Date.now() - bootStart}ms`);

			const machines: StrandMachine[] = [
				{ label: 'a[0]', store: captures.a0.forStrand(strandId), db: instances[0]!.database!.getDatabase(), instance: instances[0]! },
				{ label: 'a[1]', store: captures.a1.forStrand(strandId), db: instances[1]!.database!.getDatabase(), instance: instances[1]! },
				{ label: 'b[0]', store: captures.b0.forStrand(strandId), db: instances[2]!.database!.getDatabase(), instance: instances[2]! },
				{ label: 'b[1]', store: captures.b1.forStrand(strandId), db: instances[3]!.database!.getDatabase(), instance: instances[3]! },
			];
			const [mA0, mA1, mB0, mB1] = machines as [StrandMachine, StrandMachine, StrandMachine, StrandMachine];

			/** Everything committed so far, key → val — what every converged read must equal. */
			const written = new Map<string, string>();
			const insertRow = async (db: Database, key: string, val: string): Promise<void> => {
				await db.exec('insert into App.Data (Key, Val) values (?, ?)', [key, val]);
				written.set(key, val);
			};

			// ── Phase 1: a founder-party write reaches everyone, physically ─────────
			const phase1Start = Date.now();
			await insertRow(mA0.db, 'phase1-founder', 'written-on-a0');
			// Raw stores FIRST (probe rule), before any cross-machine database read.
			for (const target of [mA1, mB0, mB1]) {
				await awaitBlockCoverage(mA0.store, target.store, {
					timeoutMs: CONVERGE_BUDGET_MS,
					description: `phase 1: a[0]'s strand blocks land physically in ${target.label}'s own store`,
				});
			}
			// Only now read through the other machines' databases.
			await waitForRowConvergence(machines, written, 'phase 1');
			console.log(`[2x2] phase 1 (founder write, full coverage + visibility) took ${Date.now() - phase1Start}ms`);

			// ── Phase 2: a write from the joining party's SECOND machine ────────────
			// b[1] neither founded the strand nor owns its party — cross-party writes
			// today are always issued by the machine that formed the strand.
			const phase2Start = Date.now();
			await insertRow(mB1.db, 'phase2-joiner-second-machine', 'written-on-b1');
			for (const target of [mA0, mA1, mB0]) {
				await awaitBlockCoverage(mB1.store, target.store, {
					timeoutMs: CONVERGE_BUDGET_MS,
					description: `phase 2: b[1]'s strand blocks land physically in ${target.label}'s own store`,
				});
			}
			await waitForRowConvergence(machines, written, 'phase 2');
			console.log(`[2x2] phase 2 (b[1] write, full coverage + visibility) took ${Date.now() - phase2Start}ms`);

			// ── Phase 3: both parties writing — rapid-sequential, interleaved ───────
			// All four machines take turns; every write awaited; each iteration reads
			// before it writes (Optimystic convergence is read-driven — a write-only
			// loop never pulls the other side's rows; see convergence-stress).
			const phase3Start = Date.now();
			for (let round = 1; round <= BURST_ROUNDS; round++) {
				for (const machine of machines) {
					await readDataRows(machine.db);
					await insertRow(machine.db, randomUUID(), `burst-${machine.label}-round-${round}`);
				}
			}
			const convergenceMs = await waitForRowConvergence(machines, written, 'phase 3');
			console.log(`[2x2] phase 3: ${BURST_ROUNDS * machines.length} interleaved writes, `
				+ `converged to identical ${written.size}-row sets in ${convergenceMs}ms `
				+ `(phase total ${Date.now() - phase3Start}ms)`);

			// ── Phase 4: one machine off, the strand still commits ──────────────────
			// Whole machine off (`node.stop()`), not just a strand hangup.
			const a1StrandPeerId = mA1.instance.libp2pNode!.peerId.toString();
			console.log('[2x2] phase 4: stopping a[1] (whole CadreNode)');
			await a1.node.stop();
			const live = [mA0, mB0, mB1];
			for (const machine of live) {
				await waitUntil(
					() => !machine.instance.libp2pNode!.getConnections()
						.some((c) => c.remotePeer.toString() === a1StrandPeerId),
					{
						timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 250,
						description: `${machine.label}'s strand node drops the connection to the stopped a[1]`,
					});
			}
			// The commit needs 3 of 4 approvals, so three live holders suffice — the
			// assertion this whole topology exists for.
			const phase4Start = Date.now();
			await insertWithRetry(mB0.db, 'phase4-degraded', 'written-with-a1-off', DEGRADED_WRITE_BUDGET_MS, 'phase 4 degraded write on b[0]');
			written.set('phase4-degraded', 'written-with-a1-off');
			await waitForRowConvergence(live, written, 'phase 4');
			console.log(`[2x2] phase 4 (degraded write + visibility on the three live machines) took ${Date.now() - phase4Start}ms`);

			// ── Phase 5: the machine returns and catches up ─────────────────────────
			// A NEW CadreNode with the SAME identity (a1's key) on the SAME capture —
			// the strand-late-cadre-join cold-restart recipe. It is NOT in the
			// topology's started list; `restarted` is the finally's handle to it.
			const phase5Start = Date.now();
			const a0Addrs = a0.node.getControlNode()!.getMultiaddrs().map((ma) => ma.toString());
			const returning = new CadreNode(controlNodeConfig({
				partyId: partyA.partyId,
				privateKey: a1.key,
				profile: 'transaction',
				storageProvider: captures.a1.provider,
				pinnedOwnerKeys: [partyA.ownerPublicKey],
				bootstrapNodes: a0Addrs,
			}));
			restarted = returning;
			await returning.start();
			await waitUntil(() => hasOutboundTo(returning, a0.peerId), {
				timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 250,
				description: 'restarted a[1] re-establishes a control connection to a[0]',
			});

			// Same strand row + sApp config; then re-dial the three live strand nodes.
			const returningStrand = await returning.addStrand({ strandRow, sAppConfig: sApp });
			expect(returningStrand.status).toBe('active');
			for (const machine of live) {
				await connectStrandNodes(
					returningStrand.libp2pNode!, 'a[1] (restarted)',
					machine.instance.libp2pNode!, machine.label,
					CONVERGE_BUDGET_MS);
			}

			// Physical catch-up gate, BEFORE any read through the restarted node's
			// database: the write a[1] missed lands in its OWN store, delivered by the
			// peer-join backfill (the mechanism under test — deliberately left enabled).
			await awaitBlockCoverage(mB0.store, mA1.store, {
				timeoutMs: CONVERGE_BUDGET_MS,
				description: "the blocks a[1] missed while off land physically in its own store",
			});

			// Coverage proven — now the behavioural read through the restarted node.
			const returnedRows = await readDataRows(returningStrand.database!.getDatabase());
			expect(returnedRows.get('phase4-degraded'), 'restarted a[1] reads the row it missed').toBe('written-with-a1-off');
			expect(returnedRows.size, "restarted a[1]'s full row set").toBe(written.size);
			for (const [key, val] of written) {
				expect(returnedRows.get(key), `restarted a[1] row ${key}`).toBe(val);
			}
			console.log(`[2x2] phase 5 (restart, re-dial, physical catch-up + read-back) took ${Date.now() - phase5Start}ms`);
		} finally {
			// The restarted node is NOT in the topology's started list — stop it
			// explicitly. The ORIGINAL a[1] is; `Topology.stop` is idempotent per node,
			// so its early stop in phase 4 is safe to repeat.
			try {
				await restarted?.stop();
			} catch (error) {
				console.warn('[2x2] restarted-node teardown failed:', error);
			}
			await topology?.stop();
		}
	}, TEST_TIMEOUT_MS);
});
