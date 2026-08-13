/**
 * Multi-party strand workflow integration tests.
 *
 * Validates the full cross-party strand lifecycle: two independent parties
 * (each a CadreNode with its own partyId) forming strands, exchanging
 * messages, and converging under concurrent writes and network disruptions.
 *
 * Scenarios:
 *   1. Closed strand formation + bidirectional messaging
 *   2. Party C exclusion (token reuse rejection)
 *   3. Open strand join + bidirectional messaging
 *   4. Cross-party interleaved writes
 *   5. Multi-round bidirectional exchange
 */

import { describe, it, expect } from 'vitest';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import {
	CadreNode,
	type CadreNodeConfig,
	type StrandRow,
	type StrandInstance,
	type SAppConfig,
	type StrandProvisioner,
	type FormationUsageRecorder,
} from '@serfab/cadre-core';
import { generatePrivateKey } from '@optimystic/quereus-plugin-crypto';
import { waitUntil, wsTransports, createSignedSAppConfig } from '../harness/index.js';

// ── Schemas ────────────────────────────────────────────────────────────────

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

const SIMPLE_SCHEMA = `
table Data (
    Key text primary key,
    Val text
);
`;

// ── Signed sApp configs ────────────────────────────────────────────────────

const CHAT_SAPP_CONFIG = createSignedSAppConfig(CHAT_SCHEMA, '0.1.0');
const SIMPLE_SAPP_CONFIG = createSignedSAppConfig(SIMPLE_SCHEMA, '0.1.0');

// ── Mock implementations ───────────────────────────────────────────────────

function createMockProvisioner(prefix = 'mp'): StrandProvisioner {
	let counter = 0;
	return {
		provisionStrand: async (_sAppId, _initiatorKey, _responderKey) => ({
			strandId: `strand-${prefix}-${++counter}`,
		}),
	};
}

function createMockUsageRecorder(): FormationUsageRecorder & {
	knownTokens: Set<string>;
	usedTokens: Map<string, { peerKey: string; strandId: string }>;
} {
	const knownTokens = new Set<string>();
	const usedTokens = new Map<string, { peerKey: string; strandId: string }>();
	return {
		knownTokens,
		usedTokens,
		recordUsage: async ({ token, peerKey, strandId }) => {
			usedTokens.set(token, { peerKey, strandId });
		},
		isTokenUsed: async (token) => usedTokens.has(token),
		isTokenValid: async (token) => ({
			valid: knownTokens.has(token),
		}),
	};
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function createNodeConfig(
	partyId: string,
	opts: { bootstrapNodes?: string[]; profile?: 'storage' | 'transaction' } = {},
): CadreNodeConfig {
	return {
		controlNetwork: { partyId, bootstrapNodes: opts.bootstrapNodes ?? [] },
		profile: opts.profile ?? 'storage',
		strandFilter: { mode: 'all' },
		storage: { provider: () => new MemoryRawStorage() },
		network: {
			transports: wsTransports(),
			listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws'],
			enableRelay: true,
		},
		hibernation: { enabled: false },
	};
}

function nowTimestamp(): string {
	return new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

/** Collect all rows from an eval() async iterator. */
async function queryAll(db: { eval(sql: string): AsyncIterableIterator<Record<string, unknown>> }, sql: string): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	for await (const row of db.eval(sql)) {
		rows.push(row);
	}
	return rows;
}

/** Add matching strand instances on both parties and connect their libp2p nodes. */
async function setupStrandBetweenParties(
	partyA: CadreNode,
	partyB: CadreNode,
	strandId: string,
	sAppConfig: SAppConfig,
	opts: { type?: 'o' | 'c'; memberPrivateKeyA?: string | null; memberPrivateKeyB?: string | null } = {},
): Promise<{ strandA: StrandInstance; strandB: StrandInstance }> {
	const strandRow = (memberPrivateKey: string | null): StrandRow => ({
		Id: strandId,
		MemberPrivateKey: memberPrivateKey,
		Type: opts.type ?? 'o',
	});

	const strandA = await partyA.addStrand({ strandRow: strandRow(opts.memberPrivateKeyA ?? null), sAppConfig });
	expect(strandA.status).toBe('active');

	const strandB = await partyB.addStrand({ strandRow: strandRow(opts.memberPrivateKeyB ?? null), sAppConfig });
	expect(strandB.status).toBe('active');

	// Manually connect strand-level libp2p nodes (strand peer discovery not yet wired)
	const addrsA = strandA.libp2pNode!.getMultiaddrs();
	expect(addrsA.length).toBeGreaterThan(0);

	await strandB.libp2pNode!.dial(addrsA[0]!);
	await waitUntil(
		() => strandB.libp2pNode!.getConnections().length > 0,
		{ timeoutMs: 10_000, description: 'strand B connects to strand A' },
	);
	// Wait for A to also register the inbound connection
	await waitUntil(
		() => strandA.libp2pNode!.getConnections().length > 0,
		{ timeoutMs: 10_000, description: 'strand A sees inbound connection from B' },
	);

	return { strandA, strandB };
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1: Formation workflows
// ═══════════════════════════════════════════════════════════════════════════

describe('Multi-Party Strand Workflows', () => {

	describe('Phase 1: Formation workflows', () => {

		// ── Scenario 1: Closed strand formation + bidirectional messaging ──

		it('should form a closed strand and exchange messages bidirectionally', async () => {
			let partyA: CadreNode | undefined;
			let partyB: CadreNode | undefined;

			try {
				const ts = Date.now();

				// Party A = responder (storage, WS listener)
				partyA = new CadreNode(createNodeConfig(`party-a-closed-${ts}`));
				await partyA.start();

				// Party B = initiator (storage, bootstraps from A)
				partyB = new CadreNode(createNodeConfig(`party-b-closed-${ts}`, {
					bootstrapNodes: partyA.getMultiaddrs(),
				}));
				await partyB.start();

				// Initialize solicitation on Party A
				const provisioner = createMockProvisioner('closed');
				const recorder = createMockUsageRecorder();
				partyA.initializeStrandSolicitation({
					strandProvisioner: provisioner,
					formationUsageRecorder: recorder,
				});

				// Party A creates invitation
				const invitation = await partyA.createOpenInvitation('chat-sapp', 60_000);
				recorder.knownTokens.add(invitation.token);

				// Party B forms strand via invitation
				const formResult = await partyB.formStrand(invitation, {
					partyId: `party-b-closed-${ts}`,
					purpose: 'Closed strand test',
				});

				expect(formResult.strandId).toBeDefined();
				expect(formResult.memberKey).toBeDefined();
				expect(formResult.invitePrivateKey).toBeDefined();

				// Record usage so token is consumed
				await partyA.getStrandSolicitationService()!.recordFormationComplete(
					invitation.token, formResult.memberKey, formResult.strandId,
					{ usageStampId: 'stamp-closed-strand', peerSignature: 'sig-closed-strand' },
				);

				// Both parties add closed strand instances
				// Party A generates its own member key for the strand
				const aPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
				const { strandA, strandB } = await setupStrandBetweenParties(
					partyA, partyB, formResult.strandId, CHAT_SAPP_CONFIG,
					{ type: 'c', memberPrivateKeyA: aPrivateKey, memberPrivateKeyB: formResult.invitePrivateKey },
				);

				// Party A inserts a member + message
				const dbA = strandA.database!.getDatabase();
				await dbA.exec("insert into App.Member (Id, Name) values ('a-1', 'Alice')");
				// Message.Id is a text primary key (collision-free across concurrent
				// peers); fixed text ids keep these replication assertions deterministic.
				await dbA.exec(
					`insert into App.Message (Id, MemberId, Content, Timestamp)
					 values ('msg-a-1', 'a-1', 'Hello from Party A', '${nowTimestamp()}')`,
				);

				// Assert: replicates to Party B
				const dbB = strandB.database!.getDatabase();
				await waitUntil(
					async () => {
						const row = await dbB.get("select Content from App.Message where Id = 'msg-a-1'");
						return row?.Content === 'Hello from Party A';
					},
					{ timeoutMs: 15_000, intervalMs: 250, description: 'message replicates A→B' },
				);

				// Party B inserts a reply
				await dbB.exec("insert into App.Member (Id, Name) values ('b-1', 'Bob')");
				await dbB.exec(
					`insert into App.Message (Id, MemberId, Content, Timestamp)
					 values ('msg-b-1', 'b-1', 'Reply from Party B', '${nowTimestamp()}')`,
				);

				// Assert: reply replicates to Party A
				await waitUntil(
					async () => {
						const row = await dbA.get("select Content from App.Message where Id = 'msg-b-1'");
						return row?.Content === 'Reply from Party B';
					},
					{ timeoutMs: 15_000, intervalMs: 250, description: 'message replicates B→A' },
				);

				const aMessages = await queryAll(dbA, 'select * from App.Message order by Id');
				const bMessages = await queryAll(dbB, 'select * from App.Message order by Id');
				expect(aMessages).toHaveLength(2);
				expect(bMessages).toHaveLength(2);
			} finally {
				await partyB?.stop();
				await partyA?.stop();
			}
		}, 45_000);

		// ── Scenario 2: Party C exclusion (token reuse rejection) ──────────

		it('should reject Party C from reusing a consumed invitation token', async () => {
			let partyA: CadreNode | undefined;
			let partyB: CadreNode | undefined;
			let partyC: CadreNode | undefined;

			try {
				const ts = Date.now();

				partyA = new CadreNode(createNodeConfig(`party-a-excl-${ts}`));
				await partyA.start();
				const aAddrs = partyA.getMultiaddrs();

				partyB = new CadreNode(createNodeConfig(`party-b-excl-${ts}`, { bootstrapNodes: aAddrs }));
				await partyB.start();

				partyC = new CadreNode(createNodeConfig(`party-c-excl-${ts}`, { bootstrapNodes: aAddrs }));
				await partyC.start();

				// Party A: responder with usage recorder for single-use tokens
				const provisioner = createMockProvisioner('excl');
				const recorder = createMockUsageRecorder();
				partyA.initializeStrandSolicitation({
					strandProvisioner: provisioner,
					formationUsageRecorder: recorder,
				});

				const invitation = await partyA.createOpenInvitation('chat-sapp', 60_000);
				recorder.knownTokens.add(invitation.token);

				// Party B forms strand — should succeed
				const resultB = await partyB.formStrand(invitation, { partyId: `party-b-excl-${ts}` });
				expect(resultB.strandId).toBeDefined();

				// Mark token as used
				await partyA.getStrandSolicitationService()!.recordFormationComplete(
					invitation.token, resultB.memberKey, resultB.strandId,
					{ usageStampId: 'stamp-exclusive', peerSignature: 'sig-exclusive' },
				);

				// Party C attempts the same token — should be rejected
				await expect(
					partyC.formStrand(invitation, { partyId: `party-c-excl-${ts}` }),
				).rejects.toThrow();
			} finally {
				await partyC?.stop();
				await partyB?.stop();
				await partyA?.stop();
			}
		}, 30_000);

		// ── Scenario 3: Open strand join + bidirectional messaging ──────────

		it('should allow two parties to join an open strand and exchange data', async () => {
			let partyA: CadreNode | undefined;
			let partyB: CadreNode | undefined;

			try {
				const ts = Date.now();
				const strandId = `open-strand-${ts}-${Math.random().toString(36).slice(2, 8)}`;

				partyA = new CadreNode(createNodeConfig(`party-a-open-${ts}`));
				await partyA.start();

				partyB = new CadreNode(createNodeConfig(`party-b-open-${ts}`, {
					bootstrapNodes: partyA.getMultiaddrs(),
				}));
				await partyB.start();

				// Both parties directly add an open strand (no formation protocol needed)
				const { strandA, strandB } = await setupStrandBetweenParties(
					partyA, partyB, strandId, SIMPLE_SAPP_CONFIG,
					{ type: 'o' },
				);

				// Party A inserts data
				const dbA = strandA.database!.getDatabase();
				await dbA.exec("insert into App.Data (Key, Val) values ('a-key', 'from Party A')");

				// Assert: replicates to Party B
				const dbB = strandB.database!.getDatabase();
				await waitUntil(
					async () => {
						const row = await dbB.get("select Val from App.Data where Key = 'a-key'");
						return row?.Val === 'from Party A';
					},
					{ timeoutMs: 15_000, intervalMs: 250, description: 'data replicates A→B' },
				);

				// Party B inserts data
				await dbB.exec("insert into App.Data (Key, Val) values ('b-key', 'from Party B')");

				// Assert: replicates to Party A
				await waitUntil(
					async () => {
						const row = await dbA.get("select Val from App.Data where Key = 'b-key'");
						return row?.Val === 'from Party B';
					},
					{ timeoutMs: 15_000, intervalMs: 250, description: 'data replicates B→A' },
				);

				// Both sides have all data
				const aRows = await queryAll(dbA, 'select * from App.Data order by Key');
				const bRows = await queryAll(dbB, 'select * from App.Data order by Key');
				expect(aRows).toHaveLength(2);
				expect(bRows).toHaveLength(2);
				expect(aRows.map(r => r.Key)).toEqual(['a-key', 'b-key']);
				expect(bRows.map(r => r.Key)).toEqual(['a-key', 'b-key']);
			} finally {
				await partyB?.stop();
				await partyA?.stop();
			}
		}, 45_000);
	});

	// ═══════════════════════════════════════════════════════════════════════
	// Phase 2: Convergence and resilience
	// ═══════════════════════════════════════════════════════════════════════

	describe('Phase 2: Convergence and resilience', () => {

		// ── Scenario 4: Cross-party concurrent writes ──────────────────────

		it('should converge after interleaved writes from both parties', async () => {
			let partyA: CadreNode | undefined;
			let partyB: CadreNode | undefined;

			try {
				const ts = Date.now();
				const strandId = `interleave-${ts}-${Math.random().toString(36).slice(2, 8)}`;

				// Separate control networks (no bootstrap between them) to avoid
				// control-level peers interfering with strand-level replication.
				partyA = new CadreNode(createNodeConfig(`party-a-intlv-${ts}`));
				await partyA.start();

				partyB = new CadreNode(createNodeConfig(`party-b-intlv-${ts}`));
				await partyB.start();

				const { strandA, strandB } = await setupStrandBetweenParties(
					partyA, partyB, strandId, SIMPLE_SAPP_CONFIG,
					{ type: 'o' },
				);

				const dbA = strandA.database!.getDatabase();
				const dbB = strandB.database!.getDatabase();

				// Party A writes 5 rows (each write replicates to B before next)
				for (let i = 0; i < 5; i++) {
					await dbA.exec(`insert into App.Data (Key, Val) values ('a-${i}', 'val-a-${i}')`);
				}

				// Wait for A's writes to replicate to B
				await waitUntil(
					async () => {
						const rows = await queryAll(dbB, 'select * from App.Data');
						return rows.length >= 5;
					},
					{ timeoutMs: 15_000, intervalMs: 250, description: 'Party B sees 5 rows from A' },
				);

				// Party B writes 5 rows (each write replicates to A)
				for (let i = 0; i < 5; i++) {
					await dbB.exec(`insert into App.Data (Key, Val) values ('b-${i}', 'val-b-${i}')`);
				}

				// Wait for convergence to 10 rows on both
				await waitUntil(
					async () => {
						const rows = await queryAll(dbA, 'select * from App.Data');
						return rows.length >= 10;
					},
					{ timeoutMs: 15_000, intervalMs: 250, description: 'Party A has 10 rows' },
				);

				// Verify sets are identical
				const aRows = await queryAll(dbA, 'select Key, Val from App.Data order by Key');
				const bRows = await queryAll(dbB, 'select Key, Val from App.Data order by Key');
				expect(aRows).toHaveLength(10);
				expect(bRows).toHaveLength(10);
				expect(aRows).toEqual(bRows);
			} finally {
				await partyB?.stop();
				await partyA?.stop();
			}
		}, 60_000);

		// ── Scenario 5: Multi-round bidirectional convergence ──────────────────────────

		it('should converge across multiple rounds of bidirectional writes', async () => {
			let partyA: CadreNode | undefined;
			let partyB: CadreNode | undefined;

			try {
				const ts = Date.now();
				const strandId = `multi-round-${ts}-${Math.random().toString(36).slice(2, 8)}`;

				partyA = new CadreNode(createNodeConfig(`party-a-mr-${ts}`));
				await partyA.start();

				partyB = new CadreNode(createNodeConfig(`party-b-mr-${ts}`));
				await partyB.start();

				const { strandA, strandB } = await setupStrandBetweenParties(
					partyA, partyB, strandId, SIMPLE_SAPP_CONFIG,
					{ type: 'o' },
				);

				const dbA = strandA.database!.getDatabase();
				const dbB = strandB.database!.getDatabase();

				// Round 1: A writes 2 rows
				for (let i = 0; i < 2; i++) {
					await dbA.exec(`insert into App.Data (Key, Val) values ('r1-a-${i}', 'round1-a-${i}')`);
				}
				await waitUntil(
					async () => {
						const rows = await queryAll(dbB, 'select * from App.Data');
						return rows.length >= 2;
					},
					{ timeoutMs: 15_000, intervalMs: 250, description: 'Round 1: B sees 2 rows' },
				);

				// Round 2: B writes 2 rows
				for (let i = 0; i < 2; i++) {
					await dbB.exec(`insert into App.Data (Key, Val) values ('r2-b-${i}', 'round2-b-${i}')`);
				}
				await waitUntil(
					async () => {
						const rows = await queryAll(dbA, 'select * from App.Data');
						return rows.length >= 4;
					},
					{ timeoutMs: 15_000, intervalMs: 250, description: 'Round 2: A sees 4 rows' },
				);

				// Round 3: A writes 2 more rows
				for (let i = 0; i < 2; i++) {
					await dbA.exec(`insert into App.Data (Key, Val) values ('r3-a-${i}', 'round3-a-${i}')`);
				}
				await waitUntil(
					async () => {
						const rows = await queryAll(dbB, 'select * from App.Data');
						return rows.length >= 6;
					},
					{ timeoutMs: 15_000, intervalMs: 250, description: 'Round 3: B sees 6 rows' },
				);

				// Round 4: B writes 2 more rows
				for (let i = 0; i < 2; i++) {
					await dbB.exec(`insert into App.Data (Key, Val) values ('r4-b-${i}', 'round4-b-${i}')`);
				}
				await waitUntil(
					async () => {
						const rows = await queryAll(dbA, 'select * from App.Data');
						return rows.length >= 8;
					},
					{ timeoutMs: 15_000, intervalMs: 250, description: 'Round 4: A sees 8 rows' },
				);

				// Verify identical final data sets
				const aRows = await queryAll(dbA, 'select Key, Val from App.Data order by Key');
				const bRows = await queryAll(dbB, 'select Key, Val from App.Data order by Key');
				expect(aRows).toHaveLength(8);
				expect(bRows).toHaveLength(8);
				expect(aRows).toEqual(bRows);

				// Verify data from all rounds is present
				const keys = aRows.map(r => r.Key as string);
				expect(keys).toContain('r1-a-0');
				expect(keys).toContain('r2-b-1');
				expect(keys).toContain('r3-a-1');
				expect(keys).toContain('r4-b-0');
			} finally {
				await partyB?.stop();
				await partyA?.stop();
			}
		}, 60_000);
	});
});
