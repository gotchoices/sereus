/**
 * A machine that joins the cadre AFTER a strand exists must receive that strand.
 *
 * One party. The FOUNDER (standing in for a phone) creates a strand, publishes it, and
 * writes rows while it is the party's ONLY machine. A NEWCOMER is then enrolled into the
 * party, learns the strand through the product's own discovery path, runs it, and ends up
 * PHYSICALLY holding the blocks written before it existed — still readable when it is the
 * only machine running. Every other two-instance strand scenario starts both machines
 * before the strand is created; the ordering here is the subject.
 *
 * Test 3 covers the harder half of the same story: the founder keeps writing THROUGHOUT
 * the newcomer's enrollment, so its rows straddle a seam between two different delivery
 * mechanisms. Rows written before the newcomer's strand node connects arrive by the
 * peer-join block catch-up (`cadre-core/src/peer-join-backfill.ts`), a whole-store push
 * that enumerates the store ONCE and then marks the peer done for that runtime. Rows
 * written after it connects arrive by ordinary cohort replication instead. A row committed
 * after the catch-up's enumeration passed its id, but before the peer was marked done, is
 * never pushed — replication has to cover it. If the two halves do not meet cleanly, that
 * row is silently absent on the new machine, and Test 3 is what finds it.
 *
 * THREE RULES, ALL LOAD-BEARING:
 *
 * 1. ORDERING. The newcomer is constructed only AFTER the founder's writes, and the
 *    founder is asserted to hold ZERO control connections when those writes land — so
 *    "written while alone" is measured, not narrated. Moving the newcomer's construction
 *    earlier turns this file back into a duplicate of `strand-addr-seed-convergence`.
 *
 * 2. NO TEST-SIDE STRAND DIAL. The strand mesh must form from `resolveCohortSeed`'s
 *    strand-addr RPC over the control connection the newcomer holds from `applySeed` —
 *    no hand-dial of the founder's strand address anywhere in this file. A per-peer RPC
 *    failure folds to a silent `[]`, so a broken seed path shows up as a Phase 2 mesh
 *    timeout; if that fires, check the direct RPC first the way
 *    `strand-addr-seed-convergence.integration.ts` does, before blaming discovery.
 *
 * 3. THE PHYSICAL CLAIM NEVER READS THE NEWCOMER'S STRAND DATABASE. A read issued through
 *    the node under test can itself pull blocks into that node's store and mask the gap
 *    (`harness/block-store-probe.ts`). The physical claim is read off raw stores only;
 *    the newcomer's database is first read after coverage is already proven, and in both
 *    tests that read it the FOUNDER IS ALREADY STOPPED (Test 1's Phase 4a, Test 3's
 *    behavioural gate). With the founder up, a coordinator that resolves to the author
 *    answers out of the author's own storage, so such a read holds even on a newcomer
 *    that received nothing — it would restate the physical claim rather than add to it.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import type { ActionRev, BlockId } from '@optimystic/db-core';
import type { IRawStorage } from '@optimystic/db-p2p';
import type { Database } from '@quereus/quereus';
import { CadreNode } from '@serfab/cadre-core';
import type { SAppConfig, StrandInstance, StrandRow } from '@serfab/cadre-core';
import {
	waitUntil,
	sleep,
	waitForCadrePeerConverged,
	controlNodeConfig,
	createSignedSAppConfig,
	makeOwnOwner,
	hasOutboundTo,
	captureRawStorage,
	readBlockIndex,
	newOrAdvancedSince,
	compareBlockCoverage,
	awaitBlockCoverage,
	BlockStoreProbeError,
	type RawStorageCapture,
	type StrandLibp2p,
} from '../harness/index.js';

// ═════════════════════════════════════════════════════════════════════════════

/** The one-table sApp several other strand scenarios already use. */
const SIMPLE_SCHEMA = `
table Data (
    Key text primary key,
    Val text
);
`;

/**
 * Watcher poll cadence on BOTH nodes. Every quiet window below is derived from it
 * so a cadence change cannot silently turn an assertion vacuous.
 */
const STRAND_WATCH_MS = 1_000;

/** "…and it stays that way" window for Test 2, five watcher polls wide. */
const QUIET_WINDOW_MS = STRAND_WATCH_MS * 5;

/** One shared budget for every converge wait (enrollment, discovery, mesh, coverage). */
const CONVERGE_BUDGET_MS = 30_000;

/**
 * Test 3's block-coverage budget only. Its founder writes tens of rows rather than five,
 * and keeps writing while the catch-up runs, so the store the newcomer has to cover is
 * larger and settles later than Tests 1 and 2's. Given its own, longer wait.
 *
 * NOTE: sized for the ~30 rows a 100 ms writer produces inside the current ~3 s enrollment
 * window (measured 2026-09-08, 18 runs; coverage completed on the FIRST poll every time, so
 * there is a lot of headroom here). If enrollment gets slower, {@link WRITER_TICK_MS} gets
 * shorter, or the store grows for any other reason, this budget has to grow with it — a
 * timeout here would read as a replication failure when it is really a too-small window.
 */
const COVERAGE_BUDGET_MS = 60_000;

/**
 * Anti-vacuity floor for the founder's pre-join strand block count. Measured 2026-09-07
 * (5 runs, both tests): 6 committed blocks every run — `optimystic/schema`, `default/Data`,
 * and four hash-named schema/data/root blocks. Pinned conservatively below the measured
 * value so a storage-layout change does not fail the floor, while an empty or trivially
 * small store still does.
 */
const PRE_JOIN_BLOCK_FLOOR = 4;

/** The rows the founder writes while alone: pre-join-1..5. */
const SEED_ROW_COUNT = 5;
const seedKey = (i: number): string => `pre-join-${i}`;
const seedVal = (i: number): string => `written-while-alone-${i}`;

/** Every strand lifecycle event the newcomer emits, with the discovered rows kept. */
interface StrandEvents {
	discovered: string[];
	discoveredRows: StrandRow[];
	started: string[];
	stopped: string[];
	errors: string[];
}

/** Attach BEFORE `start()` so no watcher poll can beat the listener. */
function collectStrandEvents(node: CadreNode): StrandEvents {
	const events: StrandEvents = { discovered: [], discoveredRows: [], started: [], stopped: [], errors: [] };
	node.on('strand:discovered', ({ strandId, strand }) => {
		events.discovered.push(strandId);
		events.discoveredRows.push(strand);
	});
	node.on('strand:started', ({ strandId }) => void events.started.push(strandId));
	node.on('strand:stopped', ({ strandId }) => void events.stopped.push(strandId));
	node.on('strand:error', ({ strandId }) => void events.errors.push(strandId));
	return events;
}

/**
 * Every `App.Data` row, via an UNFILTERED scan filtered in JavaScript. `Key` is the
 * single-column primary key, so a where-equality on it is a full-PK point lookup the
 * networked optimystic module can MISS — a scan depends only on returning a superset
 * of the live rows (the lookup-shape note in `strand-membership-closed-strand-e2e`).
 */
async function readDataRows(db: Database): Promise<Map<string, string>> {
	const rows = new Map<string, string>();
	for await (const row of db.eval('select Key, Val from App.Data')) {
		rows.set(row.Key as string, row.Val as string);
	}
	return rows;
}

/** Assert all five pre-join rows are present with their exact values. */
function expectSeedRows(rows: Map<string, string>, where: string): void {
	for (let i = 1; i <= SEED_ROW_COUNT; i++) {
		expect(rows.get(seedKey(i)), `${where}: row ${seedKey(i)}`).toBe(seedVal(i));
	}
}

// ── Bring-up, in three pieces so a test can run code between them ────────────
//
// Test 1 and Test 2 call `foundStrandAlone` then `enrollNewcomer` back to back and behave
// exactly as they did when the two were one function. Test 3 exists because it needs to
// start a writer BETWEEN them. `joinDiscoveredStrand` is Test 1's old Phase 2 lifted out
// unchanged, because Test 3 needs the same discovery-and-mesh sequence; Test 2 must NOT
// run it, which is why enrollment and joining are separate steps rather than one.

/** Filled in as each node boots, so a test's `finally` can stop partial state. */
interface LateJoinHandles { founder?: CadreNode; newcomer?: CadreNode; restarted?: CadreNode }

/** Stop whatever is still live, watcher nodes before the founder they read. */
async function stopLateJoin(handles: LateJoinHandles): Promise<void> {
	for (const node of [handles.restarted, handles.newcomer, handles.founder]) {
		// try/catch, not `.catch()`: a `stop()` that throws SYNCHRONOUSLY would escape a
		// promise-tail handler and abandon every node after it in this list.
		try {
			await node?.stop();
		} catch (error) {
			console.warn('[late-join] node teardown failed:', error);
		}
	}
}

/** What Phase 0 produced: the founder, alone, with its strand founded and published. */
interface FoundedStrand {
	/** Names this run in every log line, and salts the party and strand ids. */
	label: string;
	founder: CadreNode;
	founderCapture: RawStorageCapture;
	newcomerCapture: RawStorageCapture;
	/** The founder's strand-scoped raw store — the source side of every coverage claim. */
	founderStore: IRawStorage;
	/** The founder's live strand database, so a test can keep writing to it. */
	founderDb: Database;
	/** The founder's strand blocks at the end of Phase 0: written before the newcomer existed. */
	preJoinIndex: Map<BlockId, ActionRev>;
	strandId: string;
	sApp: SAppConfig;
	partyId: string;
	ownerPublicKey: string;
	founderPeerId: string;
}

/** Phase 0's fixture plus everything Phase 1's enrollment produced. */
interface LateJoinFixture extends FoundedStrand {
	newcomer: CadreNode;
	newcomerPeerId: string;
	/** The newcomer's key, so a cold restart can reuse the SAME identity on the SAME capture. */
	newcomerKey: PrivateKey;
	/** The newcomer's lifecycle events, collected from before its `start()`. */
	events: StrandEvents;
}

/** What the discovery-and-mesh step produced, for the phases that come after it. */
interface JoinedStrand {
	strand: StrandInstance;
	/** The row the newcomer's OWN watcher emitted — never a test-side copy. */
	discoveredRow: StrandRow;
	founderStrandNode: StrandLibp2p;
	newcomerStrandNode: StrandLibp2p;
}

/**
 * Phase 0 — the founder, alone: own owner, addressed `CadrePeer` row, strand added and
 * published, five rows written, ZERO control connections asserted, pre-join block index
 * snapshotted.
 */
async function foundStrandAlone(label: string, handles: LateJoinHandles): Promise<FoundedStrand> {
	const partyId = `late-join-${label}-${Date.now()}`;
	const strandId = `strand-late-${label}-${Date.now()}`;
	const founderCapture = captureRawStorage();
	const newcomerCapture = captureRawStorage();

	const founderKey = await generateKeyPair('Ed25519');
	const founder = new CadreNode(controlNodeConfig({
		partyId, privateKey: founderKey, profile: 'storage',
		strandWatchMs: STRAND_WATCH_MS, storageProvider: founderCapture.provider,
	}));
	handles.founder = founder;
	await founder.start();
	const ownerPublicKey = await makeOwnOwner(founder, founderKey);
	const founderPeerId = founder.peerId!.toString();

	// The founder's self-publish rides the ~1s start timer; the newcomer's seed and the
	// strand-addr RPC target selection both stand on this row carrying a dialable address.
	await waitUntil(async () => {
		const rec = await founder.getControlDatabase()!.queryPeerRecord(founderPeerId);
		return !!rec && rec.addrs.length > 0;
	}, { timeoutMs: 20_000, intervalMs: 250, description: 'founder self-registers a CadrePeer row with addrs' });

	// Open strand, no `founder: true` — that flag seats the CLOSED-strand membership
	// bootstrap rows and is not wanted here.
	const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '1.0.0');
	const founderStrand = await founder.addStrand({
		strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null },
		sAppConfig: sApp,
	});
	expect(founderStrand.status).toBe('active');
	await founder.publishStrand(strandId);

	const founderDb = founderStrand.database!.getDatabase();
	for (let i = 1; i <= SEED_ROW_COUNT; i++) {
		await founderDb.exec('insert into App.Data (Key, Val) values (?, ?)', [seedKey(i), seedVal(i)]);
	}

	// "Written while alone" is a measured fact: zero control connections at this instant.
	expect(founder.getControlNode()!.getConnections().length).toBe(0);

	// The set of blocks written before the newcomer existed — including the named
	// collection-header blocks, written exactly once at collection creation, whose
	// revision never moves again.
	const founderStore = founderCapture.forStrand(strandId);
	const preJoinIndex = await readBlockIndex(founderStore);
	console.log(`[late-join:${label}] founder pre-join strand store holds ${preJoinIndex.size} committed blocks`);
	expect(preJoinIndex.size).toBeGreaterThanOrEqual(PRE_JOIN_BLOCK_FLOOR);

	return {
		label, founder, founderCapture, newcomerCapture, founderStore, founderDb, preJoinIndex,
		strandId, sApp, partyId, ownerPublicKey, founderPeerId,
	};
}

/**
 * Phase 1 — enrollment over the production membership path: vouch before start,
 * `createSeed`/`applySeed`, membership converged and asserted both ways.
 *
 * The newcomer does NOT run the strand here; that is {@link joinDiscoveredStrand}'s job,
 * and Test 2 is the case that never takes it.
 */
async function enrollNewcomer(founded: FoundedStrand, handles: LateJoinHandles): Promise<LateJoinFixture> {
	const { founder, founderPeerId, partyId, ownerPublicKey, newcomerCapture } = founded;

	// Vouch BEFORE the newcomer starts, so the founder's inbound gate admits its
	// cold-start dial and the push-time membership gate authorizes backfill to it.
	const newcomerKey = await generateKeyPair('Ed25519');
	const newcomerPeerId = peerIdFromPrivateKey(newcomerKey).toString();
	await founder.authorizePeer(newcomerPeerId);

	// The newcomer pins the founder's owner key into its node-local trusted-owner anchor,
	// so the default anchored seed policy accepts the seed rather than riding the
	// empty-anchor carve-out.
	const newcomer = new CadreNode(controlNodeConfig({
		partyId, privateKey: newcomerKey, profile: 'transaction',
		strandWatchMs: STRAND_WATCH_MS, storageProvider: newcomerCapture.provider,
		pinnedOwnerKeys: [ownerPublicKey],
	}));
	handles.newcomer = newcomer;
	const events = collectStrandEvents(newcomer);
	await newcomer.start();

	const seed = await founder.createSeed();
	const applied = await newcomer.applySeed(seed);
	if (!applied.success) {
		throw new Error(`newcomer failed to apply the founder's seed: ${JSON.stringify(applied)}`);
	}
	// The gate denies AFTER the dialer's upgrade completes — poll for the settled
	// connection, never the dial's return value.
	await waitUntil(() => hasOutboundTo(newcomer, founderPeerId), {
		timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 250,
		description: 'newcomer holds an outbound control connection to the founder',
	});

	// Membership converged and asserted BOTH ways, so a later strand-addr RPC failure
	// cannot be mistaken for a membership-gate failure.
	await waitForCadrePeerConverged(newcomer.getControlDatabase()!, founderPeerId, {
		timeoutMs: CONVERGE_BUDGET_MS,
		description: "newcomer observes the founder's CadrePeer row",
	});
	expect(await founder.isMember(newcomerPeerId)).toBe(true);
	expect(await newcomer.isMember(founderPeerId)).toBe(true);
	expect(await founder.isAuthorizedMember(newcomerPeerId)).toBe(true);
	expect(await newcomer.isAuthorizedMember(founderPeerId)).toBe(true);

	return { ...founded, newcomer, newcomerPeerId, newcomerKey, events };
}

/**
 * Phase 2 — discovery and join, through the product's own path, ending with the strand
 * mesh asserted in BOTH directions.
 */
async function joinDiscoveredStrand(fx: LateJoinFixture): Promise<JoinedStrand> {
	const { founder, newcomer, strandId, sApp, events } = fx;

	// The newcomer holds no sApp config for the id, so its watcher's first sighting
	// of the row (read over the network) emits `strand:discovered` with the full row.
	await waitUntil(() => events.discovered.includes(strandId), {
		timeoutMs: CONVERGE_BUDGET_MS,
		description: "newcomer's watcher discovers the strand published before it existed",
	});
	const discoveredRow = events.discoveredRows[events.discovered.indexOf(strandId)]!;
	// FounderOwnerKey carries the FOUNDER machine's owner key (any non-null string here);
	// it is what keeps the newcomer's flagless addStrand below a JOIN, not a founding.
	expect(discoveredRow).toEqual({
		Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: expect.any(String),
	});

	// Join with THAT row — never a test-side copy, and never a hand-dial (rule 2).
	let strand: StrandInstance;
	try {
		strand = await newcomer.addStrand({ strandRow: discoveredRow, sAppConfig: sApp });
	} catch (error) {
		// A failed launch keeps being retried by the watcher (the config stays
		// registered), each failure re-emitting strand:error — report the tally, not
		// just the first. A `Missing block` here is bug-strand-join-dies-on-missing-block.
		await sleep(STRAND_WATCH_MS * 3);
		throw new Error(
			`newcomer addStrand failed; ${events.errors.length} strand:error event(s) collected: ${String(error)}`,
			{ cause: error },
		);
	}
	expect(strand.status).toBe('active');

	// The mesh must form from the RPC-resolved seed alone, in BOTH directions. The
	// founder's strand peer id differing from its control peer id keeps this from
	// passing vacuously on the already-open control connection.
	const founderStrandNode = founder.getStrand(strandId)!.libp2pNode!;
	const founderStrandPeerId = founderStrandNode.peerId.toString();
	expect(founderStrandPeerId).not.toBe(fx.founderPeerId);
	const newcomerStrandNode = strand.libp2pNode!;
	const newcomerStrandPeerId = newcomerStrandNode.peerId.toString();
	await waitUntil(
		() => newcomerStrandNode.getConnections().some((c) => c.remotePeer.toString() === founderStrandPeerId),
		{
			timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 250,
			description: "newcomer's strand node connects to the founder's strand node from the RPC-resolved seed",
		},
	);
	await waitUntil(
		() => founderStrandNode.getConnections().some((c) => c.remotePeer.toString() === newcomerStrandPeerId),
		{
			timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 250,
			description: "founder's strand node sees the inbound connection from the newcomer's strand node",
		},
	);

	return { strand, discoveredRow, founderStrandNode, newcomerStrandNode };
}

// ── Test 3's bounded continuous writer ───────────────────────────────────────

/**
 * How long the writer sleeps between rows — a floor on the rate, not a guarantee of it.
 *
 * Deliberately short. The seam this test aims at is narrow (a block committed after the
 * catch-up enumeration passed its id, but before the peer was marked done), so the more
 * rows land inside the join window the better the odds of landing one in it. Measured
 * 2026-09-08 over 18 runs: 100 ms puts 23-29 rows inside enrollment. Do NOT lengthen this to
 * settle a failing run — a founder whose own writes fail under this load is a finding.
 */
const WRITER_TICK_MS = 100;

/**
 * Every Nth tick also re-writes the update-target row, advancing its revision.
 *
 * NOTE: an update is guaranteed to land in the POST-MESH half only because this is smaller
 * than {@link POST_MESH_ROW_FLOOR} — any run of that many consecutive ticks contains a
 * multiple of it. Raise this above the floor (or lower the floor below it) and every
 * revision advance can fall inside the catch-up half, leaving the `behind` gap shape
 * unexercised on the replication side without any assertion noticing.
 */
const WRITER_UPDATE_EVERY = 4;

/**
 * Hard bound on the writer, so a hung enrollment cannot let it run for the whole timeout.
 *
 * NOTE: 400 ticks is ~40 s of writing against a ~3 s enrollment window (measured 2026-09-08,
 * 18 runs: 28-34 rows), so it is currently unreachable. If enrollment ever gets slow enough
 * to reach it, `awaitPhaseRows` fails with "straddle writer exited after N row(s)" rather
 * than a replication error — that message means this bound, not a lost row.
 */
const WRITER_MAX_TICKS = 400;

/** Rows that must exist before enrollment starts, so the straddle is real and not a race. */
const WRITER_WARMUP_ROWS = 3;

/**
 * Rows that must be written AFTER the strand mesh formed. Without this floor, Test 3
 * degenerates into Test 1: every row would have been covered by the peer-join catch-up
 * and the replication half of the seam would go unexercised.
 */
const POST_MESH_ROW_FLOOR = 5;

/** The row the writer keeps UPDATING, so the run covers a revision advancing. */
const UPDATE_KEY = 'straddle-updated-row';
const updateValue = (n: number): string => `revision-${n}`;

/** When a row was written, relative to the strand mesh coming up. */
type StraddlePhase = 'enrolling' | 'post-mesh';

/** One row the writer put in, tagged with when it went in. */
interface StraddleWrite {
	key: string;
	val: string;
	phase: StraddlePhase;
}

/**
 * A bounded writer that keeps inserting into the founder's strand database while the rest
 * of the test enrolls a second machine around it.
 *
 * It captures rather than swallows its own error, and {@link StraddleWriter.stop} re-throws
 * it: a writer that died during enrollment would leave every assertion downstream passing
 * for the worst possible reason — there being nothing left to lose.
 */
interface StraddleWriter {
	/** Every row written so far, in write order. Stable only after {@link stop}. */
	readonly writes: readonly StraddleWrite[];
	/** How many rows carry `phase`. */
	countIn(phase: StraddlePhase): number;
	/** Tag every subsequent row with `phase`. */
	enterPhase(phase: StraddlePhase): void;
	/** The value {@link UPDATE_KEY} was last set to. */
	lastUpdateValue(): string;
	/** How many updates it has issued against that row. */
	updateCount(): number;
	/** Wait until `count` rows carry `phase`; fails fast if the writer has already exited. */
	awaitPhaseRows(phase: StraddlePhase, count: number, timeoutMs: number): Promise<void>;
	/** Stop, await the loop, and re-throw whatever it hit. Safe to call more than once. */
	stop(): Promise<void>;
}

function startStraddleWriter(db: Database, label: string): StraddleWriter {
	const writes: StraddleWrite[] = [];
	let phase: StraddlePhase = 'enrolling';
	let running = true;
	let exited = false;
	let failure: unknown;
	let updates = 0;
	let ticks = 0;

	const loop = (async () => {
		while (running && ticks < WRITER_MAX_TICKS) {
			ticks += 1;
			// Read the phase ONCE per tick: a row whose insert started before the mesh came
			// up but landed after keeps the earlier, more conservative tag.
			const at = phase;
			const key = `straddle-${at}-${ticks}`;
			const val = `written-while-${at}-${ticks}`;
			await db.exec('insert into App.Data (Key, Val) values (?, ?)', [key, val]);
			writes.push({ key, val, phase: at });
			if (ticks % WRITER_UPDATE_EVERY === 0) {
				updates += 1;
				await db.exec('update App.Data set Val = ? where Key = ?', [updateValue(updates), UPDATE_KEY]);
			}
			await sleep(WRITER_TICK_MS);
		}
	})().catch((error: unknown) => {
		failure = error;
	}).finally(() => {
		exited = true;
	});

	const countIn = (of: StraddlePhase): number => writes.filter((w) => w.phase === of).length;

	const stop = async (): Promise<void> => {
		running = false;
		await loop;
		if (failure !== undefined) {
			throw new Error(
				`[${label}] straddle writer failed after ${writes.length} row(s) and ${updates} update(s): ${String(failure)}`,
				{ cause: failure },
			);
		}
	};

	const awaitPhaseRows = async (of: StraddlePhase, count: number, timeoutMs: number): Promise<void> => {
		const deadline = Date.now() + timeoutMs;
		while (countIn(of) < count) {
			if (exited) {
				// `stop()` re-throws the writer's own error when it has one; reaching the
				// line past it means the writer merely ran out of ticks.
				await stop();
				throw new Error(
					`[${label}] straddle writer exited after ${writes.length} row(s) with only ` +
					`${countIn(of)} of ${count} '${of}' row(s)`,
				);
			}
			if (Date.now() > deadline) {
				throw new Error(
					`[${label}] timed out after ${timeoutMs}ms waiting for ${count} '${of}' row(s) ` +
					`from the straddle writer; saw ${countIn(of)}`,
				);
			}
			await sleep(100);
		}
	};

	return {
		writes,
		countIn,
		enterPhase: (next) => { phase = next; },
		lastUpdateValue: () => updateValue(updates),
		updateCount: () => updates,
		awaitPhaseRows,
		stop,
	};
}

// ═════════════════════════════════════════════════════════════════════════════

describe('Late cadre join: the strand follows the newcomer', () => {
	it('delivers a pre-existing strand — blocks and all — to a machine enrolled after the writes', async () => {
		const handles: LateJoinHandles = {};
		try {
			const fx = await enrollNewcomer(await foundStrandAlone('follow', handles), handles);
			const { founder, newcomer, newcomerCapture, founderStore, preJoinIndex, strandId, sApp } = fx;

			// ── Phase 2: discovery and join, through the product's own path ─────
			const joined = await joinDiscoveredStrand(fx);
			const { strand: newcomerStrand, discoveredRow, newcomerStrandNode } = joined;

			// ── Phase 3: the physical claim — RAW STORES ONLY (rule 3) ──────────
			// The peer-join backfill PUSHES the founder's blocks one debounce (~1s) after the
			// strand connection opens; a pull-on-read path could satisfy a select but not this.
			const newcomerStore = newcomerCapture.forStrand(strandId);
			expect(newcomerStore).not.toBe(founderStore);
			await awaitBlockCoverage(founderStore, newcomerStore, {
				timeoutMs: CONVERGE_BUDGET_MS,
				description: "the founder's strand blocks land physically in the newcomer's own store",
			});

			// The "written before you existed" set, named directly: every pre-join block id —
			// the once-written collection headers included — is present on the newcomer.
			const newcomerIndex = await readBlockIndex(newcomerStore);
			const preJoinIds = [...preJoinIndex.keys()];
			console.log(`[late-join:follow] pre-join blocks covered on the newcomer (${preJoinIds.length}): ${preJoinIds.join(', ')}`);
			for (const blockId of preJoinIds) {
				expect(newcomerIndex.has(blockId), `pre-join block ${blockId} present on the newcomer`).toBe(true);
			}

			// ── Phase 4a: founder down, newcomer instance still up ──────────────
			await founder.stop();
			handles.founder = undefined;
			await waitUntil(() => newcomerStrandNode.getConnections().length === 0, {
				timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 250,
				description: "newcomer's strand node drops to zero connections after the founder stops",
			});
			expectSeedRows(await readDataRows(newcomerStrand.database!.getDatabase()), 'founder down');

			// ── Phase 4b: cold restart, same capture, same identity, alone ──────
			await newcomer.stop();
			handles.newcomer = undefined;
			const restarted = new CadreNode(controlNodeConfig({
				partyId: fx.partyId, privateKey: fx.newcomerKey, profile: 'transaction',
				strandWatchMs: STRAND_WATCH_MS, storageProvider: newcomerCapture.provider,
				pinnedOwnerKeys: [fx.ownerPublicKey],
			}));
			handles.restarted = restarted;
			await restarted.start();
			expect(restarted.getControlNode()!.getConnections().length).toBe(0);

			// Control-plane half of the claim: the restarted node still names the strand from
			// its OWN control store — evidence the production discovery path would work here too.
			// NOTE: this read is not gated on the control-network catch-up having covered the
			// newcomer's control store — it relies on that landing during the several seconds of
			// Phases 2-4a (one ~1 s debounce), which held on every run to date. If it ever flakes,
			// gate it with `awaitBlockCoverage(founderCapture.provider('control'),
			// newcomerCapture.provider('control'), …)` BEFORE `newcomer.stop()` — never by reading
			// through the restarted node, which would pull the row in and mask the gap.
			const strandsSeen = await restarted.getControlDatabase()!.queryStrands();
			expect(strandsSeen.map((row) => row.Id)).toContain(strandId);

			// `composeStrand` hydrates the catalog from the persisted vtab schemas, so this
			// warm start re-emits no DDL against the already-populated store.
			const restartedStrand = await restarted.addStrand({ strandRow: discoveredRow, sAppConfig: sApp });
			expect(restartedStrand.status).toBe('active');
			expect(restartedStrand.libp2pNode!.getConnections().length).toBe(0);
			expectSeedRows(await readDataRows(restartedStrand.database!.getDatabase()), 'cold restart, alone');
			// Still alone at the end of the read — nothing could have answered over the wire.
			expect(restartedStrand.libp2pNode!.getConnections().length).toBe(0);
		} finally {
			await stopLateJoin(handles);
		}
	}, 180_000);

	it('a cadre machine that never runs the strand holds none of its blocks', async () => {
		const handles: LateJoinHandles = {};
		try {
			const fx = await enrollNewcomer(await foundStrandAlone('decline', handles), handles);
			const { newcomer, newcomerCapture, founderStore, strandId, events } = fx;

			// The newcomer demonstrably SAW the strand and declined (no addStrand)…
			await waitUntil(() => events.discovered.includes(strandId), {
				timeoutMs: CONVERGE_BUDGET_MS,
				description: "newcomer's watcher discovers the strand it will never run",
			});
			// …then a multi-poll quiet window in which nothing may launch.
			await sleep(QUIET_WINDOW_MS);

			// Joining the cadre is not what delivers a strand; RUNNING it is. No strand-scoped
			// store was ever created, no instance runs, and no launch was ever attempted.
			const scopes = newcomerCapture.scopes();
			console.log(`[late-join:decline] newcomer storage scopes after the quiet window: [${scopes.join(', ')}]`);
			expect(scopes).not.toContain(strandId);
			expect(() => newcomerCapture.forStrand(strandId)).toThrow(BlockStoreProbeError);
			expect(newcomer.getStrands().size).toBe(0);
			expect(events.started).toEqual([]);
			expect(events.errors).toEqual([]);

			// Anti-vacuity: the founder's own strand store is non-empty, so the absence on
			// the newcomer means something.
			expect((await readBlockIndex(founderStore)).size).toBeGreaterThanOrEqual(PRE_JOIN_BLOCK_FLOOR);
		} finally {
			await stopLateJoin(handles);
		}
	}, 120_000);

	it('loses no row written while the newcomer is still catching up', async () => {
		const handles: LateJoinHandles = {};
		let writer: StraddleWriter | undefined;
		try {
			const founded = await foundStrandAlone('straddle', handles);
			const { founderDb, founderStore, strandId } = founded;

			// The row the writer will keep UPDATING. Its first revision is written while the
			// founder is still the party's only machine, so a newcomer that receives that
			// revision and no later one reports as `behind` rather than `absent` — a different
			// failure shape, and one any presence-only check would read as a pass.
			await founderDb.exec('insert into App.Data (Key, Val) values (?, ?)', [UPDATE_KEY, updateValue(0)]);

			writer = startStraddleWriter(founderDb, 'late-join:straddle');
			// The straddle only exists if the writer is demonstrably going before enrollment
			// starts. Nothing below distinguishes "delivered correctly" from "never written".
			await writer.awaitPhaseRows('enrolling', WRITER_WARMUP_ROWS, CONVERGE_BUDGET_MS);

			// Enrollment and the strand join both run WHILE the founder keeps writing. The
			// peer-join catch-up enumerates the founder's store once during this window; every
			// row committed after its own id was passed over has to arrive some other way.
			const fx = await enrollNewcomer(founded, handles);
			const joined = await joinDiscoveredStrand(fx);

			// Mesh up in both directions. From here the newcomer's strand node is in the cohort,
			// so subsequent rows are ordinary replication's problem, not the catch-up's.
			const enrollingRows = writer.countIn('enrolling');
			writer.enterPhase('post-mesh');

			// DIAGNOSTIC ONLY, never asserted: one sample of the coverage gap while the founder
			// is still writing. A moving source can never be covered deterministically, so this
			// cannot be a gate — but it is the only place the test can see whether a gap exists
			// mid-window at all, which is what tells "the seam was exercised and closed" apart
			// from "the newcomer was already caught up before we looked". Raw stores only.
			const midFlight = await compareBlockCoverage(founderStore, fx.newcomerCapture.forStrand(strandId));
			console.log(
				`[late-join:straddle] mid-flight gap (diagnostic, writer still running): ` +
				`absent=${midFlight.absent.length}, behind=${midFlight.behind.length}, ` +
				`metadataOnly=${midFlight.metadataOnly.length}`,
			);

			await writer.awaitPhaseRows('post-mesh', POST_MESH_ROW_FLOOR, CONVERGE_BUDGET_MS);
			await writer.stop();

			// Anti-vacuity, both halves of the seam. Without post-mesh rows this test is Test 1
			// with extra steps; without enrolling rows there is no straddle at all.
			expect(enrollingRows, 'rows written while the newcomer was enrolling').toBeGreaterThan(0);
			const postMeshRows = writer.writes.filter((w) => w.phase === 'post-mesh');
			expect(postMeshRows.length, 'rows written AFTER the strand mesh formed').toBeGreaterThanOrEqual(POST_MESH_ROW_FLOOR);
			expect(writer.updateCount(), `updates issued against ${UPDATE_KEY}`).toBeGreaterThan(0);

			// The updates must have LANDED on the founder. `update … where Key = ?` is a
			// full-PK point lookup; one that matched nothing would no-op silently and leave the
			// revision-advance half of this test asserting over a block that never moved.
			const founderRows = await readDataRows(founderDb);
			expect(founderRows.get(UPDATE_KEY), 'founder-side value of the updated row').toBe(writer.lastUpdateValue());

			// Final tallies, not the `enrollingRows` snapshot: the tick already in flight when
			// `enterPhase` ran keeps its earlier tag, so the snapshot is one or two low.
			console.log(
				`[late-join:straddle] writer wrote ${writer.writes.length} rows ` +
				`(${writer.countIn('enrolling')} while enrolling, ${postMeshRows.length} after the mesh formed) ` +
				`and ${writer.updateCount()} updates to ${UPDATE_KEY}`,
			);

			// ── Physical gate: RAW STORES ONLY, whole store, no narrowing ───────
			// No `include`: everything the founder holds, at a revision no older than the
			// founder's, with content bytes present. The gap kinds are recorded on the way
			// through because a successful wait ends on an empty gap and would otherwise say
			// nothing about which mechanism was still catching up.
			//
			// NOTE: this gate has never actually WITNESSED a gap — coverage has completed on
			// its first poll in every run to date (18 runs to 2026-09-08), so `kindsSeen` logs
			// `[]` and the gate proves the END STATE only. The mid-flight diagnostic above is
			// what shows the newcomer was genuinely behind while the writer ran. If a future
			// change makes the window worth witnessing directly, that needs staging this test
			// does not have — a gate cannot poll a source that is still moving.
			const newcomerStore = fx.newcomerCapture.forStrand(strandId);
			expect(newcomerStore).not.toBe(founderStore);

			// Anti-vacuity for the gate itself: the founder's store must have MOVED since the
			// pre-join snapshot, or "the newcomer covers the founder" would be a claim about
			// Test 1's six blocks and say nothing about the straddling writes.
			const founderFinalIndex = await readBlockIndex(founderStore);
			const movedSincePreJoin = newOrAdvancedSince(founded.preJoinIndex);
			const moved = [...founderFinalIndex].filter(([id, rev]) => movedSincePreJoin(id, rev));
			console.log(
				`[late-join:straddle] founder strand store: ${founded.preJoinIndex.size} blocks pre-join, ` +
				`${founderFinalIndex.size} after the writer stopped, ${moved.length} new or advanced`,
			);
			expect(moved.length, 'founder blocks new or advanced since the pre-join snapshot').toBeGreaterThan(0);

			const kindsSeen = new Set<string>();
			let lastNonEmpty = 'none';
			await awaitBlockCoverage(founderStore, newcomerStore, {
				timeoutMs: COVERAGE_BUDGET_MS,
				description: "every founder block — written before, during and after the join — lands in the newcomer's own store",
				onGap: (gap) => {
					const kinds: string[] = [];
					if (gap.absent.length > 0) kinds.push('absent');
					if (gap.behind.length > 0) kinds.push('behind');
					if (gap.metadataOnly.length > 0) kinds.push('metadataOnly');
					for (const kind of kinds) kindsSeen.add(kind);
					if (kinds.length > 0) {
						lastNonEmpty = `${kinds.join('+')} ` +
							`(absent=${gap.absent.length}, behind=${gap.behind.length}, metadataOnly=${gap.metadataOnly.length})`;
					}
				},
			});
			// Which kind was last outstanding says which half of the seam was slowest: `absent`
			// is a block the newcomer never received at all, `behind` one it holds at a stale
			// revision — the shape the updated row produces.
			console.log(
				`[late-join:straddle] gap kinds seen before coverage closed: ` +
				`[${[...kindsSeen].join(', ')}]; last non-empty gap: ${lastNonEmpty}`,
			);

			// ── Behavioural gate: FOUNDER DOWN, so the read cannot be answered over the wire ──
			// Coverage is proven, so reading through the newcomer can no longer mask a gap
			// (rule 3). Stopping the founder first is what makes this gate say anything the
			// physical gate did not: with the founder up, a coordinator resolving to the
			// AUTHOR would answer every one of these rows out of the founder's own storage
			// and the assertion below would hold even on a newcomer that received nothing.
			await founded.founder.stop();
			handles.founder = undefined;
			await waitUntil(() => joined.newcomerStrandNode.getConnections().length === 0, {
				timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 250,
				description: "newcomer's strand node drops to zero connections after the founder stops",
			});
			const rows = await readDataRows(joined.strand.database!.getDatabase());
			const missing = writer.writes
				.filter((w) => rows.get(w.key) !== w.val)
				.map((w) => `${w.key} [written ${w.phase}] expected '${w.val}', got '${String(rows.get(w.key))}'`);
			expect(missing, 'rows the writer committed that the newcomer cannot read back').toEqual([]);
			expect(rows.get(UPDATE_KEY), 'newcomer-side value of the updated row').toBe(writer.lastUpdateValue());
			expectSeedRows(rows, 'straddle: newcomer after coverage');
			// Still alone at the end of the read — nothing could have answered over the wire.
			expect(joined.newcomerStrandNode.getConnections().length).toBe(0);
		} finally {
			// Stop the writer FIRST and swallow only here: a stray insert against a stopping
			// strand database would throw into teardown and mask whatever actually failed.
			try {
				await writer?.stop();
			} catch (error) {
				console.warn('[late-join:straddle] writer teardown reported:', error);
			}
			await stopLateJoin(handles);
		}
	}, 180_000);
});
