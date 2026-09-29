/**
 * A strand a phone joins from ANOTHER party ends up on its party's always-on machine, and
 * leaves it when the phone leaves the strand.
 *
 * A party's own strands reach its always-on machine through its `Strand` table. A strand
 * joined through formation has its `Strand` row in the other party's control database, so
 * the joining machine records the join locally and an owner machine's connected reconcile
 * pass publishes it as a party-wide `CadreControl.JoinedStrand` row. That row is what every
 * machine's strand watcher offers, so a storage replica host launches it; removing the row
 * (`forgetJoinedStrand`) is how the whole party leaves (see `joined-strand-store.ts`).
 *
 * ── Topology ──
 *
 *   HOST     — its own party, sole owner, storage profile. Founds an OPEN strand and
 *              publishes a formation invitation bound to it (as in
 *              `strand-formation-cross-party-seed`).
 *   PHONE    — the joiner party's genesis owner, `profile: 'transaction'` (the reference
 *              React Native deployment: the phone founds the party and enrolls its
 *              always-on machine). Redeems the invitation, claims the strand with the
 *              app's config, and writes rows.
 *   ALWAYS-ON — the joiner party's second machine, `profile: 'storage'`,
 *              `hostUnclaimedStrands: true`, enrolled by the phone. Never calls
 *              `formStrand` or `addStrand`.
 *
 * What the same-party replica does for a replacement phone is proved by
 * `strand-always-on-replica-survives-phone-loss`; this file proves only that the party-wide
 * record puts the strand on the always-on machine and later takes it off.
 *
 * Rules carried over from that scenario:
 *
 * 1. ORDERING IS MEASURED. At the first check the join is recorded on the phone only, the
 *    party-wide row does not exist, and the always-on machine runs no instance — all read,
 *    not narrated. The phone's reconcile timer is parked for the same reason: publication
 *    happens when this test calls `reconcileControlCohort`, not when a timer fires.
 *
 * 2. NO TEST-SIDE STRAND DIAL. The phone reaches the host's strand node from the addresses
 *    the formation result carried; the always-on machine reaches the phone's from the
 *    strand-addr RPC over the control connection enrollment opened.
 *
 * 3. THE PHYSICAL CLAIM READS RAW STORES ONLY. The replica holds no app schema, so its copy
 *    is checked by block coverage of the phone's strand store against its own
 *    (`block-store-probe.ts`).
 *
 * An open strand keeps this off the closed-strand admission path, which has a flake history.
 * A closed join differs only in the replica resolving the `StrandPartyKey` row `formStrand`
 * seated, which runs the same launch code.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { Database } from '@quereus/quereus';
import {
	CadreNode,
	ControlFormationUsageRecorder,
	InMemoryKeyStore,
	KeyStoreJoinedStrandStore,
} from '@serfab/cadre-core';
import type { OpenInvitation, SAppConfig } from '@serfab/cadre-core';
import {
	waitUntil,
	waitForCadrePeerConverged,
	controlNodeConfig,
	createSignedSAppConfig,
	makeOwnOwner,
	hasOutboundTo,
	connectionsTo,
	captureRawStorage,
	readBlockIndex,
	awaitBlockCoverage,
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

const SAPP_ID = 'sapp-always-on-cross-party';
const YEAR_MS = 365 * 24 * 3600_000;

/** Watcher poll cadence on every node. */
const STRAND_WATCH_MS = 1_000;

/** Longer than the test, so the phone's recurring reconcile never publishes on its own. */
const PHONE_RECONCILE_PARKED_MS = 600_000;

/** One shared budget for every converge wait (enrollment, mesh, launch, coverage, removal). */
const CONVERGE_BUDGET_MS = 30_000;

/**
 * Anti-vacuity floor for the phone's strand store before the coverage check — the floor
 * `strand-always-on-replica-survives-phone-loss` uses for the same schema and row count.
 */
const PHONE_BLOCK_FLOOR = 4;

/** Rows the phone writes before the join is published, then after the replica is up. */
const ROWS_PER_PHASE = 5;
type WritePhase = 'before-publication' | 'after-replica';

async function writeRows(db: Database, phase: WritePhase): Promise<void> {
	for (let i = 1; i <= ROWS_PER_PHASE; i++) {
		await db.exec('insert into App.Data (Key, Val) values (?, ?)', [`${phase}-${i}`, `written-${phase}-${i}`]);
	}
}

/**
 * A reconcile pass that STARTED after this call: `reconcileControlCohort` hands back a pass
 * already in flight, which may have run its publish step before the join was recorded.
 */
async function freshReconcilePass(node: CadreNode): Promise<void> {
	await node.reconcileControlCohort();
	await node.reconcileControlCohort();
}

interface Handles { host?: CadreNode; phone?: CadreNode; alwaysOn?: CadreNode }

async function stopAll(handles: Handles): Promise<void> {
	for (const node of [handles.alwaysOn, handles.phone, handles.host]) {
		try {
			await node?.stop();
		} catch (error) {
			console.warn('[always-on-cross-party] node teardown failed:', error);
		}
	}
}

interface Host {
	node: CadreNode;
	strandId: string;
	strandPeerId: string;
	sApp: SAppConfig;
	invitation: OpenInvitation;
}

/** The other party: founds an open strand, then publishes an invitation bound to it. */
async function startHost(runTag: number, handles: Handles): Promise<Host> {
	const key = await generateKeyPair('Ed25519');
	const node = new CadreNode(controlNodeConfig({
		partyId: `host-${runTag}`, privateKey: key, profile: 'storage', enableRelay: true,
	}));
	handles.host = node;
	await node.start();
	await makeOwnOwner(node, key);
	await node.initializeStrandSolicitation({
		formationUsageRecorder: new ControlFormationUsageRecorder(node.getControlDatabase()!),
	});
	const strandId = `strand-always-on-cross-party-${runTag}`;
	const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '1.0.0');
	// Founded before the invitation is published, so the formation result carries live
	// strand addresses — the phone's only route to the host's strand node.
	const founded = await node.foundStrand({ strandId, type: 'o', sAppConfig: sApp });
	expect(founded.founded).toBe(true);
	const invitation = await node.createOpenInvitation(SAPP_ID, YEAR_MS);
	await node.publishFormationInvite(invitation.token, SAPP_ID, {
		strandId,
		expiresAtMs: Date.now() + YEAR_MS,
		totalUses: 1,
	});
	return { node, strandId, strandPeerId: founded.instance.libp2pNode!.peerId.toString(), sApp, invitation };
}

interface Phone {
	node: CadreNode;
	peerId: string;
	publicKey: string;
	partyId: string;
	joinedStore: KeyStoreJoinedStrandStore;
}

/** The joiner party's genesis owner, its `CadrePeer` row addressed so it can enroll. */
async function startPhone(runTag: number, capture: RawStorageCapture, handles: Handles): Promise<Phone> {
	const partyId = `joiner-${runTag}`;
	const key = await generateKeyPair('Ed25519');
	// Kept by the test so step 2 can read that publication drained the local record.
	const joinedStore = new KeyStoreJoinedStrandStore(new InMemoryKeyStore(), partyId);
	const node = new CadreNode(controlNodeConfig({
		partyId, privateKey: key, profile: 'transaction',
		strandWatchMs: STRAND_WATCH_MS, storageProvider: capture.provider,
		reconcileMs: PHONE_RECONCILE_PARKED_MS, joinedStrandStore: joinedStore,
	}));
	handles.phone = node;
	await node.start();
	const publicKey = await makeOwnOwner(node, key);
	const peerId = node.peerId!.toString();
	await waitUntil(async () => {
		const rec = await node.getControlDatabase()!.queryPeerRecord(peerId);
		return !!rec && rec.addrs.length > 0;
	}, { timeoutMs: 20_000, intervalMs: 250, description: 'phone self-registers a CadrePeer row with addrs' });
	return { node, peerId, publicKey, partyId, joinedStore };
}

/** The always-on machine, enrolled by the phone over the production membership path. */
async function enrollAlwaysOn(
	phone: Phone, capture: RawStorageCapture, handles: Handles
): Promise<{ node: CadreNode; peerId: string }> {
	const key = await generateKeyPair('Ed25519');
	const peerId = peerIdFromPrivateKey(key).toString();
	await phone.node.authorizePeer(peerId);
	const node = new CadreNode(controlNodeConfig({
		partyId: phone.partyId, privateKey: key, profile: 'storage', hostUnclaimedStrands: true,
		strandWatchMs: STRAND_WATCH_MS, storageProvider: capture.provider,
		pinnedOwnerKeys: [phone.publicKey],
	}));
	handles.alwaysOn = node;
	await node.start();
	const applied = await node.applySeed(await phone.node.createSeed());
	if (!applied.success) {
		throw new Error(`always-on machine failed to apply the phone's seed: ${JSON.stringify(applied)}`);
	}
	await waitUntil(() => hasOutboundTo(node, phone.peerId), {
		timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 250,
		description: 'always-on machine holds an outbound control connection to the phone',
	});
	await waitForCadrePeerConverged(node.getControlDatabase()!, phone.peerId, {
		timeoutMs: CONVERGE_BUDGET_MS,
		description: "always-on machine observes the phone's CadrePeer row",
	});
	expect(await phone.node.isAuthorizedMember(peerId)).toBe(true);
	expect(await node.isAuthorizedMember(phone.peerId)).toBe(true);
	return { node, peerId };
}

// ═════════════════════════════════════════════════════════════════════════════

describe('Always-on machine hosts a strand joined from another party', () => {
	it('launches a replica from the party-wide join and stops it when the phone leaves', async () => {
		const handles: Handles = {};
		try {
			const runTag = Date.now();
			const phoneCapture = captureRawStorage();
			const alwaysOnCapture = captureRawStorage();
			const host = await startHost(runTag, handles);
			const { strandId } = host;
			const phone = await startPhone(runTag, phoneCapture, handles);
			const alwaysOn = await enrollAlwaysOn(phone, alwaysOnCapture, handles);
			const phoneControl = phone.node.getControlDatabase()!;

			// `formStrand` would register the formation handler itself, and a change to the
			// node's own protocols can start a reconcile pass that publishes the join before
			// step 1 reads. Registered and settled here instead.
			// NOTE: any other `self:peer:update` on the phone's control node between here and
			// step 1's reads (an address change) would publish early and fail step 1; none
			// occurs on loopback. If step 1 flakes on "join recorded on the phone", look there.
			await phone.node.initializeStrandSolicitation();
			await freshReconcilePass(phone.node);

			// ── Step 1: the phone joins; the join is recorded on the phone only ──
			const formResult = await phone.node.formStrand(host.invitation, {
				partyId: phone.partyId,
				purpose: 'always-on cross-party replica',
			});
			expect(formResult.strandId).toBe(strandId);
			expect(formResult.strandAddrs.length).toBeGreaterThan(0);
			const phoneStrand = await phone.node.addStrand({
				strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null },
				sAppConfig: host.sApp,
			});
			expect(phoneStrand.status).toBe('active');
			const phoneStrandNode = phoneStrand.libp2pNode!;
			await waitUntil(
				() => phoneStrandNode.getConnections().some((c) => c.remotePeer.toString() === host.strandPeerId),
				{
					timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 250,
					description: "phone's strand node connects to the host's from the formation-carried addresses",
				},
			);
			const phoneDb = phoneStrand.database!.getDatabase();
			await writeRows(phoneDb, 'before-publication');

			expect((await phone.joinedStore.list()).map((record) => record.Id), 'join recorded on the phone').toEqual([strandId]);
			expect(await phoneControl.queryJoinedStrand(strandId), 'no party-wide row before the reconcile pass').toBeNull();
			expect(alwaysOn.node.getStrand(strandId), 'always-on machine runs nothing before publication').toBeUndefined();

			// ── Step 2: the phone's connected owner reconcile pass publishes the join ──
			expect(connectionsTo(phone.node, alwaysOn.peerId).length, 'phone holds a control connection to its always-on machine')
				.toBeGreaterThan(0);
			await freshReconcilePass(phone.node);
			expect(await phoneControl.queryJoinedStrand(strandId), 'party-wide JoinedStrand row on the phone').toEqual({
				Id: strandId, Type: 'o', MemberPrivateKey: null, FounderOwnerKey: null,
			});
			expect(await phone.joinedStore.list(), 'publication drains the local record').toEqual([]);

			// ── Step 3: the always-on machine hosts it as a replica; physical claim ──
			await waitUntil(() => alwaysOn.node.getStrand(strandId)?.libp2pNode !== undefined, {
				timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 250,
				description: "always-on machine's watcher launches a storage replica from the party-wide row",
			});
			const replica = alwaysOn.node.getStrand(strandId)!;
			expect(replica.sAppInfo, 'a replica runs without the app').toBeUndefined();
			const replicaStrandPeerId = replica.libp2pNode!.peerId.toString();
			await waitUntil(
				() => phoneStrandNode.getConnections().some((c) => c.remotePeer.toString() === replicaStrandPeerId),
				{
					timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 250,
					description: "phone's strand node connects to the replica from the RPC-resolved seed",
				},
			);
			await writeRows(phoneDb, 'after-replica');
			const phoneStore = phoneCapture.forStrand(strandId);
			const phoneIndex = await readBlockIndex(phoneStore);
			console.log(`[always-on-cross-party] phone strand store holds ${phoneIndex.size} committed blocks`);
			expect(phoneIndex.size).toBeGreaterThanOrEqual(PHONE_BLOCK_FLOOR);
			// Waits on coverage, not on the launch: the replica holds nothing until it has
			// the strand's Header from a peer.
			await awaitBlockCoverage(phoneStore, alwaysOnCapture.forStrand(strandId), {
				timeoutMs: CONVERGE_BUDGET_MS,
				description: "every block the phone holds lands physically in the always-on machine's store",
			});

			// ── Step 4: the phone leaves for the whole party; the replica stops ──
			const stampId = await phoneControl.queryJoinedStrandStampId(strandId);
			expect(stampId, 'the party-wide row carries a stamp for its tombstone').not.toBeNull();
			await phone.node.forgetJoinedStrand(strandId);
			expect(await phoneControl.queryJoinedStrand(strandId), 'party-wide row removed').toBeNull();
			const tombstones = (await phoneControl.queryRevocations())
				.filter((row) => row.tableName === 'JoinedStrand' && row.rowKey === strandId);
			expect(tombstones.map((row) => row.stampId), 'a Revocation tombstone retires the row').toEqual([stampId]);
			expect(phone.node.getStrand(strandId), 'phone stopped the strand').toBeUndefined();
			await waitUntil(() => alwaysOn.node.getStrand(strandId) === undefined, {
				timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 250,
				description: "always-on machine's watcher sees the party-wide row gone and stops its replica",
			});
			expect(host.node.getStrand(strandId)?.status, "the host party's strand is untouched").toBe('active');
		} finally {
			await stopAll(handles);
		}
	}, 180_000);
});
