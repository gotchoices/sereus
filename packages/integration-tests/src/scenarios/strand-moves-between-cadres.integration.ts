/**
 * An app's strands move from the one-node cadre it founded into the user's main cadre, over a
 * real network (`docs/architecture.md` → "An app joins an existing cadre" → "Moving the app's
 * strands"). `exportStrandBundle` and `adoptStrandBundle` are unit-tested in cadre-core; this is
 * the proof that a moved strand's other member, which is told nothing, keeps syncing with it, and
 * that the new cadre's always-on machine starts hosting it.
 *
 * Machines:
 * - **N**, the app's one node: `transaction` profile, one identity key for its whole life, its
 *   joined-strand records in one key store both incarnations share (the phone kit's secure
 *   store). It founds party B as its own owner, then is stopped, and a node with the same key over
 *   the same raw stores starts for party A with no owner genesis (the kit's `origin: 'joined'`).
 * - **P**, an external party: one `storage` node, its own owner.
 * - **O**, party A's owner, phone-shaped (`listenAddrs: []`), and **M**, A's always-on member
 *   (`storage`, `hostUnclaimedStrands`), admitted by O.
 * - **Q**, a stranger party that redeems N's moved invitation after the move.
 *
 * N listens on loopback rather than nowhere: P and Q redeem formation invitations by dialing N,
 * and a relay-only link is left to the relayed formation scenarios (the move changes no
 * address). N's control node restarts on the same port, the loopback stand-in for the unchanged
 * relay address that keeps an envelope handed out in B dialable. Its strand nodes listen on
 * ephemeral ports, so the addresses P holds for them go stale at the switch; N's rebuilt strand
 * nodes start from the routing tables the bundle carried, which name P.
 *
 * Journey:
 * 1. In B. N founds closed strand S and P joins it through a bound formation invitation with two
 *    uses; P founds open strand T and N joins it. Rows cross both ways on both strands. N then
 *    refuses P's S strand node in both directions (a dial gate) and, once P has left N's strand
 *    cohort, writes one row to S alone.
 * 2. O founds A, admits M, mints an owner-granting invitation for N's peer id, and goes away.
 * 3. N exports its bundle, stops, starts for A, redeems at M and wires its owner key.
 * 4. N adopts the bundle, then adopts it again.
 * 5. N claims S and T from `strand:discovered`. P receives the row written alone; P's new rows on
 *    both strands reach N; M runs a replica of each and holds every block N holds; Q redeems the
 *    moved invitation at N, and A records the use.
 * 6. S's membership, read on P and on N, is the one seated in B: N's member key on N's strand
 *    peer, and one founding manager.
 *
 * Left out on purpose: dissolving B (`dissolve-empty-cadre`) and the kit's timing
 * (`move-strand-between-cadres`).
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import type { Database } from '@quereus/quereus';
import {
	CadreNode, InMemoryKeyStore, KeyStoreJoinedStrandStore, MemoryStrandNetworkStateStore,
	adoptStrandBundle, decodeCadreInvitation, ed25519KeyPairFromLibp2p, exportStrandBundle,
	generateStrandMemberKey, strandMemberKeyPair,
	type SAppConfig, type StrandBundle,
} from '@serfab/cadre-core';
import {
	controlNodeConfig, createSignedSAppConfig, makeOwnOwner, waitUntil, captureRawStorage, sameListenAddr,
	startPinningMember, admitMember, redeemWaitingForMember, readCohort, peerDialGate, readBlockIndex,
	awaitBlockCoverage, stopStartedNodes,
	type InviteMember, type PeerDialGate, type RawStorageCapture,
} from '../harness/index.js';

/** The one-table sApp the formation scenarios use; both strands run it. */
const SIMPLE_SCHEMA = `
table Data (
    Key text primary key,
    Val text
);
`;

const SAPP_S = 'sapp-strand-move-s';
const SAPP_T = 'sapp-strand-move-t';
const YEAR_MS = 365 * 24 * 3600_000;

/** Watcher poll cadence on N and M, so a new strand row is offered or hosted within a second. */
const STRAND_WATCH_MS = 1_000;
/**
 * Longer than the test. Any control connection counts as connected, N holds one to P's node
 * after the formations, and a connected owner pass would publish T's join into B's own
 * `JoinedStrand` table. Parked, the join stays machine-local, the shape of a one-node party.
 *
 * NOTE: a `self:peer:update` on N's control node (an address change) also starts a pass; none
 * occurs on loopback after start. If step 1 fails on "B never publishes T", look there.
 */
const RECONCILE_PARKED_MS = 3_600_000;
/** Bring-up, enrollment, cohort eviction, launches and replica coverage over loopback. */
const STARTUP_MS = 60_000;
/** One row crossing an open strand connection. */
const OP_MS = 30_000;
/**
 * A strand node rebuilt in another party re-finding P from its saved table, then the whole-store
 * push that delivers a write made alone (`joiner-first-commit-over-slow-relay` measured 24.5 s
 * from a restart to delivery).
 */
const RECONNECT_MS = 90_000;
/** The anti-vacuity floor `strand-always-on-replica-hosts-cross-party-join` puts under a coverage check. */
const BLOCK_FLOOR = 4;

const ALONE_KEY = 's-n-alone';

/** What the app keeps across its switch: its identity key, its raw stores and its secure store. */
interface AppHome {
	key: PrivateKey;
	peerId: string;
	storage: RawStorageCapture;
	secureStore: InMemoryKeyStore;
}

interface AppNodeOptions {
	listenAddrs?: string[];
	gate?: PeerDialGate;
	reconcileMs?: number;
}

/**
 * N for `partyId`. Each incarnation gets an in-memory routing-table store of its own: B's is read
 * by the export while N runs, and A's starts empty and is filled by the adoption.
 */
function buildAppNode(home: AppHome, partyId: string, options: AppNodeOptions = {}): CadreNode {
	return new CadreNode(controlNodeConfig({
		partyId, privateKey: home.key, profile: 'transaction', strandWatchMs: STRAND_WATCH_MS,
		storageProvider: home.storage.provider,
		joinedStrandStore: new KeyStoreJoinedStrandStore(home.secureStore, partyId),
		strandNetworkStateStore: new MemoryStrandNetworkStateStore(partyId),
		...(options.listenAddrs ? { listenAddrs: options.listenAddrs } : {}),
		...(options.gate ? { connectionGater: options.gate.gater } : {}),
		...(options.reconcileMs !== undefined ? { reconcileMs: options.reconcileMs } : {}),
	}));
}

/** A one-machine party whose node is its own owner: P, and the stranger Q. */
async function startOwnParty(partyId: string, profile: 'storage' | 'transaction', started: CadreNode[]): Promise<CadreNode> {
	const key = await generateKeyPair('Ed25519');
	const node = new CadreNode(controlNodeConfig({ partyId, privateKey: key, profile }));
	started.push(node);
	await node.start();
	await makeOwnOwner(node, key);
	return node;
}

async function valueOf(db: Database, key: string): Promise<string | undefined> {
	return (await db.get('select Val from App.Data where Key = ?', [key]))?.Val as string | undefined;
}

async function writeRow(db: Database, key: string): Promise<void> {
	await db.exec('insert into App.Data (Key, Val) values (?, ?)', [key, `value-${key}`]);
}

/** Wait until `db` reads the row {@link writeRow} wrote under `key`; resolves to the wait in ms. */
async function rowArrives(db: Database, key: string, timeoutMs: number, description: string): Promise<number> {
	const waitedFrom = Date.now();
	await waitUntil(async () => (await valueOf(db, key)) === `value-${key}`, { timeoutMs, intervalMs: 250, description });
	return Date.now() - waitedFrom;
}

/** One column of every row `sql` returns, sorted. */
async function column(db: Database, sql: string, name: string, params: string[] = []): Promise<string[]> {
	const values: string[] = [];
	for await (const row of db.eval(sql, params)) {
		values.push(row[name] as string);
	}
	return values.sort();
}

function strandPeerId(node: CadreNode, strandId: string): string {
	const libp2p = node.getStrand(strandId)?.libp2pNode;
	if (!libp2p) {
		throw new Error(`strand ${strandId} runs no strand node on ${node.peerId?.toString()}`);
	}
	return libp2p.peerId.toString();
}

function strandConnectedTo(node: CadreNode, strandId: string, peerId: string): boolean {
	return (node.getStrand(strandId)?.libp2pNode?.getConnections() ?? []).some((c) => c.remotePeer.toString() === peerId);
}

/** A strand row each side wrote reaches the other. */
async function rowsCrossBothWays(
	strandLabel: string, n: Database, p: Database, keys: { fromN: string; fromP: string }
): Promise<void> {
	await writeRow(n, keys.fromN);
	await rowArrives(p, keys.fromN, OP_MS, `N's row on ${strandLabel} reaches P`);
	await writeRow(p, keys.fromP);
	await rowArrives(n, keys.fromP, OP_MS, `P's row on ${strandLabel} reaches N`);
}

interface InvitedStrand {
	strandId: string;
	/** The encoded envelope, as handed out of band. */
	envelope: string;
	token: string;
	expiresAtMs: number;
}

/** `host` founds `strandId` and publishes a formation invitation bound to it. */
async function foundWithInvitation(
	host: CadreNode, strandId: string, sAppId: string, sApp: SAppConfig,
	strand: { type: 'o' } | { type: 'c'; memberPrivateKey: string }, totalUses: number
): Promise<InvitedStrand> {
	const founded = await host.foundStrand({ strandId, sAppConfig: sApp, ...strand });
	expect(founded.founded).toBe(true);
	const invitation = await host.createOpenInvitation(sAppId, YEAR_MS);
	const expiresAtMs = Date.now() + YEAR_MS;
	await host.publishFormationInvite(invitation.token, sAppId, { strandId, expiresAtMs, totalUses });
	return { strandId, envelope: host.encodeInvitation(invitation), token: invitation.token, expiresAtMs };
}

/** P redeems S's invitation and runs S; resolves once the membership reconciler has seated P's Member row. */
async function pJoinsClosedStrand(P: CadreNode, invited: InvitedStrand, sApp: SAppConfig): Promise<{ db: Database; memberKey: string }> {
	const S = invited.strandId;
	const formed = await P.formStrand(P.decodeInvitation(invited.envelope), { partyId: P.partyId, purpose: 'strand S' });
	expect(formed.strandId).toBe(S);
	expect(formed.membershipInvite).toBeDefined();
	await P.addStrand({
		strandRow: { Id: S, MemberPrivateKey: formed.memberPrivateKey!, Type: 'c', FounderOwnerKey: null },
		sAppConfig: sApp,
		awaitFirstSync: false,
	});
	const db = (await P.whenStrandWritable(S, { timeoutMs: STARTUP_MS })).database!.getDatabase();
	const memberKey = strandMemberKeyPair((await P.getControlDatabase()!.queryStrandPartyKey(S))!).publicKeyB64;
	await waitUntil(async () => (await column(db, 'select Key from Strand.Member', 'Key')).includes(memberKey), {
		timeoutMs: STARTUP_MS, intervalMs: 500, description: "P's Member row on S is seated from the formation's membership invitation",
	});
	return { db, memberKey };
}

/** N redeems T's invitation and runs T: a join recorded on N alone, which its one-node party never publishes. */
async function nJoinsOpenStrand(N: CadreNode, invited: InvitedStrand, sApp: SAppConfig): Promise<Database> {
	const T = invited.strandId;
	const formed = await N.formStrand(N.decodeInvitation(invited.envelope), { partyId: N.partyId, purpose: 'strand T' });
	expect(formed.strandId).toBe(T);
	expect(formed.strandAddrs.length).toBeGreaterThan(0);
	await N.addStrand({ strandRow: { Id: T, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null }, sAppConfig: sApp, awaitFirstSync: false });
	const db = (await N.whenStrandWritable(T, { timeoutMs: STARTUP_MS })).database!.getDatabase();
	expect((await N.listUnpublishedJoinedStrands()).map((record) => record.Id), 'T is a machine-local join on N').toEqual([T]);
	expect(await N.getControlDatabase()!.queryJoinedStrand(T), 'B never publishes T party-wide').toBeNull();
	return db;
}

/**
 * N refuses P's strand node for S in both directions, waits until P has left N's strand cohort
 * (a write offered to a cohort still naming P would wait on P), and writes one row alone.
 */
async function writeAloneOnS(N: CadreNode, gate: PeerDialGate, S: string, pSPeerId: string, nS: Database, pS: Database): Promise<void> {
	const nSNode = N.getStrand(S)!.libp2pNode!;
	gate.deny(pSPeerId);
	await nSNode.hangUp(peerIdFromString(pSPeerId));
	const cutAt = Date.now();
	await waitUntil(async () => !strandConnectedTo(N, S, pSPeerId) && !(await readCohort(nSNode, 'N strand S')).includes(pSPeerId), {
		timeoutMs: STARTUP_MS, intervalMs: 1_000, description: "P's strand node for S is cut off from N and leaves N's strand cohort",
	});
	console.log('[strand-move] P left N\'s cohort on S %d ms after the cut', Date.now() - cutAt);
	await writeRow(nS, ALONE_KEY);
	// Sound as an immediate read: N holds no connection to P's strand node for S and refuses
	// every new one, so nothing can have carried the row.
	expect(await valueOf(pS, ALONE_KEY), 'P has not received the row N wrote alone').toBeUndefined();
}

/**
 * O founds A and admits M, mints an owner-granting invitation for N's peer id, then goes away and
 * leaves M's control cohort (a member write made while it is still there waits on it; see
 * `cadre-invite-any-member`).
 */
async function startPartyA(
	partyId: string, nPeerId: string, mStorage: RawStorageCapture, started: CadreNode[]
): Promise<{ M: InviteMember; encoded: string }> {
	const oKey = await generateKeyPair('Ed25519');
	const oPeerId = peerIdFromPrivateKey(oKey).toString();
	const O = new CadreNode(controlNodeConfig({ partyId, privateKey: oKey, profile: 'transaction', strandFilter: 'none', listenAddrs: [] }));
	started.push(O);
	await O.start();
	const oOwnerKey = await makeOwnOwner(O, oKey);
	const M = await startPinningMember(partyId, oOwnerKey, {
		hostUnclaimedStrands: true, strandWatchMs: STRAND_WATCH_MS, storageProvider: mStorage.provider,
	});
	started.push(M.node);
	await admitMember(O, M, STARTUP_MS);
	await waitUntil(async () => (await O.resolvePeerAddrs(M.peerId)).length > 0, {
		timeoutMs: STARTUP_MS, intervalMs: 500, description: 'M\'s signed address record reaches O',
	});
	const minted = await O.createCadreInvitation({ peerId: nPeerId, grantsOwner: true });
	expect(minted.invitation.invite.peerId).toBe(nPeerId);
	const inviteKey = minted.invitation.invite.key;
	await waitUntil(async () => (await M.node.listCadreInvitations()).some((status) => status.invite.key === inviteKey && status.live), {
		timeoutMs: OP_MS, intervalMs: 500, description: 'M holds the invitation\'s row',
	});
	await O.stop();
	await waitUntil(async () => !(await readCohort(M.node.getControlNode()!, 'M control')).includes(oPeerId), {
		timeoutMs: STARTUP_MS, intervalMs: 1_000, description: 'the stopped owner O leaves M\'s control cohort',
	});
	return { M, encoded: minted.encoded };
}

/** The export, read entry by entry. */
async function expectBundle(
	bundle: StrandBundle, N: CadreNode, s: InvitedStrand & { memberPrivateKey: string }, T: string
): Promise<void> {
	const S = s.strandId;
	expect(bundle.partyId).toBe(N.partyId);
	expect(bundle.strands.map((entry) => [entry.row.Id, entry.kind])).toEqual([[S, 'own'], [T, 'joined']]);
	const [sEntry, tEntry] = bundle.strands;
	expect(sEntry!.row).toEqual({ Id: S, Type: 'c', MemberPrivateKey: s.memberPrivateKey });
	expect(sEntry!.partyKey).not.toBeNull();
	expect(sEntry!.partyKey).toBe(await N.getControlDatabase()!.queryStrandPartyKey(S));
	expect(sEntry!.networkState, "S's saved routing table").toBeDefined();
	expect(tEntry!.row).toEqual({ Id: T, Type: 'o', MemberPrivateKey: null });
	expect(tEntry!.partyKey).toBeNull();
	expect(tEntry!.carriedAddrs.length, "the addresses T's formation carried").toBeGreaterThan(0);
	// P's redemption used one of the two uses.
	expect(bundle.formationInvites).toEqual([
		{ token: s.token, sAppId: SAPP_S, expiresAtMs: s.expiresAtMs, usesLeft: 1, validationUrl: null, strandId: S },
	]);
	expect(bundle.pendingJoins).toEqual([]);
}

/** Stop N in B and start it for A on the same control port; it redeems at M and wires its owner key. */
async function switchToA(
	nB: CadreNode, home: AppHome, partyA: string, encoded: string, M: InviteMember, started: CadreNode[]
): Promise<CadreNode> {
	const listenAddr = sameListenAddr(nB);
	await nB.stop();
	const nA = buildAppNode(home, partyA, { listenAddrs: [listenAddr] });
	started.push(nA);
	await nA.start();
	const { joined, passes } = await redeemWaitingForMember(nA, decodeCadreInvitation(encoded), STARTUP_MS, 'switch');
	console.log('[strand-move] N was admitted to A on pass %d', passes);
	expect(joined.peerId).toBe(M.peerId);
	expect(joined.grantsOwner).toBe(true);
	await waitUntil(() => nA.wireOwnKeyIfOwner(), {
		timeoutMs: STARTUP_MS, intervalMs: 500, description: 'N\'s owner key is listed in A and wired',
	});
	return nA;
}

/** A holds each moved row once, under the key and founder the move preserves. */
async function expectSeatedOnce(N: CadreNode, bundle: StrandBundle, s: InvitedStrand, T: string, nOwnerKey: string): Promise<void> {
	const S = s.strandId;
	const control = N.getControlDatabase()!;
	const strands = (await control.queryStrands()).filter((row) => row.Id === S);
	expect(strands).toHaveLength(1);
	// The founder rule: the row names the app's key, the key that founded S in B.
	expect(strands[0]!.FounderOwnerKey).toBe(nOwnerKey);
	expect((await control.queryJoinedStrands()).filter((row) => row.Id === T)).toHaveLength(1);
	expect((await control.queryFormationInvites()).filter((row) => row.token === s.token)).toHaveLength(1);
	expect(await control.queryStrandPartyKey(S)).toBe(bundle.strands[0]!.partyKey);
	expect(await control.queryStrandPartyKey(T)).toBeNull();
}

/** Claim a strand the watcher offers, as the reference app does with a discovered row. */
async function claimDiscovered(N: CadreNode, strandId: string, sApp: SAppConfig): Promise<Database> {
	await waitUntil(() => N.getDiscoveredStrands().has(strandId), {
		timeoutMs: STARTUP_MS, intervalMs: 250, description: `N's watcher offers ${strandId} as strand:discovered`,
	});
	await N.addStrand({ strandRow: N.getDiscoveredStrands().get(strandId)!, sAppConfig: sApp, awaitFirstSync: false });
	return (await N.whenStrandWritable(strandId, { timeoutMs: STARTUP_MS })).database!.getDatabase();
}

/** M runs a replica of `strandId` from A's row and physically holds every block N holds for it. */
async function expectReplicaOnM(M: InviteMember, mStorage: RawStorageCapture, nStorage: RawStorageCapture, strandId: string): Promise<string> {
	await waitUntil(() => M.node.getStrand(strandId)?.libp2pNode !== undefined, {
		timeoutMs: STARTUP_MS, intervalMs: 250, description: `M's watcher launches a replica of ${strandId} from A's row`,
	});
	expect(M.node.getStrand(strandId)!.sAppInfo, 'a replica runs without the app').toBeUndefined();
	const nStore = nStorage.forStrand(strandId);
	const nBlocks = (await readBlockIndex(nStore)).size;
	console.log('[strand-move] N holds %d committed blocks for %s', nBlocks, strandId);
	expect(nBlocks).toBeGreaterThanOrEqual(BLOCK_FLOOR);
	await awaitBlockCoverage(nStore, mStorage.forStrand(strandId), {
		timeoutMs: STARTUP_MS, description: `every block N holds for ${strandId} lands in M's store`,
	});
	return strandPeerId(M.node, strandId);
}

describe('E2E an app\'s strands move between cadres', () => {
	it('the other member keeps syncing and the new cadre\'s always-on machine hosts them', async () => {
		const runTag = Date.now();
		const partyB = `strand-move-b-${runTag}`;
		const partyA = `strand-move-a-${runTag}`;
		const S = `strand-move-s-${runTag}`;
		const T = `strand-move-t-${runTag}`;
		const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '1.0.0');
		const nKey = await generateKeyPair('Ed25519');
		const home: AppHome = {
			key: nKey, peerId: peerIdFromPrivateKey(nKey).toString(), storage: captureRawStorage(), secureStore: new InMemoryKeyStore(),
		};
		const nOwnerKey = ed25519KeyPairFromLibp2p(nKey).publicKeyB64;
		const mStorage = captureRawStorage();
		const started: CadreNode[] = [];
		try {
			// ── Step 1, in B: N founds S, P joins; P founds T, N joins; rows cross ──
			const gate = peerDialGate({ inbound: true });
			const nB = buildAppNode(home, partyB, { gate, reconcileMs: RECONCILE_PARKED_MS });
			started.push(nB);
			await nB.start();
			await makeOwnOwner(nB, nKey);
			const P = await startOwnParty(`strand-move-p-${runTag}`, 'storage', started);

			const sMemberPrivateKey = await generateStrandMemberKey();
			const invitedS = await foundWithInvitation(nB, S, SAPP_S, sApp, { type: 'c', memberPrivateKey: sMemberPrivateKey }, 2);
			const nSDb = nB.getStrand(S)!.database!.getDatabase();
			const { db: pSDb, memberKey: pMemberKey } = await pJoinsClosedStrand(P, invitedS, sApp);
			const invitedT = await foundWithInvitation(P, T, SAPP_T, sApp, { type: 'o' }, 1);
			const pTDb = P.getStrand(T)!.database!.getDatabase();
			const nTDb = await nJoinsOpenStrand(nB, invitedT, sApp);
			await rowsCrossBothWays('S', nSDb, pSDb, { fromN: 's-n-b', fromP: 's-p-b' });
			await rowsCrossBothWays('T', nTDb, pTDb, { fromN: 't-n-b', fromP: 't-p-b' });

			const nSPeerId = strandPeerId(nB, S);
			const pSPeerId = strandPeerId(P, S);
			await writeAloneOnS(nB, gate, S, pSPeerId, nSDb, pSDb);

			// ── Step 2: party A, its owner away by the time N arrives ──
			const { M, encoded } = await startPartyA(partyA, home.peerId, mStorage, started);

			// ── Step 3: export, then the switch ──
			const bundle = await exportStrandBundle(nB);
			await expectBundle(bundle, nB, { ...invitedS, memberPrivateKey: sMemberPrivateKey }, T);
			const nA = await switchToA(nB, home, partyA, encoded, M, started);

			// ── Step 4: adopt, then adopt the same bundle again ──
			const report = await adoptStrandBundle(nA, bundle);
			expect(report).toEqual({
				fromPartyId: partyB, moved: [S, T], refused: [], failed: [],
				invitationsMoved: 1, invitationsDropped: 0, pendingJoinsMoved: 0,
			});
			expect(await adoptStrandBundle(nA, bundle), 'adopting again changes nothing').toEqual(report);
			await expectSeatedOnce(nA, bundle, invitedS, T, nOwnerKey);

			// ── Step 5: the strands run in A ──
			const claimedAt = Date.now();
			const nSDbA = await claimDiscovered(nA, S, sApp);
			const nTDbA = await claimDiscovered(nA, T, sApp);
			expect(strandPeerId(nA, S), "N's strand peer for S is the one P knows").toBe(nSPeerId);
			await waitUntil(() => strandConnectedTo(P, S, nSPeerId), {
				timeoutMs: RECONNECT_MS, intervalMs: 250, description: "P's strand node for S reconnects with N, now in A",
			});
			const reconnectedMs = Date.now() - claimedAt;
			const deliveredMs = await rowArrives(pSDb, ALONE_KEY, RECONNECT_MS, 'P receives the row N wrote alone in B');
			console.log('[strand-move] P reconnected %d ms after the claim; the row written alone arrived %d ms later', reconnectedMs, deliveredMs);
			await writeRow(pSDb, 's-p-a');
			await writeRow(pTDb, 't-p-a');
			await rowArrives(nSDbA, 's-p-a', RECONNECT_MS, "P's new row on S reaches N in A");
			await rowArrives(nTDbA, 't-p-a', RECONNECT_MS, "P's new row on T reaches N in A");

			const mSPeerId = await expectReplicaOnM(M, mStorage, home.storage, S);
			await expectReplicaOnM(M, mStorage, home.storage, T);

			const Q = await startOwnParty(`strand-move-q-${runTag}`, 'transaction', started);
			const formedByQ = await Q.formStrand(Q.decodeInvitation(invitedS.envelope), { partyId: Q.partyId, purpose: 'the moved invitation' });
			expect(formedByQ.strandId).toBe(S);
			expect(formedByQ.membershipInvite, 'S is closed, so the redemption carries a membership invitation').toBeDefined();
			await waitUntil(async () => (await nA.getControlDatabase()!.countFormationUsage(invitedS.token)) === 1, {
				timeoutMs: OP_MS, intervalMs: 250, description: 'A records the redemption: one FormationUsage row for the moved token',
			});

			// ── Step 6: S's identity is the one seated in B ──
			const nMemberKey = strandMemberKeyPair(bundle.strands[0]!.partyKey!).publicKeyB64;
			// Immediate reads: N's founding rows reached P before P's own Member row, which step 1
			// waited for (the same reading `strand-formation-cross-party-seed` makes), and a second
			// founding in A would sit in N's own store at once.
			for (const [label, db] of [['P', pSDb], ['N', nSDbA]] as const) {
				expect(await column(db, 'select Key from Strand.Member', 'Key'), `S's members on ${label}`).toEqual([nMemberKey, pMemberKey].sort());
				expect(await column(db, 'select MemberKey from Strand.Manager', 'MemberKey'), `S's managers on ${label}`).toEqual([nMemberKey]);
			}
			const bindingsOnP = await column(pSDb, 'select PeerId from Strand.MemberPeer where MemberKey = ?', 'PeerId', [nMemberKey]);
			console.log('[strand-move] peers bound to N\'s member key on P: %o', bindingsOnP);
			expect(bindingsOnP, "P still binds N's member key to N's strand peer").toContain(nSPeerId);
			// M is a machine of the same party now, so it may bind its replica's peer under the same member key.
			expect(bindingsOnP.every((peerId) => peerId === nSPeerId || peerId === mSPeerId), 'no other peer speaks for N').toBe(true);
		} finally {
			await stopStartedNodes(started);
		}
	}, 15 * STARTUP_MS);
});
