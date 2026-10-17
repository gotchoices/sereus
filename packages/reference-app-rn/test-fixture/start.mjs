#!/usr/bin/env node

/**
 * start.mjs — Drone test fixture entry point.
 *
 * Starts a CadreNode with in-memory storage and an HTTP sidecar
 * for Maestro UI test orchestration.
 *
 * Usage:
 *   node packages/reference-app-rn/test-fixture/start.mjs
 */

import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CadreNode, createOwnerKey, InMemoryKeyStore } from '@serfab/cadre-core';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { createSidecar } from './sidecar.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PARTY_ID = 'reference-chat-party';
const WS_PORT = parseInt(process.env.DRONE_WS_PORT ?? '4002', 10);
const HTTP_PORT = parseInt(process.env.DRONE_HTTP_PORT ?? '4080', 10);

// ── Chat sApp (mirrors src/chat-strand.ts) ─────────────────────────────────

const CHAT_SCHEMA = `
table Participant (
    Id text primary key,
    Name text not null check (length(Name) between 1 and 100),
    Role text not null default 'member' check (Role in ('owner', 'member'))
);

table Message (
    Id text primary key,
    ParticipantId text not null,
    Content text not null,
    Timestamp datetime not null,
    foreign key (ParticipantId) references Participant(Id)
);
`;

const CHAT_SAPP_CONFIG = {
	id: 'sereus-chat-simple',
	version: '0.1.0',
	schema: CHAT_SCHEMA,
	latencyHint: 'interactive',
};

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
	console.log('Starting drone test fixture...');

	// The drone's owner key, made in an owner slot as an app makes one; in memory, since the
	// party lasts one fixture run.
	const owner = await createOwnerKey(new InMemoryKeyStore());

	// Pre-generate strand ID for deterministic test data
	const strandId = randomUUID();

	const node = new CadreNode({
		controlNetwork: {
			partyId: PARTY_ID,
			bootstrapNodes: [],
		},
		profile: 'storage',
		strandFilter: { mode: 'all' },
		storage: {
			provider: () => new MemoryRawStorage(),
		},
		network: {
			transports: [webSockets(), circuitRelayTransport()],
			listenAddrs: [`/ip4/127.0.0.1/tcp/${WS_PORT}/ws`],
			enableRelay: true,
		},
		hibernation: { enabled: false },
		// Same demo opt-out as the phone (src/cadre-phone.ts): the chat sApp config
		// is unsigned, so the fail-closed schema policy would refuse the strand.
		requireSignedSchemas: false,
	});

	node.on('strand:started', ({ strandId: sid }) => {
		console.log(`  Strand started: ${sid}`);
	});
	node.on('strand:error', ({ strandId: sid, error }) => {
		console.error(`  Strand error (${sid}): ${error.message}`);
	});
	node.on('seed:received', ({ peerId }) => {
		console.log(`  Seed received from: ${peerId}`);
	});

	await node.start();
	console.log(`  Peer ID: ${node.peerId.toString()}`);

	// Seed bootstrap — allows creating + delivering seeds
	await node.useOwnerSigner(owner);

	// Enroll the drone's own owner key into the replicated OwnerKey table: the
	// member that redeems the invitation below checks the row's issuer against it.
	// The invitation's `ownerKeys` come from the node-local anchor, which
	// `useOwnerSigner` above already seeded with this same key.
	const controlDb = node.getControlDatabase();
	if (!controlDb) throw new Error('Control database unavailable; cannot enroll drone owner');
	await controlDb.ensureOwnerKey(owner.publicKey, 'drone');

	// Mint the cadre invitation the phone redeems at this drone (`_setup.yaml`
	// pastes it into `input-cadre-invitation`). Its member address is the ws
	// listener above, so the phone dials the drone directly; an hour covers a slow
	// device run. It admits the phone as a machine only, and the flow then creates a
	// strand, which needs an owner: the owner-grant join arrives with `reference-app-rn-owner-grants`.
	const { encoded: cadreInvitation } = await node.createCadreInvitation({ expiresInMs: 60 * 60_000 });

	// Found the pre-configured chat strand: publish its row naming this machine as founder
	// and launch it. A bare `addStrand` of an unpublished row would launch as a joiner and
	// wait for a first sync from a member that does not exist.
	const { instance: strand } = await node.foundStrand({ strandId, sAppConfig: CHAT_SAPP_CONFIG });
	console.log(`  Strand created: ${strandId}`);

	// Register the drone as a chat participant
	const droneDb = strand.database.getDatabase();
	await droneDb.exec(
		'insert or ignore into App.Participant (Id, Name) values (?, ?)',
		['drone', 'Test Drone'],
	);

	// The WS address, logged for a manual run; the e2e phone reaches the drone through
	// the invitation's member address instead.
	const multiaddrs = node.getMultiaddrs();
	const bootstrapAddr = multiaddrs.find((a) => a.includes('/ws')) ?? multiaddrs[0];
	console.log(`  Bootstrap addr: ${bootstrapAddr}`);

	// Start HTTP sidecar
	const sidecar = createSidecar(node, CHAT_SAPP_CONFIG);
	await new Promise((resolve) => {
		sidecar.listen(HTTP_PORT, '0.0.0.0', resolve);
	});
	console.log(`  HTTP sidecar: http://localhost:${HTTP_PORT}`);

	// Write test-data.json
	const testData = {
		strandId,
		cadreInvitation,
	};
	const testDataPath = join(__dirname, 'test-data.json');
	await writeFile(testDataPath, JSON.stringify(testData, null, '\t'));
	console.log(`  Test data: ${testDataPath}`);

	console.log('\nDrone fixture ready. Press Ctrl+C to stop.');

	// Graceful shutdown
	const shutdown = async () => {
		console.log('\nShutting down...');
		sidecar.close();
		await node.stop();
		console.log('Drone fixture stopped.');
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	// Keep alive
	await new Promise(() => {});
}

main().catch((err) => {
	console.error('Drone fixture failed:', err);
	process.exit(1);
});
