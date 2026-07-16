/**
 * sApp signed-write RBAC integration test (real two-node strand).
 *
 * Drives a `verify()`-gated signed write through a REAL strand (two `CadreNode`s,
 * `formStrand` over libp2p, `addStrand` on each side) and asserts that an authorized
 * write is accepted while unauthorized writes are rejected.
 *
 * ── SCOPE (read before extending) ────────────────────────────────────────────
 * This covers **sApp-level RBAC** only: the `verify()`-gated CHECK constraints
 * declared inside the application schema via `with context (MemberKey, Signature)`,
 * which `StrandDatabase.executeSchema` applies under `declare schema App` — exposed
 * here as `App.Items`. We assert ONLY against the sApp's own `App.Items` constraints.
 *
 * It is INDEPENDENT of the Strand-level membership schema work (applying
 * `schemas/strand.qsql`'s `Member`/`Invite`/`Manager` tables) tracked by the plan
 * ticket `strand-membership-rbac-schema-not-applied` — a different layer. Do NOT
 * assert against `Strand.*` tables here, and do NOT make this scenario wait on that
 * ticket. sApp schema-signature rejection (unsigned/tampered SAppConfig) is likewise
 * out of scope — owned by `sapp-schema-signature-gate-bypassable`.
 */

import { describe, it, expect } from 'vitest';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { CadreNode, signSchema, type StrandProvisioner } from '@serfab/cadre-core';
import type { CadreNodeConfig, StrandRow, SAppConfig } from '@serfab/cadre-core';
import { generatePrivateKey, getPublicKey, digest, sign } from '@optimystic/quereus-plugin-crypto';
import { waitUntil } from '../harness/index.js';
import { loadSimpleSApp } from '../fixtures/index.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function wsTransports() {
	return [webSockets(), circuitRelayTransport()];
}

/** Deterministic strand provisioner for test predictability */
function createMockProvisioner(prefix = 'rbac'): StrandProvisioner {
	let counter = 0;
	return {
		provisionStrand: async (_sAppId, _initiatorKey, _responderKey) => ({
			strandId: `strand-${prefix}-${++counter}`,
		}),
	};
}

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

/** Create a properly signed sApp config (matches strand-formation-e2e). */
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

// ── sApp member identities + signing ─────────────────────────────────────────
// The fixture's verify() is pinned to ed25519, so member keys MUST be ed25519.

const SAPP_CURVE = 'ed25519' as const;

interface Member {
	privateKey: string;
	publicKey: string;
}

function createMember(): Member {
	const privateKey = generatePrivateKey(SAPP_CURVE, 'base64url') as string;
	const publicKey = getPublicKey(privateKey, SAPP_CURVE, 'base64url', 'base64url') as string;
	return { privateKey, publicKey };
}

/**
 * Reproduce the authenticated payload exactly as the constraint computes it:
 *   new.Id || '|' || new.Name || '|' || coalesce(new.Value,'')
 */
function itemPayload(id: string, name: string, value: string | null): string {
	return `${id}|${name}|${value ?? ''}`;
}

/**
 * Sign the Id|Name|Value payload for an insert/update. We hash to raw bytes and sign
 * those bytes; the constraint passes `digest(payload)` (the base64url
 * form of the same hash) to verify(), whose default inputEncoding decodes it back to
 * these bytes — so signer and verifier operate on identical data.
 */
function signItem(member: Member, id: string, name: string, value: string | null): string {
	const hashBytes = digest([itemPayload(id, name, value)], 'sha256', 'bytes') as Uint8Array;
	return sign(hashBytes, member.privateKey, SAPP_CURVE, 'bytes', 'base64url', 'base64url') as string;
}

/** Sign the row-key payload for a delete (matches AuthorizedDelete's digest(old.Id)). */
function signDelete(member: Member, id: string): string {
	const hashBytes = digest([id], 'sha256', 'bytes') as Uint8Array;
	return sign(hashBytes, member.privateKey, SAPP_CURVE, 'bytes', 'base64url', 'base64url') as string;
}

// ═════════════════════════════════════════════════════════════════════════════

describe('sApp signed-write RBAC (real strand)', () => {
	it('accepts authorized signed writes and rejects unauthorized ones', async () => {
		let aliceNode: CadreNode | undefined;
		let bobNode: CadreNode | undefined;

		try {
			const partyId = `rbac-${Date.now()}`;

			// Repaired fixture is the single source of truth for the app logic.
			const appLogic = await loadSimpleSApp();
			const sAppConfig = createSignedSAppConfig(appLogic, '0.1.0');

			// Two real CadreNodes over libp2p (Phase-2 pattern from strand-formation-e2e).
			aliceNode = new CadreNode(createTestNodeConfig(`alice-${partyId}`, { profile: 'storage', enableRelay: true }));
			await aliceNode.start();

			bobNode = new CadreNode(createTestNodeConfig(`bob-${partyId}`, { bootstrapNodes: aliceNode.getMultiaddrs() }));
			await bobNode.start();

			aliceNode.initializeStrandSolicitation({ strandProvisioner: createMockProvisioner('rbac') });
			const invitation = await aliceNode.createOpenInvitation('rbac-sapp');
			const formResult = await bobNode.formStrand(invitation, {
				partyId: `bob-${partyId}`,
				purpose: 'sApp signed-write RBAC test',
			});
			expect(formResult.strandId).toBeDefined();

			const strandRow: StrandRow = { Id: formResult.strandId, MemberPrivateKey: null, Type: 'o' };
			const aliceStrand = await aliceNode.addStrand({ strandRow, sAppConfig });
			const bobStrand = await bobNode.addStrand({ strandRow, sAppConfig });
			expect(aliceStrand.status).toBe('active');
			expect(bobStrand.status).toBe('active');

			// Manually connect strand-level libp2p (strand peer discovery via control net is TODO).
			await bobStrand.libp2pNode!.dial(aliceStrand.libp2pNode!.getMultiaddrs()[0]!);
			await waitUntil(
				() => bobStrand.libp2pNode!.getConnections().length > 0,
				{ timeoutMs: 10_000, description: 'Bob strand connects to Alice strand' },
			);

			const aliceDb = aliceStrand.database!.getDatabase();

			const M = createMember(); // the authorized creator
			const N = createMember(); // a different, unauthorized member

			// ── 1. Authorized insert accepted ────────────────────────────────
			const insertSig = signItem(M, 'item-1', 'first', 'hello');
			await aliceDb.exec(
				`insert into App.Items (Id, Name, Value, CreatedBy)
				   with context MemberKey = ?, Signature = ?
				   values (?, ?, ?, ?)`,
				[M.publicKey, insertSig, 'item-1', 'first', 'hello', M.publicKey],
			);

			const inserted = await aliceDb.get(
				`select Name, Value, CreatedBy from App.Items where Id = 'item-1'`,
			);
			expect(inserted?.Name).toBe('first');
			expect(inserted?.Value).toBe('hello');
			expect(inserted?.CreatedBy).toBe(M.publicKey);

			// Bob's strand applied the same constrained sApp schema, so querying App.Items
			// there must not error (proves the repaired fixture applies cleanly on a second
			// node too).
			const bobDb = bobStrand.database!.getDatabase();
			const bobRow = await bobDb.get(`select Value from App.Items where Id = 'item-1'`);

			// Cross-node replication is a BEST-EFFORT observation here, NOT a gating
			// assertion: it only happens once the strand runs in `networked` mode, which
			// depends on cohort/control-sync wiring owned by ticket
			// `2-integration-tests-real-control-sync-and-scenario-honesty`. Until that lands
			// the strand runs in `bootstrap` (local) mode and writes stay node-local — the
			// same reason strand-formation-e2e Phase 2 is pre-existing-red. The RBAC
			// accept/reject assertions in this test are local to the writer and are the
			// actual deliverable; they do not depend on replication.
			let replicated = bobRow?.Value === 'hello';
			if (!replicated) {
				try {
					await waitUntil(
						async () => {
							const row = await bobDb.get(`select Value from App.Items where Id = 'item-1'`);
							return row?.Value === 'hello';
						},
						{ timeoutMs: 3_000, intervalMs: 250, description: 'signed row replicates to Bob' },
					);
					replicated = true;
				} catch {
					replicated = false; // expected in bootstrap mode; observed, not asserted
				}
			}
			console.log(
				`[rbac] App.Items schema applied on Bob; cross-node replication observed=${replicated} ` +
				`(bootstrap mode → expected false until networked/control-sync wiring lands; owned by ticket 2)`,
			);

			// ── 2. Authorized update accepted (fresh signature) ──────────────
			const updateSig = signItem(M, 'item-1', 'first', 'updated');
			await aliceDb.exec(
				`update App.Items
				   with context MemberKey = ?, Signature = ?
				   set Value = ?
				   where Id = ?`,
				[M.publicKey, updateSig, 'updated', 'item-1'],
			);
			const updated = await aliceDb.get(`select Value from App.Items where Id = 'item-1'`);
			expect(updated?.Value).toBe('updated');

			// ── 3. Unauthorized insert rejected — signature over the WRONG payload ──
			// M is the context member, but signs a different value than the row carries.
			const wrongSig = signItem(M, 'item-2', 'bogus', 'WRONG-PAYLOAD');
			await expect(
				aliceDb.exec(
					`insert into App.Items (Id, Name, Value, CreatedBy)
					   with context MemberKey = ?, Signature = ?
					   values (?, ?, ?, ?)`,
					[M.publicKey, wrongSig, 'item-2', 'bogus', 'actual-value', M.publicKey],
				),
			).rejects.toThrow();
			expect(await aliceDb.get(`select Id from App.Items where Id = 'item-2'`)).toBeUndefined();

			// ── 4. Unauthorized insert rejected — missing (null) signature ───
			await expect(
				aliceDb.exec(
					`insert into App.Items (Id, Name, Value, CreatedBy)
					   with context MemberKey = ?, Signature = ?
					   values (?, ?, ?, ?)`,
					[M.publicKey, null, 'item-3', 'nosig', 'v', M.publicKey],
				),
			).rejects.toThrow();
			expect(await aliceDb.get(`select Id from App.Items where Id = 'item-3'`)).toBeUndefined();

			// ── 5. Unauthorized update rejected — wrong member (N updates M's row) ──
			// N supplies a perfectly valid signature with N's own key, isolating the
			// ownership check (old.CreatedBy = context.MemberKey) as the rejecting clause.
			const nSig = signItem(N, 'item-1', 'first', 'hijacked');
			await expect(
				aliceDb.exec(
					`update App.Items
					   with context MemberKey = ?, Signature = ?
					   set Value = ?
					   where Id = ?`,
					[N.publicKey, nSig, 'hijacked', 'item-1'],
				),
			).rejects.toThrow();
			const afterHijack = await aliceDb.get(
				`select Value, CreatedBy from App.Items where Id = 'item-1'`,
			);
			expect(afterHijack?.Value).toBe('updated'); // unchanged
			expect(afterHijack?.CreatedBy).toBe(M.publicKey);

			// ── 6. Unauthorized delete rejected — non-creator N ──────────────
			const nDeleteSig = signDelete(N, 'item-1');
			await expect(
				aliceDb.exec(
					`delete from App.Items
					   with context MemberKey = ?, Signature = ?
					   where Id = ?`,
					[N.publicKey, nDeleteSig, 'item-1'],
				),
			).rejects.toThrow();
			expect(await aliceDb.get(`select Id from App.Items where Id = 'item-1'`)).toBeDefined();

			// ── 7. Authorized delete accepted — creator M ────────────────────
			const mDeleteSig = signDelete(M, 'item-1');
			await aliceDb.exec(
				`delete from App.Items
				   with context MemberKey = ?, Signature = ?
				   where Id = ?`,
				[M.publicKey, mDeleteSig, 'item-1'],
			);
			expect(await aliceDb.get(`select Id from App.Items where Id = 'item-1'`)).toBeUndefined();

			// ── 8. Authorized insert with a null Value accepted ──────────────
			// Exercises the empty-segment branch of the payload: the JS signer's
			// `${value ?? ''}` and the constraint's `coalesce(Value,'')` must both
			// collapse a null Value to the same empty string, so signer and verifier
			// still operate on identical bytes. (Cases 1–7 only used non-null values.)
			const nullSig = signItem(M, 'item-null', 'noval', null);
			await aliceDb.exec(
				`insert into App.Items (Id, Name, Value, CreatedBy)
				   with context MemberKey = ?, Signature = ?
				   values (?, ?, ?, ?)`,
				[M.publicKey, nullSig, 'item-null', 'noval', null, M.publicKey],
			);
			const nullRow = await aliceDb.get(
				`select Name, Value from App.Items where Id = 'item-null'`,
			);
			expect(nullRow?.Name).toBe('noval');
			expect(nullRow?.Value ?? null).toBeNull();
		} finally {
			await bobNode?.stop();
			await aliceNode?.stop();
		}
	}, 60_000);
});
