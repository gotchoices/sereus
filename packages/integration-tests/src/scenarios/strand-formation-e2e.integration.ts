/**
 * E2E Strand Formation integration tests.
 *
 * Exercises the real strand formation protocol over libp2p:
 * - Open strand formation (responderCreates mode)
 * - Token validation and rejection
 * - Disclosure validation
 * - Full cross-party strand instance lifecycle with replication
 * - Multiple strands between same parties
 * - Three-party strand formation
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import {
	CadreNode,
	StrandSolicitationService,
	signSchema,
	type DisclosureValidator,
	type FormationUsageRecorder,
	type StrandProvisioner,
} from '@serfab/cadre-core';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import type { CadreNodeConfig, StrandRow, SAppConfig, StrandFormationDisclosure } from '@serfab/cadre-core';
import { TestCadreNetwork, waitUntil } from '../harness/index.js';

// ── Mock implementations ────────────────────────────────────────────────────

/** Deterministic strand provisioner for test predictability */
function createMockProvisioner(prefix = 'test'): StrandProvisioner {
	let counter = 0;
	return {
		provisionStrand: async (_sAppId, _initiatorKey, _responderKey) => ({
			strandId: `strand-${prefix}-${++counter}`,
		}),
	};
}

/** In-memory usage recorder that tracks tokens */
function createMockUsageRecorder(): FormationUsageRecorder & {
	knownTokens: Set<string>;
	usedTokens: Map<string, { initiatorKey: string; strandId: string }>;
} {
	const knownTokens = new Set<string>();
	const usedTokens = new Map<string, { initiatorKey: string; strandId: string }>();

	return {
		knownTokens,
		usedTokens,
		recordUsage: async (token, initiatorKey, strandId) => {
			usedTokens.set(token, { initiatorKey, strandId });
		},
		isTokenUsed: async (token) => usedTokens.has(token),
		isTokenValid: async (token) => ({
			valid: knownTokens.has(token),
		}),
	};
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function wsTransports() {
	return [webSockets(), circuitRelayTransport()];
}

const SIMPLE_SCHEMA = `
table Data (
    Key text primary key,
    Val text
);
`;

/** Create a properly signed sApp config for integration tests */
function createSignedSAppConfig(schema: string, version: string): SAppConfig {
	const authorPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
	const authorPublicKey = getPublicKey(authorPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
	const signature = signSchema(schema, version, authorPrivateKey);
	return {
		id: authorPublicKey,
		version,
		schema,
		signature,
		latencyHint: 'interactive' as const,
	};
}

/** Create an unsigned sApp config (no `signature`) — rejected under the default policy. */
function createUnsignedSAppConfig(schema: string, version: string): SAppConfig {
	const authorPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
	const authorPublicKey = getPublicKey(authorPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
	return { id: authorPublicKey, version, schema, latencyHint: 'interactive' as const };
}

/**
 * Create a tampered sApp config: a valid signature over the original schema, but
 * the `schema` field mutated after signing — verification must reject it.
 */
function createTamperedSAppConfig(schema: string, version: string): SAppConfig {
	const authorPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
	const authorPublicKey = getPublicKey(authorPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
	const signature = signSchema(schema, version, authorPrivateKey);
	return { id: authorPublicKey, version, schema: schema + ' -- injected', signature, latencyHint: 'interactive' as const };
}

/**
 * Create a wrong-key sApp config: `signature` produced by a different author
 * private key than the one whose public key is in `id` — verification rejects it.
 */
function createWrongKeySAppConfig(schema: string, version: string): SAppConfig {
	const authorPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
	const authorPublicKey = getPublicKey(authorPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
	const otherPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
	const signature = signSchema(schema, version, otherPrivateKey);
	return { id: authorPublicKey, version, schema, signature, latencyHint: 'interactive' as const };
}

// Create two distinct signed sApp configs for isolation tests
const SAPP_CONFIG_A = createSignedSAppConfig(SIMPLE_SCHEMA, '0.1.0');
const SAPP_CONFIG_B = createSignedSAppConfig(SIMPLE_SCHEMA, '0.2.0');

/** Create a CadreNodeConfig for Phase 2 tests */
function createTestNodeConfig(
	partyId: string,
	opts: { bootstrapNodes?: string[]; profile?: 'storage' | 'transaction'; enableRelay?: boolean } = {},
): CadreNodeConfig {
	return {
		controlNetwork: { partyId, bootstrapNodes: opts.bootstrapNodes ?? [] },
		profile: opts.profile ?? 'transaction',
		strandFilter: { mode: 'all' },
		storage: { provider: () => new MemoryRawStorage() },
		network: {
			transports: wsTransports(),
			listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws'],
			...(opts.enableRelay ? { enableRelay: true } : {}),
		},
		hibernation: { enabled: false },
	};
}

// ═════════════════════════════════════════════════════════════════════════════
// Phase 1: Strand formation protocol over libp2p
// ═════════════════════════════════════════════════════════════════════════════

describe('E2E Strand Formation', () => {
	describe('Phase 1: Protocol over libp2p', () => {
		let network: TestCadreNetwork;

		beforeAll(() => {
			network = new TestCadreNetwork({ verbose: true, defaultTimeoutMs: 20_000 });
		});

		afterAll(async () => {
			await network.shutdown();
		});

		// ── 1. Open strand formation (responderCreates) ──────────────────

		it('should form a strand via open invitation over real libp2p', async () => {
			const alice = await network.createParty({ name: 'alice-open' });
			const bob = await network.createParty({ name: 'bob-open' });

			const mockProvisioner = createMockProvisioner('open');

			// Alice = responder: creates invitation, registers handler
			const aliceService = new StrandSolicitationService({
				partyId: alice.partyId,
				cadrePeerAddrs: alice.authorityNode.multiaddrs,
				strandProvisioner: mockProvisioner,
			});
			aliceService.registerResponder(alice.authorityNode.libp2p);

			const invitation = await aliceService.createOpenInvitation(
				'test-sapp',
				60_000,
				alice.authorityNode.multiaddrs,
			);

			// Bob = initiator: dials Alice via invitation
			const bobService = new StrandSolicitationService({
				partyId: bob.partyId,
				cadrePeerAddrs: bob.authorityNode.multiaddrs,
			});

			const result = await bobService.formStrand(
				invitation,
				{ partyId: bob.partyId, purpose: 'Open strand formation test' },
				bob.authorityNode.libp2p,
			);

			// Assert: both sides get valid results
			expect(result.memberKey).toBeDefined();
			expect(result.memberKey.startsWith('12D3KooW')).toBe(true);
			expect(result.invitePrivateKey).toBeDefined();
			expect(result.strandId).toBeDefined();
			expect(result.strandId.startsWith('strand-')).toBe(true);

			aliceService.unregisterResponder(alice.authorityNode.libp2p);
		}, 15_000);

		// ── 2. Token validation + rejection ──────────────────────────────

		it('should validate tokens and reject reuse', async () => {
			const alice = await network.createParty({ name: 'alice-token' });
			const bob = await network.createParty({ name: 'bob-token' });

			const mockProvisioner = createMockProvisioner('token');
			const mockRecorder = createMockUsageRecorder();

			// Alice = responder with usage recorder
			const aliceService = new StrandSolicitationService({
				partyId: alice.partyId,
				cadrePeerAddrs: alice.authorityNode.multiaddrs,
				strandProvisioner: mockProvisioner,
				formationUsageRecorder: mockRecorder,
			});
			aliceService.registerResponder(alice.authorityNode.libp2p);

			// Create invitation and register its token as known
			const invitation = await aliceService.createOpenInvitation(
				'test-sapp',
				60_000,
				alice.authorityNode.multiaddrs,
			);
			mockRecorder.knownTokens.add(invitation.token);

			// Bob forms a strand — first attempt should succeed
			const bobService = new StrandSolicitationService({
				partyId: bob.partyId,
				cadrePeerAddrs: bob.authorityNode.multiaddrs,
			});

			const result = await bobService.formStrand(
				invitation,
				{ partyId: bob.partyId },
				bob.authorityNode.libp2p,
			);

			expect(result.strandId).toBeDefined();

			// Record the usage (simulating what happens after successful formation)
			await aliceService.recordFormationComplete(
				invitation.token,
				result.memberKey,
				result.strandId,
			);

			// Assert: token is now marked as used
			expect(await mockRecorder.isTokenUsed(invitation.token)).toBe(true);

			// Second attempt with same token should be rejected
			await expect(
				bobService.formStrand(
					invitation,
					{ partyId: bob.partyId },
					bob.authorityNode.libp2p,
				),
			).rejects.toThrow();

			aliceService.unregisterResponder(alice.authorityNode.libp2p);
		}, 20_000);

		// ── 3. Disclosure validation (real disclosed identity) ──────────

		it('should transmit the real disclosure and accept/reject on it', async () => {
			const alice = await network.createParty({ name: 'alice-disc' });
			const bob = await network.createParty({ name: 'bob-disc' });
			const carol = await network.createParty({ name: 'carol-disc' });

			const mockProvisioner = createMockProvisioner('disc');

			// The disclosure is now carried end-to-end (real token + real disclosure),
			// so the responder validates against it directly — an allowlist keyed on the
			// real disclosed `purpose`. We also capture what arrives to assert the real
			// token and the initiator's real member-key partyId reach the responder
			// (no synthetic { partyId: sessionId } bundle).
			let seen: { token: string; disclosure: StrandFormationDisclosure } | null = null;
			const allowlistValidator: DisclosureValidator = {
				validateDisclosure: async (token, disclosure) => {
					seen = { token, disclosure };
					return disclosure.purpose === 'authorized-collaboration';
				},
			};

			const aliceService = new StrandSolicitationService({
				partyId: alice.partyId,
				cadrePeerAddrs: alice.authorityNode.multiaddrs,
				strandProvisioner: mockProvisioner,
				disclosureValidator: allowlistValidator,
			});
			aliceService.registerResponder(alice.authorityNode.libp2p);

			const invitation = await aliceService.createOpenInvitation(
				'test-sapp',
				60_000,
				alice.authorityNode.multiaddrs,
			);

			// Bob discloses the allowed purpose → accepted.
			const bobService = new StrandSolicitationService({
				partyId: bob.partyId,
				cadrePeerAddrs: bob.authorityNode.multiaddrs,
			});

			const bobResult = await bobService.formStrand(
				invitation,
				{ partyId: bob.partyId, purpose: 'authorized-collaboration' },
				bob.authorityNode.libp2p,
			);
			expect(bobResult.strandId).toBeDefined();

			// The responder saw the REAL token + disclosure, and the disclosed partyId
			// is Bob's generated member key (not a synthetic session id).
			expect(seen).not.toBeNull();
			expect(seen!.token).toBe(invitation.token);
			expect(seen!.disclosure.purpose).toBe('authorized-collaboration');
			expect(seen!.disclosure.partyId).toBe(bobResult.memberKey);

			// Carol discloses a non-allowed purpose → rejected by the same allowlist.
			const carolService = new StrandSolicitationService({
				partyId: carol.partyId,
				cadrePeerAddrs: carol.authorityNode.multiaddrs,
			});

			await expect(
				carolService.formStrand(
					invitation,
					{ partyId: carol.partyId, purpose: 'unsolicited' },
					carol.authorityNode.libp2p,
				),
			).rejects.toThrow();

			aliceService.unregisterResponder(alice.authorityNode.libp2p);
		}, 20_000);
	});

	// ═════════════════════════════════════════════════════════════════════════
	// Phase 2: End-to-end strand instance lifecycle
	// ═════════════════════════════════════════════════════════════════════════

	describe('Phase 2: Strand instance lifecycle', () => {

		// ── 4. Cross-party formation + strand instance + replication ──────

		it('should form strand, start instances, and replicate data', async () => {
			let aliceNode: CadreNode | undefined;
			let bobNode: CadreNode | undefined;

			try {
				const partyId = `lifecycle-${Date.now()}`;

				aliceNode = new CadreNode(createTestNodeConfig(`alice-${partyId}`, { profile: 'storage', enableRelay: true }));
				await aliceNode.start();

				const aliceAddrs = aliceNode.getMultiaddrs();
				expect(aliceAddrs.length).toBeGreaterThan(0);

				bobNode = new CadreNode(createTestNodeConfig(`bob-${partyId}`, { bootstrapNodes: aliceAddrs }));
				await bobNode.start();

				// Initialize strand solicitation on Alice (responder)
				const mockProvisioner = createMockProvisioner('lifecycle');
				aliceNode.initializeStrandSolicitation({
					strandProvisioner: mockProvisioner,
				});

				// Alice creates open invitation
				const invitation = await aliceNode.createOpenInvitation('test-sapp');

				// Bob forms strand using invitation
				const formResult = await bobNode.formStrand(invitation, {
					partyId: `bob-${partyId}`,
					purpose: 'E2E lifecycle test',
				});

				expect(formResult.strandId).toBeDefined();
				expect(formResult.memberKey).toBeDefined();

				// Both sides create strand instances with the negotiated strandId
				const strandRow: StrandRow = {
					Id: formResult.strandId,
					MemberPrivateKey: null,
					Type: 'o',
				};

				// These tests manually wire strand-level libp2p connections below
				// (control-network cohort discovery is intentionally not exercised here —
				// see strand-formation-e2e header), so request `networked` mode explicitly.
				// Without it, addStrand infers `bootstrap` from the empty CadrePeer cohort
				// and each node keeps an independent local transactor that never replicates.
				const aliceStrand = await aliceNode.addStrand({
					strandRow,
					sAppConfig: SAPP_CONFIG_A,
					mode: 'networked',
				});
				expect(aliceStrand.status).toBe('active');

				const bobStrand = await bobNode.addStrand({
					strandRow,
					sAppConfig: SAPP_CONFIG_A,
					mode: 'networked',
				});
				expect(bobStrand.status).toBe('active');

				// Manually connect strand-level libp2p nodes
				// (strand peer discovery via control network is TODO)
				const aliceStrandAddrs = aliceStrand.libp2pNode!.getMultiaddrs();
				expect(aliceStrandAddrs.length).toBeGreaterThan(0);

				await bobStrand.libp2pNode!.dial(aliceStrandAddrs[0]!);
				await waitUntil(
					() => bobStrand.libp2pNode!.getConnections().length > 0,
					{ timeoutMs: 10_000, description: 'Bob strand connects to Alice strand' },
				);

				// Insert data on Alice's strand
				const aliceDb = aliceStrand.database!.getDatabase();
				await aliceDb.exec(
					"insert into App.Data (Key, Val) values ('key1', 'hello from Alice')",
				);

				// Verify local write
				const localRow = await aliceDb.get(
					"select Val from App.Data where Key = 'key1'",
				);
				expect(localRow?.Val).toBe('hello from Alice');

				// Verify replication to Bob
				const bobDb = bobStrand.database!.getDatabase();
				await waitUntil(
					async () => {
						const row = await bobDb.get(
							"select Val from App.Data where Key = 'key1'",
						);
						return row?.Val === 'hello from Alice';
					},
					{
						timeoutMs: 15_000,
						intervalMs: 250,
						description: 'data replicates from Alice to Bob',
					},
				);

				const replicated = await bobDb.get(
					"select Val from App.Data where Key = 'key1'",
				);
				expect(replicated?.Val).toBe('hello from Alice');
			} finally {
				await bobNode?.stop();
				await aliceNode?.stop();
			}
		}, 45_000);

		// ── 5. Multiple strands between same parties ─────────────────────

		it('should support multiple independent strands between same parties', async () => {
			let aliceNode: CadreNode | undefined;
			let bobNode: CadreNode | undefined;

			try {
				const partyId = `multi-${Date.now()}`;

				aliceNode = new CadreNode(createTestNodeConfig(`alice-${partyId}`, { profile: 'storage', enableRelay: true }));
				await aliceNode.start();

				bobNode = new CadreNode(createTestNodeConfig(`bob-${partyId}`, { bootstrapNodes: aliceNode.getMultiaddrs() }));
				await bobNode.start();

				// Alice initializes solicitation with a provisioner
				const mockProvisioner = createMockProvisioner('multi');
				aliceNode.initializeStrandSolicitation({
					strandProvisioner: mockProvisioner,
				});

				// Form strand A
				const invitationA = await aliceNode.createOpenInvitation('sapp-a');
				const resultA = await bobNode.formStrand(invitationA, {
					partyId: `bob-${partyId}`,
				});

				// Form strand B
				const invitationB = await aliceNode.createOpenInvitation('sapp-b');
				const resultB = await bobNode.formStrand(invitationB, {
					partyId: `bob-${partyId}`,
				});

				// Different strand IDs
				expect(resultA.strandId).not.toBe(resultB.strandId);

				// Start strand instances on both sides
				const strandRowA: StrandRow = { Id: resultA.strandId, MemberPrivateKey: null, Type: 'o' };
				const strandRowB: StrandRow = { Id: resultB.strandId, MemberPrivateKey: null, Type: 'o' };

				// Manually-wired strands (see note in the first Phase 2 test): request
				// `networked` explicitly so writes replicate over the dialed connections.
				const aliceStrandA = await aliceNode.addStrand({ strandRow: strandRowA, sAppConfig: SAPP_CONFIG_A, mode: 'networked' });
				const aliceStrandB = await aliceNode.addStrand({ strandRow: strandRowB, sAppConfig: SAPP_CONFIG_B, mode: 'networked' });
				const bobStrandA = await bobNode.addStrand({ strandRow: strandRowA, sAppConfig: SAPP_CONFIG_A, mode: 'networked' });
				const bobStrandB = await bobNode.addStrand({ strandRow: strandRowB, sAppConfig: SAPP_CONFIG_B, mode: 'networked' });

				expect(aliceStrandA.status).toBe('active');
				expect(aliceStrandB.status).toBe('active');
				expect(bobStrandA.status).toBe('active');
				expect(bobStrandB.status).toBe('active');

				// Connect strand-level nodes for both strands
				await bobStrandA.libp2pNode!.dial(aliceStrandA.libp2pNode!.getMultiaddrs()[0]!);
				await bobStrandB.libp2pNode!.dial(aliceStrandB.libp2pNode!.getMultiaddrs()[0]!);

				await waitUntil(
					() => bobStrandA.libp2pNode!.getConnections().length > 0,
					{ timeoutMs: 10_000, description: 'strand A connected' },
				);
				await waitUntil(
					() => bobStrandB.libp2pNode!.getConnections().length > 0,
					{ timeoutMs: 10_000, description: 'strand B connected' },
				);

				// Insert data in strand A
				const aliceDbA = aliceStrandA.database!.getDatabase();
				await aliceDbA.exec(
					"insert into App.Data (Key, Val) values ('strand-a-key', 'strand-a-value')",
				);

				// Insert different data in strand B
				const aliceDbB = aliceStrandB.database!.getDatabase();
				await aliceDbB.exec(
					"insert into App.Data (Key, Val) values ('strand-b-key', 'strand-b-value')",
				);

				// Wait for replication
				const bobDbA = bobStrandA.database!.getDatabase();
				const bobDbB = bobStrandB.database!.getDatabase();

				await waitUntil(
					async () => {
						const row = await bobDbA.get("select Val from App.Data where Key = 'strand-a-key'");
						return row?.Val === 'strand-a-value';
					},
					{ timeoutMs: 15_000, intervalMs: 250, description: 'strand A data replicates' },
				);

				await waitUntil(
					async () => {
						const row = await bobDbB.get("select Val from App.Data where Key = 'strand-b-key'");
						return row?.Val === 'strand-b-value';
					},
					{ timeoutMs: 15_000, intervalMs: 250, description: 'strand B data replicates' },
				);

				// Verify isolation: strand-A data should NOT appear in strand-B
				const crossCheckA = await bobDbB.get("select Val from App.Data where Key = 'strand-a-key'");
				expect(crossCheckA).toBeUndefined();

				const crossCheckB = await bobDbA.get("select Val from App.Data where Key = 'strand-b-key'");
				expect(crossCheckB).toBeUndefined();
			} finally {
				await bobNode?.stop();
				await aliceNode?.stop();
			}
		}, 60_000);

		// ── 6. Three-party strand ────────────────────────────────────────

		it('should form a strand with three parties', async () => {
			let aliceNode: CadreNode | undefined;
			let bobNode: CadreNode | undefined;
			let carolNode: CadreNode | undefined;

			try {
				const partyId = `three-${Date.now()}`;

				// Alice (responder)
				aliceNode = new CadreNode(createTestNodeConfig(`alice-${partyId}`, { profile: 'storage', enableRelay: true }));
				await aliceNode.start();

				const aliceAddrs = aliceNode.getMultiaddrs();

				// Bob (initiator 1)
				bobNode = new CadreNode(createTestNodeConfig(`bob-${partyId}`, { bootstrapNodes: aliceAddrs }));
				await bobNode.start();

				// Carol (initiator 2)
				carolNode = new CadreNode(createTestNodeConfig(`carol-${partyId}`, { bootstrapNodes: aliceAddrs }));
				await carolNode.start();

				// Alice initializes solicitation
				const mockProvisioner = createMockProvisioner('three');
				aliceNode.initializeStrandSolicitation({
					strandProvisioner: mockProvisioner,
				});

				// Use a single invitation — both Bob and Carol join
				const invitation = await aliceNode.createOpenInvitation('test-sapp');

				// Bob and Carol form strands independently (same invitation)
				const bobResult = await bobNode.formStrand(invitation, {
					partyId: `bob-${partyId}`,
				});
				const carolResult = await carolNode.formStrand(invitation, {
					partyId: `carol-${partyId}`,
				});

				// For a three-party strand, all three must use the same strandId.
				// Since the provisioner increments, Bob gets strand-three-1 and Carol gets strand-three-2.
				// In a real system, the invitation would be tied to one strandId.
				// For this test, we use the first result's strandId for all.
				const strandId = bobResult.strandId;
				expect(strandId).toBeDefined();
				expect(carolResult.strandId).toBeDefined();

				// Start strand instances on all three parties using bob's strandId
				// (in real use, the responder would return the same strandId for the same invitation)
				const strandRow: StrandRow = { Id: strandId, MemberPrivateKey: null, Type: 'o' };

				// Manually-wired strands (see note in the first Phase 2 test): request
				// `networked` explicitly so writes replicate over the dialed connections.
				const aliceStrand = await aliceNode.addStrand({ strandRow, sAppConfig: SAPP_CONFIG_A, mode: 'networked' });
				const bobStrand = await bobNode.addStrand({ strandRow, sAppConfig: SAPP_CONFIG_A, mode: 'networked' });
				const carolStrand = await carolNode.addStrand({ strandRow, sAppConfig: SAPP_CONFIG_A, mode: 'networked' });

				expect(aliceStrand.status).toBe('active');
				expect(bobStrand.status).toBe('active');
				expect(carolStrand.status).toBe('active');

				// Connect strand-level libp2p: full mesh (Alice↔Bob, Alice↔Carol, Bob↔Carol)
				const aliceStrandAddrs = aliceStrand.libp2pNode!.getMultiaddrs();
				await bobStrand.libp2pNode!.dial(aliceStrandAddrs[0]!);
				await carolStrand.libp2pNode!.dial(aliceStrandAddrs[0]!);

				await waitUntil(
					() => bobStrand.libp2pNode!.getConnections().length > 0,
					{ timeoutMs: 10_000, description: 'Bob strand connects to Alice' },
				);
				await waitUntil(
					() => carolStrand.libp2pNode!.getConnections().length > 0,
					{ timeoutMs: 10_000, description: 'Carol strand connects to Alice' },
				);
				// Wait for Alice to see both inbound connections
				await waitUntil(
					() => aliceStrand.libp2pNode!.getConnections().length >= 2,
					{ timeoutMs: 10_000, description: 'Alice strand sees connections from Bob and Carol' },
				);

				// Connect Bob↔Carol so cluster consensus can reach all peers
				const bobStrandAddrs = bobStrand.libp2pNode!.getMultiaddrs();
				await carolStrand.libp2pNode!.dial(bobStrandAddrs[0]!);
				await waitUntil(
					() => bobStrand.libp2pNode!.getConnections().length >= 2,
					{ timeoutMs: 10_000, description: 'Bob strand sees connection from Carol' },
				);
				await waitUntil(
					() => carolStrand.libp2pNode!.getConnections().length >= 2,
					{ timeoutMs: 10_000, description: 'Carol strand sees connection from Bob' },
				);

				// Insert data from Alice
				const aliceDb = aliceStrand.database!.getDatabase();
				await aliceDb.exec(
					"insert into App.Data (Key, Val) values ('alice-data', 'from Alice')",
				);

				// Verify replication to Bob
				const bobDb = bobStrand.database!.getDatabase();
				await waitUntil(
					async () => {
						const row = await bobDb.get("select Val from App.Data where Key = 'alice-data'");
						return row?.Val === 'from Alice';
					},
					{ timeoutMs: 15_000, intervalMs: 250, description: 'data replicates to Bob' },
				);

				// Verify replication to Carol
				const carolDb = carolStrand.database!.getDatabase();
				await waitUntil(
					async () => {
						const row = await carolDb.get("select Val from App.Data where Key = 'alice-data'");
						return row?.Val === 'from Alice';
					},
					{ timeoutMs: 15_000, intervalMs: 250, description: 'data replicates to Carol' },
				);

				const bobRow = await bobDb.get("select Val from App.Data where Key = 'alice-data'");
				expect(bobRow?.Val).toBe('from Alice');

				const carolRow = await carolDb.get("select Val from App.Data where Key = 'alice-data'");
				expect(carolRow?.Val).toBe('from Alice');
			} finally {
				await carolNode?.stop();
				await bobNode?.stop();
				await aliceNode?.stop();
			}
		}, 60_000);
	});

	// ═════════════════════════════════════════════════════════════════════════════
	// Phase 3: Schema-signature gate fail-closed (enforcing default policy)
	// ═════════════════════════════════════════════════════════════════════════════
	//
	// Drive each unsafe config through the real addStrand creation/join path and
	// assert it is rejected BEFORE strand bring-up — no instance ever reaches
	// `active`. The node config leaves `requireSignedSchemas` unset, so the
	// fail-closed default (`true`) applies.

	describe('Phase 3: Schema-signature gate (fail-closed default)', () => {
		const cases: Array<{ name: string; config: SAppConfig; reason: string }> = [
			{ name: 'unsigned', config: createUnsignedSAppConfig(SIMPLE_SCHEMA, '0.1.0'), reason: 'missing signature' },
			{ name: 'tampered', config: createTamperedSAppConfig(SIMPLE_SCHEMA, '0.1.0'), reason: 'invalid signature' },
			{ name: 'wrong-key', config: createWrongKeySAppConfig(SIMPLE_SCHEMA, '0.1.0'), reason: 'invalid signature' },
		];

		for (const { name, config, reason } of cases) {
			it(`should reject a ${name} sApp config before bring-up`, async () => {
				let node: CadreNode | undefined;
				try {
					const partyId = `gate-${name}-${Date.now()}`;
					node = new CadreNode(createTestNodeConfig(`solo-${partyId}`));
					await node.start();

					const strandId = `strand-gate-${name}`;
					const strandRow: StrandRow = { Id: strandId, MemberPrivateKey: null, Type: 'o' };

					await expect(
						node.addStrand({ strandRow, sAppConfig: config, mode: 'networked' }),
					).rejects.toThrow(reason);

					// The strand instance must never have been brought up.
					expect(node.getStrand(strandId)).toBeUndefined();
				} finally {
					await node?.stop();
				}
			}, 30_000);
		}
	});
});
