/**
 * Closed-strand membership lifecycle E2E (real two-node strand).
 *
 * Capstone integration coverage for the `Strand.*` membership tables landed by the
 * `strand-membership-*` tickets (founder bootstrap → invite/join → member-peer →
 * manager rotation, member-peer REMOVAL, both a join and MANAGER ACTIONS driven
 * from the SECOND node's own database, and SEALING — the end of the lifecycle, where
 * the sole manager freezes admission forever). Drives the full CLOSED-strand path
 * across two REAL `CadreNode`s over libp2p, modelled on the proven two-node pattern
 * in `rbac-signed-write.integration.ts` (real nodes, `formStrand` over libp2p,
 * `addStrand` on each side, a manual strand-level dial) and the Phase-2 lifecycle
 * tests in `strand-formation-e2e.integration.ts`.
 *
 * EIGHT independent tests, each with its OWN two-node strand via
 * {@link bringUpClosedStrand}: the admission/rotation lifecycle, device-record
 * (`MemberPeer`) removal, a JOINER-AUTHORED join, PHYSICAL block replication,
 * MANAGER-AUTHORIZED writers run from the second node, OFFLINE DURABILITY — the
 * founder STOPPED, the joiner answering out of its own copy — and finally two SEAL
 * tests, which are the only ones whose claim is about a write the second node must
 * REFUSE rather than one it must accept: that the founder's seal converges and binds
 * the joiner's own schema, and that a sealed strand cannot be re-founded from the node
 * that did not seal it. They are deliberately NOT one narrative — the removal test
 * asserts enumerations, the physical-replication test may not read the joiner's database
 * at all, the durability test may not read it until the founder is down, and six of the
 * eight end with rejected writes whose post-state this file does not assert (see the
 * rejection floor below).
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
 * `cadre-core/test/strand-membership-peer-registration.spec.ts` on the local transactor and
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
 * The FIFTH test is joiner-authored too, but for the MANAGER writers rather than the
 * join. The founder promotes a second-node member to manager, and from there
 * `issueInvite`, `addMemberByManager`, `addManager`, `revokeMember` and the manager arm
 * of `removeMemberPeer` all run against `joinerDb`. Between them they cover both
 * flavours of manager-list read the schema uses — the LIVE `Manager` table
 * (`Invite.InviteValid`, `Manager.Authorized`'s promotion branch) and the PRE-transaction
 * snapshot `committed.Manager` (`Member.Authorized`'s direct-admit and manager-remove
 * branches, `MemberPeer.Authorized`'s manager branch) — each of which must resolve that
 * founder-authored `Manager` row over the network. Its own comment states what is local
 * by construction rather than cross-node.
 *
 * Replication of `Strand.*` is GATED EVERYWHERE in this file — the bootstrap-rows
 * gate in {@link bringUpClosedStrand}, the removal test's cross-node checks, and
 * every convergence check in the third, fifth, seventh and eighth tests all throw on
 * timeout, all on the shared {@link GATE} budget. The old best-effort/observe-then-require
 * paths are gone. A timeout here is a real convergence defect; do NOT restore a skip branch.
 *
 * NOTE: `waitUntil` swallows a throwing condition and retries, so a gate whose read
 * ERRORS on every attempt still reports a plain timeout, indistinguishable from rows
 * that simply never arrived. If one of these ever times out, check the harness debug
 * log (`Wait condition threw: …`) before concluding it is a convergence failure.
 *
 * VISIBILITY IS NOT PHYSICAL REPLICATION. Every cross-node assertion in the six
 * CONVERGENCE tests (the first, second, third, fifth and both SEAL tests) proves a row is
 * VISIBLE from the other node's database, not that its block lives there. A read on either
 * node resolves one coordinator peer per block; when that resolves to the authoring node,
 * the other node's `select` is a remote call against the author's storage and nothing needs
 * to live locally. Visibility is the property an application actually observes, and it is
 * what those six assert — including the seal tests, whose claim is that the joiner's schema
 * REFUSES admission once the seal is visible to it, not that the seal's blocks live in
 * the joiner's store.
 * Physical replication is proven separately by the FOURTH test, which writes only on
 * the founder and then reads the joiner's raw block store directly, never its database.
 * It gates both halves: post-dial blocks arriving as part of each commit, and pre-dial
 * blocks arriving via the peer-join catch-up (cadre-core's `peer-join-backfill.ts`) — see
 * its WHAT IS AND IS NOT CLAIMED comment.
 * PHYSICAL PRESENCE IS NOT USABILITY, and the SIXTH test closes that last step: it waits
 * for whole-store coverage through the raw store alone, STOPS the founder, proves the
 * joiner holds zero strand connections, and only then reads `joinerDb`. With nobody left
 * to answer remotely, those reads are the first in this file that the joiner must serve
 * out of its own storage.
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
	addMemberByManager,
	registerMemberPeer,
	listMemberPeers,
	removeMemberPeer,
	revokeMember,
	addManager,
	admitManager,
	sealStrand,
	isStrandSealed,
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
	newOrAdvancedSince,
	type RawStorageCapture,
	type BlockCoverageOptions,
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
			...(opts.enableRelay !== undefined ? { enableRelay: opts.enableRelay } : {}),
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

/** The `Strand.*` tables this file reads by name. */
type StrandTable = 'Header' | 'Member' | 'Manager' | 'Invite' | 'ConsumedInvite' | 'MemberPeer';

/** Count rows in a `Strand.*` table as seen by a strand DB. */
async function strandCount(db: Database, table: StrandTable): Promise<number> {
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

/**
 * Every value of one column of a `Strand.*` table, via an UNFILTERED scan.
 *
 * SCANNED, never sought — the single primitive behind {@link memberKeys},
 * {@link inviteKeys} and {@link managerKeys}. Each of those tables has a single-column
 * primary key, so ANY where-equality on it is a FULL-PK predicate, which the optimystic
 * module serves as a point lookup that can MISS on a networked strand (see the
 * lookup-shape note in the file header). Inside a `waitUntil` that miss is
 * indistinguishable from a plain timeout — exactly the wrong way for a convergence gate
 * to fail. Filtering in JavaScript instead depends only on the scan returning a SUPERSET
 * of the live rows, the weakest possible assumption about the storage layer.
 */
async function scanColumn(db: Database, table: StrandTable, column: string): Promise<string[]> {
	const values: string[] = [];
	for await (const row of db.eval(`select ${column} from Strand.${table}`)) {
		values.push(row[column] as string);
	}
	return values;
}

/** Every `Strand.Member.Key` currently visible. */
async function memberKeys(db: Database): Promise<string[]> {
	return scanColumn(db, 'Member', 'Key');
}

/** Every `Strand.Invite.Key` currently visible. */
async function inviteKeys(db: Database): Promise<string[]> {
	return scanColumn(db, 'Invite', 'Key');
}

/** Every `Strand.Manager.MemberKey` currently visible. */
async function managerKeys(db: Database): Promise<string[]> {
	return scanColumn(db, 'Manager', 'MemberKey');
}

/** One manager's visible row, or `undefined` if that key holds none. */
interface VisibleManager { generation: number; stampId: string }

/**
 * One manager's `Strand.Manager` row, via ONE scan reading every column the callers
 * below need together — never a scan per column matched by position, which the storage
 * layer never promises to keep aligned.
 */
async function managerRow(db: Database, memberKey: string): Promise<VisibleManager | undefined> {
	for await (const row of db.eval('select MemberKey, Generation, StampId from Strand.Manager')) {
		if (row.MemberKey === memberKey) {
			return { generation: Number(row.Generation), stampId: row.StampId as string };
		}
	}
	return undefined;
}

/** The `Strand.Manager.Generation` of one manager, or `undefined` if it holds no visible row. */
async function managerGeneration(db: Database, memberKey: string): Promise<number | undefined> {
	return (await managerRow(db, memberKey))?.generation;
}

/**
 * The live `Strand.Manager.StampId` of one manager.
 *
 * Throws rather than returning `undefined`: its only caller captures the stamp a seal is
 * about to retire, and a missing stamp there would silently turn the tombstone assertion
 * into "some `Manager` tombstone exists" — exactly the weakening that assertion exists
 * to prevent.
 */
async function managerStamp(db: Database, memberKey: string): Promise<string> {
	const row = await managerRow(db, memberKey);
	if (row === undefined) throw new Error(`no Strand.Manager row for ${memberKey}`);
	return row.stampId;
}

// ── Raw block-store coverage gate ────────────────────────────────────────────

/**
 * Poll `target`'s raw store until it covers `source`'s, on the shared {@link GATE} budget.
 *
 * `waitUntil` swallows a throwing condition (header note), so a probe that ERRORED on every
 * attempt would otherwise report a bare timeout. On expiry the comparison is re-run OUTSIDE
 * the wait: that either rethrows the real per-attempt error or names the exact block ids the
 * target never got.
 *
 * ⚠ Both stores are read directly — never through either node's database, per the confound
 * `block-store-probe.ts` documents.
 *
 * NOTE: every 250 ms poll re-indexes BOTH stores and does one content-bytes lookup per
 * source block, so the gate costs O(blocks) per attempt. Free at the 20-29 blocks these
 * tests hold; if a scenario ever gates on a store with thousands of blocks, compare
 * incrementally against the previous attempt's index instead of re-reading both in full.
 *
 * @param description - What the poll is waiting for, for the timeout message.
 * @param failure - What a timeout MEANS, phrased so a reader cannot mistake a catch-up
 *   failure for the property the calling test is actually about.
 */
async function awaitBlockCoverage(
	source: IRawStorage,
	target: IRawStorage,
	description: string,
	failure: string,
	options: BlockCoverageOptions = {},
): Promise<void> {
	try {
		await waitUntil(
			async () => blockCoverageIsComplete(await compareBlockCoverage(source, target, options)),
			{ ...GATE, description },
		);
	} catch (timeout) {
		const finalGap = await compareBlockCoverage(source, target, options);
		throw new Error(
			`${failure} within ${GATE.timeoutMs}ms — ${formatBlockCoverageGap(finalGap)}`,
			{ cause: timeout },
		);
	}
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

		// Both nodes run the network transactor (every strand does), so the manual
		// strand dial below actually replicates rows across the two raw stores.
		const founderStrand = await founderNode.addStrand({ strandRow, sAppConfig, founder: true });
		const joinerStrand = await joinerNode.addStrand({ strandRow, sAppConfig, founder: false });
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
			 * that the block replicated to it — see the visibility caveat in the header. The
			 * physical property is proven by this file's fourth test, which polls the joiner's
			 * raw block store instead of its database.
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
	// ── WHAT IS AND IS NOT CLAIMED (measured, not assumed) ────────────────────
	// TWO physical claims, gated separately because different mechanisms carry them:
	//
	//   1. ONGOING replication (first gate, narrowed by `authoredSinceDial`): every
	//      block the founder authors or advances AFTER the two strand nodes are dialled
	//      together lands in the joiner's own store as part of the commit. Measured:
	//      complete on the FIRST poll every run — ~1 ms after the last write returns —
	//      so this gate has never been exercised as a wait. A regression that made
	//      commit replication merely slow rather than absent would still pass it; if
	//      that path ever grows an asynchronous leg, add a latency bound (assert the
	//      elapsed ms) to keep the gate saying anything about it.
	//
	//   2. PEER-JOIN CATCH-UP (second gate, NO narrowing — `founder ⊆ joiner`): the
	//      blocks committed BEFORE the dial reach the joiner too, pushed by cadre-core's
	//      `peer-join-backfill.ts` one debounce (~1 s) after the strand connection opens.
	//      Before that module existed, a measured run showed 9 of the founder's 27
	//      blocks never reached the joiner — the bootstrap Header/Member/Manager data
	//      blocks, their `default/*/index/_uniq_*` index blocks, and the founder's
	//      collection ROOT blocks, all committed to a cohort of one before the dial.
	//      The catch-up closes exactly that gap. Collection roots are covered as well:
	//      each node mints its own random root id, so the joiner's locally-minted root
	//      differs from the founder's — but the push copies the founder's root under
	//      the FOUNDER's id, which is the block the founder's collections are actually
	//      traversed through. Measured with the catch-up live (2026-08-03, 5 green runs):
	//      the founder holds 29 committed blocks after the writes below and the joiner's
	//      own store covered all 29 — but unlike the first gate this one DOES wait, ~510
	//      to 530 ms, being the tail of the ~1 s debounce that the writes did not use up.
	//      Do not tighten this gate toward first-poll coverage; waiting is correct here.
	//
	// If a residue ever reappears here, narrow the second gate only with an EXPLICIT,
	// measured exclusion naming exactly which ids and why — never a blanket narrowing
	// back to post-dial blocks; that would silently un-prove the catch-up.
	//
	// ⚠ THE JOINER'S DATABASE IS OFF LIMITS FROM HERE ON — `joinerDb` is deliberately not
	// destructured below, and no read of any kind may be issued against it. A read through
	// the joiner can PUT the block there itself: `CoordinatorRepo.get` falls through to
	// `restoreCorroborated` → `acquireBlockFromCohort` → `saveReplicatedBlock`, which
	// persists the acquired block into the joiner's local storage. Probing after such a
	// read would prove only "the bytes are here now", satisfying the probe for exactly the
	// wrong reason. Every write below runs on `founderDb`; the joiner is observed only
	// through its raw store, which no probe read can mutate. Adding a `joinerDb` read here
	// silently converts this proof into a restatement of the visibility tests.
	//
	// "From here on", precisely: `bringUpClosedStrand` DOES read `joinerDb` — its
	// bootstrap-row gate counts Strand.Header/Member/Manager there. Every one of those
	// reads precedes the founder-only writes below, so none of them can have pre-placed a
	// block this test then credits to replication. (Pre-dial blocks DO now land on the
	// joiner — that is the peer-join catch-up the second gate proves — but they arrive by
	// the founder PUSHING them on connection:open, not by anything a joiner read pulls in;
	// the read-side confound remains a sound caution, not an observed behaviour.) The rule
	// that is load-bearing is ordering: no `joinerDb` read at or after the writes.
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

			// ── The baseline: what the founder already held when the dial completed ──
			// See WHAT IS AND IS NOT CLAIMED above. Measured here: 18 blocks.
			const baseline = await readBlockIndex(founderStore);
			expect(baseline.size).toBeGreaterThanOrEqual(2);
			const authoredSinceDial = newOrAdvancedSince(baseline);

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

			// ── Anti-vacuity floor C: the writes above really produced blocks ─────
			// An empty compared-set makes coverage trivially satisfied, so the size of the
			// post-dial set is asserted separately from — and before — the coverage gate.
			// Observed 2026-08-03: 29 founder blocks total, of which 15 are new-or-advanced
			// since the baseline (Invite/ConsumedInvite/Items and their index and data blocks,
			// plus pre-existing blocks pushed to a higher revision). The floor sits at 6, so
			// it pins "more than one table's worth of work" without pinning the storage layout.
			const founderIndex = await readBlockIndex(founderStore);
			const authored = new Map([...founderIndex].filter(([id, rev]) => authoredSinceDial(id, rev)));
			expect(authored.size).toBeGreaterThanOrEqual(6);

			// ── THE PROOF: poll the joiner's RAW STORE until it covers those blocks ──
			// One-directional coverage, at a revision no older than the founder's, with
			// content bytes actually present — never set equality (the joiner holds blocks of
			// its own, including node-local roots the founder will never have) and never
			// revision equality (it may be ahead).
			// Source and target are read INSIDE each iteration, so a founder that gains a
			// block mid-poll is compared against a joiner snapshot from the same moment — and
			// `authoredSinceDial` re-evaluates against that fresh read, so a block first
			// written mid-poll is included rather than skipped.
			const startedAt = Date.now();
			await awaitBlockCoverage(
				founderStore, joinerStore,
				"the founder's post-dial blocks land physically in the joiner's block store",
				"joiner's block store never covered the founder's post-dial blocks",
				{ include: authoredSinceDial },
			);
			console.log(
				`[closed-strand:physical] founder holds ${founderIndex.size} committed blocks, ` +
				`${authored.size} of them authored or advanced since the dial; joiner's own store ` +
				`covered those in ${Date.now() - startedAt}ms (joiner store holds ${(await readBlockIndex(joinerStore)).size})`,
			);

			// ── THE CATCH-UP PROOF: the founder's WHOLE store, pre-dial blocks included ──
			// No `include` narrowing — founder ⊆ joiner, at revisions no older than the
			// founder's, with content bytes present. This is the gap the first gate cannot
			// see and the very thing cadre-core's peer-join-backfill.ts exists for: the
			// bootstrap blocks committed before the dial must be physically on the joiner.
			// Still a raw-store poll — the ⚠ joinerDb rule above holds here too.
			const wholeStoreStartedAt = Date.now();
			await awaitBlockCoverage(
				founderStore, joinerStore,
				"the founder's WHOLE store (pre-dial blocks included) lands physically in the joiner's block store",
				"joiner's block store never covered the founder's WHOLE store " +
				'(peer-join catch-up failed — see cadre-core/src/peer-join-backfill.ts)',
			);
			console.log(
				`[closed-strand:physical] whole-store coverage (peer-join catch-up) complete ` +
				`${Date.now() - wholeStoreStartedAt}ms after the gate started: founder holds ` +
				`${(await readBlockIndex(founderStore)).size} committed blocks, joiner holds ` +
				`${(await readBlockIndex(joinerStore)).size}`,
			);
		} finally {
			await stopBoth(founderNode, joinerNode);
		}
	}, 60_000);

	// ── MANAGER actions, authored on the SECOND node's own database ───────────
	//
	// The third test proves the second node can JOIN from its own database. This one
	// proves it can ADMINISTER from there: a member seated on the second node is
	// promoted to manager by the founder, and from that point every manager writer runs
	// against `joinerDb`.
	//
	// WHAT IS GENUINELY CROSS-NODE HERE. Each manager rule below resolves M's `Manager`
	// row — authored on the FOUNDER — from the second node's database, in one of the
	// schema's two flavours:
	//   • LIVE `Manager`:      `Invite.InviteValid` (step 5),
	//                          `Manager.Authorized`'s promotion branch (step 7).
	//   • `committed.Manager`: `Member.Authorized`'s direct-admit branch (step 6) and
	//                          manager-remove branch (step 9),
	//                          `MemberPeer.Authorized`'s manager branch (step 10).
	// Those are DIFFERENT reads — a plain `select`, versus a PRE-transaction snapshot
	// taken inside a later transaction on that same database. This test asserts they
	// AGREE. If they do not, that is the finding, not something to work around.
	//
	// WHAT IS LOCAL BY CONSTRUCTION — do not over-credit the test. M's own `Member` row
	// is authored on `joinerDb` (step 1), so `Revocation.Authorized`'s `committed.Member`
	// check on the tombstone filer in steps 9/10 is a local read. `Manager.MemberExists`
	// in step 7 and `MemberPeer.MemberExists` in step 8 read rows steps 6/8 just wrote on
	// this very database. And the invite M issues in step 5 is CONSUMED on the founder, so
	// its consumption-side checks are founder-local — the cross-node claim there is that a
	// joiner-authored invite is USABLE, not merely visible.
	//
	// Step order is load-bearing. Presence gates come BEFORE the mutations whose absence
	// they later gate: without step 6's gate, "the founder no longer sees Y" would pass
	// instantly against a founder that never received Y at all. And `revokeMember` /
	// `removeMemberPeer` are quiet no-ops on rows they cannot see, so each is preceded by
	// a local assertion that the target IS visible — otherwise a step that never ran would
	// report success. The single rejected write is LAST, per this file's rejection floor.
	it('a manager promoted on the second node runs manager actions from its OWN database', async () => {
		const { founderNode, joinerNode, founderDb, joinerDb, founderKeyPair } =
			await bringUpClosedStrand('manager-2nd');

		try {
			const managerM = freshKeyPair();   // seated on the joiner, promoted by the founder
			const memberZ = freshKeyPair();    // admitted on the founder off M's invite
			const managerX = freshKeyPair();   // admitted AND promoted by M
			const memberY = freshKeyPair();    // admitted, then revoked and cleaned up by M

			// ── 1. Seat M as a member, via a join authored on the second node ────
			// Already proven by the joiner-authored join test — setup here, not the claim.
			const { inviteKey: seatInvite, invitePrivateKey: seatSecret } =
				await issueInvite(founderDb, { managerKeyPair: founderKeyPair });
			await waitUntil(
				async () => (await inviteKeys(joinerDb)).includes(seatInvite),
				{ ...GATE, description: "M's seating invite becomes visible to the second node" },
			);
			await consumeInvite(joinerDb, {
				inviteKey: seatInvite,
				invitePrivateKey: seatSecret,
				memberKey: managerM.publicKeyB64,
			});

			// ── 2. M's membership reaches the founder (so step 3 is not racing it) ──
			await waitUntil(
				async () => (await memberKeys(founderDb)).includes(managerM.publicKeyB64),
				{ ...GATE, description: "M's Member row reaches the founder" },
			);

			// ── 3. The founder promotes M to manager ─────────────────────────────
			await addManager(founderDb, { byManagerKeyPair: founderKeyPair, newManagerKey: managerM.publicKeyB64 });
			expect(await managerKeys(founderDb)).toContain(managerM.publicKeyB64);

			// ── 4. THE ENABLING GATE: M's Manager row visible on the joiner ──────
			// Everything below depends on the second node resolving this row.
			await waitUntil(
				async () => (await managerKeys(joinerDb)).includes(managerM.publicKeyB64),
				{ ...GATE, description: "M's Manager row becomes visible on the second node" },
			);
			// Generation asserted separately so a step-7 failure is unambiguous: `addManager`'s
			// writer falls back to generation 1 when it cannot see the authorizer's row, and the
			// schema then rejects — which would read as "the promotion rule is wrong" rather than
			// "the joiner could not see M's manager row".
			// NOTE: this pins the WRITER's successor policy (authorizer generation + 1), not the
			// schema's, which enforces only strict ordering. If `addManager` ever seats successors
			// at some other larger value, relax this to `toBeGreaterThan(0)` — nothing is wrong in
			// that case.
			expect(await managerGeneration(joinerDb, managerM.publicKeyB64)).toBe(1);

			// ── 5. M issues an invite from the joiner — LIVE Manager read ────────
			const { inviteKey: mInvite, invitePrivateKey: mSecret } =
				await issueInvite(joinerDb, { managerKeyPair: managerM });
			await waitUntil(
				async () => (await inviteKeys(founderDb)).includes(mInvite),
				{ ...GATE, description: "M's joiner-authored invite reaches the founder" },
			);
			// USABLE, not merely present: the founder admits Z off M's invite.
			await consumeInvite(founderDb, {
				inviteKey: mInvite,
				invitePrivateKey: mSecret,
				memberKey: memberZ.publicKeyB64,
			});
			expect(await memberKeys(founderDb)).toContain(memberZ.publicKeyB64);

			// ── 6. M admits X and Y directly — committed.Manager read ────────────
			// Not insert-if-absent: each key is admitted exactly once (a repeat call would
			// collide on Member's primary key).
			await addMemberByManager(joinerDb, { managerKeyPair: managerM, memberKey: managerX.publicKeyB64 });
			await addMemberByManager(joinerDb, { managerKeyPair: managerM, memberKey: memberY.publicKeyB64 });
			await waitUntil(
				async () => {
					const seen = await memberKeys(founderDb);
					return seen.includes(managerX.publicKeyB64) && seen.includes(memberY.publicKeyB64);
				},
				{ ...GATE, description: "M's directly-admitted members reach the founder" },
			);

			// ── 7. M promotes X — LIVE Manager read, strict generation ordering ──
			await addManager(joinerDb, { byManagerKeyPair: managerM, newManagerKey: managerX.publicKeyB64 });
			expect(await managerGeneration(joinerDb, managerX.publicKeyB64)).toBe(2);
			await waitUntil(
				async () => (await managerKeys(founderDb)).includes(managerX.publicKeyB64),
				{ ...GATE, description: "X's Manager row reaches the founder" },
			);

			// ── 8. Y registers a device record on the joiner ─────────────────────
			// Self-signed (the test holds Y's private key); a synthetic peer id is correct —
			// Y is not a real node. Presence is gated on the founder so step 10's absence
			// gate cannot pass vacuously.
			const yPeerId = 'peer-manager-2nd-y';
			await registerMemberPeer(joinerDb, { memberKeyPair: memberY, peerId: yPeerId });
			await waitUntil(
				async () => (await listMemberPeers(founderDb, memberY.publicKeyB64)).includes(yPeerId),
				{ ...GATE, description: "Y's device record reaches the founder" },
			);

			// ── 9. M revokes Y — committed.Manager read ──────────────────────────
			// Y holds no Manager row (NotAManager passes); F/M/X/Z remain (MinOneMember).
			expect(await memberKeys(joinerDb)).toContain(memberY.publicKeyB64);
			await revokeMember(joinerDb, { managerKeyPair: managerM, memberKey: memberY.publicKeyB64 });
			expect(await memberKeys(joinerDb)).not.toContain(memberY.publicKeyB64);
			await waitUntil(
				async () => !(await memberKeys(founderDb)).includes(memberY.publicKeyB64),
				{ ...GATE, description: "Y's revocation reaches the founder" },
			);

			// ── 10. M clears Y's orphan device record — committed.Manager read ───
			// Device records do NOT cascade on revocation, so the manager branch is the only
			// way this orphan can ever be cleared (Y would never sign the self branch).
			expect(await listMemberPeers(joinerDb, memberY.publicKeyB64)).toEqual([yPeerId]);
			await removeMemberPeer(joinerDb, { managerKeyPair: managerM, memberKey: memberY.publicKeyB64, peerId: yPeerId });
			expect(await listMemberPeers(joinerDb, memberY.publicKeyB64)).toEqual([]);
			await waitUntil(
				async () => (await listMemberPeers(founderDb, memberY.publicKeyB64)).length === 0,
				{ ...GATE, description: "the cleared device record is gone on the founder" },
			);

			// ── 11. LAST — a non-manager is refused ON THE SECOND NODE too ───────
			// Without this the test could pass by the joiner accepting everything
			// indiscriminately. Two flavours, because they fail for DIFFERENT reasons:
			// a stranger holds neither a Member nor a Manager row, while Z is a seated
			// MEMBER holding no Manager row — the only case that distinguishes
			// `Invite.InviteValid`'s `Manager` lookup from a membership check. Z is
			// gated visible here first, otherwise "no Manager row" would be trivially
			// true for a node that had never heard of Z at all.
			// Rejection floor: `rejects.toThrow()` only, nothing follows.
			await waitUntil(
				async () => (await memberKeys(joinerDb)).includes(memberZ.publicKeyB64),
				{ ...GATE, description: "Z's founder-authored Member row is visible on the second node" },
			);
			await expect(issueInvite(joinerDb, { managerKeyPair: freshKeyPair() })).rejects.toThrow();
			await expect(issueInvite(joinerDb, { managerKeyPair: memberZ })).rejects.toThrow();
		} finally {
			await stopBoth(founderNode, joinerNode);
		}
		// Roughly twice as many convergence gates as the other tests. Bring-up still
		// dominates the wall clock — this is headroom, not an expectation of slowness.
	}, 90_000);

	// ── OFFLINE DURABILITY: the founder stops, the joiner answers alone ───────
	//
	// The fourth test proves the BYTES moved — the founder's whole store is covered by the
	// joiner's own store. That is a storage claim, and it is the reason the peer-join
	// catch-up was built, but on its own it does not show the joiner can USE what it
	// holds: every read in this file so far ran while the founder was up, and a read
	// resolves one coordinator peer per block, so any of them could have been answered
	// out of the founder's storage (see the visibility note in the header).
	//
	// This test removes that possibility by removing the founder. Sequence, and why each
	// step is in this order:
	//
	//   1. WAIT FOR CATCH-UP THROUGH THE RAW STORE ONLY. Whole-store coverage,
	//      `founder ⊆ joiner`, no `include` narrowing. It must be the raw store and not a
	//      `joinerDb` read, for the reason `block-store-probe.ts` documents: a read issued
	//      through the joiner can itself pull the block in (`CoordinatorRepo.get` →
	//      `restoreCorroborated` → `acquireBlockFromCohort` → `saveReplicatedBlock`), which
	//      would place the bytes this step is supposed to be waiting for. Failing this poll
	//      is a failure of the CATCH-UP (`cadre-core/src/peer-join-backfill.ts`), not of
	//      offline durability — the message says so, because proceeding past it would make
	//      the second half meaningless.
	//   2. STOP THE FOUNDER, then POLL until the joiner's strand node reports ZERO
	//      connections. Polled, not asserted once: the founder's transport teardown is not
	//      instantaneous, and a single leftover connection would let the reads below be
	//      answered over the wire — exactly the trap the disconnection scenario in
	//      `convergence-stress.integration.ts` fell into (see
	//      `tickets/blocked/offline-node-cannot-serve-its-own-data.md`). Self-coordination
	//      is decided per key-network, i.e. per strand libp2p node, so the joiner's control
	//      connections neither rescue nor contaminate this.
	//   3. ONLY NOW read `joinerDb`. From here it is not merely allowed, it is the whole
	//      point: nobody else is left to answer.
	//
	// The founder is never restarted. Convergence-after-reconnect is a different
	// scenario's job and adding it here would blur what a red result means.
	it("serves the strand's founding membership from the joiner alone after the founder stops", async () => {
		const { founderNode, joinerNode, joinerStrand, joinerDb, founderKeyPair, founderStore, joinerStore } =
			await bringUpClosedStrand('offline-founder');

		// The teardown must not stop a node that is already down: `founderNode.stop()` is
		// a step of the test itself, not only of the cleanup.
		let founderStopped = false;
		try {
			// ── 1. Catch-up, observed through the RAW STORE alone ────────────────
			await awaitBlockCoverage(
				founderStore, joinerStore,
				"the founder's whole store lands physically in the joiner's block store",
				"joiner's block store never covered the founder's whole store, so this run says nothing " +
				'about offline durability — this is a PEER-JOIN CATCH-UP failure ' +
				'(cadre-core/src/peer-join-backfill.ts), not an offline-read failure',
			);

			// What the joiner was holding at the moment it went solo, for a future reader.
			const founderBlocks = (await readBlockIndex(founderStore)).size;
			const joinerBlocks = (await readBlockIndex(joinerStore)).size;
			console.log(
				`[closed-strand:offline-founder] before the stop: founder holds ${founderBlocks} committed blocks, ` +
				`joiner holds ${joinerBlocks} (joiner covers all of the founder's)`,
			);

			// ── 2. The founder goes away, and the joiner is proven alone ─────────
			await founderNode.stop();
			founderStopped = true;
			await waitUntil(
				() => joinerStrand.libp2pNode!.getConnections().length === 0,
				{ ...GATE, description: "the joiner's strand node drops to zero connections" },
			);
			console.log(
				`[closed-strand:offline-founder] founder stopped; joiner strand connections = ` +
				`${joinerStrand.libp2pNode!.getConnections().length}`,
			);

			// ── 3. THE CLAIM: the joiner answers the founding membership by itself ──
			// Elapsed time of the FIRST post-stop read is logged because that read is the one
			// that has to resolve the joiner itself as coordinator. Optimystic refuses
			// self-coordination for 30 s after the last connection drops, EXCEPT for a
			// deferrable denial on a read with zero connections, which is admitted as a
			// degraded read (`libp2p-key-network.ts`, `findCoordinator:fret-self-degraded`).
			// This test sits squarely in that escape. If it is ever removed the read dies with
			// `Self-coordination blocked: grace-period-not-elapsed. No coordinator available
			// for key.` — the fingerprint tracked by
			// `tickets/blocked/offline-node-cannot-serve-its-own-data.md`, and a dependency
			// failure rather than anything this file can fix. Do NOT sleep past the guard: the
			// point of this test is that an isolated node answers NOW.
			const firstReadStartedAt = Date.now();
			const headerCount = await strandCount(joinerDb, 'Header');
			const firstReadMs = Date.now() - firstReadStartedAt;
			console.log(`[closed-strand:offline-founder] first post-stop read took ${firstReadMs}ms`);
			expect(headerCount).toBeGreaterThanOrEqual(1);
			expect(await strandCount(joinerDb, 'Member')).toBeGreaterThanOrEqual(1);
			expect(await strandCount(joinerDb, 'Manager')).toBeGreaterThanOrEqual(1);

			// The strand is still the CLOSED one it was founded as.
			expect((await joinerDb.get('select Type from Strand.Header'))?.Type).toBe('c');

			// A KEYED lookup, deliberately a shape the bring-up gate never issued. That gate
			// read only `count(1)`, so a collection-level cache could satisfy a repeat of it
			// from memory and hide a block the joiner does not actually hold. Resolving the
			// founder's key by equality forces the read down a path the earlier count did not
			// take. Presence-by-equality is allowed by this file's lookup-shape rule (a point
			// lookup that misses FAILS this assertion rather than passing it); the scan-based
			// `managerKeys` below covers the same claim from the other direction, so a
			// disagreement between the two is itself the finding.
			expect((await joinerDb.get('select Key from Strand.Member where Key = ?', [founderKeyPair.publicKeyB64]))?.Key)
				.toBe(founderKeyPair.publicKeyB64);
			expect(await memberKeys(joinerDb)).toContain(founderKeyPair.publicKeyB64);
			expect(await managerKeys(joinerDb)).toContain(founderKeyPair.publicKeyB64);

			// Still alone AFTER the reads, not merely before them. The step-2 poll proves the
			// joiner was isolated when the reads began; without this it could have been rescued
			// by a connection landing mid-test and every assertion above would still pass.
			expect(joinerStrand.libp2pNode!.getConnections(), 'joiner strand connections during the reads').toHaveLength(0);
		} finally {
			await stopBoth(founderStopped ? undefined : founderNode, joinerNode);
		}
	}, 60_000);
});

// ═════════════════════════════════════════════════════════════════════════════

/**
 * SEALING, PROVEN ON THE NODE THAT DID NOT SEAL.
 *
 * `sealStrand` is the end of a closed strand's admission lifecycle: its SOLE manager
 * deliberately deletes its own `Strand.Manager` row (plus the matching
 * `Strand.Revocation` tombstone that makes it permanent), after which every admission
 * path is dead because every one of them needs a `Manager` row. That is the privacy
 * guarantee the remaining members are buying — no key is left holding the power to
 * admit a party who would then read the strand's whole history.
 *
 * All of that has been proven SINGLE-NODE (`cadre-core/test/strand-seal.spec.ts`)
 * against the database that did the sealing. These two tests add the one thing a
 * single-node spec structurally cannot: THE OTHER MACHINE. A guarantee that binds only
 * the node which performed the act is not a guarantee at all, so what is asserted here
 * is (a) the seal CONVERGES — both halves, the delete and the tombstone — and (b) once
 * it has, the SECOND node's own schema is the thing doing the rejecting, for each
 * admission path in turn and under the specific constraint name that owns it.
 *
 * NOTE: these two tests share ~400 lines of private harness with the six above
 * (`bringUpClosedStrand`, `stopBoth`, `freshKeyPair`, `GATE`, the `scanColumn` family).
 * They live here rather than in a sibling file for exactly that reason. If a THIRD
 * scenario ever needs this harness, hoist it into `src/harness/` rather than duplicating
 * it — a hoist is a refactor across eight passing network tests and wants its own ticket.
 *
 * NOTE: the PROPAGATION WINDOW — the interval in which the sealing node has committed
 * but another node has not yet converged, during which that node's schema still admits —
 * deliberately gets NO test here, because it cannot be staged on two nodes. Both ways of
 * trying were measured, and BOTH end with the founder unable to seal at all:
 *   - with `Strand.Revocation` never yet written, `sealStrand` fails with
 *     `Block default/Revocation is unavailable (cohort-unreachable): the repo could not
 *     determine whether it exists` — sealing is a fresh strand's FIRST `Revocation`
 *     write, and a block whose existence cannot be determined cannot be written to;
 *   - with `Revocation` pre-materialised (register then remove a device record first),
 *     `sealStrand` fails with `Failed to get super-majority: 1/2 approvals (needed 2, 0
 *     rejects)` on the `Manager` block.
 * On a TWO-node strand the seal therefore FAILS CLOSED when the other node is
 * unreachable: nobody is sealed, and both nodes agree on that once the partition heals.
 * That is a property of this FIXTURE (a commit needs a super-majority of the block's
 * COHORT, and at two nodes the cohort is both of them), not a guarantee of the system —
 * above the cohort size a node outside a given block's cohort never has to approve, so
 * it can stay stale while the seal commits elsewhere, and THAT node's window is
 * unmeasured (recorded as an arm on `backlog/debt-replication-proof-above-cohort-size`).
 * Do not assert the fail-closed behaviour either: it is an optimystic quorum property
 * that may legitimately change, and pinning it here would fail as a false alarm the day
 * solo-cohort commit reaches that block.
 *
 * What IS measured, on this fixture: the joiner reported `isStrandSealed` true 42 ms and
 * 138 ms after the founder's commit in two runs, and a poll with no sleep between
 * attempts never once observed a SPLIT state — the `Manager` delete without its
 * tombstone, or the tombstone without the delete — even though the two land in different
 * blocks of one transaction.
 */
describe('Closed-strand sealing converges to the second node (real two-node strand)', () => {
	it("the founder's seal reaches the second node and binds ITS schema against every admission path", async () => {
		const { founderNode, joinerNode, founderDb, joinerDb, founderKeyPair } =
			await bringUpClosedStrand('seal-binds');

		try {
			// ── 1. A PRE-SEAL invitation, gated visible on the joiner ────────────
			// This is the one the rejection block redeems below, and it must be visible
			// there BEFORE the seal: otherwise its `consumeInvite` could fail on
			// `InviteExists` (the joiner never heard of the invitation) and the test would
			// pass for entirely the wrong reason — it is `NotSealed` that must reject it.
			const { inviteKey: preSealInvite, invitePrivateKey: preSealSecret } =
				await issueInvite(founderDb, { managerKeyPair: founderKeyPair });
			await waitUntil(
				async () => (await inviteKeys(joinerDb)).includes(preSealInvite),
				{ ...GATE, description: 'the pre-seal invitation becomes visible on the second node' },
			);

			// ── 2. Capture the stamp the seal is about to retire ─────────────────
			// Read BEFORE the seal, while the row is still live. Keying step 5's tombstone
			// assertion to this exact stamp is what stops it degrading into "some Manager
			// tombstone exists".
			const founderManagerStamp = await managerStamp(founderDb, founderKeyPair.publicKeyB64);

			// ── 3. The joiner can currently see the founder's Manager row ────────
			// Without this, step 5's "no managers" assertion could pass because the row
			// never arrived in the first place, rather than because the seal removed it.
			expect(await managerKeys(joinerDb)).toContain(founderKeyPair.publicKeyB64);

			// ── 4. The founder seals, and THE GATE: the seal reaches the joiner ──
			// `isStrandSealed` is all three conjuncts at once (closed `Header`, zero
			// `Manager` rows, a retired `Manager` stamp), so this gate cannot be satisfied
			// by either half of the seal arriving alone.
			// The clock starts the instant the seal's transaction returns, BEFORE the
			// founder-side verification below — that read is itself several networked
			// scans, and starting the clock after it would subtract them from the
			// reported propagation delay. Over-reporting is the safe direction for a
			// number the docs quote as an upper bound.
			await sealStrand(founderDb, { managerKeyPair: founderKeyPair });
			const sealCommittedAt = Date.now();
			expect(await isStrandSealed(founderDb)).toBe(true);
			await waitUntil(
				() => isStrandSealed(joinerDb),
				{ ...GATE, description: "the founder's seal becomes visible on the second node" },
			);
			console.log(
				`[closed-strand:seal-binds] joiner observed the seal ${Date.now() - sealCommittedAt}ms ` +
				'after the founder committed it',
			);

			// ── 5. The joiner's SEALED SHAPE — all of it, before any rejected write ──
			// Per this file's rejection floor, no count or enumeration assertion may
			// follow a rejected write, so everything about state is asserted here.
			// Both reads SCAN and filter in JavaScript: `Revocation`'s primary key is
			// (TableName, StampId), so an equality on both would be exactly the full-PK
			// point lookup the header's lookup-shape rule forbids.
			expect(await managerKeys(joinerDb)).toEqual([]);
			expect(await revocationExists(joinerDb, 'Manager', founderManagerStamp)).toBe(true);

			// ── 6. THE CLAIM: every admission path is refused ON THE JOINER ──────
			// Each names the constraint that owns it, so a rejection for an unrelated
			// reason (a malformed signature, a missing row) cannot be mistaken for the
			// seal doing its job. The ex-manager's own key drives the three manager
			// paths — on a sealed strand it is the only key that ever held authority
			// here, so it is the strongest attacker available.
			// Rejection floor: `rejects.toThrow()` only; nothing follows.
			await expect(
				issueInvite(joinerDb, { managerKeyPair: founderKeyPair }),
			).rejects.toThrow(/InviteValid/);

			// The STRANGER case, and the one the docs used to get wrong: a fresh key that
			// was never a manager anywhere, redeeming an invitation issued before the
			// seal. On a CONVERGED node `NotSealed` refuses it — that gate is
			// `exists (select 1 from Manager)` over the rows THIS node can see, which is
			// why it binds here and would not bind on a node that had not yet converged.
			await expect(
				consumeInvite(joinerDb, {
					inviteKey: preSealInvite,
					invitePrivateKey: preSealSecret,
					memberKey: freshKeyPair().publicKeyB64,
				}),
			).rejects.toThrow(/NotSealed/);

			await expect(
				addMemberByManager(joinerDb, { managerKeyPair: founderKeyPair, memberKey: freshKeyPair().publicKeyB64 }),
			).rejects.toThrow(/Authorized/);

			// RE-PROMOTING THE EX-MANAGER, not a fresh key. A promotion naming a key that
			// is not a member fails on `MemberExists` on a LIVE strand too, so that shape
			// would pin nothing about sealing. The ex-manager is still a `Member`, so
			// `MemberExists` passes and `Authorized` is the constraint left to reject:
			// the founding branch needs generation 0 (the writer seats a successor at 1),
			// and the promotion branch needs an existing manager to sign as — and the
			// table is empty.
			await expect(
				addManager(joinerDb, { byManagerKeyPair: founderKeyPair, newManagerKey: founderKeyPair.publicKeyB64 }),
			).rejects.toThrow(/Authorized/);

			// The last admission path, and the only one this file cannot pin to a single
			// constraint: `admitManager` writes a `Member` row AND a `Manager` row in one
			// transaction, so `Member.Authorized` and `Manager.Authorized` can each reject
			// and which one is REPORTED is engine evaluation order. Pin the fact of a CHECK
			// rejection only — same compromise, and same reason, as the single-node
			// `strand-seal.spec.ts` → "rejects every admission path".
			await expect(
				admitManager(joinerDb, { byManagerKeyPair: founderKeyPair, newManagerKey: freshKeyPair().publicKeyB64 }),
			).rejects.toThrow(/CHECK constraint failed/);
		} finally {
			await stopBoth(founderNode, joinerNode);
		}
	}, 60_000);

	// Kept SEPARATE from the test above rather than appended to it. Two reasons: the
	// claims differ — that one is "the seal binds", this one is "the seal is
	// IRREVERSIBLE" — and that one's rejection block has already spent its budget for
	// post-write assertions, so the state this test asserts first could not be asserted
	// there at all.
	it('a sealed strand cannot be re-founded from the node that did not seal it', async () => {
		const { founderNode, joinerNode, founderDb, joinerDb, founderKeyPair } =
			await bringUpClosedStrand('seal-refound');

		try {
			await sealStrand(founderDb, { managerKeyPair: founderKeyPair });
			await waitUntil(
				() => isStrandSealed(joinerDb),
				{ ...GATE, description: "the founder's seal becomes visible on the second node" },
			);

			// State first, for the rejection-floor reason: nothing may be asserted after
			// the rejected write below. The surviving member matters — a re-founding
			// attempt is only interesting while somebody is left who might try it.
			expect(await managerKeys(joinerDb)).toEqual([]);
			expect(await memberKeys(joinerDb)).toEqual([founderKeyPair.publicKeyB64]);

			// THE CLAIM: a SIGNED generation-0 insert — the founding shape, carrying a real
			// signature over the 'add' digest so the refusal cannot be blamed on a
			// malformed or absent context — is refused on the node that did not seal.
			// Same shape as `cadre-core/test/strand-seal.spec.ts` → "refuses a SIGNED
			// re-founding attempt at generation 0"; that spec already pins the post-state
			// locally, and what this adds is THE OTHER MACHINE: the retired `Manager`
			// stamp closed the founding branch on the joiner too, having arrived over the
			// wire rather than been written there.
			const stampId = generateStrandStampId();
			const signature = signStrandApproval(
				['Strand.Manager', 'add', founderKeyPair.publicKeyB64, 0, stampId],
				founderKeyPair.privateKeyB64,
			);
			await expect(
				joinerDb.exec(
					`insert into Strand.Manager (MemberKey, Generation, StampId)
					   with context ManagerKey = ?, Signature = ?
					   values (?, 0, ?)`,
					[founderKeyPair.publicKeyB64, signature, founderKeyPair.publicKeyB64, stampId],
				),
			).rejects.toThrow(/Authorized/);
		} finally {
			await stopBoth(founderNode, joinerNode);
		}
	}, 60_000);
});
