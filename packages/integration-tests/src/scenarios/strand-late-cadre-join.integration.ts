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
 * 3. PHASE 3 NEVER READS THE NEWCOMER'S STRAND DATABASE. A read issued through the node
 *    under test can itself pull blocks into that node's store and mask the gap
 *    (`harness/block-store-probe.ts`). The physical claim is read off raw stores only;
 *    the newcomer's database is first read in Phase 4a, after coverage is already proven
 *    and the founder is down.
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
	awaitBlockCoverage,
	BlockStoreProbeError,
	type RawStorageCapture,
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

// ── Bring-up: Phase 0 (founder alone) + Phase 1 (enrollment) ─────────────────

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

interface LateJoinFixture {
	founder: CadreNode;
	newcomer: CadreNode;
	founderCapture: RawStorageCapture;
	newcomerCapture: RawStorageCapture;
	/** The founder's strand-scoped raw store — the source side of every coverage claim. */
	founderStore: IRawStorage;
	/** The founder's strand blocks at the end of Phase 0: written before the newcomer existed. */
	preJoinIndex: Map<BlockId, ActionRev>;
	strandId: string;
	sApp: SAppConfig;
	partyId: string;
	ownerPublicKey: string;
	founderPeerId: string;
	newcomerPeerId: string;
	/** The newcomer's key, so Phase 4b can restart the SAME identity on the SAME capture. */
	newcomerKey: PrivateKey;
	/** The newcomer's lifecycle events, collected from before its `start()`. */
	events: StrandEvents;
}

/**
 * Phase 0 — the founder, alone: own owner, addressed `CadrePeer` row, strand added and
 * published, five rows written, ZERO control connections asserted, pre-join block index
 * snapshotted. Phase 1 — enrollment over the production membership path: vouch before
 * start, `createSeed`/`applySeed`, membership converged and asserted both ways.
 */
async function bringUpLateJoin(label: string, handles: LateJoinHandles): Promise<LateJoinFixture> {
	const partyId = `late-join-${label}-${Date.now()}`;
	const strandId = `strand-late-${label}-${Date.now()}`;
	const founderCapture = captureRawStorage();
	const newcomerCapture = captureRawStorage();

	// ── Phase 0: the founder, alone ─────────────────────────────────────────
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
		strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' },
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

	// ── Phase 1: enrollment, the production membership path ─────────────────
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

	return {
		founder, newcomer, founderCapture, newcomerCapture, founderStore, preJoinIndex,
		strandId, sApp, partyId, ownerPublicKey, founderPeerId, newcomerPeerId, newcomerKey, events,
	};
}

// ═════════════════════════════════════════════════════════════════════════════

describe('Late cadre join: the strand follows the newcomer', () => {
	it('delivers a pre-existing strand — blocks and all — to a machine enrolled after the writes', async () => {
		const handles: LateJoinHandles = {};
		try {
			const fx = await bringUpLateJoin('follow', handles);
			const { founder, newcomer, newcomerCapture, founderStore, preJoinIndex, strandId, sApp, events } = fx;

			// ── Phase 2: discovery and join, through the product's own path ─────
			// The newcomer holds no sApp config for the id, so its watcher's first sighting
			// of the row (read over the network) emits `strand:discovered` with the full row.
			await waitUntil(() => events.discovered.includes(strandId), {
				timeoutMs: CONVERGE_BUDGET_MS,
				description: "newcomer's watcher discovers the strand published before it existed",
			});
			const discoveredRow = events.discoveredRows[events.discovered.indexOf(strandId)]!;
			expect(discoveredRow).toEqual({ Id: strandId, MemberPrivateKey: null, Type: 'o' });

			// Join with THAT row — never a test-side copy, and never a hand-dial (rule 2).
			let newcomerStrand: StrandInstance;
			try {
				newcomerStrand = await newcomer.addStrand({ strandRow: discoveredRow, sAppConfig: sApp });
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
			expect(newcomerStrand.status).toBe('active');

			// The mesh must form from the RPC-resolved seed alone, in BOTH directions. The
			// founder's strand peer id differing from its control peer id keeps this from
			// passing vacuously on the already-open control connection.
			const founderStrandNode = founder.getStrand(strandId)!.libp2pNode!;
			const founderStrandPeerId = founderStrandNode.peerId.toString();
			expect(founderStrandPeerId).not.toBe(fx.founderPeerId);
			const newcomerStrandNode = newcomerStrand.libp2pNode!;
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
			const fx = await bringUpLateJoin('decline', handles);
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
});
