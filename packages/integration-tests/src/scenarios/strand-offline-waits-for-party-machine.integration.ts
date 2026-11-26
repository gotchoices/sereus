/**
 * A phone in offline mode does not commit a queued transaction alone while one of its party's
 * own machines holds the strand and cannot be reached (gotchoices/sereus#56;
 * docs/strands/writes.md → "Waiting for the party's own machines").
 *
 * ── The machines ──
 *
 * One party. The PHONE is its owner: `nodeClass: 'device'`, no listen address, and file-backed
 * storage in a temp directory, one directory per scope — every strand starts in offline mode and
 * journals into its own scope's key-value store, which Optimystic requires to survive a restart.
 * The NODE is an always-on storage machine
 * that pins the phone's owner key and runs a storage replica of every strand the party lists
 * (`hostUnclaimedStrands`), as a production server node does.
 *
 * Each runs a test-supplied connection gater (`network.connectionGater`), which cadre-core hands
 * to its control node and to every strand node it launches. While the strand plane is CUT, a
 * machine refuses every connection in either direction except with the other machine's CONTROL
 * node, and every `/p2p-circuit` address. So the control plane is up (the phone dials the node's
 * control port, rows replicate both ways) and the strand plane is not: the shape of a node whose
 * control port is open and whose strand port a firewall blocks, which the issue's phone sat
 * behind for a whole session.
 *
 * ── The flow ──
 *
 *   1. The phone founds an open strand and publishes its row. The node is admitted, discovers
 *      the row and launches a replica. Its strand node exists and its `StrandPeer` row reaches the
 *      phone, so `getUnreachedStrandMachines` names the node; the strand-addr RPC puts the node's
 *      strand address in the phone's strand address book. The replica stays `syncing`: nothing of
 *      the strand can reach it.
 *   2. Outside offline mode the phone commits a row alone: nothing is held, and the commit's
 *      `awaitedMachines` names the node. The phone goes back to offline mode.
 *   3. The phone inserts a row. The statement resolves at once (`queued`), and the transaction
 *      then stays `queued` with `waitingFor: 'cohort'`: `commitDurability` is undefined and nothing
 *      is reported committed. Before this hold the phone's own reachability gate knew no member,
 *      so the queue committed the transaction alone, `quorum: 'local'`.
 *   4. The strand plane opens: the phone's gater admits everything, the node's admits inbound
 *      connections but still refuses to dial anyone but the phone's control node, so the strand
 *      connection that forms was dialed by the phone. The phone's strand node connects from the
 *      address book alone (no FRET record, an empty launch seed: the strand launched before the
 *      node existed), the replica syncs over the connection, and the transaction commits on a
 *      cohort of two: `committed` once, `heldElsewhere` true, every block the phone holds in the
 *      node's store, and nothing left unreached. Which of the phone's dialers makes the connection
 *      is not pinned here: the strand redial loop (`strand-peer-redial.ts`) is one and libp2p's own
 *      are others, and in a traced run the connection formed about 200 ms before the loop's next
 *      round. The loop's decision to dial a party machine is `strand-peer-redial.spec.ts`'s. The
 *      commit made alone in step 2 is then held, and its `awaitedMachines` is empty.
 *
 * `[OFFLINE-HOLD]` lines print the elapsed time of each step. The reconnect after the plane opens
 * is bounded by the strand redial's backoff, which doubled from one dial budget for as long as the
 * plane was cut, so that step's wait varies with how long the hold took.
 *
 * ── Removing the machine ──
 *
 * Two more flows, over the same two machines with no gater: the phone's strand node meets the
 * node, the node takes a commit and then stops for good, a queued transaction waits, and
 * `removeMachine(node)` releases it, committed by the phone alone. Each pins one mechanism, since
 * Optimystic's own gate holds for two separate reasons a removal has to end:
 *
 *   - Met, not seeded. The strand launched before the node existed, so the node is only in the
 *     strand node's memory of peers it saw serving (`absent-members`). Refusing the removed
 *     machine as a member (`NodeOptions.isNetworkMember`) ends that, and the strand node stays the
 *     same object: no rebuild ran.
 *   - Met and seeded. A hibernate and wake while the node is up puts it in the launch seed
 *     (`awaiting-bootstrap`), and a refused seed peer stays unheard for the life of the node. The
 *     strand node is replaced by one built from a fresh seed.
 *
 * A third flow is the met one on a closed strand. The removal's key replacement is refused while
 * the queue holds the transaction, so it must run on the queue's drain.
 *
 * ── Running it ──
 *
 *   yarn workspace @serfab/integration-tests exec vitest run strand-offline-waits-for-party-machine
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';
import type { ConnectionGater, Libp2p, PrivateKey } from '@libp2p/interface';
import type { IKVStore, OpenNodeStorage } from '@optimystic/db-p2p';
import { fileNodeStorage } from '@optimystic/db-p2p-storage-fs';
import { CadreNode, generateStrandMemberKey } from '@serfab/cadre-core';
import type { StrandInstance, StrandOfflineStatus } from '@serfab/cadre-core';
import {
	waitUntil,
	sleep,
	controlNodeConfig,
	createSignedSAppConfig,
	makeOwnOwner,
	admitMember,
	captureRawStorage,
	awaitBlockCoverage,
	readCohort,
} from '../harness/index.js';

const SIMPLE_SCHEMA = `
table Data (
    Key text primary key,
    Val text
);
`;

/** Bring-up, admission and a strand launch over loopback. */
const STARTUP_MS = 60_000;
/** A row crossing an open control connection, and the reads that follow it. */
const CONVERGE_MS = 60_000;
/** How long the queued transaction is watched for a lone commit: well past the queue's 1 s re-check base. */
const HOLD_MS = 5_000;
/**
 * The strand redial's next round after the plane opens, then the sync and the commit. At the
 * declared link the first dial budget is 4.5 s and the backoff doubles from there for as long as
 * the plane was cut, so the round that connects may be up to a minute out.
 */
const REDIAL_MS = 150_000;
/** Every budget both machines derive from the declared link; short, so the redial's first backoff is too. */
const LINK_MS = 100;
/** The watcher's and the strand-addr refresh's cadence, so launches and addresses land within seconds. */
const POLL_MS = 1_000;
/** From the removal's write to the queued transaction committing: a control read, the queue's wake, and for the seeded flow a rebuild. */
const RELEASE_MS = 60_000;

const INSERT_RETURNING_TX = 'insert into App.Data (Key, Val) values (?, ?) returning StampId() as Tx';

/**
 * A gater that cuts the strand plane. While cut it refuses every connection, in either direction,
 * with any peer but `controlPeer()` (the other machine's control node), and every dial of a
 * `/p2p-circuit` address. `admitInbound()` lets inbound connections through while still refusing
 * to dial anyone but the control peer, so the machine connects to nobody on its own; `open()`
 * lifts everything. A multiaddr naming no peer is left to `denyOutboundConnection`, which sees
 * every dial at the upgrader (the harness's `peerDialGate` takes the same route).
 */
function strandPlaneCut(controlPeer: () => string): { gater: ConnectionGater; admitInbound(): void; open(): void } {
	let refusingOutbound = true;
	let refusingInbound = true;
	const refuseOutbound = (peerId: string | undefined): boolean => refusingOutbound && peerId !== controlPeer();
	const gater: ConnectionGater = {
		denyDialPeer: (peerId) => refuseOutbound(peerId.toString()),
		denyDialMultiaddr: (ma) => {
			const components = ma.getComponents();
			if (refusingOutbound && components.some((c) => c.name === 'p2p-circuit')) return true;
			const target = components.filter((c) => c.name === 'p2p').pop()?.value;
			return target !== undefined && refuseOutbound(target);
		},
		denyOutboundConnection: (peerId, _maConn) => refuseOutbound(peerId.toString()),
		denyInboundEncryptedConnection: (peerId, _maConn) => refusingInbound && peerId.toString() !== controlPeer(),
	};
	return {
		gater,
		admitInbound: () => { refusingInbound = false; },
		open: () => { refusingInbound = false; refusingOutbound = false; },
	};
}

/** The addresses `node`'s address book holds for `peerId`; none for a peer it has never heard of. */
async function addressBookAddrs(node: Libp2p, peerId: string): Promise<string[]> {
	try {
		const peer = await node.peerStore.get(peerIdFromString(peerId));
		return peer.addresses.map((address) => address.multiaddr.toString());
	} catch (error) {
		if ((error as { name?: string }).name === 'NotFoundError') return [];
		throw error;
	}
}

/** Whether `node` holds an open connection to `peerId`, dialed by `node` itself when `outbound`. */
function connectedTo(node: Libp2p, peerId: string, outbound = false): boolean {
	return node.getConnections().some((connection) =>
		connection.remotePeer.toString() === peerId && connection.status === 'open' && (!outbound || connection.direction === 'outbound'));
}

/** The two machines' identities, drawn ahead of the party so a gater can name the other machine. */
interface PartyKeys {
	phoneKey: PrivateKey;
	nodeKey: PrivateKey;
	phonePeerId: string;
	nodePeerId: string;
}

async function drawPartyKeys(): Promise<PartyKeys> {
	const phoneKey = await generateKeyPair('Ed25519');
	const nodeKey = await generateKeyPair('Ed25519');
	return { phoneKey, nodeKey, phonePeerId: peerIdFromPrivateKey(phoneKey).toString(), nodePeerId: peerIdFromPrivateKey(nodeKey).toString() };
}

/** Step 1 of every flow done: the phone founded and published in offline mode, the node was admitted and runs a replica. */
interface OfflineParty {
	say(msg: string, ...args: unknown[]): void;
	strandId: string;
	phone: CadreNode;
	node: CadreNode;
	phoneStrand: StrandInstance;
	replica: StrandInstance;
	nodeStrandPeerId: string;
	statuses: StrandOfflineStatus[];
	phoneCapture: ReturnType<typeof captureRawStorage>;
	nodeCapture: ReturnType<typeof captureRawStorage>;
}

/** Run `flow` over a fresh party on a strand of `strandType`, then stop both machines and remove the journals. */
async function withOfflineParty(
	keys: PartyKeys,
	gaters: { phone?: ConnectionGater; node?: ConnectionGater },
	flow: (party: OfflineParty) => Promise<void>,
	strandType: 'o' | 'c' = 'o'
): Promise<void> {
	const startedAt = Date.now();
	const say = (msg: string, ...args: unknown[]): void => {
		console.log(`[OFFLINE-HOLD] ${Date.now() - startedAt} ms: ${msg}`, ...args);
	};
	const home = mkdtempSync(join(tmpdir(), 'sereus-offline-hold-'));
	// The phone's storage is FILE-backed, one directory per scope under `home`, because its
	// offline journal is that scope's key-value store and Optimystic refuses a journal that would
	// not survive a restart (a `MemoryKVStore` is the no-journal configuration). The journal is
	// not a store of its own: Optimystic declares its key prefix in `NODE_KV_NAMESPACES` so one
	// store serves the node and the journal, and a journal in its own directory would keep its
	// bytes outside the one location the node measures itself against. Held out here so the
	// cleanup below closes every storage this run opened, however the run ended.
	const opened: OpenNodeStorage[] = [];
	let phone: CadreNode | undefined;
	let node: CadreNode | undefined;
	try {
		const runTag = Date.now();
		const partyId = `offline-hold-${runTag}`;
		const strandId = `strand-offline-hold-${runTag}`;
		const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '1.0.0');
		const { phoneKey, nodeKey, nodePeerId } = keys;
		const phoneCapture = captureRawStorage((scope) => {
			const storage = fileNodeStorage(join(home, 'storage', scope));
			opened.push(storage);
			return storage;
		});
		// The node is a storage replica with no offline mode, so in-memory storage does for it.
		const nodeCapture = captureRawStorage();
		/** The strand's offline journal: its own scope's key-value store, opened once per scope. */
		const journal = async (scope: string): Promise<IKVStore> => (await phoneCapture.open(scope)).kv;

		// ── 1. The phone founds and publishes; the node is admitted and launches a replica ──
		phone = new CadreNode(controlNodeConfig({
			partyId, privateKey: phoneKey, nodeClass: 'device', listenAddrs: [],
			reconcileMs: 2_000, strandAddrRefreshMs: POLL_MS, strandWatchMs: POLL_MS, linkRoundTripMs: LINK_MS,
			storageProvider: phoneCapture.open, connectionGater: gaters.phone,
			strandOffline: { journal, initialMode: 'offline' },
			membershipReconciliation: { pollIntervalMs: 2_000 },
		}));
		await phone.start();
		const owner = await makeOwnOwner(phone);
		const statuses: StrandOfflineStatus[] = [];
		phone.on('strand:offline-status', (event) => { statuses.push(event); });
		const phoneStrand = strandType === 'c'
			? (await phone.foundStrand({ strandId, type: 'c', memberPrivateKey: await generateStrandMemberKey(), sAppConfig: sApp })).instance
			: await phone.addStrand({
				strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null, FounderPeerId: null },
				sAppConfig: sApp,
				founder: true,
			});
		expect(phoneStrand.status).toBe('active');
		expect(phone.getStrandOfflineMode(strandId)).toBe('offline');
		if (strandType === 'o') {
			await phone.publishStrand(strandId);
		}
		say('step 1: the phone founded and published the strand in offline mode');

		node = new CadreNode(controlNodeConfig({
			partyId, privateKey: nodeKey, nodeClass: 'server', pinnedOwnerKeys: [owner.publicKey], enableRelay: false,
			strandFilter: 'all', hostUnclaimedStrands: true, strandWatchMs: POLL_MS, reconcileMs: 2_000, linkRoundTripMs: LINK_MS,
			storageProvider: nodeCapture.open, connectionGater: gaters.node,
			membershipReconciliation: { pollIntervalMs: 2_000 },
		}));
		await node.start();
		await node.enableSeedListener();
		await admitMember(phone, { node, peerId: nodePeerId, key: nodeKey }, STARTUP_MS);
		const admittedNode = node;
		await waitUntil(() => admittedNode.getStrand(strandId)?.libp2pNode !== undefined, {
			timeoutMs: STARTUP_MS, intervalMs: 250, description: 'the node discovers the strand row and launches a replica',
		});
		const replica = node.getStrand(strandId)!;
		const nodeStrandPeerId = replica.libp2pNode!.peerId.toString();
		say('step 1: the node was admitted and runs a replica (%s)', nodeStrandPeerId);

		await flow({ say, strandId, phone, node, phoneStrand, replica, nodeStrandPeerId, statuses, phoneCapture, nodeCapture });
	} finally {
		await Promise.allSettled([node?.stop(), phone?.stop()]);
		// The phone's storage is closed only now — cadre-core closes nothing it was handed — so
		// its write-ahead logs are checkpointed and its directory locks released before the
		// directory goes. Only files written by this process: no node_modules junctions.
		await Promise.allSettled(opened.map((storage) => storage.close()));
		rmSync(home, { recursive: true, force: true });
		// NOTE: intermittently a run still leaves `home` behind holding one empty directory (seen
		// once in 8 test executions on 2026-11-26, `storage/<strand>/under-replicated`). A ledger
		// write lands after both `stop()` and `close()` and recreates the path this line just
		// removed, so retrying the removal would not catch it. Cost is one empty directory in the
		// OS temp directory; if that ever matters, or if a post-close write starts throwing where
		// it is issued, the thing to find is which background task outlives `CadreNode.stop()`.
	}
}

async function runOfflineWaitsForPartyMachine(): Promise<void> {
	const keys = await drawPartyKeys();
	const { phonePeerId, nodePeerId } = keys;
	const phoneCut = strandPlaneCut(() => nodePeerId);
	const nodeCut = strandPlaneCut(() => phonePeerId);
	await withOfflineParty(keys, { phone: phoneCut.gater, node: nodeCut.gater }, async (party) => {
		const { say, strandId, phone, phoneStrand, replica, nodeStrandPeerId, statuses, phoneCapture, nodeCapture } = party;
		const phoneStrandNode = phoneStrand.libp2pNode!;

		// The node's StrandPeer row reached the phone, which now names the node as unreached, and the
		// strand-addr RPC put the node's strand address where the redial reads it. The replica cannot
		// sync: nothing of the strand reaches it while the plane is cut.
		const owningPhone = phone;
		await waitUntil(() => {
			const unreached = owningPhone.getUnreachedStrandMachines(strandId);
			return unreached.length === 1 && unreached[0]!.peerId === nodePeerId && unreached[0]!.strandPeerId === nodeStrandPeerId;
		}, { timeoutMs: CONVERGE_MS, intervalMs: 250, description: "the phone names the node as a party machine holding the strand it cannot reach" });
		await waitUntil(async () => (await addressBookAddrs(phoneStrandNode, nodeStrandPeerId)).length > 0, {
			timeoutMs: CONVERGE_MS, intervalMs: 250, description: "the phone's strand node holds an address for the node's strand node",
		});
		expect(connectedTo(phoneStrandNode, nodeStrandPeerId)).toBe(false);
		expect(replica.database, 'the replica cannot sync while the strand plane is cut').toBeUndefined();
		say("step 1: the phone names the node as unreached and holds its strand address");

		// ── 2. Outside offline mode the phone commits alone, and the commit names the node ──
		const db = phoneStrand.database!.getDatabase();
		phone.setStrandOfflineMode(strandId, 'online');
		const alone = await db.get('insert into App.Data (Key, Val) values (?, ?) returning StampId() as Tx', ['alone', 'committed-without-the-node']);
		const aloneTx = alone!.Tx as string;
		expect(phoneStrand.database!.commitDurability(aloneTx), `${aloneTx} committed alone`).toMatchObject({
			heldElsewhere: false,
			awaitedMachines: [{ peerId: nodePeerId, strandPeerId: nodeStrandPeerId }],
		});
		phone.setStrandOfflineMode(strandId, 'offline');
		say('step 2: %s committed alone and names the node as awaited', aloneTx);

		// ── 3. The phone writes; the transaction waits for the node ──
		const row = { key: 'held', val: 'written-while-the-node-was-unreachable' };
		const writeAt = Date.now();
		const written = await db.get('insert into App.Data (Key, Val) values (?, ?) returning StampId() as Tx', [row.key, row.val]);
		const tx = written!.Tx as string;
		say('step 3: the insert resolved in %d ms (%s)', Date.now() - writeAt, tx);
		const queue = phoneStrand.database!.offline!;
		expect(queue.status(tx), 'the status right after the insert').toMatchObject({ kind: 'queued' });
		// `waitingFor` is set by the first re-check, which asks the gate.
		await waitUntil(() => {
			const status = queue.status(tx);
			return status?.kind === 'queued' && status.waitingFor === 'cohort';
		}, { timeoutMs: CONVERGE_MS, intervalMs: 100, description: `${tx} to report it is waiting for its cohort` });
		await sleep(HOLD_MS);
		expect(queue.status(tx), `${tx} after ${HOLD_MS} ms with the node unreachable`).toMatchObject({ kind: 'queued', waitingFor: 'cohort' });
		expect(phoneStrand.database!.commitDurability(tx), `commitDurability(${tx}) while queued`).toBeUndefined();
		expect(statuses.filter(({ status }) => status.transactionId === tx && status.kind === 'committed'), `${tx} committed while the node was unreachable`).toHaveLength(0);
		expect(phone.getUnreachedStrandMachines(strandId).map((machine) => machine.strandPeerId)).toEqual([nodeStrandPeerId]);
		say('step 3: %s stayed queued, waiting for its cohort', tx);

		// ── 4. The strand plane opens; the phone redials, the replica syncs, the transaction commits ──
		const openedAt = Date.now();
		nodeCut.admitInbound();
		phoneCut.open();
		await waitUntil(() => connectedTo(phoneStrandNode, nodeStrandPeerId, true), {
			timeoutMs: REDIAL_MS, intervalMs: 250, description: "the phone's strand node redials the node's strand node",
		});
		say('step 4: the phone connected to the node\'s strand node %d ms after the plane opened', Date.now() - openedAt);
		await waitUntil(() => statuses.some(({ status }) => status.transactionId === tx && status.kind === 'committed'), {
			timeoutMs: REDIAL_MS, intervalMs: 250, description: `${tx} to be reported committed`,
		});
		say('step 4: %s committed %d ms after the plane opened', tx, Date.now() - openedAt);
		const database = phoneStrand.database!;
		await waitUntil(() => database.commitDurability(tx)?.heldElsewhere === true, {
			timeoutMs: CONVERGE_MS, intervalMs: 250, description: `${tx} to be held by the node`,
		});
		await awaitBlockCoverage(phoneCapture.forStrand(strandId), nodeCapture.forStrand(strandId), {
			timeoutMs: CONVERGE_MS, description: "every block the phone holds lands in the node's store",
		});
		expect(statuses.filter(({ status }) => status.transactionId === tx && status.kind === 'committed'), `${tx} reported committed`).toHaveLength(1);
		expect(statuses.filter(({ status }) => status.transactionId === tx && status.kind === 'failed'), `${tx} reported failed`).toHaveLength(0);
		expect(phone.getUnreachedStrandMachines(strandId)).toEqual([]);
		await waitUntil(() => database.commitDurability(aloneTx)?.heldElsewhere === true, {
			timeoutMs: CONVERGE_MS, intervalMs: 250, description: `${aloneTx}, committed alone, to be held by the node`,
		});
		expect(database.commitDurability(aloneTx)?.awaitedMachines).toEqual([]);
		say('RESULT the transaction waited for the node and reached it once');
	});
}

/**
 * The removal flows (header, "Removing the machine"). `seeded` hibernates and wakes the phone's
 * strand while the node is up, so the runtime the removal finds names the node in its launch seed.
 */
async function runRemovalReleasesQueue(seeded: boolean, strandType: 'o' | 'c' = 'o'): Promise<void> {
	const keys = await drawPartyKeys();
	const { nodePeerId } = keys;
	await withOfflineParty(keys, {}, async ({ say, strandId, phone, node, phoneStrand, nodeStrandPeerId, statuses }) => {
		const reportedAs = (tx: string, kind: 'committed' | 'failed'): StrandOfflineStatus[] =>
			statuses.filter(({ status }) => status.transactionId === tx && status.kind === kind);
		const phoneConnected = (): boolean => connectedTo(phoneStrand.libp2pNode!, nodeStrandPeerId);
		await waitUntil(phoneConnected, { timeoutMs: REDIAL_MS, intervalMs: 250, description: "the phone's strand node connects to the node's" });
		if (seeded) {
			await phone.hibernateStrand(strandId);
			expect(phoneStrand.status, 'a strand whose latency hint never hibernates would keep its seed').toBe('hibernating');
			await phone.wakeStrand(strandId);
			await waitUntil(phoneConnected, { timeoutMs: REDIAL_MS, intervalMs: 250, description: "the woken strand node connects to the node's" });
		}

		// A commit the node holds, so the phone has seen the node serve the strand.
		const met = await phoneStrand.database!.getDatabase().get(INSERT_RETURNING_TX, ['met', 'held-by-the-node']);
		const metTx = met!.Tx as string;
		const metDatabase = phoneStrand.database!;
		await waitUntil(() => metDatabase.commitDurability(metTx)?.heldElsewhere === true, {
			timeoutMs: CONVERGE_MS, intervalMs: 250, description: `${metTx} to be held by the node`,
		});
		say('the phone has met the node (seeded: %s), and the node holds %s', seeded, metTx);

		// ── The node stops for good, and a transaction waits for it ──
		// A background `CadrePeer` write still committing at a stop tears (docs/contributing/testing.md).
		expect(await node.registerSelf()).not.toBe('skipped');
		await node.stop();
		await waitUntil(() => !phoneConnected(), { timeoutMs: CONVERGE_MS, intervalMs: 250, description: "the phone's strand node sees the node go" });
		// `removeMachine` is a control write, and a cohort that still lists the node fails it.
		await waitUntil(async () => !(await readCohort(phone.getControlNode()!, 'phone')).includes(nodePeerId), {
			timeoutMs: CONVERGE_MS, intervalMs: 250, description: "the node leaves the phone's control cohort",
		});
		const partyKeyBefore = await phone.getControlDatabase()!.queryStrandPartyKey(strandId);
		const written = await phoneStrand.database!.getDatabase().get(INSERT_RETURNING_TX, ['held', 'written-after-the-node-stopped']);
		const tx = written!.Tx as string;
		await sleep(HOLD_MS);
		expect(phoneStrand.database!.offline!.status(tx), `${tx} ${HOLD_MS} ms after the write`).toMatchObject({ kind: 'queued' });
		expect(reportedAs(tx, 'committed'), `${tx} committed with the node stopped`).toHaveLength(0);
		expect(phone.getUnreachedStrandMachines(strandId).map((machine) => machine.strandPeerId)).toEqual([nodeStrandPeerId]);
		say('%s waits: %o', tx, phoneStrand.database!.offline!.status(tx));

		// ── The removal releases it ──
		const strandNodeBefore = phoneStrand.libp2pNode;
		const removedAt = Date.now();
		expect(await phone.removeMachine(nodePeerId)).toMatchObject({ removedPeer: true });
		await waitUntil(() => reportedAs(tx, 'committed').length > 0, {
			timeoutMs: RELEASE_MS, intervalMs: 100, description: `${tx} to be reported committed after the removal`,
		});
		say('%s committed %d ms after the removal began', tx, Date.now() - removedAt);
		if (strandType === 'c') {
			await waitUntil(async () => (await phone.getControlDatabase()!.queryStrandPartyKey(strandId)) !== partyKeyBefore, {
				timeoutMs: RELEASE_MS, intervalMs: 100, description: 'the key replacement to finish once the queue drained',
			});
			say('the key replacement finished %d ms after the removal began', Date.now() - removedAt);
		}
		expect(reportedAs(tx, 'committed'), `${tx} reported committed`).toHaveLength(1);
		expect(reportedAs(tx, 'failed'), `${tx} reported failed`).toHaveLength(0);
		expect(phone.getUnreachedStrandMachines(strandId)).toEqual([]);
		if (seeded) {
			expect(phoneStrand.libp2pNode, 'the seed names the node, so the runtime was rebuilt').not.toBe(strandNodeBefore);
		} else {
			expect(phoneStrand.libp2pNode, 'no seed names the node, so no rebuild ran').toBe(strandNodeBefore);
		}
	}, strandType);
}

describe('offline mode waits for the party\'s own machines', () => {
	it('a phone does not commit a queued transaction alone while a party machine holding the strand is unreachable, and sends it once the machine is reached', async () => {
		await runOfflineWaitsForPartyMachine();
	}, 300_000);

	it('removing a machine this node met releases the queue without a rebuild', async () => {
		await runRemovalReleasesQueue(false);
	}, 300_000);

	it('removing a machine in the launch seed releases the queue through one rebuild', async () => {
		await runRemovalReleasesQueue(true);
	}, 300_000);

	it('removing a machine from a closed strand holding a queue finishes the key replacement once the queue drains', async () => {
		await runRemovalReleasesQueue(false, 'c');
	}, 300_000);
});
