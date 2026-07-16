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

import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CadreNode, ed25519PublicKeyFromPrivate } from '@serfab/cadre-core';
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
table Member (
    Id text primary key,
    Name text not null check (length(Name) between 1 and 100),
    Role text not null default 'member' check (Role in ('owner', 'member'))
);

table Message (
    Id text primary key,
    MemberId text not null,
    Content text not null,
    Timestamp datetime not null,
    foreign key (MemberId) references Member(Id)
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

	// Generate owner keypair — raw 32-byte Ed25519 seed, base64url-encoded.
	const ownerPrivateKey = randomBytes(32).toString('base64url');

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
	node.initializeSeedBootstrap(ownerPrivateKey);

	// Enroll the drone's own owner key so a cold-start invitee can pin it
	// out-of-band. Without this, getOwnerKeys() is empty and the minted
	// invite carries no ownerKeys (undefined) — useless for trust anchoring.
	const ownerPublicKey = ed25519PublicKeyFromPrivate(ownerPrivateKey);
	const controlDb = node.getControlDatabase();
	if (!controlDb) throw new Error('Control database unavailable; cannot enroll drone owner');
	await controlDb.ensureOwnerKey(ownerPublicKey);

	// Mint an enrollment invite carrying the drone owner key out-of-band.
	const { encodedInvite } = await node.createInvite();

	// Create pre-configured chat strand
	const strand = await node.addStrand({
		strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' },
		sAppConfig: CHAT_SAPP_CONFIG,
	});
	console.log(`  Strand created: ${strandId}`);

	// Register the drone as a member
	const droneDb = strand.database.getDatabase();
	await droneDb.exec(
		'insert or ignore into App.Member (Id, Name) values (?, ?)',
		['drone', 'Test Drone'],
	);

	// Resolve the WS bootstrap address (includes peer ID)
	const multiaddrs = node.getMultiaddrs();
	const bootstrapAddr = multiaddrs.find((a) => a.includes('/ws')) ?? multiaddrs[0];
	console.log(`  Bootstrap addr: ${bootstrapAddr}`);

	// Create initial seed
	const seed = await node.createSeed();
	const encodedSeed = node.encodeSeed(seed);

	// Start HTTP sidecar
	const sidecar = createSidecar(node, CHAT_SAPP_CONFIG);
	await new Promise((resolve) => {
		sidecar.listen(HTTP_PORT, '0.0.0.0', resolve);
	});
	console.log(`  HTTP sidecar: http://localhost:${HTTP_PORT}`);

	// Write test-data.json
	const testData = {
		partyId: PARTY_ID,
		droneBootstrapAddr: bootstrapAddr,
		seed: encodedSeed,
		strandId,
		enrollInvite: encodedInvite,
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
