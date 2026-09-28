/**
 * Relay-only RESTART re-convergence — the reproduction of gotchoices/sereus#18: two
 * relay-only parties share a closed strand, both machines restart over the storage they
 * kept, both re-attach and report `active`, and a write made after the restart must still
 * cross.
 *
 * Before the strand peer book, it never did. A restarted strand node starts with an empty
 * libp2p peer store; a joiner's only record of the other party's strand addresses was the
 * formation reply, held in memory; and the delegate-announce seed pass asks the node's own
 * party's control siblings, which know nothing of a strand another party founded. So each
 * side came back with nothing to dial, the relay could not introduce them, and the strand
 * stayed split for as long as anyone waited (3 of 3 reporter runs, 180 to 600 s budgets,
 * cadre-core 1.5.0 and 1.6.0). What makes it converge now is the book
 * (`strand-peer-book.ts`, filled by formation, by every connection, and by the signed swap
 * in `strand-peer-book-swap.ts`) persisted through `strandPeers.store`, and the joined-strand
 * record (`joined-strand-store.ts`) that brings B's join back with no app-side list.
 *
 * ── The topology ──
 *
 * `blind-relay-phone-to-phone-e2e.integration.ts`'s: one dedicated loopback relay; parties A
 * and B, each ONE relay-only `CadreNode` (`listenAddrs: []`, `enableRelay: false`), so every
 * byte between them is relayed. A founds a CLOSED strand and publishes a bound invitation;
 * B, a stranger, forms against it and attaches from the formation-carried seed alone.
 *
 * ── The flow ──
 *
 *   1. Phase 1: B reads A's first row.
 *   2. Control: A writes a second row before any restart and B must read it, so a phase 2
 *      failure cannot be a strand that never worked.
 *   3. Restart: B's node stops, then A's; two NEW `CadreNode`s are built over the same
 *      identity keys, raw stores, peer-book backing and joined-strand key store (everything a
 *      phone keeps on disk). Each claims its strand from `strand:discovered` — A's from its
 *      control database's `Strand` row, B's from the remembered join — and both reach
 *      `active`. B sometimes comes up `'syncing'` first: its kept store can lack a collection
 *      it read before (the bimodal re-attach recorded at `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS`),
 *      and then it needs A to become writable.
 *   4. Phase 2: A writes, B reads; then B writes, A reads.
 *   5. Each book holds the other side's entry signed AFTER the restart (so the swap ran again
 *      on the rebuilt nodes), and every A↔B strand connection classifies `relayed`.
 *
 * ── The arms ──
 *
 * - Default: both books persist, and the scenario must pass.
 * - `RESTART_NEGATIVE_CONTROL=1`: both books are the in-memory default, which dies with the
 *   node — the pre-fix state — while the joined-strand record still persists. Phase 2 must
 *   NOT converge within its budget; the arm passes only when it does not. It has failed in
 *   both shapes the reporter could have seen: both strands `active` and never reconnected, or
 *   B stuck `'syncing'` with nobody to sync from. Opt-in because it costs that whole budget.
 * - `RESTART_TWO_PROCESS=1`: each party runs in its own `node` child process
 *   (`harness/fixtures/strand-restart-party.mjs`) over a temp directory with real on-disk
 *   stores (`FileRawStorage`, `FileKeyStore`, `FileStrandPeerBookStore`). The children exit
 *   after the control step and are respawned over the same directories, and the parent drives
 *   phase 2. Opt-in because it runs the whole journey a second time.
 *
 * ── Why the two-process arm exists ──
 *
 * In one process the "restart" is not a clean one. `captureRawStorage` hands a scope the same
 * `IRawStorage` object for its whole lifetime, so the rebuilt node reopens LIVE in-memory
 * stores, not files; and any module-level state in cadre-core, libp2p or optimystic survives
 * the rebuild. The reporter's caveat about their own one-process reproduction was exactly
 * this. The two-process arm removes both.
 *
 * ── Running it ──
 *
 *   yarn workspace @serfab/integration-tests exec vitest run strand-relay-only-restart-reconverges
 *   RESTART_NEGATIVE_CONTROL=1 yarn workspace @serfab/integration-tests exec vitest run strand-relay-only-restart-reconverges
 *   RESTART_TWO_PROCESS=1 yarn workspace @serfab/integration-tests exec vitest run strand-relay-only-restart-reconverges
 *
 * Every arm prints `[RESTART]` lines with the elapsed times of each post-restart step,
 * measured from the moment the rebuild began (both old nodes already stopped).
 *
 * Lookup shape: App.Data reads scan and filter in JavaScript — a where-equality on the
 * primary key can MISS on a networked strand (`debt-composite-pk-point-lookup-unreliable-untracked`).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';
import type { Libp2p } from 'libp2p';
import type { Database } from '@quereus/quereus';
import {
	CadreNode,
	ControlFormationUsageRecorder,
	InMemoryKeyStore,
	KeyStoreJoinedStrandStore,
	PersistentStrandPeerBookStore,
	generateStrandMemberKey,
	summarizeConnectionPaths,
} from '@serfab/cadre-core';
import type { DurableSlot, SAppConfig, StrandInstance, StrandPeerEntry, StrandRow } from '@serfab/cadre-core';
import {
	waitUntil,
	controlNodeConfig,
	createSignedSAppConfig,
	makeOwnOwner,
	startDedicatedRelay,
	captureRawStorage,
	startStrandRestartParty,
	type DedicatedRelay,
	type RawStorageCapture,
	type StrandRestartParty,
} from '../harness/index.js';

const NEGATIVE_CONTROL = process.env.RESTART_NEGATIVE_CONTROL === '1';
const TWO_PROCESS = process.env.RESTART_TWO_PROCESS === '1';

const SIMPLE_SCHEMA = `
table Data (
    Key text primary key,
    Val text
);
`;

const SAPP_ID = 'sapp-restart-reconverges';
const YEAR_MS = 365 * 24 * 3600_000;

/** Budget for every gate before the restart — the blind-relay scenario's. */
const GATE = { timeoutMs: 60_000, intervalMs: 250 } as const;

/**
 * Budget for every gate after the restart: both strands reaching `active`, and each phase 2
 * read. A relayed re-attach took about 150 s on 1.6.0 over a 900 ms link
 * (`DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS`); this link is undelayed loopback, so 180 s is
 * headroom, not an expectation — the `[RESTART]` lines say what a run actually took.
 */
const RESTART_GATE = { timeoutMs: 180_000, intervalMs: 500 } as const;

const isCircuit = (addr: string): boolean => addr.includes('/p2p-circuit');

/** Every App.Data row visible on one strand DB, via an unfiltered scan. */
async function readDataRows(db: Database): Promise<Map<string, string>> {
	const rows = new Map<string, string>();
	for await (const row of db.eval('select Key, Val from App.Data')) {
		rows.set(row.Key as string, row.Val as string);
	}
	return rows;
}

/** An in-memory {@link DurableSlot} — the text a phone would keep on disk, held outside the node. */
function memorySlot(): DurableSlot {
	let text: string | undefined;
	return {
		load: async () => text,
		save: async (next) => { text = next; },
	};
}

/**
 * Everything one party keeps across a restart: its identity, its raw stores, and the backing
 * of its two node-local stores. A rebuilt node is handed the same objects, which is what makes
 * the rebuild a restart rather than a new machine.
 */
interface PartyHome {
	partyId: string;
	key: PrivateKey;
	storage: RawStorageCapture;
	/** Backs the joined-strand record; a new `KeyStoreJoinedStrandStore` reloads it per node. */
	joinedKeys: InMemoryKeyStore;
	/** Backs the strand peer book, reopened per node; undefined = the in-memory default (the negative control). */
	bookSlot: DurableSlot | undefined;
	profile: 'storage' | 'transaction';
}

function partyHome(partyId: string, key: PrivateKey, profile: PartyHome['profile'], persistentBook: boolean): PartyHome {
	return {
		partyId,
		key,
		storage: captureRawStorage(),
		joinedKeys: new InMemoryKeyStore(),
		bookSlot: persistentBook ? memorySlot() : undefined,
		profile,
	};
}

/** Build and start one relay-only node over a party's kept state. */
async function startPartyNode(home: PartyHome, relay: DedicatedRelay): Promise<CadreNode> {
	const node = new CadreNode(controlNodeConfig({
		partyId: home.partyId,
		privateKey: home.key,
		profile: home.profile,
		enableRelay: false,
		listenAddrs: [],
		relayAddrs: [relay.dialAddr],
		storageProvider: home.storage.provider,
		joinedStrandStore: new KeyStoreJoinedStrandStore(home.joinedKeys, home.partyId),
		...(home.bookSlot !== undefined
			? { strandPeerBook: await PersistentStrandPeerBookStore.open(home.bookSlot, home.partyId) }
			: {}),
	}));
	await node.start();
	return node;
}

/**
 * Claim `strandId` the way an app that auto-joins discovered strands does after a restart:
 * subscribe to `strand:discovered` first, then drain `getDiscoveredStrands()` (the strand is
 * normally offered while `start()` is still running), and `addStrand` the row it was offered.
 * Resolves once the launch returns, which may still be gated on its first sync (`'syncing'`).
 */
async function claimDiscoveredStrand(node: CadreNode, strandId: string, sAppConfig: SAppConfig): Promise<StrandInstance> {
	const offered = new Promise<StrandRow>((resolve) => {
		const onDiscovered = (event: { strandId: string; strand: StrandRow }): void => {
			if (event.strandId !== strandId) return;
			node.off('strand:discovered', onDiscovered);
			resolve(event.strand);
		};
		node.on('strand:discovered', onDiscovered);
		const backlog = node.getDiscoveredStrands().get(strandId);
		if (backlog) {
			node.off('strand:discovered', onDiscovered);
			resolve(backlog);
		}
	});
	const strandRow = await withTimeout(offered, RESTART_GATE.timeoutMs, `${strandId} offered as strand:discovered`);
	return await node.addStrand({ strandRow, sAppConfig, awaitFirstSync: false });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`Timeout waiting for ${description} after ${timeoutMs}ms`)), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** The signed entry `node`'s book holds for `peerId`, if any. */
function signedEntryFor(node: CadreNode, strandId: string, peerId: string): StrandPeerEntry | undefined {
	return node.getStrandPeerBookStore()!.entries(strandId).find((e) => e.peerId === peerId && e.sig !== undefined);
}

/** Every connection `node` holds to `peerId` is a relayed circuit path. */
function expectAllPathsRelayed(node: Libp2p, peerId: string, label: string): void {
	const toPeer = summarizeConnectionPaths(node.getConnections()).paths.filter((p) => p.peerId === peerId);
	expect(toPeer.length, `${label}: no connection to ${peerId}`).toBeGreaterThan(0);
	for (const path of toPeer) {
		expect(path.kind, `${label}: ${path.remoteAddr}`).toBe('relayed');
	}
}

function connectedTo(node: Libp2p, peerId: string): boolean {
	return node.getConnections().some((c) => c.remotePeer.toString() === peerId);
}

// ═════════════════════════════════════════════════════════════════════════════

/**
 * The whole in-process journey. `persistentBook` false is the negative control: phase 2 is
 * then expected NOT to converge, and everything after it is skipped.
 */
async function runInProcess(persistentBook: boolean): Promise<void> {
	const say = (msg: string, ...args: unknown[]): void => { console.log(`[RESTART ${persistentBook ? 'book' : 'no-book'}] ${msg}`, ...args); };
	let relay: DedicatedRelay | undefined;
	let A: CadreNode | undefined;
	let B: CadreNode | undefined;
	try {
		const runTag = Date.now();
		const strandId = `strand-restart-${runTag}`;
		const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '0.1.0');
		relay = await startDedicatedRelay();

		const aHome = partyHome(`restart-a-${runTag}`, await generateKeyPair('Ed25519'), 'storage', persistentBook);
		const bHome = partyHome(`restart-b-${runTag}`, await generateKeyPair('Ed25519'), 'transaction', persistentBook);

		// ── First incarnation: found, invite, form, attach (the blind-relay flow) ──
		A = await startPartyNode(aHome, relay);
		await makeOwnOwner(A, aHome.key);
		await A.initializeStrandSolicitation({
			formationUsageRecorder: new ControlFormationUsageRecorder(A.getControlDatabase()!),
		});
		const memberPrivateKey = await generateStrandMemberKey();
		const founded = await A.foundStrand({ strandId, type: 'c', memberPrivateKey, sAppConfig: sApp });
		const aStrandPeerId = founded.instance.libp2pNode!.peerId.toString();
		const invitation = await A.createOpenInvitation(SAPP_ID, YEAR_MS);
		await A.publishFormationInvite(invitation.token, SAPP_ID, { strandId, expiresAtMs: Date.now() + YEAR_MS, totalUses: 1 });

		B = await startPartyNode(bHome, relay);
		await makeOwnOwner(B, bHome.key);
		const formResult = await B.formStrand(B.decodeInvitation(A.encodeInvitation(invitation)), {
			partyId: bHome.partyId,
			purpose: 'relay-only restart re-convergence',
		});
		expect(formResult.strandId).toBe(strandId);
		const bStrand = await B.addStrand({
			strandRow: { Id: strandId, MemberPrivateKey: formResult.memberPrivateKey ?? null, Type: 'c', FounderOwnerKey: null },
			sAppConfig: sApp,
			awaitFirstSync: false,
		});
		const bStrandPeerId = bStrand.libp2pNode!.peerId.toString();
		await B.whenStrandWritable(strandId, { timeoutMs: GATE.timeoutMs });

		// ── Phase 1 and the control write: the strand works before any restart ──
		const aDb = founded.instance.database!.getDatabase();
		const bDb = bStrand.database!.getDatabase();
		await aDb.exec("insert into App.Data (Key, Val) values ('phase-1', 'written-on-A')");
		await waitUntil(async () => (await readDataRows(bDb)).get('phase-1') === 'written-on-A',
			{ ...GATE, description: "phase 1: B reads A's first row" });
		await aDb.exec("insert into App.Data (Key, Val) values ('control', 'written-on-A-before-restart')");
		await waitUntil(async () => (await readDataRows(bDb)).get('control') === 'written-on-A-before-restart',
			{ ...GATE, description: "control: B reads A's second row before any restart" });
		// Both books hold the other side's self-signed entry before anyone stops, in BOTH arms,
		// so the only difference the negative control makes is whether the book outlives the node.
		await waitUntil(
			() => signedEntryFor(A!, strandId, bStrandPeerId) !== undefined && signedEntryFor(B!, strandId, aStrandPeerId) !== undefined,
			{ ...GATE, description: "both strand peer books hold the other side's signed entry before the restart" },
		);
		say('phase 1 and control converged; restarting (B stops first, then A)');

		// ── Restart: B first, then A, then two NEW nodes over the same kept state ──
		const bStopping = B;
		B = undefined;
		await bStopping.stop();
		const aStopping = A;
		A = undefined;
		await aStopping.stop();

		const restartedAt = Date.now();
		const since = (): number => Date.now() - restartedAt;
		A = await startPartyNode(aHome, relay);
		B = await startPartyNode(bHome, relay);
		say('both nodes rebuilt at %d ms', since());

		// Each launch returns as soon as its node is up. A founder's is never gated; a
		// joiner's comes up `'syncing'` when its kept store lacks a collection it read before
		// (the bimodal re-attach recorded at `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS`) and then
		// needs A to become writable, so the launch status is logged, not asserted.
		const [aStrand2, bStrand2] = await Promise.all([
			claimDiscoveredStrand(A, strandId, sApp),
			claimDiscoveredStrand(B, strandId, sApp),
		]);
		say('both strands launched at %d ms (A %s, B %s)', since(), aStrand2.status, bStrand2.status);
		const aStrandNode = aStrand2.libp2pNode!;
		const bStrandNode = bStrand2.libp2pNode!;
		// The strand transport key is derived from the identity key and the strand id, so the
		// rebuilt strand nodes keep their ids — which is what makes a remembered entry dialable.
		expect(aStrandNode.peerId.toString()).toBe(aStrandPeerId);
		expect(bStrandNode.peerId.toString()).toBe(bStrandPeerId);
		const connected = waitUntil(() => connectedTo(bStrandNode, aStrandPeerId),
			{ ...RESTART_GATE, intervalMs: 100, description: "B's rebuilt strand node connects to A's" })
			.then(() => { say('strand nodes connected at %d ms', since()); }, () => { say('strand nodes never connected'); });

		// ── Phase 2: a write made after the restart crosses, both ways ──
		const aDb2 = (await A.whenStrandWritable(strandId, { timeoutMs: RESTART_GATE.timeoutMs })).database!.getDatabase();
		say('A strand writable at %d ms', since());

		if (!persistentBook) {
			// The negative control: with the book gone neither side has an address to dial, so
			// B either stays gated (nothing to sync from) or comes up alone and never hears the row.
			await aDb2.exec("insert into App.Data (Key, Val) values ('phase-2-a', 'written-on-A-after-restart')");
			await expect(waitUntil(async () => {
				const bDb = B!.getStrand(strandId)?.database?.getDatabase();
				return bDb !== undefined && (await readDataRows(bDb)).get('phase-2-a') === 'written-on-A-after-restart';
			}, { ...RESTART_GATE, description: 'phase 2: B reads the row A wrote after the restart' }))
				.rejects.toThrow(/Timeout waiting for phase 2/);
			await connected;
			expect(connectedTo(bStrandNode, aStrandPeerId), 'the strand nodes found each other with no book').toBe(false);
			say('negative control: phase 2 did not converge in %d ms; B strand %s (expected without a persistent book)',
				RESTART_GATE.timeoutMs, B.getStrand(strandId)?.status);
			return;
		}

		const bDb2 = (await B.whenStrandWritable(strandId, { timeoutMs: RESTART_GATE.timeoutMs })).database!.getDatabase();
		say('B strand writable at %d ms', since());
		expect(A.getStrand(strandId)?.status).toBe('active');
		expect(B.getStrand(strandId)?.status).toBe('active');
		const aWroteAt = since();
		await aDb2.exec("insert into App.Data (Key, Val) values ('phase-2-a', 'written-on-A-after-restart')");
		await waitUntil(async () => (await readDataRows(bDb2)).get('phase-2-a') === 'written-on-A-after-restart',
			{ ...RESTART_GATE, description: 'phase 2: B reads the row A wrote after the restart' });
		say("phase 2: B read A's post-restart row at %d ms (%d ms after the write)", since(), since() - aWroteAt);
		const bWroteAt = since();
		await bDb2.exec("insert into App.Data (Key, Val) values ('phase-2-b', 'written-on-B-after-restart')");
		await waitUntil(async () => (await readDataRows(aDb2)).get('phase-2-b') === 'written-on-B-after-restart',
			{ ...RESTART_GATE, description: 'phase 2: A reads the row B wrote after the restart' });
		say("phase 2: A read B's post-restart row at %d ms (%d ms after the write)", since(), since() - bWroteAt);
		await connected;

		// ── The swap ran again on the rebuilt nodes, and everything is relayed ──
		// An own entry is re-signed at every arm with an `issuedAt` past anything it signed
		// before, so an entry stamped at or after the restart can only have come from a swap
		// between the NEW nodes.
		await waitUntil(
			() => (signedEntryFor(A!, strandId, bStrandPeerId)?.issuedAt ?? 0) >= restartedAt
				&& (signedEntryFor(B!, strandId, aStrandPeerId)?.issuedAt ?? 0) >= restartedAt,
			{ ...GATE, description: "each book holds the other side's entry signed after the restart" },
		);
		for (const [node, peerId] of [[A, bStrandPeerId], [B, aStrandPeerId]] as const) {
			const entry = signedEntryFor(node, strandId, peerId)!;
			expect(entry.addrs.length).toBeGreaterThan(0);
			for (const addr of entry.addrs) {
				expect(isCircuit(addr), addr).toBe(true);
			}
		}
		expectAllPathsRelayed(aStrandNode, bStrandPeerId, 'A strand after restart');
		expectAllPathsRelayed(bStrandNode, aStrandPeerId, 'B strand after restart');
		say('RESULT converged after the restart; total %d ms', since());
	} finally {
		await Promise.allSettled([B?.stop(), A?.stop()]);
		await relay?.stop();
	}
}

// ═════════════════════════════════════════════════════════════════════════════

/**
 * The same journey with each party in its own `node` process over on-disk stores. The parent
 * owns the relay and the temp directory; the children own everything else.
 */
async function runTwoProcess(): Promise<void> {
	const say = (msg: string, ...args: unknown[]): void => { console.log(`[RESTART two-process] ${msg}`, ...args); };
	const home = mkdtempSync(join(tmpdir(), 'sereus-restart-'));
	let relay: DedicatedRelay | undefined;
	let A: StrandRestartParty | undefined;
	let B: StrandRestartParty | undefined;
	try {
		const runTag = Date.now();
		const strandId = `strand-restart-${runTag}`;
		const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '0.1.0');
		relay = await startDedicatedRelay();
		const aParty = { label: 'A', partyId: `restart-a-${runTag}`, stateDir: join(home, 'a'), profile: 'storage' } as const;
		const bParty = { label: 'B', partyId: `restart-b-${runTag}`, stateDir: join(home, 'b'), profile: 'transaction' } as const;

		// ── First incarnation ──
		A = await startStrandRestartParty({ ...aParty, relayAddr: relay.dialAddr });
		const { strandPeerId: aStrandPeerId, encodedInvitation } = await A.request('found', { strandId, sApp, sAppId: SAPP_ID });
		B = await startStrandRestartParty({ ...bParty, relayAddr: relay.dialAddr });
		const { strandPeerId: bStrandPeerId } = await B.request('form', { strandId, sApp, encodedInvitation, timeoutMs: GATE.timeoutMs });

		await A.request('write', { strandId, key: 'phase-1', val: 'written-on-A' });
		await B.request('waitRow', { strandId, key: 'phase-1', val: 'written-on-A', timeoutMs: GATE.timeoutMs });
		await A.request('write', { strandId, key: 'control', val: 'written-on-A-before-restart' });
		await B.request('waitRow', { strandId, key: 'control', val: 'written-on-A-before-restart', timeoutMs: GATE.timeoutMs });
		await A.request('waitSignedEntry', { strandId, peerId: bStrandPeerId, issuedSince: 0, timeoutMs: GATE.timeoutMs });
		await B.request('waitSignedEntry', { strandId, peerId: aStrandPeerId, issuedSince: 0, timeoutMs: GATE.timeoutMs });
		say('phase 1 and control converged; both processes exit (B first, then A)');

		// ── Restart: each process stops its node and exits; new processes over the same dirs ──
		await B.exit();
		B = undefined;
		await A.exit();
		A = undefined;

		const restartedAt = Date.now();
		const since = (): number => Date.now() - restartedAt;
		A = await startStrandRestartParty({ ...aParty, relayAddr: relay.dialAddr });
		B = await startStrandRestartParty({ ...bParty, relayAddr: relay.dialAddr });
		say('both processes respawned at %d ms', since());
		const [aClaim, bClaim] = await Promise.all([
			A.request('claim', { strandId, sApp, timeoutMs: RESTART_GATE.timeoutMs }),
			B.request('claim', { strandId, sApp, timeoutMs: RESTART_GATE.timeoutMs }),
		]);
		say('both strands active at %d ms', since());
		expect(aClaim.status).toBe('active');
		expect(bClaim.status).toBe('active');
		expect(aClaim.strandPeerId).toBe(aStrandPeerId);
		expect(bClaim.strandPeerId).toBe(bStrandPeerId);

		// ── Phase 2 ──
		await A.request('write', { strandId, key: 'phase-2-a', val: 'written-on-A-after-restart' });
		await B.request('waitRow', { strandId, key: 'phase-2-a', val: 'written-on-A-after-restart', timeoutMs: RESTART_GATE.timeoutMs });
		say('phase 2: B read A\'s post-restart row at %d ms', since());
		await B.request('write', { strandId, key: 'phase-2-b', val: 'written-on-B-after-restart' });
		await A.request('waitRow', { strandId, key: 'phase-2-b', val: 'written-on-B-after-restart', timeoutMs: RESTART_GATE.timeoutMs });
		say('phase 2: A read B\'s post-restart row at %d ms', since());

		// ── The swap ran again, and every A↔B strand connection is relayed ──
		for (const [party, peerId] of [[A, bStrandPeerId], [B, aStrandPeerId]] as const) {
			const { addrs } = await party.request('waitSignedEntry', { strandId, peerId, issuedSince: restartedAt, timeoutMs: GATE.timeoutMs });
			expect(addrs.length).toBeGreaterThan(0);
			for (const addr of addrs) expect(isCircuit(addr), addr).toBe(true);
			const { kinds } = await party.request('pathKinds', { strandId, peerId });
			expect(kinds.length, `${party.label}: no strand connection to ${peerId}`).toBeGreaterThan(0);
			for (const kind of kinds) expect(kind, `${party.label} strand connection to ${peerId}`).toBe('relayed');
		}
		say('RESULT two-process restart converged; total %d ms', since());
	} finally {
		await Promise.allSettled([B?.exit(), A?.exit()]);
		await relay?.stop();
		// Children are gone before this, so nothing holds a file open (Windows refuses otherwise).
		// The temp dir holds only files the children wrote — no node_modules junctions.
		rmSync(home, { recursive: true, force: true });
	}
}

describe('relay-only restart re-convergence (gotchoices/sereus#18)', () => {
	it('two relay-only parties restart over kept storage and a post-restart write crosses both ways', async () => {
		await runInProcess(true);
	}, 600_000);

	it.runIf(NEGATIVE_CONTROL)('negative control (RESTART_NEGATIVE_CONTROL=1): with in-memory books, phase 2 never converges', async () => {
		await runInProcess(false);
	}, 600_000);

	it.runIf(TWO_PROCESS)('two OS processes (RESTART_TWO_PROCESS=1): the same restart across process exits, over on-disk stores', async () => {
		await runTwoProcess();
	}, 900_000);
});
