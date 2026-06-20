/**
 * Closed-strand membership lifecycle E2E (real two-node strand).
 *
 * Capstone integration coverage for the `Strand.*` membership tables landed by the
 * `strand-membership-*` tickets (founder bootstrap → invite/join → member-peer →
 * authority rotation). Drives the full CLOSED-strand path across two REAL
 * `CadreNode`s over libp2p, modelled on the proven two-node pattern in
 * `rbac-signed-write.integration.ts` (real nodes, `formStrand` over libp2p,
 * `addStrand` on each side, a manual strand-level dial) and the Phase-2 lifecycle
 * tests in `strand-formation-e2e.integration.ts`.
 *
 * ── SCOPE (read before extending) ────────────────────────────────────────────
 * This asserts the SQL-LAYER membership lifecycle using the writer APIs against the
 * two nodes' real strand DBs. The full closed-formation-over-the-wire delivery of
 * `MemberPrivateKey` (provision-then-record) is exercised at the control layer
 * (`strand-formation-e2e` Phase 4) and is OUT OF SCOPE here — we construct the
 * shared closed `StrandRow` directly (`Type:'c'`, a `MemberPrivateKey` minted via
 * `generateStrandMemberKey`), exactly as the existing tests construct the open
 * `StrandRow` from `formResult.strandId`. Both nodes `addStrand` the same closed
 * row; the founder passes `founder:true`, the joiner `founder:false`.
 *
 * ── WHERE THE WRITER LIFECYCLE RUNS (and why) ────────────────────────────────
 * The invite/join, member-peer, and authority-rotation writers all run against the
 * FOUNDER's strand DB — the authoritative DB where the founder bootstrap seated the
 * `Authority`/`Member`/`Header` those deferred constraints (`InviteValid`,
 * `MemberExists`, `Authority.Authorized`, …) read. Their accept/reject outcomes are
 * the gating deliverable. Cross-node replication of `Strand.*` rows to the JOINER's
 * DB is observed BEST-EFFORT and logged, never asserted as a gate: per the same
 * bootstrap-vs-networked caveat noted in `rbac-signed-write`, deferred-constraint-
 * bearing `Strand.*` rows may not reliably replicate under the manual-wire setup, and
 * the ticket directs us to gate on the founder-local rows + writer accept/reject
 * cases instead. A "joiner" here is a distinct member keypair (+ the joiner node's
 * real strand peer id) admitted into the founder DB, never the founder's own key.
 *
 * Rejection floor: per the optimystic deferred-constraint-rollback gap (backlog),
 * rejected writes assert via `rejects.toThrow()` ("throws" is the floor) and do NOT
 * assert post-state rollback. Accept assertions use precise key lookups (not bare
 * counts) so a leaked row from a rejected write can never corrupt them.
 */

import { describe, it, expect } from 'vitest';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import {
	CadreNode,
	signSchema,
	generateStrandMemberKey,
	strandMemberKeyPair,
	issueInvite,
	consumeInvite,
	registerMemberPeer,
	addAuthority,
	signStrandPayload,
	type StrandProvisioner,
	type AuthorityKeyPair,
} from '@serfab/cadre-core';
import type { CadreNodeConfig, StrandRow, SAppConfig } from '@serfab/cadre-core';
import type { Database } from '@quereus/quereus';
import { generatePrivateKey, getPublicKey, digest, sign } from '@optimystic/quereus-plugin-crypto';
import { waitUntil } from '../harness/index.js';
import { loadSimpleSApp } from '../fixtures/index.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function wsTransports() {
	return [webSockets(), circuitRelayTransport()];
}

/** Deterministic strand provisioner for test predictability. */
function createMockProvisioner(prefix = 'closed'): StrandProvisioner {
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

/** Create a properly signed sApp config (matches rbac-signed-write/strand-formation-e2e). */
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

/** A fresh, unrelated ed25519 keypair in the base64url shape the constraints consume. */
function freshKeyPair(): AuthorityKeyPair {
	const privateKeyB64 = generatePrivateKey('ed25519', 'base64url') as string;
	const publicKeyB64 = getPublicKey(privateKeyB64, 'ed25519', 'base64url', 'base64url') as string;
	return { privateKeyB64, publicKeyB64 };
}

/** Count rows in a `Strand.*` table as seen by a strand DB. */
async function strandCount(
	db: Database,
	table: 'Header' | 'Member' | 'Authority' | 'Invite' | 'ConsumedInvite' | 'MemberPeer',
): Promise<number> {
	const row = await db.get(`select count(1) as c from Strand.${table}`);
	return (row?.c as number) ?? 0;
}

// ── App.Items signed-write helpers (reused shape from rbac-signed-write) ───────
// The fixture's verify() is pinned to ed25519, so member keys MUST be ed25519 —
// which the strand member keypairs already are.

const SAPP_CURVE = 'ed25519' as const;

/** Reproduce the authenticated payload exactly as the App.Items constraint computes it. */
function itemPayload(id: string, name: string, value: string | null): string {
	return `${id}|${name}|${value ?? ''}`;
}

/** Sign the Id|Name|Value payload for an App.Items insert/update with a member's key. */
function signItem(privateKeyB64: string, id: string, name: string, value: string | null): string {
	const hashBytes = digest([itemPayload(id, name, value)], 'sha256', 'bytes') as Uint8Array;
	return sign(hashBytes, privateKeyB64, SAPP_CURVE, 'bytes', 'base64url', 'base64url') as string;
}

// ═════════════════════════════════════════════════════════════════════════════

describe('Closed-strand membership lifecycle (real two-node strand)', () => {
	it('founds a closed strand, admits a second member, and gates writes by membership', async () => {
		let founderNode: CadreNode | undefined;
		let joinerNode: CadreNode | undefined;

		try {
			const partyId = `closed-${Date.now()}`;

			// The closed strand's sApp is the realistic signed-write RBAC fixture, so the
			// admitted member can drive a real App.Items signed write at the end (layer-3).
			const appLogic = await loadSimpleSApp();
			const sAppConfig = createSignedSAppConfig(appLogic, '0.1.0');

			// ── Two real CadreNodes over libp2p (rbac/Phase-2 pattern) ───────────
			founderNode = new CadreNode(createTestNodeConfig(`founder-${partyId}`, { profile: 'storage', enableRelay: true }));
			await founderNode.start();

			joinerNode = new CadreNode(createTestNodeConfig(`joiner-${partyId}`, { bootstrapNodes: founderNode.getMultiaddrs() }));
			await joinerNode.start();

			// Form a strand over the wire to get a real negotiated strandId (the closed
			// MemberPrivateKey delivery itself is out of scope — see header).
			founderNode.initializeStrandSolicitation({ strandProvisioner: createMockProvisioner('closed') });
			const invitation = await founderNode.createOpenInvitation('closed-sapp');
			const formResult = await joinerNode.formStrand(invitation, {
				partyId: `joiner-${partyId}`,
				purpose: 'closed-strand membership lifecycle test',
			});
			expect(formResult.strandId).toBeDefined();

			// ── Construct the shared CLOSED StrandRow directly ───────────────────
			// Type:'c' + a minted MemberPrivateKey; both nodes attach the same row. The
			// founder derives the founding Member/Authority key from MemberPrivateKey.
			const memberPrivateKey = await generateStrandMemberKey();
			const founderKeyPair = strandMemberKeyPair(memberPrivateKey);
			const strandRow: StrandRow = { Id: formResult.strandId, MemberPrivateKey: memberPrivateKey, Type: 'c' };

			// Request `networked` explicitly on both so writes route through the network
			// transactor and the manual strand dial actually replicates (an empty
			// CadrePeer cohort would otherwise infer `bootstrap` and keep rows node-local).
			const founderStrand = await founderNode.addStrand({ strandRow, sAppConfig, mode: 'networked', founder: true });
			const joinerStrand = await joinerNode.addStrand({ strandRow, sAppConfig, mode: 'networked', founder: false });
			expect(founderStrand.status).toBe('active');
			expect(joinerStrand.status).toBe('active');

			const founderDb = founderStrand.database!.getDatabase();
			const joinerDb = joinerStrand.database!.getDatabase();

			// ── 1. Founder bootstrap: exactly Header(c) + founding Member + Authority ──
			expect(await strandCount(founderDb, 'Header')).toBe(1);
			expect(await strandCount(founderDb, 'Member')).toBe(1);
			expect(await strandCount(founderDb, 'Authority')).toBe(1);

			const header = await founderDb.get('select Type from Strand.Header');
			expect(header?.Type).toBe('c');
			const founderMember = await founderDb.get('select Key from Strand.Member');
			const founderAuthority = await founderDb.get('select MemberKey from Strand.Authority');
			expect(founderMember?.Key).toBe(founderKeyPair.publicKeyB64);
			expect(founderAuthority?.MemberKey).toBe(founderKeyPair.publicKeyB64);

			// ── 2. Joiner writes nothing on bring-up (BEFORE any strand dial) ────
			// No strand-level connection exists yet, so nothing could have synced — this
			// proves the joiner's `addStrand({ founder:false })` inserted no rows itself.
			expect(await strandCount(joinerDb, 'Header')).toBe(0);
			expect(await strandCount(joinerDb, 'Member')).toBe(0);
			expect(await strandCount(joinerDb, 'Authority')).toBe(0);

			// ── 3. Manually connect strand-level libp2p (peer discovery via control net is TODO) ──
			const founderStrandAddrs = founderStrand.libp2pNode!.getMultiaddrs();
			expect(founderStrandAddrs.length).toBeGreaterThan(0);
			await joinerStrand.libp2pNode!.dial(founderStrandAddrs[0]!);
			await waitUntil(
				() => joinerStrand.libp2pNode!.getConnections().length > 0,
				{ timeoutMs: 10_000, description: 'joiner strand connects to founder strand' },
			);

			// ── 4. BEST-EFFORT: joiner observes the founder's bootstrap rows via sync ──
			// Logged, NOT gated — deferred-constraint-bearing Strand.* rows may not
			// replicate reliably under the manual-wire setup (see header rationale).
			let syncObserved = false;
			try {
				await waitUntil(
					async () =>
						(await strandCount(joinerDb, 'Header')) >= 1 &&
						(await strandCount(joinerDb, 'Member')) >= 1 &&
						(await strandCount(joinerDb, 'Authority')) >= 1,
					{ timeoutMs: 8_000, intervalMs: 250, description: 'founder bootstrap rows replicate to joiner' },
				);
				syncObserved = true;
			} catch {
				syncObserved = false; // observed, not asserted
			}
			console.log(
				`[closed-strand] founder bootstrap rows observed on joiner via sync=${syncObserved} ` +
				'(best-effort; gating assertions are founder-local + writer accept/reject)',
			);

			// ════ Writer-driven membership lifecycle (against the founder DB) ════

			// ── 5. Invite issuance: authority accepts, non-authority rejects ─────
			const { inviteKey, invitePrivateKey } = await issueInvite(founderDb, { authorityKeyPair: founderKeyPair });
			const issuedRow = await founderDb.get('select Key from Strand.Invite where Key = ?', [inviteKey]);
			expect(issuedRow?.Key).toBe(inviteKey);

			// A non-authority cannot issue an invite (InviteValid has no matching Authority).
			await expect(issueInvite(founderDb, { authorityKeyPair: freshKeyPair() })).rejects.toThrow();

			// ── 6. Invite consumption: joiner joins with its own member keypair ──
			const joinerMember = freshKeyPair();
			await consumeInvite(founderDb, {
				inviteKey,
				invitePrivateKey,
				memberKey: joinerMember.publicKeyB64,
			});

			// The joiner's Member + the matching ConsumedInvite both committed.
			const admittedMember = await founderDb.get('select Key from Strand.Member where Key = ?', [joinerMember.publicKeyB64]);
			expect(admittedMember?.Key).toBe(joinerMember.publicKeyB64);
			const consumed = await founderDb.get('select MemberKey from Strand.ConsumedInvite where InviteKey = ?', [inviteKey]);
			expect(consumed?.MemberKey).toBe(joinerMember.publicKeyB64);

			// An unauthorized join — consume a fresh invite with the WRONG private key —
			// is rejected (the invite-key possession proof fails at commit).
			const { inviteKey: inviteKey2 } = await issueInvite(founderDb, { authorityKeyPair: founderKeyPair });
			await expect(
				consumeInvite(founderDb, {
					inviteKey: inviteKey2,
					invitePrivateKey: freshKeyPair().privateKeyB64,
					memberKey: freshKeyPair().publicKeyB64,
				}),
			).rejects.toThrow();

			// ── 7. MemberPeer: the joining member binds its OWN node, self-signed ──
			// Use the joiner node's real strand-level peer id, proving a member registers
			// its actual network node.
			const joinerPeerId = joinerStrand.libp2pNode!.peerId.toString();
			await registerMemberPeer(founderDb, { memberKeyPair: joinerMember, peerId: joinerPeerId });
			// Assert via a bare select (exactly one MemberPeer row exists at this point —
			// the impostor reject below uses a distinct PeerId and runs AFTER this): the
			// optimystic networked transactor does not reliably serve a full composite-PK
			// (`where MemberKey = ? and PeerId = ?`) point lookup, so we read the singleton
			// row directly rather than seeking it.
			expect(await strandCount(founderDb, 'MemberPeer')).toBe(1);
			const peerRow = await founderDb.get('select MemberKey, PeerId from Strand.MemberPeer');
			expect(peerRow?.MemberKey).toBe(joinerMember.publicKeyB64);
			expect(peerRow?.PeerId).toBe(joinerPeerId);

			// A peer insert for the joiner's key under a DIFFERENT signer is rejected
			// (MemberPeer.Authorized verifies the self-signature against MemberKey itself).
			// Driven via raw exec because the writer always self-signs correctly.
			const impostor = freshKeyPair();
			const impostorPeerId = 'peer-impostor';
			const impostorPayload = `${joinerMember.publicKeyB64}|${impostorPeerId}`;
			const impostorSignature = signStrandPayload(impostorPayload, impostor.privateKeyB64);
			await expect(
				founderDb.exec(
					`insert into Strand.MemberPeer (MemberKey, PeerId)
					   with context Signature = ?
					   values (?, ?)`,
					[impostorSignature, joinerMember.publicKeyB64, impostorPeerId],
				),
			).rejects.toThrow();

			// ── 8. Authority rotation: founder promotes the joiner to a 2nd authority ──
			await addAuthority(founderDb, { byAuthorityKeyPair: founderKeyPair, newAuthorityKey: joinerMember.publicKeyB64 });
			const promoted = await founderDb.get('select MemberKey from Strand.Authority where MemberKey = ?', [joinerMember.publicKeyB64]);
			expect(promoted?.MemberKey).toBe(joinerMember.publicKeyB64);
			// At commit the count is 2, so this genuinely took the signature-verifying
			// branch (not the `count(Authority) <= 1` bootstrap shortcut).
			expect(await strandCount(founderDb, 'Authority')).toBe(2);

			// A non-authority cannot add an authority.
			await expect(
				addAuthority(founderDb, { byAuthorityKeyPair: freshKeyPair(), newAuthorityKey: freshKeyPair().publicKeyB64 }),
			).rejects.toThrow();

			// ── 9. A signed sApp write by the newly-admitted member is accepted ──
			// Ties layer-2 membership (Strand.Member) to layer-3 sApp RBAC: the SAME key
			// just admitted to the strand signs an App.Items insert the fixture verifies.
			const writeSig = signItem(joinerMember.privateKeyB64, 'item-joiner', 'hello', 'from the admitted member');
			await founderDb.exec(
				`insert into App.Items (Id, Name, Value, CreatedBy)
				   with context MemberKey = ?, Signature = ?
				   values (?, ?, ?, ?)`,
				[joinerMember.publicKeyB64, writeSig, 'item-joiner', 'hello', 'from the admitted member', joinerMember.publicKeyB64],
			);
			const written = await founderDb.get(
				'select Name, Value, CreatedBy from App.Items where Id = ?',
				['item-joiner'],
			);
			expect(written?.Name).toBe('hello');
			expect(written?.Value).toBe('from the admitted member');
			expect(written?.CreatedBy).toBe(joinerMember.publicKeyB64);

			// A write the admitted member did NOT sign (signature over a different payload)
			// is rejected — the RBAC floor still holds for an admitted member.
			const tamperedSig = signItem(joinerMember.privateKeyB64, 'item-joiner-2', 'bogus', 'WRONG');
			await expect(
				founderDb.exec(
					`insert into App.Items (Id, Name, Value, CreatedBy)
					   with context MemberKey = ?, Signature = ?
					   values (?, ?, ?, ?)`,
					[joinerMember.publicKeyB64, tamperedSig, 'item-joiner-2', 'bogus', 'actual-value', joinerMember.publicKeyB64],
				),
			).rejects.toThrow();
		} finally {
			// Two-node teardown cascades to the strand libp2p nodes — no leaked nodes.
			await joinerNode?.stop();
			await founderNode?.stop();
		}
	}, 60_000);
});
