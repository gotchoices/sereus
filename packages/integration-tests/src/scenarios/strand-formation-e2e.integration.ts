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
 * - Real-recorder consent enforcement, real-approval-hook redemption, provisioning abort
 *
 * NOTE: 1744 lines (`wc -l`, 2026-08-02) — the largest file in `src/scenarios/`, next largest
 * 1170. Still one cohesive subject, and each `Phase N` describe owns its own `TestCadreNetwork`,
 * so the phases are already independent. If another phase lands here, split per phase into
 * sibling files and move the module-scope helpers above (`ownerSigner` … `readFormationUsage`)
 * into a shared `strand-formation-helpers.ts` — the split is mechanical precisely because no
 * phase shares state with another.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import {
	CadreNode,
	StrandSolicitationService,
	ControlFormationUsageRecorder,
	verifyFormationConsent,
	ed25519PublicKeyB64FromPeerId,
	ed25519PublicKeyFromPrivate,
	signFormationApproval,
	signSchema,
	type DisclosureValidator,
	type FormationApproval,
	type FormationUsageRecorder,
	type StrandProvisioner,
} from '@serfab/cadre-core';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import type { CadreNodeConfig, StrandRow, SAppConfig, StrandFormationDisclosure, OpenInvitation, StrandFormationManagerConfig } from '@serfab/cadre-core';
import { TestCadreNetwork, signMessageEd25519, startApprovalHook, waitUntil, wsTransports, createSignedSAppConfig, readCohort } from '../harness/index.js';
import type { TestParty } from '../harness/types.js';

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

const SIMPLE_SCHEMA = `
table Data (
    Key text primary key,
    Val text
);
`;

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

// ── Consent-path helpers (Phases 4 & 5) ─────────────────────────────────────
//
// Shared by every case that drives the REAL DB-backed `ControlFormationUsageRecorder`
// rather than an in-memory mock.

/**
 * Sign control-row authorization bytes with a party's owner key via the SAME
 * harness signer {@link TestCadreNetwork.createOpenInvitation} uses, so a bespoke
 * `insertFormationInvite` here is byte-identical to the harness's own invites.
 */
function ownerSigner(party: TestParty): (message: Uint8Array) => string {
	return (message) => signMessageEd25519(message, party.ownerPrivateKey);
}

/**
 * A responder solicitation service wired to the party's REAL DB-backed recorder.
 *
 * Passes no `approver` option on purpose: the recorder then defaults to the real HTTP
 * approval client, which is precisely what Phase 5 puts under test. Injecting a fake
 * approver here would void it.
 *
 * `overrides` is additive and every field is optional, so the single-argument callers of
 * Phases 4 and 5 keep their behaviour verbatim:
 * - `formationConfig` — Phase 6 shrinks the responder's provisioning budget so its work
 *   deadline (and the abort it fires) lands in ~1.5 s instead of the 12 s default.
 * - `formationUsageRecorder` — Phase 6 (ii) wraps the real recorder in a timing decorator.
 *
 * NOTE: callers unregister at the END of the case rather than in a `finally`, so a failing
 * assertion leaves the handler registered. Harmless while every case creates its own
 * parties (the leak dies with `network.shutdown()`); if a case ever shares a party with
 * another, move the unregister into a `finally` — Phase 6 already does, because it has
 * assertions that can throw while an approval hook is still held.
 */
function responderService(
	party: TestParty,
	overrides: { formationConfig?: StrandFormationManagerConfig; formationUsageRecorder?: FormationUsageRecorder } = {},
): StrandSolicitationService {
	const service = new StrandSolicitationService({
		partyId: party.partyId,
		cadrePeerAddrs: party.ownerNode.multiaddrs,
		formationUsageRecorder: overrides.formationUsageRecorder ?? new ControlFormationUsageRecorder(party.controlDatabase),
		...(overrides.formationConfig ? { formationConfig: overrides.formationConfig } : {}),
	});
	service.registerResponder(party.ownerNode.libp2p);
	return service;
}

/**
 * A joiner-side service for a party that is redeeming, not hosting.
 *
 * No recorder and no `registerResponder`: a joiner only dials, so wiring either would give the
 * redeeming side a responder surface it never has in production.
 */
function joinerService(party: TestParty): StrandSolicitationService {
	return new StrandSolicitationService({
		partyId: party.partyId,
		cadrePeerAddrs: party.ownerNode.multiaddrs,
	});
}

/** Build an OpenInvitation pointing at the responder party's bootstrap addrs. */
function invitationFor(token: string, sAppId: string, party: TestParty): OpenInvitation {
	return {
		token,
		sAppId,
		expiration: new Date(Date.now() + 365 * 24 * 3600_000),
		bootstrap: party.ownerNode.multiaddrs,
	};
}

/**
 * Read back the single `FormationUsage` row recorded against `token`, in exactly the
 * shape {@link verifyFormationConsent} takes. `Disclosure` is returned verbatim: the
 * responder wrote the canonical serialization the joiner signed, so re-serializing it
 * here would break the signature-over-stored-bytes property under test.
 *
 * NOTE: returns whichever row the scan yields first, which is unambiguous only because
 * every caller here redeems a single-use invite. If a case ever reads back a multi-use
 * token, select by the `UsageStampId` it means rather than trusting scan order.
 *
 * There is deliberately no approval material to read back: an approver's sign-off is an
 * INSERT-CONTEXT parameter (`context.ValidationKey` / `context.ValidationSignature`, see
 * `schemas/control.qsql` → `FormationUsage ... with context`), verified at write time against
 * the stored `ValidationKey` row and never persisted on the usage row. So "the approval
 * landed" is asserted from the row EXISTING at all — an unapproved insert is rolled back by
 * the schema's `Authorized` CHECK — plus the hook's own request count, not from a column.
 */
async function readFormationUsage(party: TestParty, token: string): Promise<{
	token: string; usageStampId: string; peerKey: string; disclosure: string; peerSig: string;
} | null> {
	const db = party.controlDatabase.getDatabase();
	for await (const row of db.eval(
		'select Token, UsageStampId, PeerKey, PeerSig, Disclosure from CadreControl.FormationUsage where Token = ?',
		[token],
	)) {
		return {
			token: row.Token as string,
			usageStampId: row.UsageStampId as string,
			peerKey: row.PeerKey as string,
			disclosure: row.Disclosure as string,
			peerSig: row.PeerSig as string,
		};
	}
	return null;
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
				cadrePeerAddrs: alice.ownerNode.multiaddrs,
				strandProvisioner: mockProvisioner,
			});
			aliceService.registerResponder(alice.ownerNode.libp2p);

			const invitation = await aliceService.createOpenInvitation(
				'test-sapp',
				60_000,
				alice.ownerNode.multiaddrs,
			);

			// Bob = initiator: dials Alice via invitation
			const bobService = new StrandSolicitationService({
				partyId: bob.partyId,
				cadrePeerAddrs: bob.ownerNode.multiaddrs,
			});

			const result = await bobService.formStrand(
				invitation,
				{ partyId: bob.partyId, purpose: 'Open strand formation test' },
				bob.ownerNode.libp2p,
			);

			// Assert: both sides get valid results
			expect(result.memberKey).toBeDefined();
			expect(result.memberKey.startsWith('12D3KooW')).toBe(true);
			expect(result.invitePrivateKey).toBeDefined();
			expect(result.strandId).toBeDefined();
			expect(result.strandId.startsWith('strand-')).toBe(true);

			aliceService.unregisterResponder(alice.ownerNode.libp2p);
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
				cadrePeerAddrs: alice.ownerNode.multiaddrs,
				strandProvisioner: mockProvisioner,
				formationUsageRecorder: mockRecorder,
			});
			aliceService.registerResponder(alice.ownerNode.libp2p);

			// Create invitation and register its token as known
			const invitation = await aliceService.createOpenInvitation(
				'test-sapp',
				60_000,
				alice.ownerNode.multiaddrs,
			);
			mockRecorder.knownTokens.add(invitation.token);

			// Bob forms a strand — first attempt should succeed
			const bobService = new StrandSolicitationService({
				partyId: bob.partyId,
				cadrePeerAddrs: bob.ownerNode.multiaddrs,
			});

			const result = await bobService.formStrand(
				invitation,
				{ partyId: bob.partyId },
				bob.ownerNode.libp2p,
			);

			expect(result.strandId).toBeDefined();

			// Record the usage (simulating what happens after successful formation)
			await aliceService.recordFormationComplete(
				invitation.token,
				result.memberKey,
				result.strandId,
				{ usageStampId: 'stamp-e2e-rejoin', peerSignature: 'sig-e2e-rejoin' },
			);

			// Assert: token is now marked as used
			expect(await mockRecorder.isTokenUsed(invitation.token)).toBe(true);

			// Second attempt with same token should be rejected
			await expect(
				bobService.formStrand(
					invitation,
					{ partyId: bob.partyId },
					bob.ownerNode.libp2p,
				),
			).rejects.toThrow();

			aliceService.unregisterResponder(alice.ownerNode.libp2p);
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
				cadrePeerAddrs: alice.ownerNode.multiaddrs,
				strandProvisioner: mockProvisioner,
				disclosureValidator: allowlistValidator,
			});
			aliceService.registerResponder(alice.ownerNode.libp2p);

			const invitation = await aliceService.createOpenInvitation(
				'test-sapp',
				60_000,
				alice.ownerNode.multiaddrs,
			);

			// Bob discloses the allowed purpose → accepted.
			const bobService = new StrandSolicitationService({
				partyId: bob.partyId,
				cadrePeerAddrs: bob.ownerNode.multiaddrs,
			});

			const bobResult = await bobService.formStrand(
				invitation,
				{ partyId: bob.partyId, purpose: 'authorized-collaboration' },
				bob.ownerNode.libp2p,
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
				cadrePeerAddrs: carol.ownerNode.multiaddrs,
			});

			await expect(
				carolService.formStrand(
					invitation,
					{ partyId: carol.partyId, purpose: 'unsolicited' },
					carol.ownerNode.libp2p,
				),
			).rejects.toThrow();

			aliceService.unregisterResponder(alice.ownerNode.libp2p);
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

				// The cohort a strand write is offered to is `min(serving peers, clusterSize)`.
				// At `DEFAULT_STRAND_CLUSTER_SIZE` = 4 that is all three members here, so the
				// row lands on every one of them. This assertion is what would catch the
				// default silently dropping back to 2, where at most two of the three held any
				// given block and the third obtained it on demand at read time
				// (`cluster-fetch:synced`) — which the waiters below cannot distinguish from
				// real replication, since both end in a successful `select`.
				await waitUntil(
					async () => (await readCohort(aliceStrand.libp2pNode!, 'alice strand')).length >= 3,
					{ timeoutMs: 15_000, intervalMs: 250, description: 'Alice strand cohort to reach all three members' },
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

	// ═════════════════════════════════════════════════════════════════════════════
	// Phase 4: Responder consent enforcement over libp2p (REAL ControlFormationUsageRecorder)
	// ═════════════════════════════════════════════════════════════════════════════
	//
	// Unlike Phases 1-3 (in-memory mock recorders/provisioners), this drives the responder
	// through the DB-backed ControlFormationUsageRecorder so the single-use accounting and the
	// missing-host-strand rejection are exercised against the real control network — the same
	// path cadre-core's strand-formation-consent.spec.ts asserts off-network with a MockStream.
	// Covers the two responder-fallback gaps:
	//   (i)  an unbound single-use invite redeemed twice rejects the SECOND redemption, and
	//   (ii) a bound invite naming a host strand absent on the responder yields a clean
	//        `approved:false` (formStrand throws `Formation rejected: <reason>`) rather than a
	//        dial read-error / step timeout.

	describe('Phase 4: Responder consent enforcement (real recorder)', () => {
		let network: TestCadreNetwork;

		beforeAll(() => {
			network = new TestCadreNetwork({ verbose: true, defaultTimeoutMs: 20_000 });
		});

		afterAll(async () => {
			await network.shutdown();
		});

		// Helpers (`ownerSigner` / `responderService` / `invitationFor` / `readFormationUsage`)
		// live at module scope — Phase 5 drives the same real recorder through them.

		it('(i) rejects the second redemption of an unbound single-use invite', async () => {
			const alice = await network.createParty({ name: 'alice-consent' });
			const bob = await network.createParty({ name: 'bob-consent' });

			const aliceService = responderService(alice);
			const sign = ownerSigner(alice);

			// Owner-signed UNBOUND single-use invite (no strandId → responder-provisions).
			const token = `invite-unbound-${Date.now()}`;
			await alice.controlDatabase.insertFormationInvite(token, 'sapp-consent', alice.ownerPublicKey, sign, {
				totalUses: 1,
				expiresAtMs: Date.now() + 365 * 24 * 3600_000,
			});

			const bobService = joinerService(bob);

			// First redemption provisions a fresh strand and records the single usage row.
			const first = await bobService.formStrand(
				invitationFor(token, 'sapp-consent', alice),
				{ partyId: bob.partyId, purpose: 'consent-1' },
				bob.ownerNode.libp2p,
			);
			expect(first.strandId).toBeDefined();
			expect(await alice.controlDatabase.countFormationUsage(token)).toBe(1);

			// Second redemption of the now-exhausted single-use invite is rejected.
			await expect(
				bobService.formStrand(
					invitationFor(token, 'sapp-consent', alice),
					{ partyId: bob.partyId, purpose: 'consent-2' },
					bob.ownerNode.libp2p,
				),
			).rejects.toThrow(/Formation rejected/);

			// Still exactly one usage row — the rejected attempt wrote nothing.
			expect(await alice.controlDatabase.countFormationUsage(token)).toBe(1);

			aliceService.unregisterResponder(alice.ownerNode.libp2p);
		}, 30_000);

		it('(ii) a bound-but-unconverged host strand yields a clean rejection (no read-error/timeout)', async () => {
			const alice = await network.createParty({ name: 'alice-missing' });
			const bob = await network.createParty({ name: 'bob-missing' });

			const aliceService = responderService(alice);
			const sign = ownerSigner(alice);

			// Invite binds a strand id that is NEVER inserted as a Strand row (unconverged host).
			const missingStrandId = `strand-unconverged-${Date.now()}`;
			const token = `invite-missing-${Date.now()}`;
			await alice.controlDatabase.insertFormationInvite(token, 'sapp-missing', alice.ownerPublicKey, sign, {
				totalUses: 1,
				strandId: missingStrandId,
				expiresAtMs: Date.now() + 365 * 24 * 3600_000,
			});

			const bobService = joinerService(bob);

			// formStrand surfaces the responder's `approved:false` as a thrown
			// `Formation rejected: Host strand not yet available on this responder` —
			// a clean protocol rejection, NOT a dial read-error or step timeout.
			await expect(
				bobService.formStrand(
					invitationFor(token, 'sapp-missing', alice),
					{ partyId: bob.partyId, purpose: 'missing-host' },
					bob.ownerNode.libp2p,
				),
			).rejects.toThrow(/Host strand not yet available/);

			// No usage row was written, so a retry after convergence is not pre-blocked.
			expect(await alice.controlDatabase.countFormationUsage(token)).toBe(0);

			aliceService.unregisterResponder(alice.ownerNode.libp2p);
		}, 30_000);

		it("(iii) stores a joiner consent signature that re-verifies against the joiner's own key", async () => {
			const alice = await network.createParty({ name: 'alice-consent-sig' });
			const bob = await network.createParty({ name: 'bob-consent-sig' });

			const aliceService = responderService(alice);
			const sign = ownerSigner(alice);

			const token = `invite-consent-sig-${Date.now()}`;
			await alice.controlDatabase.insertFormationInvite(token, 'sapp-consent-sig', alice.ownerPublicKey, sign, {
				totalUses: 1,
				expiresAtMs: Date.now() + 365 * 24 * 3600_000,
			});

			const bobService = joinerService(bob);

			const result = await bobService.formStrand(
				invitationFor(token, 'sapp-consent-sig', alice),
				{ partyId: bob.partyId, purpose: 'consent-signature' },
				bob.ownerNode.libp2p,
			);
			expect(result.strandId).toBeDefined();

			// Pins the single-row premise {@link readFormationUsage}'s scan-order NOTE rests on,
			// so a future multi-use case fails here rather than silently asserting the wrong row.
			expect(await alice.controlDatabase.countFormationUsage(token)).toBe(1);

			const row = await readFormationUsage(alice, token);
			expect(row).not.toBeNull();

			// The stored signature re-verifies from the row ALONE — nothing is carried over from
			// the session that wrote it. That is what makes the row an audit record: any later
			// reader of alice's control database can re-check the joiner's consent.
			expect(verifyFormationConsent(row!)).toBe(true);

			// ...and the key it verifies against is the joiner's real identity — an Ed25519 libp2p
			// peer id is the identity multihash of exactly these key bytes, so the returned
			// memberKey and the stored PeerKey are two encodings of one key.
			expect(ed25519PublicKeyB64FromPeerId(result.memberKey)).toBe(row!.peerKey);

			// Guard against a vacuous pass: the digest really does cover the stored disclosure
			// bytes, so a tampered Disclosure column fails the very same check.
			expect(verifyFormationConsent({ ...row!, disclosure: `${row!.disclosure} ` })).toBe(false);

			aliceService.unregisterResponder(alice.ownerNode.libp2p);
		}, 30_000);
	});

	// ═════════════════════════════════════════════════════════════════════════════
	// Phase 5: ValidationUrl redemption end-to-end (REAL approval hook over a REAL socket)
	// ═════════════════════════════════════════════════════════════════════════════
	//
	// An invitation may demand a sign-off from an outside approver before anyone can redeem it:
	// the invite carries the approver's `ValidationUrl`, the responder POSTs the redemption's
	// five signed fields there, and the returned signature must verify against a key the party
	// enrolled in `CadreControl.ValidationKey`.
	//
	// Every piece has its own coverage — `test/formation-approval-real-fetch.spec.ts` drives the
	// HTTP client against a real socket, cadre-core's specs drive the recorder against a fake
	// approver, and the schema's `FormationUsage.Authorized` rule is unit-tested. What has never
	// run in one go is the whole chain: real HTTP hook → real approval client (the
	// `ControlFormationUsageRecorder` default, NOT an injected fake) → real control database →
	// real libp2p formation handshake. That is what these cases pin, for both invitation shapes
	// (unbound, and bound to an existing strand) plus every one of the five rejection reasons —
	// six cases, because `unenrolled` is reached two different ways (never enrolled, and enrolled
	// then removed).
	//
	// Not re-tested here: transport behaviour (redirects, body cap, timeouts, dead socket) — see
	// the real-fetch spec for the full transport decision table. Case (vi) does drive two
	// transport outcomes, but only because they are the two that carry a distinct joiner-visible
	// reason: an unreachable hook and a hook that answers a non-2xx both surface as
	// `Formation approval unavailable, retry`.

	describe('Phase 5: ValidationUrl redemption (real approval hook)', () => {
		let network: TestCadreNetwork;

		beforeAll(() => {
			network = new TestCadreNetwork({ verbose: true, defaultTimeoutMs: 20_000 });
		});

		afterAll(async () => {
			await network.shutdown();
		});

		/**
		 * Enroll an approver key on a party, the way an operator would.
		 *
		 * This is the exact `ControlDatabase` call `CadreNode.enrollValidationKey` bottoms out
		 * in — a byte-identical owner-signed control write. Deliberately NOT routed through
		 * cadre-cli's `applyAdd`: that is a pure read-then-decide plan function, already unit
		 * tested there against a fake key store, and reaching it from this package would mean
		 * adding a cadre-cli dependency plus a test-only store adapter — a shim written for the
		 * test is not the operator path, so it would weaken what this suite proves rather than
		 * strengthen it.
		 */
		function enrollApprover(party: TestParty, validationKey: string): Promise<void> {
			return party.controlDatabase.insertValidationKey(validationKey, party.ownerPublicKey, ownerSigner(party));
		}

		/**
		 * Publish an owner-signed, single-use invite gated on `validationUrl`.
		 *
		 * Unbound by default (no `strandId`): the redemption then runs through
		 * `ControlFormationUsageRecorder.provisionAndRecord`, which mints the strand id and obtains
		 * the approval over it in one go — the shortest real path to a committed `FormationUsage`
		 * row that the schema only accepts with a valid sign-off. Pass `strandId` for the BOUND
		 * shape, which routes through `recordUsage` → `ControlDatabase.recordFormationUsage`
		 * against a strand that must already exist on the responder.
		 */
		function publishGatedInvite(
			party: TestParty, token: string, sAppId: string, validationUrl: string, strandId?: string,
		): Promise<void> {
			return party.controlDatabase.insertFormationInvite(token, sAppId, party.ownerPublicKey, ownerSigner(party), {
				totalUses: 1,
				validationUrl,
				...(strandId ? { strandId } : {}),
				expiresAtMs: Date.now() + 365 * 24 * 3600_000,
			});
		}

		it('(i) redeems a gated invitation through a real approval hook over a real socket', async () => {
			const alice = await network.createParty({ name: 'alice-hook-ok' });
			const bob = await network.createParty({ name: 'bob-hook-ok' });
			const hook = await startApprovalHook();
			try {
				const aliceService = responderService(alice);
				await enrollApprover(alice, hook.validationKey);

				const token = `invite-hook-ok-${Date.now()}`;
				await publishGatedInvite(alice, token, 'sapp-hook-ok', hook.validationUrl);

				const result = await joinerService(bob).formStrand(
					invitationFor(token, 'sapp-hook-ok', alice),
					{ partyId: bob.partyId, purpose: 'approval-happy-path' },
					bob.ownerNode.libp2p,
				);

				expect(result.strandId).toBeDefined();
				// The responder really did call out — a redemption that somehow skipped the hook and
				// still wrote a row would fail here rather than pass silently.
				expect(hook.requestCount).toBe(1);
				expect(await alice.controlDatabase.countFormationUsage(token)).toBe(1);

				const posted = hook.lastRequest;
				expect(posted).not.toBeNull();

				// A hook is posted the five SIGNED fields and nothing else. No `validationUrl`, no
				// owner keys, no bootstrap addresses ever reach an outside approver — a privacy
				// property of the wire contract (`docs/api.md` → Validate Strand Formation) that this
				// is the only place checked end to end.
				expect(Object.keys(posted!).sort()).toEqual(
					['disclosure', 'peerKey', 'strandId', 'token', 'usageStampId'],
				);

				// The rest of the same contract: a hook operator is promised a POST carrying JSON and
				// asking for JSON back, at the ValidationUrl's OWN path — which may carry a hook
				// secret, so it has to arrive unmangled.
				expect(hook.lastMethod).toBe('POST');
				expect(hook.lastPath).toBe('/hook');
				expect(hook.lastHeaders?.['content-type']).toBe('application/json');
				expect(hook.lastHeaders?.accept).toBe('application/json');

				const row = await readFormationUsage(alice, token);
				expect(row).not.toBeNull();

				// What the approver signed and what was committed are the same redemption, field for
				// field — the point of the whole chain. `disclosure` especially: the approver signs
				// those bytes verbatim, so any re-serialization anywhere would already have failed
				// the recorder's `verifyFormationApproval` pre-check before reaching this assertion.
				expect(posted!.token).toBe(row!.token);
				expect(posted!.usageStampId).toBe(row!.usageStampId);
				expect(posted!.peerKey).toBe(row!.peerKey);
				expect(posted!.disclosure).toBe(row!.disclosure);
				expect(posted!.strandId).toBe(result.strandId);

				// The joiner's own consent signature still re-verifies alongside the approval, and the
				// key it verifies against is the joiner's real libp2p identity.
				expect(verifyFormationConsent(row!)).toBe(true);
				expect(ed25519PublicKeyB64FromPeerId(result.memberKey)).toBe(row!.peerKey);

				aliceService.unregisterResponder(alice.ownerNode.libp2p);
			} finally {
				await hook.close();
			}
		}, 30_000);

		it('(ii) refuses redemption when the hook says no, leaving the seat unspent', async () => {
			const alice = await network.createParty({ name: 'alice-hook-no' });
			const bob = await network.createParty({ name: 'bob-hook-no' });
			// One hook, one URL, a flipped verdict — so the retry below reaches the SAME published
			// `ValidationUrl` and only the approver's answer differs.
			let verdict: 'approve' | 'refuse' = 'refuse';
			const hook = await startApprovalHook({ decide: () => verdict });
			try {
				const aliceService = responderService(alice);
				await enrollApprover(alice, hook.validationKey);

				const token = `invite-hook-no-${Date.now()}`;
				await publishGatedInvite(alice, token, 'sapp-hook-no', hook.validationUrl);

				const bobService = joinerService(bob);
				const invitation = invitationFor(token, 'sapp-hook-no', alice);

				await expect(
					bobService.formStrand(invitation, { partyId: bob.partyId, purpose: 'refused' }, bob.ownerNode.libp2p),
				).rejects.toThrow(/Formation approval refused/);
				expect(await alice.controlDatabase.countFormationUsage(token)).toBe(0);

				// A zero count alone would also be satisfied by an invite that had been consumed and
				// then rolled back into an unusable state. Redeeming the SAME single-use token again
				// once the approver relents proves the seat is genuinely still there.
				verdict = 'approve';
				const result = await bobService.formStrand(
					invitation, { partyId: bob.partyId, purpose: 'refused-then-allowed' }, bob.ownerNode.libp2p,
				);
				expect(result.strandId).toBeDefined();
				expect(hook.requestCount).toBe(2);
				expect(await alice.controlDatabase.countFormationUsage(token)).toBe(1);

				aliceService.unregisterResponder(alice.ownerNode.libp2p);
			} finally {
				await hook.close();
			}
		}, 30_000);

		it('(iii) refuses an approval signed by a key that was never enrolled', async () => {
			const alice = await network.createParty({ name: 'alice-hook-unenrolled' });
			const bob = await network.createParty({ name: 'bob-hook-unenrolled' });
			// Hook signs a perfectly valid approval — with a key alice never wrote to ValidationKey.
			const hook = await startApprovalHook();
			try {
				const aliceService = responderService(alice);

				const token = `invite-hook-unenrolled-${Date.now()}`;
				await publishGatedInvite(alice, token, 'sapp-hook-unenrolled', hook.validationUrl);

				await expect(
					joinerService(bob).formStrand(
						invitationFor(token, 'sapp-hook-unenrolled', alice),
						{ partyId: bob.partyId, purpose: 'unenrolled-approver' },
						bob.ownerNode.libp2p,
					),
				).rejects.toThrow(/Formation approval key is not enrolled/);

				// The hook WAS asked — the refusal is the redeeming node's own local enrollment
				// pre-check, not something the approver could have reported.
				expect(hook.requestCount).toBe(1);
				expect(await alice.controlDatabase.countFormationUsage(token)).toBe(0);

				aliceService.unregisterResponder(alice.ownerNode.libp2p);
			} finally {
				await hook.close();
			}
		}, 30_000);

		it('(iv) refuses once the approver key is removed, after the invitation went out', async () => {
			const alice = await network.createParty({ name: 'alice-hook-removed' });
			const bob = await network.createParty({ name: 'bob-hook-removed' });
			const hook = await startApprovalHook();
			try {
				const aliceService = responderService(alice);
				await enrollApprover(alice, hook.validationKey);

				const token = `invite-hook-removed-${Date.now()}`;
				await publishGatedInvite(alice, token, 'sapp-hook-removed', hook.validationUrl);

				// Un-enroll through `deleteValidationKey`, which writes the row delete AND its
				// `Revocation` tombstone in one transaction (schema: `ValidationKey.RevocationRecorded`).
				// It returns false — a silent no-op — when no row matched, so asserting the true keeps
				// a mis-typed key from making this case pass for the wrong reason.
				const removed = await alice.controlDatabase.deleteValidationKey(
					hook.validationKey, alice.ownerPublicKey, ownerSigner(alice),
				);
				expect(removed).toBe(true);

				await expect(
					joinerService(bob).formStrand(
						invitationFor(token, 'sapp-hook-removed', alice),
						{ partyId: bob.partyId, purpose: 'removed-approver' },
						bob.ownerNode.libp2p,
					),
				).rejects.toThrow(/Formation approval key is not enrolled/);
				// Same shape as (iii): the hook still answered, and its perfectly valid sign-off was
				// discarded by the redeeming node's local enrollment check against the now-deleted row.
				expect(hook.requestCount).toBe(1);
				expect(await alice.controlDatabase.countFormationUsage(token)).toBe(0);

				aliceService.unregisterResponder(alice.ownerNode.libp2p);
			} finally {
				await hook.close();
			}
		}, 30_000);

		it('(v) refuses a sign-off replayed from an earlier redemption', async () => {
			const alice = await network.createParty({ name: 'alice-hook-replay' });
			const bob = await network.createParty({ name: 'bob-hook-replay' });
			const carol = await network.createParty({ name: 'carol-hook-replay' });

			// One hook throughout, so the second invite's published `ValidationUrl` stays live and
			// only the ANSWER changes: after the flag flips it hands back the first joiner's
			// sign-off verbatim instead of signing the redemption it was actually asked about.
			const approverPrivate = generatePrivateKey('ed25519', 'base64url') as string;
			const approverPublic = ed25519PublicKeyFromPrivate(approverPrivate);
			let issued: FormationApproval | null = null;
			let replay = false;
			const hook = await startApprovalHook({
				privateKeyB64: approverPrivate,
				decide: (fields) => {
					if (replay) {
						return issued!;
					}
					issued = signFormationApproval(fields, approverPublic, approverPrivate);
					return issued;
				},
			});
			try {
				const aliceService = responderService(alice);
				await enrollApprover(alice, hook.validationKey);

				const firstToken = `invite-hook-replay-1-${Date.now()}`;
				const secondToken = `invite-hook-replay-2-${Date.now()}`;
				await publishGatedInvite(alice, firstToken, 'sapp-hook-replay', hook.validationUrl);
				// A second single-use invite: the first is spent by the redemption below, and a replay
				// needs a live token to be attempted against at all.
				await publishGatedInvite(alice, secondToken, 'sapp-hook-replay', hook.validationUrl);

				const first = await joinerService(bob).formStrand(
					invitationFor(firstToken, 'sapp-hook-replay', alice),
					{ partyId: bob.partyId, purpose: 'replay-source' },
					bob.ownerNode.libp2p,
				);
				expect(first.strandId).toBeDefined();
				expect(await alice.controlDatabase.countFormationUsage(firstToken)).toBe(1);
				expect(issued).not.toBeNull();

				replay = true;

				// Which guard fires, and why it matters: the approver's digest covers
				// (token, usageStampId, strandId, peerKey, disclosure). Carol mints her own
				// `usageStampId` and brings her own `peerKey` against a different token, so the replayed
				// signature fails `verifyFormationApproval` — the recorder's LOCAL pre-check, which runs
				// before the enrollment check and before any write is attempted. Hence `malformed`
				// ('Formation approval invalid'), NOT `unenrolled` (the key IS enrolled) and NOT the
				// `FormationUsage.UsageStampId` unique column, which is the second, independent replay
				// guard and never gets the chance to fire here. If a future change reorders those
				// pre-checks, this assertion fails loudly instead of quietly passing on the other one.
				await expect(
					joinerService(carol).formStrand(
						invitationFor(secondToken, 'sapp-hook-replay', alice),
						{ partyId: carol.partyId, purpose: 'replay-attempt' },
						carol.ownerNode.libp2p,
					),
				).rejects.toThrow(/Formation approval invalid/);

				expect(await alice.controlDatabase.countFormationUsage(secondToken)).toBe(0);
				expect(await alice.controlDatabase.countFormationUsage(firstToken)).toBe(1);
				// Both redemptions really went out to the hook: the replay was refused on the ANSWER,
				// not because the second attempt short-circuited before asking.
				expect(hook.requestCount).toBe(2);

				aliceService.unregisterResponder(alice.ownerNode.libp2p);
			} finally {
				await hook.close();
			}
		}, 30_000);

		it('(vi) refuses when the approver cannot be asked, and again when it answers broken', async () => {
			const alice = await network.createParty({ name: 'alice-hook-down' });
			const bob = await network.createParty({ name: 'bob-hook-down' });
			// One live, ENROLLED hook. Arm A's invite deliberately does not name it — its zero
			// request count is what proves arm A failed on the URL under test rather than somewhere
			// else — and arm B's invite does, so arm B can flip the verdict and re-redeem.
			let verdict: 'approve' | 'unavailable' = 'unavailable';
			const hook = await startApprovalHook({ decide: () => verdict });
			try {
				const aliceService = responderService(alice);
				// Enrolled even though neither arm gets far enough to consult enrollment: if a future
				// reordering of the recorder's pre-checks moves that check earlier, these cases fail on
				// a changed reason string instead of quietly having failed for the wrong reason all along.
				await enrollApprover(alice, hook.validationKey);
				// A second recorder purely to READ: `isTokenUsed` is the predicate the responder itself
				// consults on the next redemption, so asserting it is asserting the seat, not a proxy.
				const recorder = new ControlFormationUsageRecorder(alice.controlDatabase);
				const bobService = joinerService(bob);

				// ── Arm A: nothing is listening ────────────────────────────────────────────────
				// Port 1 is privileged, so no test process can be holding it and a loopback connect is
				// refused immediately — landing in the approval client's catch-all. (An environment
				// that silently DROPS instead of refusing falls to the client's own 10 s budget, which
				// reports the same category; the case then takes ~10 s and still passes.)
				const deadToken = `invite-hook-dead-${Date.now()}`;
				await publishGatedInvite(alice, deadToken, 'sapp-hook-dead', 'http://127.0.0.1:1/hook');

				await expect(
					bobService.formStrand(
						invitationFor(deadToken, 'sapp-hook-dead', alice),
						{ partyId: bob.partyId, purpose: 'approver-unreachable' },
						bob.ownerNode.libp2p,
					),
				).rejects.toThrow(/Formation approval unavailable, retry/);

				expect(hook.requestCount).toBe(0);
				expect(await alice.controlDatabase.countFormationUsage(deadToken)).toBe(0);
				// Arm A cannot prove the seat by re-redeeming the way (ii) does: the dead `ValidationUrl`
				// is inside the owner-signed `FormationInvite` row and cannot be repointed at a live hook
				// afterwards. So it asserts the predicate directly, and arm B carries the re-redemption.
				expect(await recorder.isTokenUsed(deadToken)).toBe(false);

				// ── Arm B: the hook answered, badly ────────────────────────────────────────────
				// HTTP 503 is the same `unavailable` category by a different route (a non-2xx status,
				// not a failed connect), and the hook stays live on the URL its invite published.
				const brokenToken = `invite-hook-broken-${Date.now()}`;
				await publishGatedInvite(alice, brokenToken, 'sapp-hook-broken', hook.validationUrl);
				const invitation = invitationFor(brokenToken, 'sapp-hook-broken', alice);

				await expect(
					bobService.formStrand(invitation, { partyId: bob.partyId, purpose: 'approver-broken' }, bob.ownerNode.libp2p),
				).rejects.toThrow(/Formation approval unavailable, retry/);
				expect(hook.requestCount).toBe(1);
				expect(await alice.controlDatabase.countFormationUsage(brokenToken)).toBe(0);

				// Redeeming the SAME single-use token once the hook recovers is the real proof the seat
				// was never consumed — the shape case (ii) uses for `refused`.
				verdict = 'approve';
				const result = await bobService.formStrand(
					invitation, { partyId: bob.partyId, purpose: 'approver-recovered' }, bob.ownerNode.libp2p,
				);
				expect(result.strandId).toBeDefined();
				expect(hook.requestCount).toBe(2);
				expect(await alice.controlDatabase.countFormationUsage(brokenToken)).toBe(1);

				aliceService.unregisterResponder(alice.ownerNode.libp2p);
			} finally {
				await hook.close();
			}
		}, 30_000);

		it('(vii) refuses a ValidationUrl the redeeming node cannot use at all', async () => {
			const alice = await network.createParty({ name: 'alice-hook-scheme' });
			const bob = await network.createParty({ name: 'bob-hook-scheme' });
			// Live and enrolled, and deliberately not what the invite names: the scheme check runs
			// BEFORE any HTTP, so a hook that was asked at all means the check never fired.
			const hook = await startApprovalHook();
			try {
				const aliceService = responderService(alice);
				await enrollApprover(alice, hook.validationKey);
				const recorder = new ControlFormationUsageRecorder(alice.controlDatabase);

				// Nothing on the WRITE side validates the scheme — `insertFormationInvite` stores the
				// string verbatim (`schemas/control.qsql`: `ValidationUrl text null`) — so an operator
				// really can publish this, and the mistake surfaces only at redemption time.
				const token = `invite-hook-scheme-${Date.now()}`;
				await publishGatedInvite(alice, token, 'sapp-hook-scheme', 'ftp://127.0.0.1:9/hook');

				await expect(
					joinerService(bob).formStrand(
						invitationFor(token, 'sapp-hook-scheme', alice),
						{ partyId: bob.partyId, purpose: 'approver-misconfigured' },
						bob.ownerNode.libp2p,
					),
				).rejects.toThrow(/Formation approval misconfigured/);

				// The URL parsed fine and was rejected on its scheme, before any request went out.
				expect(hook.requestCount).toBe(0);
				expect(await alice.controlDatabase.countFormationUsage(token)).toBe(0);
				expect(await recorder.isTokenUsed(token)).toBe(false);

				aliceService.unregisterResponder(alice.ownerNode.libp2p);
			} finally {
				await hook.close();
			}
		}, 30_000);

		it('(viii) redeems a gated invitation BOUND to an existing closed strand', async () => {
			const alice = await network.createParty({ name: 'alice-hook-bound' });
			const bob = await network.createParty({ name: 'bob-hook-bound' });
			const hook = await startApprovalHook();
			try {
				const aliceService = responderService(alice);
				await enrollApprover(alice, hook.validationKey);

				// CLOSED (`'c'`) and inserted BEFORE the redemption: the `FormationUsage` insert carries
				// a deferred `StrandExists` CHECK, and an absent row is Phase 4 (ii)'s rejection
				// (`Host strand not yet available on this responder`), not a write failure. Closed
				// rather than open so the membership secret exists to be delivered at all.
				const strandId = `strand-hook-bound-${Date.now()}`;
				const memberPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
				await alice.controlDatabase.insertStrand(
					strandId, 'c', alice.ownerPublicKey, ownerSigner(alice), memberPrivateKey,
				);

				const token = `invite-hook-bound-${Date.now()}`;
				await publishGatedInvite(alice, token, 'sapp-hook-bound', hook.validationUrl, strandId);

				const result = await joinerService(bob).formStrand(
					invitationFor(token, 'sapp-hook-bound', alice),
					{ partyId: bob.partyId, purpose: 'approval-bound-path' },
					bob.ownerNode.libp2p,
				);

				// The joiner was seated on the PRE-EXISTING strand rather than a freshly minted one —
				// the whole difference between this write path (`recordFormationUsage`) and the unbound
				// one (`redeemInvitation`) every other Phase 5 case drives.
				expect(result.strandId).toBe(strandId);
				// ...and received the closed strand's read-gating secret, exactly as the owner inserted
				// it. Only a joiner the responder validated ever gets this.
				expect(result.memberPrivateKey).toBe(memberPrivateKey);

				expect(hook.requestCount).toBe(1);
				expect(await alice.controlDatabase.countFormationUsage(token)).toBe(1);

				const posted = hook.lastRequest;
				expect(posted).not.toBeNull();
				// Still exactly the five signed fields on this path too: the membership secret is
				// disclosed to the JOINER after sign-off and never to the APPROVER.
				expect(Object.keys(posted!).sort()).toEqual(
					['disclosure', 'peerKey', 'strandId', 'token', 'usageStampId'],
				);
				// The approver signed off on the strand the invite named, not on a minted id.
				expect(posted!.strandId).toBe(strandId);

				const row = await readFormationUsage(alice, token);
				expect(row).not.toBeNull();
				expect(verifyFormationConsent(row!)).toBe(true);
				expect(ed25519PublicKeyB64FromPeerId(result.memberKey)).toBe(row!.peerKey);

				aliceService.unregisterResponder(alice.ownerNode.libp2p);
			} finally {
				await hook.close();
			}
		}, 30_000);
	});

	// ═════════════════════════════════════════════════════════════════════════════
	// Phase 6: Provisioning abort and settle grace
	// ═════════════════════════════════════════════════════════════════════════════
	//
	// An invitation can be single-use, and redeeming one writes a `FormationUsage` row into the
	// host's control database. When the host's provisioning budget runs out mid-redemption, two
	// behaviours have to hold together:
	//
	//   (i)  CANCEL BEFORE WRITE — the host aborts the in-flight work and every layer below
	//        checks that abort before issuing the insert, so an invitation that was not yet
	//        redeemed stays unredeemed and the joiner's retry with the SAME token works.
	//   (ii) ADOPT IF IT LANDS — if the work lands anyway inside the settle grace, the host
	//        adopts the outcome and tells the joiner the join succeeded, rather than reporting
	//        a timeout over an invitation that is in fact spent.
	//
	// Both shipped, and before these two cases both were covered per-layer only
	// (`FormationListener` against a fake hook, the manager against a fake recorder, the recorder
	// against a fake approver). Nothing ran the COMPOSED path, so deleting the `signal` argument
	// from any single hop still passed every existing test. The chain these two cases drive end to
	// end:
	//
	//   FormationListener.provision()                       strand-formation-protocol.ts
	//     → AbortController.abort() at workMs, then settleWithinGrace()
	//     → StrandFormationManager.provisionAsResponder(contact, signal)
	//       → ControlFormationUsageRecorder.recordUsage({ ..., signal })
	//         → obtainApproval(..., signal) → askApprover(..., signal)   (relays onto the HTTP call)
	//         → ControlDatabase.recordFormationUsage({ ..., signal })
	//
	// Both cases use the BOUND (provision-then-record) invite shape — an owner-signed `Strand`
	// row inserted up front and an invite naming it — because that is the shape production
	// publishes and it routes through `recordUsage` → `recordFormationUsage`, the path carrying
	// the real abort checks.
	//
	// Both hops above the recorder were measured NON-VACUOUS (2026-08-02): dropping `signal` from
	// the listener→manager hop (`provisionStrand: (contact, signal) => provisionAsResponder(...)`)
	// and, separately, from the manager→recorder hop (`recorder.recordUsage({ ..., signal })`)
	// each fails BOTH cases — (i) on `hook.abortedCount` never reaching 1, (ii) on `observedAbort`.
	//
	// NOT covered here, deliberately: `ControlDatabase`'s own in-lock abort check is reached only
	// AFTER the recorder's earlier checks, so dropping the `signal` on the
	// `controlDatabase.recordFormationUsage({ ..., signal })` call ALONE would not fail either
	// case. Driving that seam end to end needs the write lock held from outside, which has no
	// public handle; it stays covered off-network by
	// `packages/cadre-core/test/control-formation-invite.spec.ts` (~line 361).

	describe('Phase 6: Provisioning abort and settle grace', () => {
		let network: TestCadreNetwork;

		beforeAll(() => {
			network = new TestCadreNetwork({ verbose: true, defaultTimeoutMs: 20_000 });
		});

		afterAll(async () => {
			await network.shutdown();
		});

		/**
		 * Responder provisioning budget. Not clamped (`resolveProvisionTimeoutMs`'s ceiling here is
		 * 22 s), and `splitProvisionBudget` halves it into a 1500 ms WORK budget — when the abort
		 * fires — plus a 1500 ms settle grace. The joiner is left unconfigured, so it waits out the
		 * 15 s initiator default and never times out first.
		 */
		const RESPONDER_PROVISION_MS = 3000;

		/** Upper bound on {@link waitForAbort}, so a regression fails an assertion instead of hanging. */
		const ABORT_WAIT_CAP_MS = 10_000;

		/** Owner-signed open host strand — the row a bound invite's `StrandId` must resolve to. */
		function insertHostStrand(party: TestParty, strandId: string): Promise<void> {
			return party.controlDatabase.insertStrand(strandId, 'o', party.ownerPublicKey, ownerSigner(party));
		}

		/** Owner-signed single-use invite BOUND to `strandId`, optionally gated on an approval hook. */
		function publishBoundInvite(
			party: TestParty, token: string, sAppId: string, strandId: string, validationUrl?: string,
		): Promise<void> {
			return party.controlDatabase.insertFormationInvite(token, sAppId, party.ownerPublicKey, ownerSigner(party), {
				totalUses: 1,
				strandId,
				...(validationUrl ? { validationUrl } : {}),
				expiresAtMs: Date.now() + 365 * 24 * 3600_000,
			});
		}

		/**
		 * Resolve true once `signal` aborts (immediately if it already has), false after `capMs`.
		 *
		 * The cap is what keeps a regression honest: a build that stopped cancelling would otherwise
		 * park here until the vitest timeout killed the whole file, reporting nothing useful. An
		 * absent signal — the plumbing dropped it somewhere up the chain — reports false at once.
		 */
		function waitForAbort(signal: AbortSignal | undefined, capMs: number): Promise<boolean> {
			if (!signal) {
				return Promise.resolve(false);
			}
			if (signal.aborted) {
				return Promise.resolve(true);
			}
			return new Promise<boolean>((resolve) => {
				// Ordering: each closure captures the other's binding, and the listener is registered
				// LAST — after both bindings are initialized — so neither can run before the other
				// exists. Whichever settles first tears down the loser, leaving no timer holding the
				// event loop open and no listener on a signal the test has finished with.
				const onAbort = (): void => {
					clearTimeout(timer);
					resolve(true);
				};
				const timer = setTimeout(() => {
					signal.removeEventListener('abort', onAbort);
					resolve(false);
				}, capMs);
				signal.addEventListener('abort', onAbort, { once: true });
			});
		}

		it('(i) a cancelled redemption leaves the invitation unspent, and the same token then works', async () => {
			const alice = await network.createParty({ name: 'alice-abort-cancel' });
			const bob = await network.createParty({ name: 'bob-abort-cancel' });

			// The lever is fully real: an approval hook that goes QUIET on the first ask, which is
			// what a queue behind a human approver looks like when it stalls. No test shim sits
			// anywhere on the path — the responder's own work deadline fires at 1500 ms, its abort is
			// relayed onto the outgoing `fetch`, and the held request dies on the wire.
			let releaseHold!: () => void;
			const held = new Promise<void>((resolve) => { releaseHold = resolve; });
			const hook = await startApprovalHook({
				beforeAnswer: (_fields, requestIndex) => (requestIndex === 1 ? held : Promise.resolve()),
			});
			const aliceService = responderService(alice, {
				formationConfig: { provisionTimeoutMs: RESPONDER_PROVISION_MS },
			});
			try {
				await alice.controlDatabase.insertValidationKey(hook.validationKey, alice.ownerPublicKey, ownerSigner(alice));

				const hostStrandId = `strand-abort-cancel-${Date.now()}`;
				await insertHostStrand(alice, hostStrandId);
				const token = `invite-abort-cancel-${Date.now()}`;
				await publishBoundInvite(alice, token, 'sapp-abort-cancel', hostStrandId, hook.validationUrl);

				const bobService = joinerService(bob);
				const invitation = invitationFor(token, 'sapp-abort-cancel', alice);

				// The listener's OWN retryable reason. Asserting the exact string — not merely that
				// something threw — is what keeps a joiner-side timeout, an `Internal formation error`,
				// or a dial read-error from being mistaken for the responder's deliberate rejection.
				await expect(
					bobService.formStrand(invitation, { partyId: bob.partyId, purpose: 'abort-cancel' }, bob.ownerNode.libp2p),
				).rejects.toThrow(/Formation provisioning timed out/);

				expect(await alice.controlDatabase.countFormationUsage(token)).toBe(0);
				expect(hook.requestCount).toBe(1);

				// The cancellation reached the WIRE and killed the outbound HTTP call — without this the
				// case would also pass if the reply had come from some unrelated timeout. The server
				// observes the hang-up a few ticks after the client aborts, hence the short wait.
				await waitUntil(
					() => hook.abortedCount === 1,
					{ timeoutMs: 5000, intervalMs: 50, description: 'approval hook observes the client abort' },
				);
				expect(hook.abortedCount).toBe(1);

				// A zero count alone would also be satisfied by an invite consumed and then rolled back
				// into an unusable state. Redeeming the SAME single-use token, once the approver stops
				// stalling, is the assertion that carries this case.
				releaseHold();

				const result = await bobService.formStrand(
					invitation, { partyId: bob.partyId, purpose: 'abort-cancel-retry' }, bob.ownerNode.libp2p,
				);
				expect(result.strandId).toBe(hostStrandId);
				expect(await alice.controlDatabase.countFormationUsage(token)).toBe(1);
				expect(hook.requestCount).toBe(2);

				const row = await readFormationUsage(alice, token);
				expect(row).not.toBeNull();
				expect(verifyFormationConsent(row!)).toBe(true);
			} finally {
				// Released here too: the assertions above can throw while the hook is still held, and a
				// forgotten hold would leave the handler parked forever.
				releaseHold();
				aliceService.unregisterResponder(alice.ownerNode.libp2p);
				await hook.close();
			}
		}, 30_000);

		it('(ii) a redemption that lands inside the settle grace is adopted', async () => {
			const alice = await network.createParty({ name: 'alice-abort-adopt' });
			const bob = await network.createParty({ name: 'bob-abort-adopt' });

			/**
			 * A TIMING SHIM, not a fake. Every method delegates to a REAL
			 * `ControlFormationUsageRecorder` over the REAL control database, and the consent row is
			 * written by the real write path. The only thing changed is WHEN `recordUsage`'s promise
			 * settles: the row is written first, then the call parks until the listener's work budget
			 * expires and aborts — so it settles just inside the 1500 ms settle grace, on purpose and
			 * without a timer race.
			 *
			 * Why a shim at all: a real commit finishes in milliseconds, and no production lever lands
			 * a write inside the grace on demand. The approval hook cannot be that lever here — the
			 * caller-abort is relayed onto the outgoing HTTP request and kills it, which is case (i).
			 */
			const inner = new ControlFormationUsageRecorder(alice.controlDatabase);
			let observedAbort = false;
			const gracefullyLateRecorder: FormationUsageRecorder = {
				recordUsage: async (params) => {
					await inner.recordUsage(params);
					observedAbort = await waitForAbort(params.signal, ABORT_WAIT_CAP_MS);
				},
				isTokenUsed: (token) => inner.isTokenUsed(token),
				isTokenValid: (token) => inner.isTokenValid(token),
				resolveStrand: (token) => inner.resolveStrand(token),
				provisionAndRecord: (params) => inner.provisionAndRecord(params),
				hasOutstandingInvitation: () => inner.hasOutstandingInvitation(),
			};

			const aliceService = responderService(alice, {
				formationConfig: { provisionTimeoutMs: RESPONDER_PROVISION_MS },
				formationUsageRecorder: gracefullyLateRecorder,
			});
			try {
				// No `validationUrl` and no hook: the abort must come from the listener's work deadline
				// alone, so nothing else can be what the decorator observes.
				const hostStrandId = `strand-abort-adopt-${Date.now()}`;
				await insertHostStrand(alice, hostStrandId);
				const token = `invite-abort-adopt-${Date.now()}`;
				await publishBoundInvite(alice, token, 'sapp-abort-adopt', hostStrandId);

				const bobService = joinerService(bob);
				const invitation = invitationFor(token, 'sapp-abort-adopt', alice);

				// RESOLVES — the joiner is told the truth about a spent invitation, not "timed out".
				const result = await bobService.formStrand(
					invitation, { partyId: bob.partyId, purpose: 'abort-adopt' }, bob.ownerNode.libp2p,
				);
				expect(result.strandId).toBe(hostStrandId);

				// Without this the case degenerates into an ordinary happy path and would pass even if
				// cancellation were removed entirely. The assignment is safely ordered: the `await`
				// completes before `recordUsage` returns, which is before the result frame goes out.
				expect(observedAbort).toBe(true);

				expect(await alice.controlDatabase.countFormationUsage(token)).toBe(1);
				const row = await readFormationUsage(alice, token);
				expect(row).not.toBeNull();
				expect(verifyFormationConsent(row!)).toBe(true);
				expect(ed25519PublicKeyB64FromPeerId(result.memberKey)).toBe(row!.peerKey);

				// The adopted redemption really did consume the seat — an adoption that reported success
				// without spending the invite would sail past everything above and fail only here.
				await expect(
					bobService.formStrand(invitation, { partyId: bob.partyId, purpose: 'abort-adopt-again' }, bob.ownerNode.libp2p),
				).rejects.toThrow(/Invalid token/);
				expect(await alice.controlDatabase.countFormationUsage(token)).toBe(1);
			} finally {
				aliceService.unregisterResponder(alice.ownerNode.libp2p);
			}
		}, 30_000);
	});
});
