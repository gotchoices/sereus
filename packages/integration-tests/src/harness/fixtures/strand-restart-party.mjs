#!/usr/bin/env node
/**
 * Test fixture: ONE party of the two-process arm of
 * `scenarios/strand-relay-only-restart-reconverges.integration.ts`, run as its own `node`
 * process by `harness/strand-restart-party.ts`, which documents the request set
 * (`StrandRestartOps`) this script answers over the IPC channel.
 *
 * The party is a relay-only `CadreNode` (`listenAddrs: []`, one relay, `enableRelay: false`)
 * whose kept state lives on disk under `stateDir`, the way cadre-cli keeps it:
 *
 *   - `keys/`     `FileKeyStore` — the identity key, and (as the node's default
 *                 `joinedStrands` store over its `keyStore`) the strands joined from another party;
 *   - `node/`     `FileStrandNetworkStateStore` — each strand node's saved network state;
 *   - `storage/`  one `FileRawStorage` directory per storage scope, cadre-cli's layout.
 *
 * The node config mirrors `harness/node-fixtures.ts` `controlNodeConfig`, which this plain
 * ESM script cannot import (it is TypeScript source).
 *
 * argv[2] is the JSON `StrandRestartPartyOptions`. The script sends `{ type: 'ready' }` once
 * the node has started, answers each `{ id, op, args }` with `{ type: 'reply', id, result }`
 * or `{ ..., error }`, and on `{ op: 'stop' }` stops the node and exits.
 */
import { join } from 'node:path';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import {
	CadreNode,
	ed25519KeyPairFromLibp2p,
	generateStrandMemberKey,
	loadOrCreateIdentityKey,
	summarizeConnectionPaths,
} from '@serfab/cadre-core';
import { FileKeyStore } from '@serfab/cadre-core/key-store-file';
import { FileStrandNetworkStateStore } from '@serfab/cadre-core/strand-network-state-file';

const YEAR_MS = 365 * 24 * 3600_000;
const POLL_MS = 250;

const options = JSON.parse(process.argv[2]);
const { label, partyId, stateDir, relayAddr, profile } = options;
const say = (msg) => console.log(`[restart-party ${label}] ${msg}`);

const keyStore = new FileKeyStore(join(stateDir, 'keys'));
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
});

/** Owner genesis, as `makeOwnOwner` does: the node's own key is the party's owner key. */
async function makeOwnOwner() {
	const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(await loadOrCreateIdentityKey(keyStore));
	await node.getControlDatabase().insertOwnerKey(publicKeyB64);
	await node.initializeSeedBootstrap(privateKeyB64);
}

function strandOf(strandId) {
	const instance = node.getStrand(strandId);
	if (!instance?.database) throw new Error(`strand ${strandId} is not running with a published database`);
	return instance;
}

async function readDataRows(strandId) {
	const rows = new Map();
	for await (const row of strandOf(strandId).database.getDatabase().eval('select Key, Val from App.Data')) {
		rows.set(row.Key, row.Val);
	}
	return rows;
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
		await strandOf(strandId).database.getDatabase().exec('insert into App.Data (Key, Val) values (?, ?)', [key, val]);
		return {};
	},

	async waitRow({ strandId, key, val, timeoutMs }) {
		await pollFor(async () => ((await readDataRows(strandId)).get(key) === val ? true : undefined), timeoutMs, `row ${key} = ${val}`);
		return {};
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

await node.start();
say(`started (control peer ${node.peerId.toString()})`);
process.send({ type: 'ready', peerId: node.peerId.toString() });
