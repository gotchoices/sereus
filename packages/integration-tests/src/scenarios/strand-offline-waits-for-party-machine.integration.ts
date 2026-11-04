/**
 * A phone in offline mode does not commit a queued transaction alone while one of its party's
 * own machines holds the strand and cannot be reached (gotchoices/sereus#56; docs/strands.md →
 * "Waiting for the party's own machines").
 *
 * ── The machines ──
 *
 * One party. The PHONE is its owner: `profile: 'transaction'`, no listen address, every strand
 * starting in offline mode over a file journal in a temp directory (Optimystic refuses a journal
 * that would not survive a restart). The NODE is an always-on storage machine
 * that pins the phone's owner key and runs a storage replica of every strand the party lists
 * (`hostUnclaimedStrands`), the production storage profile.
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
import type { ConnectionGater, Libp2p } from '@libp2p/interface';
import type { IKVStore } from '@optimystic/db-p2p';
import { FileKVStore } from '@optimystic/db-p2p-storage-fs';
import { CadreNode } from '@serfab/cadre-core';
import type { StrandOfflineStatus } from '@serfab/cadre-core';
import {
	waitUntil,
	sleep,
	controlNodeConfig,
	createSignedSAppConfig,
	makeOwnOwner,
	admitMember,
	captureRawStorage,
	awaitBlockCoverage,
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

async function runOfflineWaitsForPartyMachine(): Promise<void> {
	const startedAt = Date.now();
	const say = (msg: string, ...args: unknown[]): void => {
		console.log(`[OFFLINE-HOLD] ${Date.now() - startedAt} ms: ${msg}`, ...args);
	};
	const home = mkdtempSync(join(tmpdir(), 'sereus-offline-hold-'));
	let phone: CadreNode | undefined;
	let node: CadreNode | undefined;
	try {
		const runTag = Date.now();
		const partyId = `offline-hold-${runTag}`;
		const strandId = `strand-offline-hold-${runTag}`;
		const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '1.0.0');
		const phoneKey = await generateKeyPair('Ed25519');
		const nodeKey = await generateKeyPair('Ed25519');
		const phonePeerId = peerIdFromPrivateKey(phoneKey).toString();
		const nodePeerId = peerIdFromPrivateKey(nodeKey).toString();
		const phoneCut = strandPlaneCut(() => nodePeerId);
		const nodeCut = strandPlaneCut(() => phonePeerId);
		const phoneCapture = captureRawStorage();
		const nodeCapture = captureRawStorage();
		// One journal per strand scope, as a production journal is: every build asks again.
		const journals = new Map<string, IKVStore>();
		const journal = (scope: string): IKVStore => {
			let store = journals.get(scope);
			if (!store) {
				store = new FileKVStore(join(home, 'offline', scope));
				journals.set(scope, store);
			}
			return store;
		};

		// ── 1. The phone founds and publishes; the node is admitted and launches a replica ──
		phone = new CadreNode(controlNodeConfig({
			partyId, privateKey: phoneKey, profile: 'transaction', listenAddrs: [],
			reconcileMs: 2_000, strandAddrRefreshMs: POLL_MS, strandWatchMs: POLL_MS, linkRoundTripMs: LINK_MS,
			storageProvider: phoneCapture.provider, connectionGater: phoneCut.gater,
			strandOffline: { journal, initialMode: 'offline' },
		}));
		await phone.start();
		const owner = await makeOwnOwner(phone);
		const statuses: StrandOfflineStatus[] = [];
		phone.on('strand:offline-status', (event) => { statuses.push(event); });
		const phoneStrand = await phone.addStrand({
			strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null, FounderPeerId: null },
			sAppConfig: sApp,
			founder: true,
		});
		expect(phoneStrand.status).toBe('active');
		expect(phone.getStrandOfflineMode(strandId)).toBe('offline');
		await phone.publishStrand(strandId);
		const phoneStrandNode = phoneStrand.libp2pNode!;
		say('step 1: the phone founded and published the strand in offline mode');

		node = new CadreNode(controlNodeConfig({
			partyId, privateKey: nodeKey, profile: 'storage', pinnedOwnerKeys: [owner.publicKey], enableRelay: false,
			strandFilter: 'all', hostUnclaimedStrands: true, strandWatchMs: POLL_MS, reconcileMs: 2_000, linkRoundTripMs: LINK_MS,
			storageProvider: nodeCapture.provider, connectionGater: nodeCut.gater,
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
	} finally {
		await Promise.allSettled([node?.stop(), phone?.stop()]);
		// Only the journal's files, written by this process: no node_modules junctions.
		rmSync(home, { recursive: true, force: true });
	}
}

describe('offline mode waits for the party\'s own machines', () => {
	it('a phone does not commit a queued transaction alone while a party machine holding the strand is unreachable, and sends it once the machine is reached', async () => {
		await runOfflineWaitsForPartyMachine();
	}, 300_000);
});
