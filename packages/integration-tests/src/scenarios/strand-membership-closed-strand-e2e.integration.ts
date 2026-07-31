/**
 * Closed-strand membership lifecycle E2E (real two-node strand).
 *
 * Capstone integration coverage for the `Strand.*` membership tables landed by the
 * `strand-membership-*` tickets (founder bootstrap → invite/join → member-peer →
 * manager rotation, member-peer REMOVAL, and a join driven from the SECOND node's own
 * database). Drives the full CLOSED-strand path
 * across two REAL `CadreNode`s over libp2p, modelled on the proven two-node pattern
 * in `rbac-signed-write.integration.ts` (real nodes, `formStrand` over libp2p,
 * `addStrand` on each side, a manual strand-level dial) and the Phase-2 lifecycle
 * tests in `strand-formation-e2e.integration.ts`.
 *
 * Three independent tests, each with its OWN two-node strand via
 * {@link bringUpClosedStrand}: the admission/rotation lifecycle, device-record
 * (`MemberPeer`) removal, and a JOINER-AUTHORED join. They are deliberately NOT one
 * narrative — the removal test asserts enumerations, and the other two end with
 * rejected writes whose post-state this file does not assert (see the rejection
 * floor below).
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
 * Permission/rejection SEMANTICS for `MemberPeer` (which branch authorizes what,
 * stranger rejection, `NoUpdate`, same-transaction managers) are settled in
 * `cadre-core/test/strand-membership-peer-rotation.spec.ts` under bootstrap mode and
 * are NOT repeated here. What this file adds is the NETWORK.
 *
 * ── WHERE THE WRITER LIFECYCLE RUNS (and why) ────────────────────────────────
 * The first two tests are FOUNDER-AUTHORITATIVE by design: every writer call runs
 * against the founder's strand DB, the DB where the founder bootstrap seated the
 * `Manager`/`Member`/`Header` that the deferred constraints (`InviteValid`,
 * `MemberExists`, `Manager.Authorized`, …) read. That keeps their accept/reject
 * BREADTH — many outcomes per bring-up — cheap and unambiguous. In those two, a
 * "joiner" is a distinct member keypair (+ the joiner node's real strand peer id)
 * admitted into the founder DB, never the founder's own key.
 *
 * The third test is JOINER-AUTHORED: the founder issues an invite, and the second
 * node then runs `consumeInvite` / `registerMemberPeer` / a signed `App.Items` write
 * against its OWN database, with each resulting row gated as visible from the
 * founder. That proves a membership write authored on the second node converges back
 * — and that the one deferred check with a genuine cross-node read (`ConsumedInvite`'s
 * `InviteExists`/`ValidUsage`/`NotExpired`, all of which read the founder-authored
 * `Strand.Invite` row) resolves from there. See that test's own comment for which of
 * the join's other constraints are local rather than cross-node.
 *
 * Replication of `Strand.*` is GATED EVERYWHERE in this file — the bootstrap-rows
 * gate in {@link bringUpClosedStrand}, the removal test's cross-node checks, and
 * every convergence check in the third test all throw on timeout, all on the shared
 * {@link GATE} budget. The old best-effort/observe-then-require paths are gone. A
 * timeout here is a real convergence defect; do NOT restore a skip branch.
 *
 * NOTE: `waitUntil` swallows a throwing condition and retries, so a gate whose read
 * ERRORS on every attempt still reports a plain timeout, indistinguishable from rows
 * that simply never arrived. If one of these ever times out, check the harness debug
 * log (`Wait condition threw: …`) before concluding it is a convergence failure.
 *
 * VISIBILITY IS NOT PHYSICAL REPLICATION. Every cross-node assertion in this file
 * proves a row is VISIBLE from the other node's database, not that its block lives
 * there. A read on either node resolves one coordinator peer per block; when that
 * resolves to the authoring node, the other node's `select` is a remote call against
 * the author's storage and nothing needs to live locally. Visibility is the property
 * an application actually observes, and it is what this file asserts. Proving
 * physical replication needs a different technique (stop the authoring node first) —
 * parked as `backlog/debt-strand-replication-vs-visibility-proof`.
 *
 * Rejection floor: per the optimystic deferred-constraint-rollback gap (backlog),
 * rejected writes assert via `rejects.toThrow()` ("throws" is the floor) and do NOT
 * assert post-state rollback. Accept assertions use precise key lookups (not bare
 * counts) so a leaked row from a rejected write can never corrupt them — and no count
 * or enumeration assertion may FOLLOW a rejected write in the same test.
 *
 * Lookup shape: an assertion that a row is GONE must never be served by a full-PK
 * where-equality, which the optimystic module serves as a point lookup that can MISS
 * on a networked strand (`debt-composite-pk-point-lookup-unreliable-untracked`) and so
 * could report "gone" for a row that is still there. Absence assertions here scan and
 * filter in JavaScript; presence assertions may use an equality, since a miss there
 * fails the test rather than passing it.
 */

import { describe, it, expect } from 'vitest';
import type { IRawStorage } from '@optimystic/db-p2p';
import {
	CadreNode,
	generateStrandMemberKey,
	strandMemberKeyPair,
	issueInvite,
	consumeInvite,
	registerMemberPeer,
	listMemberPeers,
	removeMemberPeer,
	revokeMember,
	addManager,
	signStrandApproval,
	generateStrandStampId,
	type StrandProvisioner,
	type Ed25519KeyPair,
} from '@serfab/cadre-core';
import type { CadreNodeConfig, StrandRow, StrandInstance } from '@serfab/cadre-core';
import type { Database } from '@quereus/quereus';
import { generatePrivateKey, getPublicKey, digest, sign } from '@optimystic/quereus-plugin-crypto';
import {
	waitUntil,
	wsTransports,
	createSignedSAppConfig,
	captureRawStorage,
	compareBlockCoverage,
	blockCoverageIsComplete,
	formatBlockCoverageGap,
	readBlockIndex,
	type RawStorageCapture,
} from '../harness/index.js';
import { loadSimpleSApp } from '../fixtures/index.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * The budget every cross-node convergence gate in this file waits on.
 *
 * Measured convergence is well under a second — ~1 s even with the box at 2×
 * CPU oversubscription — so 15 s is a wide margin, not a hope. One constant so a
 * future CI-driven bump happens once rather than at eight call sites.
 */
const GATE = { timeoutMs: 15_000, intervalMs: 250 } as const;

/** Deterministic strand provisioner for test predictability. */
function createMockProvisioner(prefix = 'closed'): StrandProvisioner {
	let counter = 0;
	return {
		provisionStrand: async (_sAppId, _initiatorKey, _responderKey) => ({
			strandId: `strand-${prefix}-${++counter}`,
		}),
	};
}

/**
 * @param capture - This node's OWN storage capture, whose per-scope factory becomes the
 *   node's storage provider. One capture per node — see {@link bringUpClosedStrand}.
 */
function createTestNodeConfig(
	partyId: string,
	capture: RawStorageCapture,
	opts: { bootstrapNodes?: string[]; profile?: 'storage' | 'transaction'; enableRelay?: boolean } = {},
): CadreNodeConfig {
	return {
		controlNetwork: { partyId, bootstrapNodes: opts.bootstrapNodes ?? [] },
		profile: opts.profile ?? 'transaction',
		strandFilter: { mode: 'all' },
		storage: { provider: capture.provider },
		network: {
			transports: wsTransports(),
			listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws'],
			...(opts.enableRelay ? { enableRelay: true } : {}),
		},
		hibernation: { enabled: false },
	};
}

/** A fresh, unrelated ed25519 keypair in the base64url shape the constraints consume. */
function freshKeyPair(): Ed25519KeyPair {
	const privateKeyB64 = generatePrivateKey('ed25519', 'base64url') as string;
	const publicKeyB64 = getPublicKey(privateKeyB64, 'ed25519', 'base64url', 'base64url') as string;
	return { privateKeyB64, publicKeyB64 };
}

/** Count rows in a `Strand.*` table as seen by a strand DB. */
async function strandCount(
	db: Database,
	table: 'Header' | 'Member' | 'Manager' | 'Invite' | 'ConsumedInvite' | 'MemberPeer',
): Promise<number> {
	const row = await db.get(`select count(1) as c from Strand.${table}`);
	return (row?.c as number) ?? 0;
}

/**
 * The live `StampId` of one `MemberPeer` row, via unfiltered scan + JavaScript filter.
 * `MemberPeer`'s primary key is `(MemberKey, PeerId)`, so an equality on both columns
 * is a full-PK point lookup — see the lookup-shape note in the file header.
 */
async function memberPeerStamp(db: Database, memberKey: string, peerId: string): Promise<string> {
	for await (const row of db.eval('select MemberKey, PeerId, StampId from Strand.MemberPeer')) {
		if (row.MemberKey === memberKey && row.PeerId === peerId) return row.StampId as string;
	}
	throw new Error(`no MemberPeer row for (${memberKey}, ${peerId})`);
}

/**
 * Whether a `Strand.Revocation` tombstone retiring `stampId` for `tableName` exists.
 * `Revocation`'s primary key is `(TableName, StampId)` — scanned, never sought, for
 * the same reason as {@link memberPeerStamp}.
 */
async function revocationExists(db: Database, tableName: string, stampId: string): Promise<boolean> {
	for await (const row of db.eval('select TableName, StampId from Strand.Revocation')) {
		if (row.TableName === tableName && row.StampId === stampId) return true;
	}
	return false;
}

/** Every `Strand.Member.Key` currently visible, scanned (`Key` alone is the whole PK). */
async function memberKeys(db: Database): Promise<string[]> {
	const keys: string[] = [];
	for await (const row of db.eval('select Key from Strand.Member')) {
		keys.push(row.Key as string);
	}
	return keys;
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

// ── Two-node closed-strand bring-up ──────────────────────────────────────────

/**
 * Stop both nodes, never letting one failure strand the other.
 *
 * A sequential `await a.stop(); await b.stop()` leaks `b` whenever `a` rejects — and
 * a live libp2p node outliving its test hangs the run. Every caller is a `finally`
 * or a bring-up rollback, so a teardown fault is logged rather than rethrown: it must
 * not mask the failure that brought us here.
 */
async function stopBoth(founderNode?: CadreNode, joinerNode?: CadreNode): Promise<void> {
	for (const result of await Promise.allSettled([joinerNode?.stop(), founderNode?.stop()])) {
		if (result.status === 'rejected') {
			console.error('[closed-strand] node teardown failed:', result.reason);
		}
	}
}

/** A live two-node closed strand, ready for writer-driven membership work. */
interface ClosedStrandFixture {
	founderNode: CadreNode;
	joinerNode: CadreNode;
	founderStrand: StrandInstance;
	joinerStrand: StrandInstance;
	founderDb: Database;
	joinerDb: Database;
	/** The founding Member/Manager keypair, derived from the shared `MemberPrivateKey`. */
	founderKeyPair: Ed25519KeyPair;
	/** The strand id both nodes attached — the scope key each node's raw store is filed under. */
	strandId: string;
	/**
	 * Each node's OWN strand-scoped raw block store, for the physical-replication proof.
	 * Reading these is a pure observation and never routes through either database — the
	 * point of a raw-store probe is that it cannot itself cause a block to be acquired.
	 */
	founderStore: IRawStorage;
	joinerStore: IRawStorage;
	/** Each node's capture, so a test can assert WHICH scopes the provider was asked for. */
	founderCapture: RawStorageCapture;
	joinerCapture: RawStorageCapture;
}

/**
 * Stand up two real `CadreNode`s sharing ONE closed strand.
 *
 * Forms a strand over the wire for a real negotiated strandId, attaches the same
 * directly-constructed closed `StrandRow` on both sides, asserts the bring-up
 * invariants (the founder bootstrap seated exactly `Header`/`Member`/`Manager`; the
 * joiner wrote nothing of its own), dials the two strand-level libp2p nodes together,
 * and GATES on the founder's bootstrap rows becoming visible to the joiner.
 *
 * `label` keeps the tests' party ids, strand ids and member keys disjoint, and each
 * call gets its OWN provisioner instance (its counter is per-instance), so nothing
 * two bring-ups create can collide.
 *
 * Each node's storage provider is a {@link captureRawStorage} capture, so the fixture can
 * expose that node's strand-scoped raw block store. The capture is a PURE OBSERVATION —
 * it hands out exactly the store the plain `() => new MemoryRawStorage()` provider used
 * to, only remembered by scope — so the three tests that predate it are unaffected.
 *
 * On any internal failure both nodes are stopped before the error is rethrown —
 * otherwise a bring-up fault leaks live libp2p nodes into the rest of the file.
 */
async function bringUpClosedStrand(label: string): Promise<ClosedStrandFixture> {
	const partyId = `closed-${label}-${Date.now()}`;
	let founderNode: CadreNode | undefined;
	let joinerNode: CadreNode | undefined;

	// SEPARATE captures, one per node. A shared capture would hand both nodes the same
	// per-scope stores, and the physical-replication proof below would pass for the worst
	// possible reason (comparing a store with itself). The distinctness is asserted, not
	// merely intended — see the fourth test.
	const founderCapture = captureRawStorage();
	const joinerCapture = captureRawStorage();

	try {
		// The closed strand's sApp is the realistic signed-write RBAC fixture, so an
		// admitted member can drive a real App.Items signed write (layer-3).
		const appLogic = await loadSimpleSApp();
		const sAppConfig = createSignedSAppConfig(appLogic, '0.1.0');

		// ── Two real CadreNodes over libp2p (rbac/Phase-2 pattern) ───────────
		founderNode = new CadreNode(createTestNodeConfig(`founder-${partyId}`, founderCapture, { profile: 'storage', enableRelay: true }));
		await founderNode.start();

		joinerNode = new CadreNode(createTestNodeConfig(`joiner-${partyId}`, joinerCapture, { bootstrapNodes: founderNode.getMultiaddrs() }));
		await joinerNode.start();

		// Form a strand over the wire to get a real negotiated strandId (the closed
		// MemberPrivateKey delivery itself is out of scope — see header).
		founderNode.initializeStrandSolicitation({ strandProvisioner: createMockProvisioner(label) });
		const invitation = await founderNode.createOpenInvitation('closed-sapp');
		const formResult = await joinerNode.formStrand(invitation, {
			partyId: `joiner-${partyId}`,
			purpose: `closed-strand membership lifecycle test (${label})`,
		});
		expect(formResult.strandId).toBeDefined();

		// ── Construct the shared CLOSED StrandRow directly ───────────────────
		// Type:'c' + a minted MemberPrivateKey; both nodes attach the same row. The
		// founder derives the founding Member/Manager key from MemberPrivateKey.
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

		// Each node's strand-scoped raw store, now that the provider has been asked for
		// this strand's scope. `forStrand` throws (naming the scopes it did see) rather
		// than returning an empty store, so a change to how cadre-core invokes the
		// provider fails here instead of silently making every coverage check vacuous.
		const founderStore = founderCapture.forStrand(formResult.strandId);
		const joinerStore = joinerCapture.forStrand(formResult.strandId);

		// ── Founder bootstrap: exactly Header(c) + founding Member + Manager ──
		expect(await strandCount(founderDb, 'Header')).toBe(1);
		expect(await strandCount(founderDb, 'Member')).toBe(1);
		expect(await strandCount(founderDb, 'Manager')).toBe(1);

		const header = await founderDb.get('select Type from Strand.Header');
		expect(header?.Type).toBe('c');
		const founderMember = await founderDb.get('select Key from Strand.Member');
		const founderManager = await founderDb.get('select MemberKey from Strand.Manager');
		expect(founderMember?.Key).toBe(founderKeyPair.publicKeyB64);
		expect(founderManager?.MemberKey).toBe(founderKeyPair.publicKeyB64);

		// ── Joiner writes nothing on bring-up (BEFORE any strand dial) ───────
		// No strand-level connection exists yet, so nothing could have synced — this
		// proves the joiner's `addStrand({ founder:false })` inserted no rows itself.
		expect(await strandCount(joinerDb, 'Header')).toBe(0);
		expect(await strandCount(joinerDb, 'Member')).toBe(0);
		expect(await strandCount(joinerDb, 'Manager')).toBe(0);

		// ── Manually connect strand-level libp2p (peer discovery via control net is TODO) ──
		const founderStrandAddrs = founderStrand.libp2pNode!.getMultiaddrs();
		expect(founderStrandAddrs.length).toBeGreaterThan(0);
		await joinerStrand.libp2pNode!.dial(founderStrandAddrs[0]!);
		await waitUntil(
			() => joinerStrand.libp2pNode!.getConnections().length > 0,
			{ timeoutMs: 10_000, description: 'joiner strand connects to founder strand' },
		);

		// ── GATE: the founder's bootstrap rows become visible to the joiner ──
		// Throws on timeout. Expiring the GATE budget is a real defect, not a slow
		// machine — see the header.
		await waitUntil(
			async () =>
				(await strandCount(joinerDb, 'Header')) >= 1 &&
				(await strandCount(joinerDb, 'Member')) >= 1 &&
				(await strandCount(joinerDb, 'Manager')) >= 1,
			{ ...GATE, description: 'founder bootstrap rows replicate to joiner' },
		);
		console.log(`[closed-strand:${label}] founder bootstrap rows visible on joiner (gated)`);

		return {
			founderNode, joinerNode, founderStrand, joinerStrand, founderDb, joinerDb, founderKeyPair,
			strandId: formResult.strandId, founderStore, joinerStore, founderCapture, joinerCapture,
		};
	} catch (error) {
		// A partially-built fixture still holds live libp2p nodes; the caller never
		// receives it, so it can never run its own teardown.
		await stopBoth(founderNode, joinerNode);
		throw error;
	}
}

// ═════════════════════════════════════════════════════════════════════════════

describe('Closed-strand membership lifecycle (real two-node strand)', () => {
	it('founds a closed strand, admits a second member, and gates writes by membership', async () => {
		const { founderNode, joinerNode, joinerStrand, founderDb, founderKeyPair } =
			await bringUpClosedStrand('lifecycle');

		try {
			// ════ Writer-driven membership lifecycle (against the founder DB) ════

			// ── Invite issuance: manager accepts, non-manager rejects ─────
			const { inviteKey, invitePrivateKey } = await issueInvite(founderDb, { managerKeyPair: founderKeyPair });
			const issuedRow = await founderDb.get('select Key from Strand.Invite where Key = ?', [inviteKey]);
			expect(issuedRow?.Key).toBe(inviteKey);

			// A non-manager cannot issue an invite (InviteValid has no matching Manager).
			await expect(issueInvite(founderDb, { managerKeyPair: freshKeyPair() })).rejects.toThrow();

			// ── Invite consumption: joiner joins with its own member keypair ──
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
			const { inviteKey: inviteKey2 } = await issueInvite(founderDb, { managerKeyPair: founderKeyPair });
			await expect(
				consumeInvite(founderDb, {
					inviteKey: inviteKey2,
					invitePrivateKey: freshKeyPair().privateKeyB64,
					memberKey: freshKeyPair().publicKeyB64,
				}),
			).rejects.toThrow();

			// ── MemberPeer: the joining member binds its OWN node, self-signed ──
			// Use the joiner node's real strand-level peer id, proving a member registers
			// its actual network node.
			const joinerPeerId = joinerStrand.libp2pNode!.peerId.toString();
			await registerMemberPeer(founderDb, { memberKeyPair: joinerMember, peerId: joinerPeerId });
			// Assert via a bare select (exactly one MemberPeer row exists at this point —
			// the impostor reject below uses a distinct PeerId and runs AFTER this).
			expect(await strandCount(founderDb, 'MemberPeer')).toBe(1);
			const peerRow = await founderDb.get('select MemberKey, PeerId from Strand.MemberPeer');
			expect(peerRow?.MemberKey).toBe(joinerMember.publicKeyB64);
			expect(peerRow?.PeerId).toBe(joinerPeerId);

			// Re-registering the same (MemberKey, PeerId) is a quiet no-op ON A NETWORKED
			// STRAND — this is the case that used to duplicate. registerMemberPeer's
			// existence guard scans the member's peers and compares both key columns in JS
			// instead of seeking the composite PK, which the networked transactor does not
			// reliably serve. Must run BEFORE the impostor insert below: per this file's
			// rejection floor, a rejected write is only asserted to throw, so no count
			// assertion is safe after one.
			await expect(
				registerMemberPeer(founderDb, { memberKeyPair: joinerMember, peerId: joinerPeerId }),
			).resolves.toBeUndefined();
			expect(await strandCount(founderDb, 'MemberPeer')).toBe(1);

			// A peer insert for the joiner's key under a DIFFERENT signer is rejected
			// (MemberPeer.Authorized verifies the self-signature against MemberKey itself).
			// Driven via raw exec because the writer always self-signs correctly.
			const impostor = freshKeyPair();
			const impostorPeerId = 'peer-impostor';
			const impostorStamp = generateStrandStampId();
			const impostorSignature = signStrandApproval(
				['Strand.MemberPeer', 'add', joinerMember.publicKeyB64, impostorPeerId, impostorStamp],
				impostor.privateKeyB64,
			);
			await expect(
				founderDb.exec(
					`insert into Strand.MemberPeer (MemberKey, PeerId, StampId)
					   with context Signature = ?, ManagerKey = null, ManagerSignature = null
					   values (?, ?, ?)`,
					[impostorSignature, joinerMember.publicKeyB64, impostorPeerId, impostorStamp],
				),
			).rejects.toThrow();

			// ── Manager rotation: founder promotes the joiner to a 2nd manager ──
			await addManager(founderDb, { byManagerKeyPair: founderKeyPair, newManagerKey: joinerMember.publicKeyB64 });
			const promoted = await founderDb.get('select MemberKey from Strand.Manager where MemberKey = ?', [joinerMember.publicKeyB64]);
			expect(promoted?.MemberKey).toBe(joinerMember.publicKeyB64);
			// At commit the count is 2, so this genuinely took the signature-verifying
			// branch (not the `count(Manager) <= 1` bootstrap shortcut).
			expect(await strandCount(founderDb, 'Manager')).toBe(2);

			// A non-manager cannot add a manager.
			await expect(
				addManager(founderDb, { byManagerKeyPair: freshKeyPair(), newManagerKey: freshKeyPair().publicKeyB64 }),
			).rejects.toThrow();

			// ── A signed sApp write by the newly-admitted member is accepted ──
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
			await stopBoth(founderNode, joinerNode);
		}
	}, 60_000);

	// ── MemberPeer removal on a real network ──────────────────────────────────
	//
	// A `MemberPeer` row is a member's DEVICE RECORD — "this network node acts for me".
	// Two removal paths exist and neither had ever run over a real network: a member
	// clearing its own record, and a manager clearing the leftovers of a member it
	// removed (peer rows do NOT cascade on revocation, so they survive as orphans).
	//
	// Step order is load-bearing:
	//   • self removal must precede the revocation — `Revocation.Authorized` verifies
	//     the tombstone filer against `committed.Member`, so once M is revoked it can no
	//     longer file one, and a self-branch removal would then fail on the tombstone
	//     rather than on the delete. That is correct behaviour, not a bug.
	//   • M is never promoted to manager — `Member.NotAManager` refuses to un-member a
	//     key still holding a `Manager` row, and this test revokes M.
	//   • the single rejected write is LAST, per this file's rejection floor.
	it('a member clears its own device record and a manager clears a revoked member\'s leftovers', async () => {
		const { founderNode, joinerNode, joinerStrand, founderDb, joinerDb, founderKeyPair } =
			await bringUpClosedStrand('removal');

		try {
			// ── 1. Admit a plain member M through the real invite flow ───────────
			const member = freshKeyPair();
			const { inviteKey, invitePrivateKey } = await issueInvite(founderDb, { managerKeyPair: founderKeyPair });
			await consumeInvite(founderDb, { inviteKey, invitePrivateKey, memberKey: member.publicKeyB64 });
			expect((await founderDb.get('select Key from Strand.Member where Key = ?', [member.publicKeyB64]))?.Key)
				.toBe(member.publicKeyB64);

			// ── 2. M registers TWO devices ───────────────────────────────────────
			// The first is the joiner node's REAL strand peer id (a member binding its
			// actual network node); the second is synthetic, so removing one can be shown
			// to leave the sibling intact.
			const joinerPeerId = joinerStrand.libp2pNode!.peerId.toString();
			const secondPeerId = 'peer-removal-second';
			await registerMemberPeer(founderDb, { memberKeyPair: member, peerId: joinerPeerId });
			await registerMemberPeer(founderDb, { memberKeyPair: member, peerId: secondPeerId });
			// Captured now, while both rows are live: the tombstone assertions below need
			// the exact stamps the removals retire.
			const joinerPeerStamp = await memberPeerStamp(founderDb, member.publicKeyB64, joinerPeerId);
			const secondPeerStamp = await memberPeerStamp(founderDb, member.publicKeyB64, secondPeerId);
			expect(joinerPeerStamp).not.toBe(secondPeerStamp);

			// ── 3. Enumeration over the network ──────────────────────────────────
			// First networked execution of the leading-key scan as a PUBLIC enumeration.
			expect((await listMemberPeers(founderDb, member.publicKeyB64)).sort())
				.toEqual([joinerPeerId, secondPeerId].sort());

			// GATE: M's two device rows become visible on the joiner. Throws on timeout;
			// there is no skip path (see the header — replication is gated everywhere).
			await waitUntil(
				async () => (await listMemberPeers(joinerDb, member.publicKeyB64)).length === 2,
				{ ...GATE, description: "M's two MemberPeer rows replicate to the joiner" },
			);

			/**
			 * The joiner must also see each removal — this `waitUntil` throws. Catches the
			 * failure that matters: a delete that lands on the founder and never propagates.
			 *
			 * NOTE: this proves the removal is VISIBLE from the second node's database, not
			 * that the block replicated to it — see the visibility caveat in the header.
			 */
			const requireJoinerAgrees = async (expected: string[], what: string): Promise<void> => {
				await waitUntil(
					async () => {
						const seen = (await listMemberPeers(joinerDb, member.publicKeyB64)).sort();
						return JSON.stringify(seen) === JSON.stringify([...expected].sort());
					},
					{ ...GATE, description: `joiner agrees: ${what}` },
				);
			};

			// ── 4. Self removal: M clears its OWN second device ──────────────────
			await removeMemberPeer(founderDb, { memberKeyPair: member, peerId: secondPeerId });
			expect(await listMemberPeers(founderDb, member.publicKeyB64)).toEqual([joinerPeerId]);
			// RevocationRecorded was satisfied by a NETWORKED write, not a bootstrap one.
			expect(await revocationExists(founderDb, 'MemberPeer', secondPeerStamp)).toBe(true);
			await requireJoinerAgrees([joinerPeerId], 'the self-removed device record is gone');

			// ── 5. Revoke M — its device records SURVIVE as orphans ──────────────
			// The founder stays (MinOneMember) and M holds no Manager row (NotAManager),
			// so the revocation is accepted. Nothing cascades into MemberPeer.
			await revokeMember(founderDb, { managerKeyPair: founderKeyPair, memberKey: member.publicKeyB64 });
			expect(await memberKeys(founderDb)).not.toContain(member.publicKeyB64);
			expect(await listMemberPeers(founderDb, member.publicKeyB64)).toEqual([joinerPeerId]);

			// ── 6. Manager cleanup — the loop this feature exists for ────────────
			// The departed member would never sign the self branch, so the manager branch
			// is the only way the orphan can ever be cleared.
			for (const peerId of await listMemberPeers(founderDb, member.publicKeyB64)) {
				await removeMemberPeer(founderDb, { managerKeyPair: founderKeyPair, memberKey: member.publicKeyB64, peerId });
			}
			expect(await listMemberPeers(founderDb, member.publicKeyB64)).toEqual([]);
			expect(await revocationExists(founderDb, 'MemberPeer', joinerPeerStamp)).toBe(true);
			await requireJoinerAgrees([], "the revoked member's leftover device record is gone");

			// ── 7. Restart-safe re-clear ─────────────────────────────────────────
			// A cleanup loop interrupted halfway and re-run must not throw. This is the
			// absence probe answering "absent" for a row that is genuinely gone, over the
			// network — the exact read shape that misbehaved before
			// `member-peer-exists-composite-seek-robustness`.
			await expect(
				removeMemberPeer(founderDb, { managerKeyPair: founderKeyPair, memberKey: member.publicKeyB64, peerId: joinerPeerId }),
			).resolves.toBeUndefined();
			expect(await listMemberPeers(founderDb, member.publicKeyB64)).toEqual([]);

			// ── 8. Loud-failure backstop (LAST — it is a rejected write) ─────────
			// The ticket's third expectation is that a missed delete reports a clear
			// failure rather than quietly claiming success. The miss itself cannot be
			// provoked on demand (it is nondeterministic and there is no fault-injection
			// seam), but the mechanism that CONVERTS a missed delete into a loud failure
			// is `Revocation.RowIsGone`: the tombstone filed in the same transaction
			// refuses to retire a stamp whose row is still visible, so a zero-row delete
			// fails at commit instead of returning success. Pinning that constraint on a
			// networked strand pins the failure behaviour. RowIsGone does not itself
			// depend on the unreliable read — its subquery filters on `P.StampId`, not a
			// key column of MemberPeer, so it is served by a scan.
			const founderPeerId = 'peer-founder-own';
			await registerMemberPeer(founderDb, { memberKeyPair: founderKeyPair, peerId: founderPeerId });
			const founderPeerStamp = await memberPeerStamp(founderDb, founderKeyPair.publicKeyB64, founderPeerId);
			expect(await listMemberPeers(founderDb, founderKeyPair.publicKeyB64)).toEqual([founderPeerId]);

			// A bare tombstone naming that LIVE row's stamp, correctly signed by a
			// committed member (so Revocation.Authorized passes and RowIsGone is the one
			// rejector). Built inline, mirroring the writer's insertRevocation.
			const retireSignature = signStrandApproval(
				['Strand.Revocation', 'retire', 'MemberPeer', founderPeerStamp],
				founderKeyPair.privateKeyB64,
			);
			await expect(
				founderDb.exec(
					`insert into Strand.Revocation (TableName, StampId)
					   with context MemberKey = ?, Signature = ?
					   values (?, ?)`,
					[founderKeyPair.publicKeyB64, retireSignature, 'MemberPeer', founderPeerStamp],
				),
			).rejects.toThrow(/RowIsGone/);
		} finally {
			await stopBoth(founderNode, joinerNode);
		}
	}, 60_000);

	// ── The join, authored on the SECOND node's own database ──────────────────
	//
	// The other two tests are founder-authoritative (see the header): they buy
	// accept/reject breadth against the bootstrap-seated rows. This one buys the
	// opposite property — that the second node is a genuine participant, not a
	// spectator. The founder only ISSUES the invites; every membership and sApp write
	// below is authored against `joinerDb`.
	//
	// Be precise about which deferred constraints this exercises ACROSS the network.
	// `ConsumedInvite`'s `InviteExists` / `ValidUsage` / `NotExpired` each read the
	// founder-authored `Strand.Invite` row, which the joiner has only over the wire —
	// those are the cross-node reads. The join's other checks are local or negative by
	// construction, and this test does NOT prove them networked: `Member.Authorized`'s
	// invite branch wants a same-transaction `ConsumedInvite` plus that InviteKey's
	// ABSENCE from `committed.ConsumedInvite`, `ConsumedInvite.NotCancelled` scans an
	// empty `CancelledInvite`, and `MemberPeer.MemberExists` reads the `Member` row
	// step 2 just authored on this very database.
	//
	// Step order is load-bearing: every accepted write comes first and the single
	// rejected write is LAST, per this file's rejection floor.
	it('a joining node runs the join against its OWN database and both nodes converge', async () => {
		const { founderNode, joinerNode, joinerStrand, founderDb, joinerDb, founderKeyPair } =
			await bringUpClosedStrand('joiner-db');

		try {
			// ── 1. The founder issues an invite; the secret travels out of band ──
			// Handing `invitePrivateKey` straight to the joiner side models the real
			// flow, where the manager delivers the invite secret to the invitee through
			// some channel outside the strand.
			const { inviteKey, invitePrivateKey } = await issueInvite(founderDb, { managerKeyPair: founderKeyPair });

			// The invite row must be VISIBLE to the joiner before it consumes it. Skipping
			// this wait and leaning on the constraint's own read would fail
			// `ConsumedInvite.ValidUsage` at commit and read like an authorization bug.
			await waitUntil(
				async () => (await joinerDb.get('select Key from Strand.Invite where Key = ?', [inviteKey]))?.Key === inviteKey,
				{ ...GATE, description: 'the invite row becomes visible to the joiner' },
			);

			// ── 2. The JOINER consumes it, against its OWN database ──────────────
			const joinerMember = freshKeyPair();
			await consumeInvite(joinerDb, {
				inviteKey,
				invitePrivateKey,
				memberKey: joinerMember.publicKeyB64,
			});

			// Local and immediate — the writer's transaction committed, so no wait.
			expect((await joinerDb.get('select Key from Strand.Member where Key = ?', [joinerMember.publicKeyB64]))?.Key)
				.toBe(joinerMember.publicKeyB64);
			expect((await joinerDb.get('select MemberKey from Strand.ConsumedInvite where InviteKey = ?', [inviteKey]))?.MemberKey)
				.toBe(joinerMember.publicKeyB64);

			// ── 3. THE HEADLINE: the joiner-authored membership reaches the founder ──
			await waitUntil(
				async () =>
					(await founderDb.get('select Key from Strand.Member where Key = ?', [joinerMember.publicKeyB64]))?.Key
						=== joinerMember.publicKeyB64 &&
					(await founderDb.get('select MemberKey from Strand.ConsumedInvite where InviteKey = ?', [inviteKey]))?.MemberKey
						=== joinerMember.publicKeyB64,
				{ ...GATE, description: 'the joiner-authored Member + ConsumedInvite reach the founder' },
			);

			// ── 4. The new member binds its REAL node, from its own database ─────
			const joinerPeerId = joinerStrand.libp2pNode!.peerId.toString();
			await registerMemberPeer(joinerDb, { memberKeyPair: joinerMember, peerId: joinerPeerId });
			await waitUntil(
				async () => (await listMemberPeers(founderDb, joinerMember.publicKeyB64)).includes(joinerPeerId),
				{ ...GATE, description: "the joiner's device record reaches the founder" },
			);

			// ── 5. A signed sApp write, authored on the joiner ───────────────────
			// Layer-3 convergence, not a second membership check: the fixture's
			// AuthorizedWrite is pure signature RBAC over `Id|Name|Value` and never reads
			// Strand.Member. What this proves is that an App write authored by the
			// newly-admitted key on the joiner's DB is seen by the founder.
			const itemId = 'item-joiner-authored';
			const itemValue = 'written on the joiner db';
			const writeSig = signItem(joinerMember.privateKeyB64, itemId, 'hello', itemValue);
			await joinerDb.exec(
				`insert into App.Items (Id, Name, Value, CreatedBy)
				   with context MemberKey = ?, Signature = ?
				   values (?, ?, ?, ?)`,
				[joinerMember.publicKeyB64, writeSig, itemId, 'hello', itemValue, joinerMember.publicKeyB64],
			);
			await waitUntil(
				async () => {
					const row = await founderDb.get('select Name, Value, CreatedBy from App.Items where Id = ?', [itemId]);
					return row?.Name === 'hello' && row?.Value === itemValue && row?.CreatedBy === joinerMember.publicKeyB64;
				},
				{ ...GATE, description: 'the joiner-authored App.Items row reaches the founder' },
			);

			// ── 6. LAST — a rejected join on the joiner's own database ───────────
			// The deferred constraints must reject on the joiner too, not only on the
			// founder: consuming a second founder-issued invite with the WRONG private key
			// fails the invite-key possession proof at commit.
			const { inviteKey: inviteKey2 } = await issueInvite(founderDb, { managerKeyPair: founderKeyPair });
			await waitUntil(
				async () => (await joinerDb.get('select Key from Strand.Invite where Key = ?', [inviteKey2]))?.Key === inviteKey2,
				{ ...GATE, description: 'the second invite row becomes visible to the joiner' },
			);
			await expect(
				consumeInvite(joinerDb, {
					inviteKey: inviteKey2,
					invitePrivateKey: freshKeyPair().privateKeyB64,
					memberKey: freshKeyPair().publicKeyB64,
				}),
			).rejects.toThrow();
		} finally {
			await stopBoth(founderNode, joinerNode);
		}
	}, 60_000);

	// ── PHYSICAL replication, read out of the joiner's own block store ────────
	//
	// The three tests above assert VISIBILITY (see the header): a row shows up in the
	// other node's `select`. That is the property an application observes, but it does
	// NOT establish that the block lives on the other node — a read resolves one
	// coordinator peer per block, and a coordinator that happens to be the AUTHOR answers
	// from its own storage. This test closes that gap by looking directly inside the
	// joiner's strand-scoped raw block store.
	//
	// ⚠ THE JOINER'S DATABASE IS OFF LIMITS IN THIS TEST — `joinerDb` is deliberately
	// not destructured below, and no read of any kind may be issued against it. A read
	// through the joiner can PUT the block there itself: `CoordinatorRepo.get` falls
	// through to `restoreCorroborated` → `acquireBlockFromCohort` → `saveReplicatedBlock`,
	// which persists the acquired block into the joiner's local storage. Probing after
	// such a read would prove only "the bytes are here now", satisfying the probe for
	// exactly the wrong reason. Every write below runs on `founderDb`; the joiner is
	// observed only through its raw store, which no probe read can mutate. Adding a
	// `joinerDb` read here silently converts this proof into a restatement of the
	// visibility tests.
	it("replicates the founder's blocks PHYSICALLY into the joiner's own block store", async () => {
		const {
			founderNode, joinerNode, founderDb, founderKeyPair,
			strandId, founderStore, joinerStore, founderCapture, joinerCapture,
		} = await bringUpClosedStrand('physical');

		try {
			// ── Anti-vacuity floor A: the two stores are genuinely different objects ──
			// A shared capture (or a provider returning a singleton) would compare a store
			// with itself and pass unconditionally.
			expect(founderStore).not.toBe(joinerStore);

			// ── Anti-vacuity floor B: the provider really was asked per scope ─────
			// If cadre-core ever stops calling the provider with the strand id, `forStrand`
			// in the bring-up already throws — this pins the control scope too, so a
			// collapse of the two scopes into one store cannot slip through unnamed.
			for (const [who, capture] of [['founder', founderCapture], ['joiner', joinerCapture]] as const) {
				expect(capture.scopes(), `${who} provider scopes`).toContain('control');
				expect(capture.scopes(), `${who} provider scopes`).toContain(strandId);
			}

			// ── Founder-only writes: membership blocks AND an application block ───
			const newMember = freshKeyPair();
			const { inviteKey, invitePrivateKey } = await issueInvite(founderDb, { managerKeyPair: founderKeyPair });
			await consumeInvite(founderDb, { inviteKey, invitePrivateKey, memberKey: newMember.publicKeyB64 });

			const itemId = 'item-physical-replication';
			const itemValue = 'authored only on the founder';
			const writeSig = signItem(newMember.privateKeyB64, itemId, 'hello', itemValue);
			await founderDb.exec(
				`insert into App.Items (Id, Name, Value, CreatedBy)
				   with context MemberKey = ?, Signature = ?
				   values (?, ?, ?, ?)`,
				[newMember.publicKeyB64, writeSig, itemId, 'hello', itemValue, newMember.publicKeyB64],
			);

			// ── Anti-vacuity floor C: the founder actually holds blocks ───────────
			// An empty source index makes coverage trivially satisfied, so this is asserted
			// separately from — and before — the coverage gate. The floor is deliberately
			// far below the observed count (see the log line below) so it pins "not empty,
			// and not one stray block" without pinning the storage layout.
			const founderIndex = await readBlockIndex(founderStore);
			expect(founderIndex.size).toBeGreaterThanOrEqual(2);

			// ── THE PROOF: poll the joiner's RAW STORE until it covers the founder ──
			// One-directional coverage, at a revision no older than the founder's, with
			// content bytes actually present — never set equality (the joiner may hold
			// blocks of its own) and never revision equality (it may be ahead).
			// Source and target are read INSIDE each iteration, so a founder that gains a
			// block mid-poll is compared against a joiner snapshot from the same moment.
			const startedAt = Date.now();
			try {
				await waitUntil(
					async () => blockCoverageIsComplete(await compareBlockCoverage(founderStore, joinerStore)),
					{ ...GATE, description: "the founder's blocks land physically in the joiner's block store" },
				);
			} catch (timeout) {
				// `waitUntil` swallows a throwing condition (header note), so a probe that
				// ERRORED every attempt would otherwise report a bare timeout. Re-running the
				// comparison outside the wait either rethrows that real error or names the
				// exact block ids the joiner never got.
				const finalGap = await compareBlockCoverage(founderStore, joinerStore);
				throw new Error(
					`joiner's block store never covered the founder's within ${GATE.timeoutMs}ms — ` +
					formatBlockCoverageGap(finalGap),
					{ cause: timeout },
				);
			}
			console.log(
				`[closed-strand:physical] founder holds ${founderIndex.size} committed blocks; ` +
				`joiner's own store covered them in ${Date.now() - startedAt}ms ` +
				`(joiner store holds ${(await readBlockIndex(joinerStore)).size})`,
			);
		} finally {
			await stopBoth(founderNode, joinerNode);
		}
	}, 60_000);
});
