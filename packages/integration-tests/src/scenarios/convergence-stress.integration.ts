/**
 * Convergence stress test for rapid message inserts across nodes.
 *
 * Extends the websocket-chat.integration.ts single-message pattern to exercise
 * rapid inserts from both nodes and verify eventual convergence.
 *
 * Note: Optimystic uses synchronous replication — each write blocks until the
 * peer acknowledges. Truly simultaneous writes from both sides (Promise.all)
 * cause mutual blocking. These tests exercise rapid sequential and interleaved
 * writes, which is the realistic concurrency pattern for the system.
 *
 * Scenarios:
 *   1. Sequential bursts from both nodes (10+10 → 20 converged)
 *   2. Interleaved inserts with random delays
 *   3. Disconnection resilience (data persistence through disconnect/reconnect)
 */

import { describe, it, expect, afterAll } from 'vitest';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { CadreNode, signSchema } from '@serfab/cadre-core';
import type { CadreNodeConfig, StrandRow, StrandInstance, SAppConfig } from '@serfab/cadre-core';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { waitUntil, sleep } from '../harness/wait-utils.js';
import { randomUUID } from 'node:crypto';

// ── Chat schema (mirrors websocket-chat.integration.ts) ─────────────────

const CHAT_SCHEMA = `
table Member (
    Id text primary key,
    Name text not null check (length(Name) between 1 and 100)
);

table Message (
    Id text primary key,
    MemberId text not null,
    Content text not null,
    Timestamp datetime not null,
    foreign key (MemberId) references Member(Id)
);
`;

const chatAuthorPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
const chatAuthorPublicKey = getPublicKey(chatAuthorPrivateKey, 'ed25519', 'base64url', 'base64url') as string;

const CHAT_SAPP_CONFIG: SAppConfig = {
	id: chatAuthorPublicKey,
	version: '0.1.0',
	schema: CHAT_SCHEMA,
	signature: signSchema(CHAT_SCHEMA, '0.1.0', chatAuthorPrivateKey),
	latencyHint: 'interactive' as const,
};

// ── Helpers ─────────────────────────────────────────────────────────────

function wsTransports() {
	return [webSockets(), circuitRelayTransport()];
}

function nowTimestamp(): string {
	return new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

/** Collect all rows from an eval() async iterator. */
async function queryAll(
	db: { eval(sql: string): AsyncIterableIterator<Record<string, unknown>> },
	sql: string,
): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	for await (const row of db.eval(sql)) {
		rows.push(row);
	}
	return rows;
}

/**
 * Insert N messages rapidly on a strand using locally-generated UUID keys.
 * Each insert awaits completion (Optimystic synchronous replication). The UUID
 * key is collision-free across concurrent peers — a max(Id)+1 read would collide
 * when both nodes post before either replicates.
 */
async function insertBatch(
	strand: StrandInstance,
	memberId: string,
	count: number,
	prefix: string,
): Promise<void> {
	const db = strand.database!.getDatabase();
	for (let i = 0; i < count; i++) {
		await db.exec(
			`insert into App.Message (Id, MemberId, Content, Timestamp)
			 values (?, ?, ?, ?)`,
			[randomUUID(), memberId, `${prefix}-${i}`, nowTimestamp()],
		);
	}
}

/**
 * Wait for message count convergence across all strands.
 * Returns the time (ms) from invocation until convergence.
 */
async function waitForConvergence(
	strands: StrandInstance[],
	expectedCount: number,
	timeoutMs = 30_000,
): Promise<number> {
	const start = Date.now();
	await waitUntil(
		async () => {
			for (const strand of strands) {
				const db = strand.database!.getDatabase();
				const row = await db.get('select count(*) as cnt from App.Message');
				if ((row?.cnt as number) < expectedCount) return false;
			}
			return true;
		},
		{ timeoutMs, intervalMs: 250, description: `convergence at ${expectedCount} messages` },
	);
	return Date.now() - start;
}

/** Assert that two strands have identical message sets. */
async function assertIdenticalMessages(
	strandA: StrandInstance,
	strandB: StrandInstance,
	expectedCount: number,
): Promise<void> {
	const dbA = strandA.database!.getDatabase();
	const dbB = strandB.database!.getDatabase();

	const rowsA = await queryAll(dbA, 'select Id, MemberId, Content from App.Message order by Content');
	const rowsB = await queryAll(dbB, 'select Id, MemberId, Content from App.Message order by Content');

	expect(rowsA.length).toBe(expectedCount);
	expect(rowsB.length).toBe(expectedCount);

	// Same content sets
	const contentsA = rowsA.map(r => r.Content as string).sort();
	const contentsB = rowsB.map(r => r.Content as string).sort();
	expect(contentsA).toEqual(contentsB);

	// No duplicate content values
	const uniqueA = new Set(contentsA);
	expect(uniqueA.size).toBe(expectedCount);
}

// ── Shared setup ────────────────────────────────────────────────────────

interface TestContext {
	drone: CadreNode;
	phone: CadreNode;
	droneStrand: StrandInstance;
	phoneStrand: StrandInstance;
}

async function setupDroneAndPhone(tag: string): Promise<TestContext> {
	const partyId = `convergence-${tag}-${Date.now()}`;
	const strandId = `strand-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

	// Drone: storage profile, WS listener
	const droneConfig: CadreNodeConfig = {
		controlNetwork: { partyId, bootstrapNodes: [] },
		profile: 'storage',
		strandFilter: { mode: 'all' },
		storage: { provider: () => new MemoryRawStorage() },
		network: {
			transports: wsTransports(),
			listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws'],
			enableRelay: true,
		},
		hibernation: { enabled: false },
	};

	const drone = new CadreNode(droneConfig);
	await drone.start();

	const droneAddrs = drone.getControlNode()!.getMultiaddrs().map(ma => ma.toString());

	// Phone: transaction profile, WS dialer
	const phoneConfig: CadreNodeConfig = {
		controlNetwork: { partyId, bootstrapNodes: droneAddrs },
		profile: 'transaction',
		strandFilter: { mode: 'all' },
		storage: { provider: () => new MemoryRawStorage() },
		network: {
			transports: wsTransports(),
			listenAddrs: [],
		},
		hibernation: { enabled: false },
	};

	const phone = new CadreNode(phoneConfig);
	await phone.start();

	// Wait for control-level connection
	const phoneNode = phone.getControlNode()!;
	await waitUntil(
		() => phoneNode.getConnections().length > 0,
		{ timeoutMs: 10_000, description: 'phone connects to drone' },
	);

	// Create strand on both nodes
	const strandRow: StrandRow = { Id: strandId, MemberPrivateKey: null, Type: 'o' };

	const droneStrand = await drone.addStrand({ strandRow, sAppConfig: CHAT_SAPP_CONFIG, mode: 'networked' });
	expect(droneStrand.status).toBe('active');

	const phoneStrand = await phone.addStrand({ strandRow, sAppConfig: CHAT_SAPP_CONFIG, mode: 'networked' });
	expect(phoneStrand.status).toBe('active');

	// Connect strand-level libp2p nodes
	const droneStrandAddrs = droneStrand.libp2pNode!.getMultiaddrs();
	expect(droneStrandAddrs.length).toBeGreaterThan(0);

	await phoneStrand.libp2pNode!.dial(droneStrandAddrs[0]);
	await waitUntil(
		() => phoneStrand.libp2pNode!.getConnections().length > 0,
		{ timeoutMs: 10_000, description: 'phone strand connects to drone strand' },
	);
	await waitUntil(
		() => droneStrand.libp2pNode!.getConnections().length > 0,
		{ timeoutMs: 10_000, description: 'drone strand sees inbound connection' },
	);

	// Seed both sides with a member
	const droneDb = droneStrand.database!.getDatabase();
	await droneDb.exec("insert into App.Member (Id, Name) values ('drone-1', 'Drone')");

	const phoneDb = phoneStrand.database!.getDatabase();
	await phoneDb.exec("insert into App.Member (Id, Name) values ('phone-1', 'Phone')");

	// Wait for member replication both ways
	await waitUntil(
		async () => {
			const row = await phoneDb.get("select Id from App.Member where Id = 'drone-1'");
			return row?.Id === 'drone-1';
		},
		{ timeoutMs: 15_000, intervalMs: 250, description: 'drone member replicates to phone' },
	);
	await waitUntil(
		async () => {
			const row = await droneDb.get("select Id from App.Member where Id = 'phone-1'");
			return row?.Id === 'phone-1';
		},
		{ timeoutMs: 15_000, intervalMs: 250, description: 'phone member replicates to drone' },
	);

	return { drone, phone, droneStrand, phoneStrand };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('Convergence Stress Tests', () => {

	// ── Scenario 1: Sequential burst inserts from both nodes ────────────

	describe('Sequential Burst Convergence', () => {
		let ctx: TestContext | undefined;

		afterAll(async () => {
			await ctx?.phone.stop();
			await ctx?.drone.stop();
		});

		it('should converge after rapid burst inserts from both nodes', async () => {
			ctx = await setupDroneAndPhone('burst');

			// Drone inserts 10 messages rapidly (each awaited for replication)
			await insertBatch(ctx.droneStrand, 'drone-1', 10, 'drone-msg');
			console.log('Drone burst: 10 messages inserted');

			// Phone inserts 10 messages rapidly
			await insertBatch(ctx.phoneStrand, 'phone-1', 10, 'phone-msg');
			console.log('Phone burst: 10 messages inserted');

			// Wait for convergence: both nodes should have 20 messages
			const convergenceMs = await waitForConvergence(
				[ctx.droneStrand, ctx.phoneStrand],
				20,
				30_000,
			);
			console.log(`Sequential burst: converged in ${convergenceMs}ms`);

			// Assert identical message sets
			await assertIdenticalMessages(ctx.droneStrand, ctx.phoneStrand, 20);

			console.log('Sequential burst: convergence verified');
		});
	});

	// ── Scenario 2: Interleaved inserts ─────────────────────────────────

	describe('Interleaved Inserts', () => {
		let ctx: TestContext | undefined;

		afterAll(async () => {
			await ctx?.phone.stop();
			await ctx?.drone.stop();
		});

		it('should converge with interleaved inserts and random delays', async () => {
			ctx = await setupDroneAndPhone('interleaved');

			const droneDb = ctx.droneStrand.database!.getDatabase();
			const phoneDb = ctx.phoneStrand.database!.getDatabase();

			// Interleave: odd on drone, even on phone, collision-free UUID keys.
			//
			// Each iteration reads before it writes. Optimystic convergence is
			// read-driven: a peer observes another peer's appends when it reads,
			// so a write-only loop never pulls the other side's rows. This mirrors
			// the real chat app, where every peer polls queryMessages on a timer
			// (useChat / messages.svelte) between sends. The previous version got
			// this read for free from the `select max(Id)+1` subquery it used to
			// pick the key; now that the key is a locally-generated UUID (no read),
			// the poll is explicit. Reading the full list, as the app's poll does.
			for (let i = 1; i <= 20; i++) {
				if (i % 2 === 1) {
					await queryAll(droneDb, 'select Id from App.Message');
					await droneDb.exec(
						`insert into App.Message (Id, MemberId, Content, Timestamp)
						 values (?, 'drone-1', ?, ?)`,
						[randomUUID(), `interleaved-${i}`, nowTimestamp()],
					);
				} else {
					await queryAll(phoneDb, 'select Id from App.Message');
					await phoneDb.exec(
						`insert into App.Message (Id, MemberId, Content, Timestamp)
						 values (?, 'phone-1', ?, ?)`,
						[randomUUID(), `interleaved-${i}`, nowTimestamp()],
					);
				}
				// Random delay 0-50ms between inserts
				await sleep(Math.floor(Math.random() * 50));
			}

			// Wait for convergence
			const convergenceMs = await waitForConvergence(
				[ctx.droneStrand, ctx.phoneStrand],
				20,
				30_000,
			);
			console.log(`Interleaved inserts: converged in ${convergenceMs}ms`);

			// Assert identical message sets
			await assertIdenticalMessages(ctx.droneStrand, ctx.phoneStrand, 20);

			console.log('Interleaved inserts: convergence verified');
		});
	});

	// ── Scenario 3: Data persistence through disconnection ──────────────

	describe('Disconnection Resilience', () => {
		let ctx: TestContext | undefined;

		afterAll(async () => {
			await ctx?.phone.stop();
			await ctx?.drone.stop();
		});

		it('should retain converged data after disconnect and reconnect', async () => {
			ctx = await setupDroneAndPhone('reconnect');

			// 1. Bidirectional inserts while connected (sequential)
			await insertBatch(ctx.droneStrand, 'drone-1', 5, 'drone-msg');
			await insertBatch(ctx.phoneStrand, 'phone-1', 5, 'phone-msg');

			// Wait for convergence at 10 messages
			const preDisconnectMs = await waitForConvergence(
				[ctx.droneStrand, ctx.phoneStrand],
				10,
				15_000,
			);
			console.log(`Pre-disconnect: converged at 10 in ${preDisconnectMs}ms`);

			// Snapshot content before disconnect
			const droneDb = ctx.droneStrand.database!.getDatabase();
			const phoneDb = ctx.phoneStrand.database!.getDatabase();
			const preDisconnectDrone = await queryAll(droneDb, 'select Content from App.Message order by Content');
			const preDisconnectPhone = await queryAll(phoneDb, 'select Content from App.Message order by Content');
			expect(preDisconnectDrone).toEqual(preDisconnectPhone);

			// 2. Disconnect: hang up all connections between strand nodes
			const phoneStrandNode = ctx.phoneStrand.libp2pNode!;
			const phoneConns = phoneStrandNode.getConnections();
			for (const conn of phoneConns) {
				await phoneStrandNode.hangUp(conn.remotePeer);
			}

			await waitUntil(
				() => phoneStrandNode.getConnections().length === 0,
				{ timeoutMs: 5_000, description: 'phone strand fully disconnected' },
			);
			console.log('Phone strand disconnected');

			// 3. Verify data persists on both sides while disconnected
			const droneCount = await droneDb.get('select count(*) as cnt from App.Message');
			const phoneCount = await phoneDb.get('select count(*) as cnt from App.Message');
			expect(droneCount?.cnt).toBe(10);
			expect(phoneCount?.cnt).toBe(10);

			// Verify content is unchanged
			const offlineDrone = await queryAll(droneDb, 'select Content from App.Message order by Content');
			const offlinePhone = await queryAll(phoneDb, 'select Content from App.Message order by Content');
			expect(offlineDrone).toEqual(preDisconnectDrone);
			expect(offlinePhone).toEqual(preDisconnectPhone);
			console.log('Offline: both sides retain all 10 messages with identical content');

			// 4. Reconnect
			const droneStrandAddrs = ctx.droneStrand.libp2pNode!.getMultiaddrs();
			await phoneStrandNode.dial(droneStrandAddrs[0]);
			await waitUntil(
				() => phoneStrandNode.getConnections().length > 0,
				{ timeoutMs: 10_000, description: 'phone strand reconnects to drone strand' },
			);
			console.log('Phone strand reconnected');

			// 5. Verify data is still intact after reconnection
			const postReconnDrone = await queryAll(droneDb, 'select Content from App.Message order by Content');
			const postReconnPhone = await queryAll(phoneDb, 'select Content from App.Message order by Content');
			expect(postReconnDrone).toEqual(preDisconnectDrone);
			expect(postReconnPhone).toEqual(preDisconnectPhone);
			expect(postReconnDrone.length).toBe(10);

			console.log('Disconnection resilience: data integrity verified');
		});
	});
});
