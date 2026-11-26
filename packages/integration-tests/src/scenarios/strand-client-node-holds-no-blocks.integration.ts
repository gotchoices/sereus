/**
 * A machine whose `strandCohortMember` role is off runs a strand as a CLIENT: it reads and
 * writes the strand through the machines that store it, and stores none of its blocks itself.
 *
 * One party, three machines, the reference chat schema (`schemas/chat-simple.qsql`). Two
 * `server`-class machines serve the strand. The third is a `device` with
 * `roles: { strandCohortMember: false }`: its strand node is an Optimystic client
 * (`servesBlocks: false`), which registers none of the storage protocols, so every other machine
 * classifies it from its identify list as not serving and leaves it out of every cohort — its own
 * view of itself included. That classification is the invariant the whole role rests on, and this
 * is the one place it is observed end to end.
 *
 * What is asserted, in order:
 *
 *   1. The client's `addStrand` resolves with a published database (a client is never gated on a
 *      first sync — there is no local copy to fork), and its strand node declares itself a client.
 *   2. The client writes a participant and a message; a serving machine reads both.
 *   3. Both serving machines physically hold the strand's blocks (a raw-store coverage check in
 *      each direction, `block-store-probe.ts`), while the client's BLOCK store for the same
 *      strand holds not one block. The client is handed storage for the strand like any other
 *      machine — it keeps its clock high-water mark, its blob records and owed-blob ledger, and
 *      blob pieces whose only copy may be the one its own host put there — so the question is
 *      not whether it was given somewhere to store blocks but whether it stored any.
 *   4. After that traffic, neither serving machine names the client in a cohort or picks it as a
 *      coordinator, and the client itself picks a serving machine.
 *   5. The client reads a message a serving machine wrote.
 *   6. All three machines published a `StrandPeer` row, and the client's row is marked `client`
 *      while the two serving rows carry no role. The row set is the party's machines that RUN the
 *      strand, and the role is what tells a serving sibling's offline queue which of them it may
 *      wait for. A client publishes its row at bring-up on an open strand like this one, where no
 *      membership loop runs to write it later.
 *
 * The two serving machines come up through `joinStrandOn` (full mesh, cohort barrier at 2). The
 * client is launched after them, so a serving machine is reachable from the start. Its strand node
 * is then dialed to both servers by hand, so the scenario's claims do not ride on seed timing.
 *
 * The SECOND test reverses that order: the client opens the strand with no serving machine running
 * it at all. A client's own cohort is empty by construction, so every block its launch touches
 * resolves no coordinator, starting with the schema catalog it opens — and the launch must WAIT
 * rather than fail, keeping its runtime up and retrying the database phase alone, which is what a
 * joining storage replica whose seed is silent already gets
 * (`docs/strands/lifecycle.md` → "A launch with nobody to answer waits").
 *
 * LIMIT THIS SCENARIO STATES: at the default strand cluster size (4) every block lives on both
 * serving machines, so "both hold it" and "the client holds nothing" are both exact. Nothing here
 * covers a strand with more serving machines than the cluster size.
 */

import { describe, it, expect } from 'vitest';
import type { Libp2p } from '@libp2p/interface';
import type { Libp2pKeyPeerNetwork } from '@optimystic/db-p2p';
import type { Database } from '@quereus/quereus';
import type { StrandInstance, StrandRow } from '@serfab/cadre-core';
import {
	bootTopology,
	joinStrandOn,
	connectStrandNodes,
	createSignedSAppConfig,
	captureRawStorage,
	readBlockIndex,
	readDurableBlockIds,
	awaitBlockCoverage,
	readCohort,
	strandPeerRoles,
	waitForCohortOn,
	waitUntil,
	CONTROL_COHORT_PROBE_KEY,
	type Topology,
	type TopologyMachine,
	type RawStorageCapture,
} from '../harness/index.js';
import { loadChatSimpleSchema } from '../fixtures/index.js';

/** One shared budget for every converge wait: mesh, coverage, cross-machine visibility. */
const CONVERGE_BUDGET_MS = 30_000;

/**
 * Anti-vacuity floor for a serving machine's strand store before the coverage check. The strand
 * schema's catalog plus two chat tables with one row each committed more than this on every
 * measured run; a store under it means the writes did not land where the check thinks they did.
 */
const SERVER_BLOCK_FLOOR = 4;

/**
 * How long the second test gives the deferred database build to succeed once a serving machine is
 * reachable. Several periods of `StrandInstanceManager`'s retry timer (a fixed 5 s, not exported),
 * plus an in-flight attempt's own coordinator-lookup window — not the number of retries, which is
 * what the cadre-core unit suite pins.
 */
const DEFERRED_BUILD_BUDGET_MS = 60_000;

/** Every machine's strand node plus its control node: six libp2p nodes, each with a converge wait. */
const TEST_TIMEOUT_MS = 180_000;

const PARTY = 'A';

/** The same open-strand row `joinStrandOn` launches its members from, for a client's own launch. */
function openStrandRow(strandId: string): StrandRow {
	return { Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null, FounderPeerId: null };
}

/**
 * The slice of db-p2p's node attachments this scenario reads. `servesBlocks` and `coordinatedRepo`
 * are what tell a client from a serving node (`OptimysticClientNode` upstream); the key network is
 * where cohorts and coordinator picks are read from. Not on libp2p's own `Libp2p` type, so read
 * through this structural shape rather than a cast to `any`.
 */
type StrandNode = Libp2p & {
	servesBlocks?: boolean;
	coordinatedRepo?: unknown;
	keyNetwork?: Libp2pKeyPeerNetwork;
};

interface ChatMessage { Id: unknown; ParticipantId: unknown }

async function messages(db: Database): Promise<ChatMessage[]> {
	const rows: ChatMessage[] = [];
	for await (const row of db.eval('select Id, ParticipantId from App.Message order by Id')) {
		rows.push({ Id: row.Id, ParticipantId: row.ParticipantId });
	}
	return rows;
}

async function insertParticipantAndMessage(db: Database, participantId: string, messageId: string): Promise<void> {
	await db.exec('insert into App.Participant (Id, Name) values (?, ?)', [participantId, participantId]);
	await db.exec(
		'insert into App.Message (Id, ParticipantId, Content, Timestamp) values (?, ?, ?, ?)',
		[messageId, participantId, `${messageId} from ${participantId}`, new Date().toISOString()],
	);
}

/** Poll `db` until a message with `messageId` is visible, and return every message it then holds. */
async function awaitMessage(db: Database, messageId: string, description: string): Promise<ChatMessage[]> {
	let seen: ChatMessage[] = [];
	await waitUntil(async () => {
		seen = await messages(db);
		return seen.some((row) => row.Id === messageId);
	}, { timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 250, description });
	return seen;
}

function databaseOf(instance: StrandInstance, label: string): Database {
	if (!instance.database) {
		throw new Error(`${label}: strand instance has no published database (status '${instance.status}')`);
	}
	return instance.database.getDatabase();
}

function strandNodeOf(instance: StrandInstance, label: string): StrandNode {
	if (!instance.libp2pNode) {
		throw new Error(`${label}: strand instance exposes no libp2p node (status '${instance.status}')`);
	}
	return instance.libp2pNode as StrandNode;
}

/** The peer the node would send a write to the probe key to: `findCoordinator`, as every write runs it. */
async function pickCoordinator(node: StrandNode, label: string): Promise<string> {
	if (!node.keyNetwork) {
		throw new Error(`${label}: strand node carries no keyNetwork attachment`);
	}
	return (await node.keyNetwork.findCoordinator(CONTROL_COHORT_PROBE_KEY)).toString();
}

interface Machines {
	servers: [TopologyMachine, TopologyMachine];
	client: TopologyMachine;
	serverCaptures: [RawStorageCapture, RawStorageCapture];
	clientCapture: RawStorageCapture;
}

async function bootMachines(): Promise<{ topology: Topology } & Machines> {
	const serverCaptures: [RawStorageCapture, RawStorageCapture] = [captureRawStorage(), captureRawStorage()];
	const clientCapture = captureRawStorage();
	const topology = await bootTopology({
		tag: 'client-node',
		parties: [{
			name: PARTY,
			machines: [
				{ nodeClass: 'server', storageProvider: serverCaptures[0].open },
				{ nodeClass: 'server', storageProvider: serverCaptures[1].open },
				{ nodeClass: 'device', roles: { strandCohortMember: false }, storageProvider: clientCapture.open },
			],
		}],
	});
	return {
		topology,
		servers: [topology.machine(PARTY, 0), topology.machine(PARTY, 1)],
		client: topology.machine(PARTY, 2),
		serverCaptures,
		clientCapture,
	};
}

describe('A strand node that holds no blocks', () => {
	it('runs the strand through the serving machines and stores none of it', async () => {
		const { topology, servers, client, serverCaptures, clientCapture } = await bootMachines();
		try {
			const strandId = `strand-client-${Date.now()}`;
			const sApp = createSignedSAppConfig(await loadChatSimpleSchema(), '1.0.0');
			const strandRow = openStrandRow(strandId);

			// ── The two serving machines found and join the strand, meshed, each seeing the other ──
			const [founderStrand, secondStrand] = await joinStrandOn({
				strandId, sAppConfig: sApp, members: servers, publish: true, timeoutMs: CONVERGE_BUDGET_MS,
			});
			const serverNodes = [strandNodeOf(founderStrand!, 'server 0'), strandNodeOf(secondStrand!, 'server 1')] as const;
			const serverPeerIds = serverNodes.map((node) => node.peerId.toString());

			// ── 1. The client opens the strand: published at once, declared a client ──
			const clientStrand = await client.node.addStrand({ strandRow, sAppConfig: sApp });
			expect(clientStrand.status).toBe('active');
			const clientNode = strandNodeOf(clientStrand, 'client');
			const clientPeerId = clientNode.peerId.toString();
			expect(clientNode.servesBlocks, 'the strand node was built as an Optimystic client').toBe(false);
			expect(clientNode.coordinatedRepo, 'a client coordinates no writes').toBeUndefined();
			expect(clientStrand.sAppInfo?.id, 'the client runs the app, not a replica').toBe(sApp.id);
			for (const [i, server] of serverNodes.entries()) {
				await connectStrandNodes(clientNode, 'client', server, `server ${i}`, CONVERGE_BUDGET_MS);
			}
			// The client's own cohort is the two serving machines: it leaves itself out.
			await waitForCohortOn(clientNode, 2, { timeoutMs: CONVERGE_BUDGET_MS, label: 'client strand node' });

			// ── 2. The client writes; a serving machine reads ──
			const clientDb = databaseOf(clientStrand, 'client');
			await insertParticipantAndMessage(clientDb, 'client', 'msg-client-1');
			const seenOnServer = await awaitMessage(databaseOf(secondStrand!, 'server 1'), 'msg-client-1',
				"server 1 reads the client's message");
			expect(seenOnServer).toEqual([{ Id: 'msg-client-1', ParticipantId: 'client' }]);

			// ── 3. Both serving machines hold the blocks; the client's block store is empty ──
			const serverStores = [serverCaptures[0].forStrand(strandId), serverCaptures[1].forStrand(strandId)] as const;
			const founderIndex = await readBlockIndex(serverStores[0]);
			console.log(`[client-node] server 0's strand store holds ${founderIndex.size} committed blocks`);
			expect(founderIndex.size).toBeGreaterThanOrEqual(SERVER_BLOCK_FLOOR);
			await awaitBlockCoverage(serverStores[0], serverStores[1], {
				timeoutMs: CONVERGE_BUDGET_MS, description: "every block server 0 holds lands in server 1's store",
			});
			await awaitBlockCoverage(serverStores[1], serverStores[0], {
				timeoutMs: CONVERGE_BUDGET_MS, description: "every block server 1 holds lands in server 0's store",
			});
			// The strand's scope IS opened for the client: a client keeps the strand's non-block
			// records (`StorageConfig.open`). So the claim under test is the stronger one — it
			// had somewhere to put blocks and put none there, while the two serving machines
			// hold every block above.
			expect(clientCapture.scopes(), "the client's storage was opened for the strand too").toContain(strandId);
			// Every id the store holds durable state for, not `readBlockIndex`'s committed ones:
			// a client that wrote pending transforms into its own block store would still be
			// holding blocks, and the committed-only form would call that empty.
			const clientBlockIds = await readDurableBlockIds(clientCapture.forStrand(strandId));
			expect(clientBlockIds, 'the client stores none of the strand\'s blocks').toEqual([]);

			// ── 4. After that traffic, no serving machine counts the client as serving ──
			for (const [i, server] of serverNodes.entries()) {
				const cohort = await readCohort(server, `server ${i}`);
				expect(new Set(cohort), `server ${i}'s cohort is the two serving machines`).toEqual(new Set(serverPeerIds));
				expect(await pickCoordinator(server, `server ${i}`)).not.toBe(clientPeerId);
			}
			expect(new Set(await readCohort(clientNode, 'client'))).toEqual(new Set(serverPeerIds));
			expect(serverPeerIds, 'the client sends its writes to a serving machine').toContain(await pickCoordinator(clientNode, 'client'));

			// ── 5. A serving machine writes; the client reads ──
			await insertParticipantAndMessage(databaseOf(founderStrand!, 'server 0'), 'server-0', 'msg-server-1');
			const seenOnClient = await awaitMessage(clientDb, 'msg-server-1', "the client reads server 0's message");
			expect(seenOnClient).toEqual([
				{ Id: 'msg-client-1', ParticipantId: 'client' },
				{ Id: 'msg-server-1', ParticipantId: 'server-0' },
			]);

			// ── 6. Every machine published a StrandPeer row, the client's marked `client` ──
			await waitUntil(async () => (await strandPeerRoles(servers[0].node, strandId, 'server 0')).size >= 3, {
				timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 250,
				description: 'all three machines have published their StrandPeer rows',
			});
			const roles = await strandPeerRoles(servers[0].node, strandId, 'server 0');
			expect(new Set(roles.keys()), 'the row set is every machine that runs the strand').toEqual(new Set([...serverPeerIds, clientPeerId]));
			expect(roles.get(clientPeerId), "the client's row says it stores none of the strand").toBe('client');
			for (const [i, peerId] of serverPeerIds.entries()) {
				expect(roles.get(peerId), `server ${i}'s row carries no role, which means it serves`).toBeNull();
			}
			// The client reads its own row back, so its write reached its own control database too.
			expect([...(await strandPeerRoles(client.node, strandId, 'client')).keys()]).toContain(clientPeerId);
		} finally {
			await topology.stop();
		}
	}, TEST_TIMEOUT_MS);

	/**
	 * The reproduction of `client-strand-waits-for-a-serving-machine`: before it, this launch threw
	 * out of `addStrand` and the whole strand was dropped until `StrandWatcher` rebuilt it from
	 * scratch on a doubling delay capped at five minutes.
	 *
	 * The client opens the strand while NO machine runs it. Its own cohort is empty, so the
	 * schema-catalog write falls through to `findCoordinator`, which resolves nobody. What must
	 * happen instead of a failed launch: the runtime stays up `'syncing'` with no database, the
	 * database phase alone is retried on the SAME libp2p node, and the strand becomes writable once
	 * a serving machine is reachable. The same-instance, same-node assertions after the wait are
	 * what separate "the deferred database build finished" from "the watcher relaunched the strand".
	 */
	it('keeps a client up and retries its database until a serving machine is reachable', async () => {
		const { topology, servers, client } = await bootMachines();
		try {
			const strandId = `strand-client-waits-${Date.now()}`;
			const sApp = createSignedSAppConfig(await loadChatSimpleSchema(), '1.0.0');
			const strandRow = openStrandRow(strandId);

			// ── The client opens the strand with nobody serving it ──
			// `awaitFirstSync: false` so the call returns the gated instance instead of spending
			// `strandFirstSync.timeoutMs` on the `StrandAwaitingFirstSyncError` an app would get.
			const clientStrand = await client.node.addStrand({ strandRow, sAppConfig: sApp, awaitFirstSync: false });
			expect(clientStrand.status, 'the launch stayed up rather than failing').toBe('syncing');
			expect(clientStrand.database, 'no coordinator could be resolved to write the schema catalog through').toBeUndefined();
			const clientNode = strandNodeOf(clientStrand, 'client');
			expect(clientNode.status, 'the strand node is running, so a serving machine can be reached through it').toBe('started');
			expect(clientNode.servesBlocks, 'the strand node was built as an Optimystic client').toBe(false);

			// ── The serving machines come up and are dialed, as a seed answering late would do ──
			const [founderStrand, secondStrand] = await joinStrandOn({
				strandId, sAppConfig: sApp, members: servers, timeoutMs: CONVERGE_BUDGET_MS,
			});
			const serverNodes = [strandNodeOf(founderStrand!, 'server 0'), strandNodeOf(secondStrand!, 'server 1')] as const;
			for (const [i, server] of serverNodes.entries()) {
				await connectStrandNodes(clientNode, 'client', server, `server ${i}`, CONVERGE_BUDGET_MS);
			}

			// ── The deferred database build finds them, on the runtime that never went down ──
			// Several retry periods: the build is retried on a timer, and an attempt that started
			// just before the dial spends its own coordinator-lookup window before the next one.
			await waitUntil(() => clientStrand.database !== undefined, {
				timeoutMs: DEFERRED_BUILD_BUDGET_MS, intervalMs: 250,
				description: "the client's deferred database build reaches a serving machine",
			});
			expect(client.node.getStrand(strandId), 'the same instance: nothing was torn down and relaunched').toBe(clientStrand);
			expect(clientStrand.libp2pNode, 'the same strand node: only the database phase was retried').toBe(clientNode);
			expect(clientStrand.status, 'a client is treated as synced, so its database is published at once').toBe('active');

			// ── And the strand is writable: the client's write commits through a serving machine ──
			await insertParticipantAndMessage(databaseOf(clientStrand, 'client'), 'client', 'msg-waited-1');
			const seenOnServer = await awaitMessage(databaseOf(secondStrand!, 'server 1'), 'msg-waited-1',
				"server 1 reads the message the client wrote once it had somewhere to send it");
			expect(seenOnServer).toEqual([{ Id: 'msg-waited-1', ParticipantId: 'client' }]);
		} finally {
			await topology.stop();
		}
	}, TEST_TIMEOUT_MS);
});
