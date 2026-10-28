#!/usr/bin/env node
/**
 * Test fixture: ONE party of a two-process strand scenario
 * (`scenarios/strand-relay-only-restart-reconverges.integration.ts`'s two-process arm,
 * `scenarios/strand-offline-queue-survives-restart.integration.ts`), run as its own `node`
 * process by `harness/strand-restart-party.ts`, which documents the request set
 * (`StrandRestartOps`) this script answers over the IPC channel.
 *
 * The party is a relay-only `CadreNode` (`listenAddrs: []`, one relay, `enableRelay: false`)
 * whose kept state lives on disk under `stateDir`, the way cadre-cli keeps it:
 *
 *   - `keys/`     `FileKeyStore` — the identity key, the owner key in its own slot beside it,
 *                 and (as the node's default `joinedStrands` store over its `keyStore`) the
 *                 strands joined from another party;
 *   - `node/`     `FileStrandNetworkStateStore` — each strand node's saved network state;
 *   - `storage/`  one `FileRawStorage` directory per storage scope, cadre-cli's layout;
 *   - `offline/`  with `offline: true` only, one `FileKVStore` per strand scope: the strand's
 *                 offline journal (`CadreNodeConfig.strandOffline`, every strand starting in
 *                 offline mode), closed after the node stops.
 *
 * The node config mirrors `harness/node-fixtures.ts` `controlNodeConfig`, which this plain
 * ESM script cannot import (it is TypeScript source).
 *
 * argv[2] is the JSON `StrandRestartPartyOptions`. The script sends `{ type: 'ready' }` once
 * the node has started, answers each `{ id, op, args }` with `{ type: 'reply', id, result }`
 * or `{ ..., error }`, forwards every `strand:offline-status` as `{ type: 'offline-status', … }`,
 * and on `{ op: 'stop' }` stops the node and exits.
 */
import { join } from 'node:path';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { FileKVStore, FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import {
	CadreNode,
	createOwnerKey,
	generateStrandMemberKey,
	loadOwnerSigner,
	summarizeConnectionPaths,
} from '@serfab/cadre-core';
import { FileKeyStore } from '@serfab/cadre-core/key-store-file';
import { FileStrandNetworkStateStore } from '@serfab/cadre-core/strand-network-state-file';

const YEAR_MS = 365 * 24 * 3600_000;
const POLL_MS = 250;

const options = JSON.parse(process.argv[2]);
const { label, partyId, stateDir, relayAddr, profile, offline } = options;
const say = (msg) => console.log(`[restart-party ${label}] ${msg}`);

const keyStore = new FileKeyStore(join(stateDir, 'keys'));
/**
 * One journal per strand scope: every database build asks again, and a second store over the
 * directory would not see the first's unflushed writes.
 */
const journals = new Map();
const journalFor = (scope) => {
	let journal = journals.get(scope);
	if (!journal) {
		journal = new FileKVStore(join(stateDir, 'offline', scope));
		journals.set(scope, journal);
	}
	return journal;
};
const node = new CadreNode({
	controlNetwork: { partyId, bootstrapNodes: [] },
	profile,
	strandFilter: { mode: 'all' },
	// Not a replica host: the storage profile here stands for "holds control blocks", and
	// the scenario asserts which strands each party runs.
	hostUnclaimedStrands: false,
	storage: { provider: (scope) => new FileRawStorage(join(stateDir, 'storage', scope)) },
	keyStore,
	strandNetworkState: { store: await FileStrandNetworkStateStore.open(join(stateDir, 'node'), partyId) },
	network: {
		transports: [webSockets(), circuitRelayTransport()],
		listenAddrs: [],
		relayAddrs: [relayAddr],
		enableRelay: false,
	},
	hibernation: { enabled: false },
	...(offline ? { strandOffline: { journal: journalFor, initialMode: 'offline' } } : {}),
});

/** Owner genesis, as `makeOwnOwner` does, over an owner key this party keeps in its key store's owner slot. */
async function makeOwnOwner() {
	const signer = await loadOwnerSigner(keyStore) ?? await createOwnerKey(keyStore);
	if (!await node.getControlDatabase().ensureOwnerKey(signer.publicKey)) {
		throw new Error('the party already has an owner key; genesis runs once per party');
	}
	await node.useOwnerSigner(signer);
}

function strandOf(strandId) {
	const instance = node.getStrand(strandId);
	if (!instance?.database) throw new Error(`strand ${strandId} is not running with a published database`);
	return instance;
}

/** Every App.Data row, by an unfiltered scan (a where-equality on the key can miss on a networked strand). */
async function readDataRows(strandId) {
	const rows = [];
	for await (const row of strandOf(strandId).database.getDatabase().eval('select Key, Val from App.Data')) {
		rows.push({ key: row.Key, val: row.Val });
	}
	return rows;
}

function offlineQueueOf(strandId) {
	const queue = strandOf(strandId).database.offline;
	if (!queue) throw new Error(`strand ${strandId} has no offline queue (this party runs without offline: true)`);
	return queue;
}

/**
 * The parts of a `QueuedTransactionStatus` the scenarios read, in a shape the IPC channel's
 * JSON carries: an `Error` there arrives as `{}`, so a failure travels as its message.
 */
function statusSummary(status) {
	const summary = { kind: status.kind, transactionId: status.transactionId };
	if (status.kind === 'queued') {
		Object.assign(summary, { persisted: status.persisted, waitingFor: status.waitingFor ?? null, attempts: status.attempts });
	} else if (status.kind === 'committed') {
		summary.effect = status.effect;
	} else if (status.kind === 'failed') {
		Object.assign(summary, { reason: status.reason, error: errorChain(status.error) });
	}
	return summary;
}

/** Poll `probe` until it returns a value other than undefined; a throw is "not yet". */
async function pollFor(probe, timeoutMs, description) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const value = await probe();
			if (value !== undefined) return value;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
	throw new Error(`Timeout waiting for ${description} after ${timeoutMs}ms${lastError ? ` (last error: ${lastError.message})` : ''}`);
}

/** Subscribe, then drain the backlog: the strand is normally offered while `start()` runs. */
function discovered(strandId) {
	return new Promise((resolve) => {
		const onDiscovered = (event) => {
			if (event.strandId !== strandId) return;
			node.off('strand:discovered', onDiscovered);
			resolve(event.strand);
		};
		node.on('strand:discovered', onDiscovered);
		const backlog = node.getDiscoveredStrands().get(strandId);
		if (backlog) {
			node.off('strand:discovered', onDiscovered);
			resolve(backlog);
		}
	});
}

const handlers = {
	async found({ strandId, sApp, sAppId }) {
		await makeOwnOwner();
		const memberPrivateKey = await generateStrandMemberKey();
		const founded = await node.foundStrand({ strandId, type: 'c', memberPrivateKey, sAppConfig: sApp });
		const invitation = await node.createOpenInvitation(sAppId, YEAR_MS);
		await node.publishFormationInvite(invitation.token, sAppId, { strandId, expiresAtMs: Date.now() + YEAR_MS, totalUses: 1 });
		return { strandPeerId: founded.instance.libp2pNode.peerId.toString(), encodedInvitation: node.encodeInvitation(invitation) };
	},

	async form({ strandId, sApp, encodedInvitation, timeoutMs }) {
		await makeOwnOwner();
		const formResult = await node.formStrand(node.decodeInvitation(encodedInvitation), { partyId, purpose: 'two-process restart re-convergence' });
		if (formResult.strandId !== strandId) throw new Error(`formed ${formResult.strandId}, expected ${strandId}`);
		const instance = await node.addStrand({
			strandRow: { Id: strandId, MemberPrivateKey: formResult.memberPrivateKey ?? null, Type: 'c', FounderOwnerKey: null },
			sAppConfig: sApp,
			awaitFirstSync: false,
		});
		await node.whenStrandWritable(strandId, { timeoutMs });
		return { strandPeerId: instance.libp2pNode.peerId.toString() };
	},

	async claim({ strandId, sApp, timeoutMs }) {
		const strandRow = await Promise.race([
			discovered(strandId),
			new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`${strandId} was never offered as strand:discovered`)), timeoutMs)),
		]);
		await node.addStrand({ strandRow, sAppConfig: sApp, awaitFirstSync: false });
		const instance = await node.whenStrandWritable(strandId, { timeoutMs });
		return { status: instance.status, strandPeerId: instance.libp2pNode.peerId.toString() };
	},

	async write({ strandId, key, val }) {
		// One statement is one commit, and its `returning` hands back that commit's id.
		const written = await strandOf(strandId).database.getDatabase()
			.get('insert into App.Data (Key, Val) values (?, ?) returning StampId() as Tx', [key, val]);
		return { transactionId: String(written.Tx) };
	},

	async rows({ strandId }) {
		return { rows: await readDataRows(strandId) };
	},

	async waitRow({ strandId, key, val, timeoutMs }) {
		await pollFor(async () => ((await readDataRows(strandId)).some((row) => row.key === key && row.val === val) ? true : undefined),
			timeoutMs, `row ${key} = ${val}`);
		return {};
	},

	async offlineEntries({ strandId }) {
		const entries = offlineQueueOf(strandId).entries()
			.map((entry) => ({ transactionId: entry.transactionId, persisted: entry.persisted, status: statusSummary(entry.status) }));
		return { entries };
	},

	async offlineStatus({ strandId, transactionId }) {
		const status = offlineQueueOf(strandId).status(transactionId);
		return { status: status === undefined ? null : statusSummary(status) };
	},

	async waitSavedAddressRecord({ strandId, peerId, timeoutMs }) {
		await pollFor(
			() => (node.getStrandNetworkStateStore().load(strandId)?.fretTable?.entries
				.some((entry) => entry.id === peerId && entry.addressRecord !== undefined) ? true : undefined),
			timeoutMs,
			`the saved network state to hold ${peerId} with an address record (a timeout here is the timing of db-p2p's saves)`,
		);
		return {};
	},

	async pathKinds({ strandId, peerId }) {
		const libp2p = node.getStrand(strandId)?.libp2pNode;
		if (!libp2p) throw new Error(`strand ${strandId} has no running node`);
		const kinds = summarizeConnectionPaths(libp2p.getConnections()).paths
			.filter((path) => path.peerId === peerId)
			.map((path) => path.kind);
		return { kinds };
	},
};

let stopping = false;

async function stopAndExit(code) {
	if (stopping) return;
	stopping = true;
	try {
		await node.stop();
	} catch (error) {
		console.error(`[restart-party ${label}] stop failed:`, error);
		code = 1;
	}
	// After the node, whose strand databases journal into these until they close; even after a
	// failed stop, so what the journals hold is flushed before the next process reads them.
	const closed = await Promise.allSettled([...journals.values()].map((journal) => journal.close()));
	for (const { reason } of closed.filter(({ status }) => status === 'rejected')) {
		console.error(`[restart-party ${label}] journal close failed:`, reason);
		code = 1;
	}
	process.exit(code);
}

process.on('message', (message) => {
	if (message.op === 'stop') {
		void stopAndExit(0);
		return;
	}
	const handler = handlers[message.op];
	const reply = handler
		? handler(message.args)
		: Promise.reject(new Error(`unknown op ${message.op}`));
	reply.then(
		(result) => process.send({ type: 'reply', id: message.id, result }),
		(error) => process.send({ type: 'reply', id: message.id, error: errorChain(error) }),
	);
});
// The parent going away (a killed test run) must not leave this node running.
process.on('disconnect', () => { void stopAndExit(0); });

function errorChain(error) {
	const parts = [];
	for (let current = error; current; current = current.cause) {
		parts.push(current instanceof Error ? `${current.name}: ${current.message}` : String(current));
	}
	return parts.join(' <- ');
}

node.on('strand:offline-status', ({ strandId, status }) => {
	const summary = statusSummary(status);
	say(`offline status ${strandId} ${summary.transactionId}: ${summary.kind}`);
	// A status delivered while the node stops after the parent went away has nowhere to go.
	if (process.connected) process.send({ type: 'offline-status', strandId, status: summary });
});

await node.start();
say(`started (control peer ${node.peerId.toString()})`);
process.send({ type: 'ready', peerId: node.peerId.toString() });
