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
 *      each direction, `block-store-probe.ts`), while the client's storage provider was never
 *      asked for the strand's scope — the client has no strand store at all.
 *   4. After that traffic, neither serving machine names the client in a cohort or picks it as a
 *      coordinator, and the client itself picks a serving machine.
 *   5. The client reads a message a serving machine wrote.
 *   6. The client published no `StrandPeer` row: the party's row set keeps meaning "the machines
 *      that serve this strand", which is what a serving sibling's offline queue waits for.
 *
 * The two serving machines come up through `joinStrandOn` (full mesh, cohort barrier at 2). The
 * client is launched after them, so a serving machine is reachable from its launch seed: a client
 * cannot open the strand database with no serving machine reachable (ticket
 * `client-strand-waits-for-a-serving-machine` owns what happens then). Its strand node is then
 * dialed to both servers by hand, so the scenario's claims do not ride on seed timing.
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
	awaitBlockCoverage,
	readCohort,
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

/** Every machine's strand node plus its control node: six libp2p nodes, each with a converge wait. */
const TEST_TIMEOUT_MS = 180_000;

const PARTY = 'A';

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

/** Every strand peer id with a `StrandPeer` row for `strandId`, as `reader`'s control database holds them. */
async function strandPeerRowIds(reader: TopologyMachine, strandId: string): Promise<string[]> {
	const control = reader.node.getControlDatabase();
	if (!control) {
		throw new Error(`${reader.party}[${reader.index}]: no control database`);
	}
	return (await control.queryStrandPeers(strandId)).map((row) => row.strandPeerId);
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
				{ nodeClass: 'server', storageProvider: serverCaptures[0].provider },
				{ nodeClass: 'server', storageProvider: serverCaptures[1].provider },
				{ nodeClass: 'device', roles: { strandCohortMember: false }, storageProvider: clientCapture.provider },
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
			// The same open-strand row `joinStrandOn` launches its members from, for the client's launch.
			const strandRow: StrandRow = { Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null, FounderPeerId: null };

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

			// ── 3. Both serving machines hold the blocks; the client has no strand store ──
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
			expect(clientCapture.scopes(), "the client's provider was asked for its control store only").not.toContain(strandId);
			expect(() => clientCapture.forStrand(strandId)).toThrow(/no raw store was created/);

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

			// ── 6. The client published no StrandPeer row ──
			await waitUntil(async () => (await strandPeerRowIds(servers[0], strandId)).length >= 2, {
				timeoutMs: CONVERGE_BUDGET_MS, intervalMs: 250,
				description: 'both serving machines have published their StrandPeer rows',
			});
			const rows = await strandPeerRowIds(servers[0], strandId);
			expect(new Set(rows), 'the row set is exactly the machines that serve the strand').toEqual(new Set(serverPeerIds));
			expect(await strandPeerRowIds(client, strandId)).not.toContain(clientPeerId);
		} finally {
			await topology.stop();
		}
	}, TEST_TIMEOUT_MS);
});
