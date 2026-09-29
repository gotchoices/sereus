/**
 * An always-on machine keeps a full copy of a strand its app is not installed on, so a phone
 * that is lost after its writes reached that machine loses nothing.
 *
 * One party. The ALWAYS-ON node (`profile: 'storage'`, `hostUnclaimedStrands: true`) never
 * calls `addStrand`: it runs the strand as a storage replica — the strand's libp2p node, raw
 * store and `Strand` membership schema, without the app's schema. A PHONE founds an open
 * strand and writes rows, some before the replica exists (they reach it by the peer-join
 * block catch-up) and some after the strand mesh formed (they reach it by ordinary cohort
 * replication). The phone is then stopped and its storage dropped, and a FRESH phone is
 * enrolled into the party, joins the strand, and reads every row back while the always-on
 * node is the only other machine up.
 *
 * The always-on node is the party's owner and the one that publishes the strand row: a
 * party has exactly one owner (nothing seats a second), and a replacement phone can only be
 * enrolled by an owner that survived the loss. The row therefore names the always-on node as
 * its founder, so its replica launch also covers the rule that a replica is always a joiner.
 *
 * Rules carried over from `strand-late-cadre-join.integration.ts`:
 *
 * 1. ORDERING IS MEASURED. The phone's first rows land while the always-on node runs no
 *    instance of the strand at all — asserted, not narrated.
 *
 * 2. NO TEST-SIDE STRAND DIAL. Every strand mesh forms from `resolveCohortSeed`'s strand-addr
 *    RPC over the control connections enrollment opened.
 *
 * 3. THE PHYSICAL CLAIM READS RAW STORES ONLY. The always-on node holds no app schema, so it
 *    could not read the rows through its database anyway; the claim that it holds them is a
 *    block-coverage check of the phone's strand store against its own (`block-store-probe.ts`).
 *
 * An open strand keeps this off the closed-strand admission path, whose physical-replication
 * scenario has a flake history. A closed-strand replica runs the same joiner path as any
 * second machine of a party (`strand-membership-second-machine.integration.ts`).
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import type { Database } from '@quereus/quereus';
import { CadreNode } from '@serfab/cadre-core';
import type { StrandRow } from '@serfab/cadre-core';
import {
	waitUntil,
	waitForCadrePeerConverged,
	controlNodeConfig,
	createSignedSAppConfig,
	makeOwnOwner,
	hasOutboundTo,
	captureRawStorage,
	readBlockIndex,
	awaitBlockCoverage,
	readCohort,
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

/** Watcher poll cadence on every node. */
const STRAND_WATCH_MS = 1_000;

/** One shared budget for every converge wait (enrollment, discovery, mesh, coverage). */
const CONVERGE_BUDGET_MS = 30_000;

/**
 * Anti-vacuity floor for the phone's strand store before the coverage check — the same floor
 * `strand-late-cadre-join` measured for five rows of this schema (6 blocks every run).
 */
const PHONE_BLOCK_FLOOR = 4;

/** Rows written before the always-on node runs the strand, then after the mesh formed. */
const ROWS_PER_PHASE = 5;
type WritePhase = 'before-replica' | 'after-mesh';
const rowKey = (phase: WritePhase, i: number): string => `${phase}-${i}`;
const rowVal = (phase: WritePhase, i: number): string => `written-${phase}-${i}`;
const PHASES: readonly WritePhase[] = ['before-replica', 'after-mesh'];

async function writeRows(db: Database, phase: WritePhase): Promise<void> {
	for (let i = 1; i <= ROWS_PER_PHASE; i++) {
		await db.exec('insert into App.Data (Key, Val) values (?, ?)', [rowKey(phase, i), rowVal(phase, i)]);
	}
}

/**
 * Every `App.Data` row, via an unfiltered scan: a where-equality on the single-column primary
 * key is a point lookup the networked optimystic module can miss (see
 * `strand-late-cadre-join`'s `readDataRows`).
 */
async function readDataRows(db: Database): Promise<Map<string, string>> {
	const rows = new Map<string, string>();
	for await (const row of db.eval('select Key, Val from App.Data')) {
		rows.set(row.Key as string, row.Val as string);
	}
	return rows;
}

/** The `strand:discovered` rows a node emitted, collected from before its `start()`. */
function collectDiscovered(node: CadreNode): StrandRow[] {
	const discovered: StrandRow[] = [];
	node.on('strand:discovered', ({ strand }) => void discovered.push(strand));
	return discovered;
}

interface Handles { alwaysOn?: CadreNode; phone?: CadreNode; replacement?: CadreNode }

async function stopAll(handles: Handles): Promise<void> {
	for (const node of [handles.replacement, handles.phone, handles.alwaysOn]) {
		try {
			await node?.stop();
		} catch (error) {
			console.warn('[always-on-replica] node teardown failed:', error);
		}
	}
}

interface Owner {
	node: CadreNode;
	peerId: string;
	publicKey: string;
	partyId: string;
}

/** The always-on node: party owner and replica host, its `CadrePeer` row addressed. */
async function startAlwaysOn(capture: RawStorageCapture): Promise<Owner & { discovered: StrandRow[] }> {
	const partyId = `always-on-replica-${Date.now()}`;
	const key = await generateKeyPair('Ed25519');
	const node = new CadreNode(controlNodeConfig({
		partyId, privateKey: key, profile: 'storage', hostUnclaimedStrands: true,
		strandWatchMs: STRAND_WATCH_MS, storageProvider: capture.provider,
	}));
	const discovered = collectDiscovered(node);
	await node.start();
	const publicKey = await makeOwnOwner(node, key);
	const peerId = node.peerId!.toString();
	// Enrollment seeds and the strand-addr RPC target selection both stand on this row
	// carrying a dialable address.
	await waitUntil(async () => {
		const rec = await node.getControlDatabase()!.queryPeerRecord(peerId);
		return !!rec && rec.addrs.length > 0;
	}, { timeoutMs: 20_000, intervalMs: 250, description: 'always-on node self-registers a CadrePeer row with addrs' });
	return { node, peerId, publicKey, partyId, discovered };
}

/**
 * A phone-shaped machine enrolled over the production membership path: vouched before start,
 * `createSeed`/`applySeed`, membership converged both ways.
 */
async function enrollPhone(
	owner: Owner, capture: RawStorageCapture
): Promise<{ node: CadreNode; peerId: string; discovered: StrandRow[] }> {
	const key: PrivateKey = await generateKeyPair('Ed25519');
	const peerId = peerIdFromPrivateKey(key).toString();
	await owner.node.authorizePeer(peerId);
	const node = new CadreNode(controlNodeConfig({
		partyId: owner.partyId, privateKey: key, profile: 'transaction',
		strandWatchMs: STRAND_WATCH_MS, storageProvider: capture.provider,
		pinnedOwnerKeys: [owner.publicKey],
	}));
	const discovered = collectDiscovered(node);
	await node.start();
	const applied = await node.applySeed(await owner.node.createSeed());
	if (!applied.success) {
		throw new Error(`phone failed to apply the owner's seed: ${JSON.stringify(applied)}`);
	}
	await waitUntil(() => hasOutboundTo(node, owner.peerId), {
		timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 250,
		description: 'phone holds an outbound control connection to the always-on node',
	});
	await waitForCadrePeerConverged(node.getControlDatabase()!, owner.peerId, {
		timeoutMs: CONVERGE_BUDGET_MS,
		description: "phone observes the always-on node's CadrePeer row",
	});
	expect(await owner.node.isAuthorizedMember(peerId)).toBe(true);
	expect(await node.isAuthorizedMember(owner.peerId)).toBe(true);
	return { node, peerId, discovered };
}

// ═════════════════════════════════════════════════════════════════════════════

describe('Always-on storage replica', () => {
	it('keeps every block a lost phone wrote and serves them to its replacement', async () => {
		const handles: Handles = {};
		try {
			const alwaysOnCapture = captureRawStorage();
			const phoneCapture = captureRawStorage();
			const owner = await startAlwaysOn(alwaysOnCapture);
			handles.alwaysOn = owner.node;
			const alwaysOn = owner.node;

			// ── Phase 1: the phone founds the strand and writes while nothing replicates it ──
			const phone = await enrollPhone(owner, phoneCapture);
			handles.phone = phone.node;
			const strandId = `strand-replica-${Date.now()}`;
			const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '1.0.0');
			const phoneStrand = await phone.node.addStrand({
				strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null },
				sAppConfig: sApp,
				founder: true,
			});
			expect(phoneStrand.status).toBe('active');
			const phoneDb = phoneStrand.database!.getDatabase();
			await writeRows(phoneDb, 'before-replica');
			expect(alwaysOn.getStrand(strandId), 'always-on node runs nothing before the row is published').toBeUndefined();

			// ── Phase 2: the row is published; the always-on node hosts it with no sApp config ──
			await alwaysOn.publishStrand(strandId);
			await waitUntil(() => alwaysOn.getStrand(strandId)?.database !== undefined, {
				timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 250,
				description: 'always-on node launches a storage replica and holds the strand Header',
			});
			const replica = alwaysOn.getStrand(strandId)!;
			expect(replica.sAppInfo, 'a replica runs without the app').toBeUndefined();
			expect(owner.discovered.map((row) => row.Id)).toEqual([strandId]);
			expect(alwaysOn.getDiscoveredStrands().has(strandId), 'still unclaimed by any app').toBe(true);
			// The sApp id read off the replica's own Strand.Header — what an `sAppId` strand
			// filter decides on for a strand no local config claims.
			await waitUntil(() => alwaysOn.getSAppId(strandId) === sApp.id, {
				timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 250,
				description: "always-on node records the replica's sApp id from its Strand.Header",
			});

			const replicaStrandPeerId = replica.libp2pNode!.peerId.toString();
			const phoneStrandNode = phoneStrand.libp2pNode!;
			await waitUntil(
				() => phoneStrandNode.getConnections().some((c) => c.remotePeer.toString() === replicaStrandPeerId),
				{
					timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 250,
					description: "phone's strand node connects to the replica from the RPC-resolved seed",
				},
			);

			// ── Phase 3: more writes, now replicated to a live cohort member; physical claim ──
			await writeRows(phoneDb, 'after-mesh');
			const phoneStore = phoneCapture.forStrand(strandId);
			const alwaysOnStore = alwaysOnCapture.forStrand(strandId);
			const phoneIndex = await readBlockIndex(phoneStore);
			console.log(`[always-on-replica] phone strand store holds ${phoneIndex.size} committed blocks`);
			expect(phoneIndex.size).toBeGreaterThanOrEqual(PHONE_BLOCK_FLOOR);
			await awaitBlockCoverage(phoneStore, alwaysOnStore, {
				timeoutMs: CONVERGE_BUDGET_MS,
				description: "every block the phone holds lands physically in the always-on node's store",
			});

			// ── Phase 4: the phone is lost — stopped, and its storage never used again ──
			await phone.node.stop();
			handles.phone = undefined;
			await waitUntil(() => replica.libp2pNode!.getConnections().length === 0, {
				timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 250,
				description: "replica's strand node drops to zero connections after the phone stops",
			});
			// Enrolling the replacement is a control write whose revocation check reads the
			// never-written `Revocation` table, which fails `cohort-unreachable` while the lost
			// phone is still in the owner's control cohort. A real replacement arrives long after.
			await waitUntil(async () => !(await readCohort(alwaysOn.getControlNode()!, 'always-on')).includes(phone.peerId), {
				timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 250,
				description: "the lost phone leaves the always-on node's control cohort",
			});

			// ── Phase 5: a fresh phone joins and reads everything back from the replica ──
			const replacement = await enrollPhone(owner, captureRawStorage());
			handles.replacement = replacement.node;
			await waitUntil(() => replacement.discovered.some((row) => row.Id === strandId), {
				timeoutMs: CONVERGE_BUDGET_MS,
				description: "replacement phone's watcher discovers the strand",
			});
			const discoveredRow = replacement.discovered.find((row) => row.Id === strandId)!;
			const replacementStrand = await replacement.node.addStrand({ strandRow: discoveredRow, sAppConfig: sApp });
			expect(replacementStrand.status).toBe('active');

			const rows = await readDataRows(replacementStrand.database!.getDatabase());
			const expected = new Map(PHASES.flatMap((phase) =>
				Array.from({ length: ROWS_PER_PHASE }, (_, k) => [rowKey(phase, k + 1), rowVal(phase, k + 1)] as const)));
			expect(rows).toEqual(expected);
			// The only strand peer that could have answered is the replica.
			const strandPeers = replacementStrand.libp2pNode!.getConnections().map((c) => c.remotePeer.toString());
			expect(new Set(strandPeers)).toEqual(new Set([replicaStrandPeerId]));
		} finally {
			await stopAll(handles);
		}
	}, 180_000);
});
