/**
 * A joiner's first transaction over a slow relayed link — the shape a two-party app's
 * "take your seat" act has, measured where it fails on real phones.
 *
 * Found on two phones (a Galaxy S7 and an Android emulator) running the Taleus tally app over
 * the public relay: the joiner's strand took minutes to become writable; its first-sync probe
 * and its first transaction both failed on tables NOBODY had written yet ("cohort-unreachable:
 * the repo could not determine whether it exists"); and once, the joiner's first transaction
 * reported success while the founder never saw any of its rows, even after both restarted.
 *
 * The schema reproduces the app's shape with nothing app-specific in it:
 * - several tables, most of which the founder never writes (the app has 17);
 * - the joiner's first act writes three tables in ONE transaction: a seat, its key, and its
 *   profile -- two of which the founder already wrote to;
 * - a constraint on the key reads a table nobody has written (`Revocation`), as an
 *   authorization check does.
 *
 * Topology: the blind-relay pair (`blind-relay-phone-to-phone-e2e`): two relay-only parties,
 * one dedicated relay, a closed strand formed by bound invitation. Arms: loopback, and a slow
 * link (`harness/ws-latency.ts`). `WS_SEND_DELAY_MS` / `WS_SEND_DELAY_MODE` pin the delay for a
 * sweep.
 *
 * The third arm adds what the phones had and the latency arms do not: a 20 ms per-frame cap
 * (`serial`, a frame-RATE limit) and an event loop kept 70% busy -- the shape of a phone whose JS
 * thread is mostly occupied (a Galaxy S7 profiled at 70% busy while serving a joiner). Both are
 * process-wide, so they slow every node and the relay alike: "every machine is a slow phone", not
 * "one slow peer". `EVENT_LOOP_BUSY=<fraction>` applies the busy loop to any arm for a sweep.
 *
 * What it asserts, after the joiner's first sync: the joiner's first transaction commits, and
 * every row of it is readable on the founder even though the joiner stops the moment its commit
 * returns. A commit that reported success must not live only on the machine that made it.
 *
 * What it found (Optimystic 1.12.1, Sereus 1.14.0): under a slow link the joiner's strand node can
 * be connected to nothing but the relay when its strand becomes writable. Its commit then resolves
 * a cluster of only itself for every block and commits with `quorum: 'local'`
 * (`coordinator-repo` `commit:solo-cohort`, `cohortSize: 1, soleIsSelf: true`) in about 0.1 s,
 * reporting success. The rows reach the founder only if the joiner later reconnects and syncs;
 * stopped, they never do. It logs how long each step took and every node's peer id, so a run's
 * `DEBUG=optimystic:db-p2p:*` log can be read against them.
 *
 * Why the joiner has no strand peer in the third arm: on this link an outbound frame waits 10 to
 * 20 s in its socket's queue, so a liveness ping's echo routinely takes longer than the 10 s that
 * `@libp2p/ping`'s handler allows on every cadre node. The handler resets the ping stream, and the
 * pinging node's monitor aborts the connection whatever its own 30 s deadline
 * (`blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline`). Between the two strand
 * nodes that drops their circuit; from the relay, whose monitor pings each strand node, it drops
 * that node's relay connection and every circuit on it. So the strand nodes lose each other about
 * 40 s after each reconnect, the member redial (`strand-peer-redial.ts`) reconnects them after its
 * 21.5 s backoff, a database build that found the founder unreachable is retried 5 s later
 * (`strand-deferred-join-keeps-its-runtime`), and the joiner's first sync completes across several
 * of those windows. When it does, the joiner can be between windows, with only the relay
 * connected. The harness relay carries the deployed relay's monitor, limits and ping handler
 * (`harness/dedicated-relay.ts`), so it no longer cuts circuits on a deadline of its own. With the
 * relay answering pings the joiner became writable after 385 s, against 85 s with the relay not
 * answering them (one run each); why the relay's ping handler costs that much is
 * `fix/slow-link-joiner-first-sync-slower-when-relay-answers-pings`.
 *
 * The fourth arm is the restart the phones also tried: the third arm's solo commit, then the
 * joiner stops, is rebuilt over the storage it kept (raw stores, saved strand network state,
 * joined-strand record) and re-claims the strand, and the founder must then hold every row. The
 * restart runs on an undelayed link: there the restarted strand node reconnects and peer-join
 * backfill delivers the solo-committed blocks, which the founder accepts.
 *
 * The fifth arm restarts on the slow link instead, the frame cap and the busy event loop still in
 * force. There FRET's maintenance pings cannot reconnect the two strand nodes -- each is allowed
 * 2 s, dial included, and a relayed dial on that link takes longer -- so what reconnects them is
 * the strand member redial, which dials with the relayed-dial budget the declared link gives
 * (`strand-peer-redial.ts`). The rows reached the founder 48 s and 211 s after the restart began,
 * in two runs.
 *
 * The sixth arm checks what the app is told about a write made alone (docs/strands.md, "A commit's
 * durability"), on an undelayed link: with the joiner stopped, the founder writes one row, and its
 * strand database must report that commit held only here and followed; once the joiner restarts
 * over its kept storage and takes the copies it is owed, the founder must emit `strand:commit-held`
 * for it.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';
import {
	CadreNode,
	InMemoryKeyStore,
	KeyStoreJoinedStrandStore,
	PersistentStrandNetworkStateStore,
	generateStrandMemberKey,
} from '@serfab/cadre-core';
import type { DurableSlot, SAppConfig, StrandCommitDurability, StrandInstance, StrandRow } from '@serfab/cadre-core';
import type { Database } from '@quereus/quereus';
import {
	waitUntil,
	controlNodeConfig,
	createSignedSAppConfig,
	makeOwnOwner,
	startDedicatedRelay,
	installWsLatency,
	captureRawStorage,
	type DedicatedRelay,
	type RawStorageCapture,
	type WsLatencyOptions,
} from '../harness/index.js';

/** Most tables are never written by the founder; `Revocation` is never written at all. */
const SCHEMA = `
table Seat (
    Side text primary key,
    Sid text
);
table Party (
    Sid text primary key,
    Name text
);
table Revocation (
    Sid text,
    PublicKey text,
    primary key (Sid, PublicKey)
);
table PartyKey (
    Sid text,
    PublicKey text,
    primary key (Sid, PublicKey),
    constraint NotRevoked check on insert (not exists (
        select 1 from Revocation R where R.Sid = New.Sid and R.PublicKey = New.PublicKey))
);
table Terms (Id text primary key, Body text);
table Contract (Id text primary key, Body text);
table Ledger (Id text primary key, Body text);
table Invoice (Id text primary key, Body text);
table CloseRequest (Id text primary key, Body text);
table Trading (Id text primary key, Body text);
`;

const SAPP_ID = 'sapp-joiner-first-commit';
const YEAR_MS = 365 * 24 * 3600_000;

/** Generous on purpose: the arm reports how long each step took; a gate only bounds a hang. */
const FIRST_SYNC_MS = 600_000;
const CONVERGE = { timeoutMs: 180_000, intervalMs: 500 } as const;

/** The joiner's "take your seat" act: three tables, one transaction. */
function seatBatch(side: string, sid: string, publicKey: string, name: string): string {
	return [
		`insert into App.Seat (Side, Sid) values ('${side}', '${sid}');`,
		`insert into App.PartyKey (Sid, PublicKey) values ('${sid}', '${publicKey}');`,
		`insert into App.Party (Sid, Name) values ('${sid}', '${name}');`,
	].join('\n');
}

async function rows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	for await (const row of db.eval(sql)) out.push({ ...row });
	return out;
}

/** Keep the event loop busy `fraction` of every 100 ms until the returned stop is called. */
function occupyEventLoop(fraction: number): () => void {
	const busyMs = Math.round(fraction * 100);
	const timer = setInterval(() => {
		const until = Date.now() + busyMs;
		while (Date.now() < until) { /* a phone's JS thread, busy elsewhere */ }
	}, 100);
	return () => clearInterval(timer);
}

const ENV_EVENT_LOOP_BUSY = Number(process.env.EVENT_LOOP_BUSY ?? 0);

interface RunOptions {
	/** Holds every outbound WebSocket frame in the process this long. */
	latency?: WsLatencyOptions;
	/** Fraction of every 100 ms this process's event loop is kept busy. */
	eventLoopBusy?: number;
}

function since(t0: number): string {
	return `${((Date.now() - t0) / 1000).toFixed(1)} s`;
}

async function runJoinerFirstCommit(opts: RunOptions = {}): Promise<void> {
	const link = opts.latency === undefined ? undefined : installWsLatency(opts.latency);
	const busy = ENV_EVENT_LOOP_BUSY || (opts.eventLoopBusy ?? 0);
	const release = busy > 0 ? occupyEventLoop(busy) : undefined;
	let relay: DedicatedRelay | undefined;
	let A: CadreNode | undefined;
	let B: CadreNode | undefined;
	// The link in force, which `WS_SEND_DELAY_MS` may have pinned over the arm's request.
	const label = (link ? `${link.delayMs} ms ${link.mode}` : 'loopback')
		+ (busy > 0 ? `, event loop ${busy * 100}% busy` : '');
	try {
		const runTag = Date.now();
		const strandId = `strand-joiner-first-commit-${runTag}`;
		const sApp = createSignedSAppConfig(SCHEMA, '0.1.0');
		relay = await startDedicatedRelay();

		// ── Founder: relay-only, founds the closed strand and takes its own seat ──
		const aKey = await generateKeyPair('Ed25519');
		A = new CadreNode(controlNodeConfig({
			partyId: `first-commit-a-${runTag}`,
			privateKey: aKey,
			listenAddrs: [],
			relayAddrs: [relay.dialAddr],
		}));
		await A.start();
		await makeOwnOwner(A, aKey);
		const memberPrivateKey = await generateStrandMemberKey();
		const founded = await A.foundStrand({ strandId, type: 'c', memberPrivateKey, sAppConfig: sApp });
		const aDb = founded.instance.database!.getDatabase();
		await aDb.exec(seatBatch('S', 'sid-a', 'key-a', 'Founder'), undefined, { transaction: true });

		const invitation = await A.createOpenInvitation(SAPP_ID, YEAR_MS);
		await A.publishFormationInvite(invitation.token, SAPP_ID, { strandId, expiresAtMs: Date.now() + YEAR_MS, totalUses: 1 });
		const encoded = A.encodeInvitation(invitation);

		// ── Joiner: relay-only, forms through the relay and launches the strand ──
		const bKey = await generateKeyPair('Ed25519');
		B = new CadreNode(controlNodeConfig({
			partyId: `first-commit-b-${runTag}`,
			privateKey: bKey,
			listenAddrs: [],
			relayAddrs: [relay.dialAddr],
		}));
		await B.start();
		await makeOwnOwner(B, bKey);
		const formResult = await B.formStrand(B.decodeInvitation(encoded), {
			partyId: `first-commit-b-${runTag}`,
			purpose: 'joiner first commit over a slow relay',
		});
		const bStrandRow: StrandRow = {
			Id: strandId,
			MemberPrivateKey: formResult.memberPrivateKey ?? null,
			Type: 'c',
			FounderOwnerKey: null,
		};
		const tJoin = Date.now();
		await B.addStrand({ strandRow: bStrandRow, sAppConfig: sApp, awaitFirstSync: false });
		const bStrand = await B.whenStrandWritable(strandId, { timeoutMs: FIRST_SYNC_MS });
		console.log(`[first-commit ${label}] joiner writable after ${since(tJoin)}`);
		console.log(`[first-commit ${label}] peers: founder control ${A.peerId}, founder strand ${founded.instance.libp2pNode!.peerId}, `
			+ `joiner control ${B.peerId}, joiner strand ${bStrand.libp2pNode!.peerId}, relay ${relay.peerId}`);
		console.log(`[first-commit ${label}] joiner strand connections: ${bStrand.libp2pNode!.getConnections().map(c => c.remotePeer.toString()).join(', ')}`);
		const bDb = bStrand.database!.getDatabase();

		// ── The joiner's first act ──
		const tCommit = Date.now();
		await bDb.exec(seatBatch('F', 'sid-b', 'key-b', 'Joiner'), undefined, { transaction: true });
		console.log(`[first-commit ${label}] joiner's seat committed after ${since(tCommit)}`);

		// ── A committed transaction does not depend on the committer staying up ──
		// The joiner goes away the moment its commit returns, as a phone does when its app is
		// backgrounded. A commit the strand's cohort accepted is already held by the founder; one
		// the joiner made with a cohort of only itself (optimystic's `commit:solo-cohort`, which
		// a slow link produces -- see the file header) exists nowhere else, and is lost.
		await B.stop();
		const tReach = Date.now();
		await waitUntil(
			async () => {
				const seats = await rows(aDb, 'select Side from App.Seat');
				const keys = await rows(aDb, 'select Sid from App.PartyKey');
				const parties = await rows(aDb, 'select Sid from App.Party');
				return seats.some(r => r.Side === 'F')
					&& keys.some(r => r.Sid === 'sid-b')
					&& parties.some(r => r.Sid === 'sid-b');
			},
			{ ...CONVERGE, description: "every row of the joiner's committed transaction is readable on the founder after the joiner stops" },
		);
		console.log(`[first-commit ${label}] joiner's rows readable on the founder ${since(tReach)} after the joiner stopped`);
		expect((await rows(aDb, 'select Side from App.Seat')).map(r => r.Side).sort()).toEqual(['F', 'S']);
	} finally {
		await Promise.allSettled([B?.stop(), A?.stop()]);
		await relay?.stop();
		release?.();
		link?.restore();
	}
}

/** Every row of the joiner's seat batch is readable on `db`. */
async function holdsJoinerSeat(db: Database): Promise<boolean> {
	const seats = await rows(db, 'select Side from App.Seat');
	const keys = await rows(db, 'select Sid from App.PartyKey');
	const parties = await rows(db, 'select Sid from App.Party');
	return seats.some(r => r.Side === 'F') && keys.some(r => r.Sid === 'sid-b') && parties.some(r => r.Sid === 'sid-b');
}

/** An in-memory {@link DurableSlot}: the text a phone keeps on disk, held outside the node. */
function memorySlot(): DurableSlot {
	let text: string | undefined;
	return { load: async () => text, save: async (next) => { text = next; } };
}

/** What a party keeps across a restart; a node rebuilt over the same objects is a restart, not a new machine. */
interface PartyHome {
	partyId: string;
	key: PrivateKey;
	storage: RawStorageCapture;
	joinedKeys: InMemoryKeyStore;
	networkStateSlot: DurableSlot;
}

async function partyHome(partyId: string): Promise<PartyHome> {
	return {
		partyId,
		key: await generateKeyPair('Ed25519'),
		storage: captureRawStorage(),
		joinedKeys: new InMemoryKeyStore(),
		networkStateSlot: memorySlot(),
	};
}

async function startPartyNode(home: PartyHome, relay: DedicatedRelay): Promise<CadreNode> {
	const node = new CadreNode(controlNodeConfig({
		partyId: home.partyId,
		privateKey: home.key,
		listenAddrs: [],
		relayAddrs: [relay.dialAddr],
		storageProvider: home.storage.provider,
		joinedStrandStore: new KeyStoreJoinedStrandStore(home.joinedKeys, home.partyId),
		strandNetworkStateStore: await PersistentStrandNetworkStateStore.open(home.networkStateSlot, home.partyId),
	}));
	await node.start();
	return node;
}

/** Re-claim `strandId` from `strand:discovered` (the remembered join), as an app does after a restart. */
async function claimDiscoveredStrand(node: CadreNode, strandId: string, sAppConfig: SAppConfig): Promise<StrandInstance> {
	const strandRow = await new Promise<StrandRow>((resolve) => {
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
	return await node.addStrand({ strandRow, sAppConfig, awaitFirstSync: false });
}

interface RestartOptions {
	/** Keep the frame cap and the busy event loop through the restart, instead of lifting them first. */
	slowRestart?: boolean;
}

/**
 * The third arm's journey up to the joiner's stop, then a restart of the joiner over the storage
 * it kept, on an undelayed link unless `slowRestart`. The founder must then hold every row.
 */
async function runJoinerRestartDelivers(opts: RestartOptions = {}): Promise<void> {
	let link: ReturnType<typeof installWsLatency> | undefined = installWsLatency({ delayMs: 20, mode: 'serial' });
	let release: (() => void) | undefined = occupyEventLoop(0.7);
	let relay: DedicatedRelay | undefined;
	let A: CadreNode | undefined;
	let B: CadreNode | undefined;
	const label = opts.slowRestart ? 'slow restart' : 'restart';
	try {
		const runTag = Date.now();
		const strandId = `strand-joiner-restart-${runTag}`;
		const sApp = createSignedSAppConfig(SCHEMA, '0.1.0');
		relay = await startDedicatedRelay();
		const aHome = await partyHome(`restart-a-${runTag}`);
		const bHome = await partyHome(`restart-b-${runTag}`);

		A = await startPartyNode(aHome, relay);
		await makeOwnOwner(A, aHome.key);
		const founded = await A.foundStrand({ strandId, type: 'c', memberPrivateKey: await generateStrandMemberKey(), sAppConfig: sApp });
		const aDb = founded.instance.database!.getDatabase();
		await aDb.exec(seatBatch('S', 'sid-a', 'key-a', 'Founder'), undefined, { transaction: true });
		const invitation = await A.createOpenInvitation(SAPP_ID, YEAR_MS);
		await A.publishFormationInvite(invitation.token, SAPP_ID, { strandId, expiresAtMs: Date.now() + YEAR_MS, totalUses: 1 });

		B = await startPartyNode(bHome, relay);
		await makeOwnOwner(B, bHome.key);
		const formResult = await B.formStrand(B.decodeInvitation(A.encodeInvitation(invitation)), {
			partyId: bHome.partyId,
			purpose: 'joiner restart delivers a write made alone',
		});
		await B.addStrand({
			strandRow: { Id: strandId, MemberPrivateKey: formResult.memberPrivateKey ?? null, Type: 'c', FounderOwnerKey: null },
			sAppConfig: sApp,
			awaitFirstSync: false,
		});
		const bStrand = await B.whenStrandWritable(strandId, { timeoutMs: FIRST_SYNC_MS });
		await bStrand.database!.getDatabase().exec(seatBatch('F', 'sid-b', 'key-b', 'Joiner'), undefined, { transaction: true });
		const stopping = B;
		B = undefined;
		await stopping.stop();
		// Logged, not asserted: once the joiner's first commit stops being made alone (the
		// third arm passing), this arm no longer exercises delivery after a restart.
		console.log(`[first-commit ${label}] founder held the joiner's rows when it stopped: ${await holdsJoinerSeat(aDb)}`);

		if (!opts.slowRestart) {
			release();
			release = undefined;
			link.restore();
			link = undefined;
		}
		const tRestart = Date.now();
		B = await startPartyNode(bHome, relay);
		await claimDiscoveredStrand(B, strandId, sApp);
		await waitUntil(() => holdsJoinerSeat(aDb),
			{ ...CONVERGE, description: "every row the joiner committed alone is readable on the founder after the joiner restarts" });
		console.log(`[first-commit ${label}] joiner's rows readable on the founder ${since(tRestart)} after the restart began`);
	} finally {
		await Promise.allSettled([B?.stop(), A?.stop()]);
		await relay?.stop();
		release?.();
		link?.restore();
	}
}

/** The founder's view of one commit, for the run output: who holds it, and whether it is followed. */
function describeCommit(commit: StrandCommitDurability | undefined): string {
	if (!commit) return 'no report recorded';
	const overall = commit.report.durability.overall;
	const holders = overall
		? `${overall.quorum} (${overall.confirmed}/${overall.cohort}, unconfirmed [${overall.unconfirmed?.join(', ') ?? '?'}], recordedBy ${overall.recordedBy ?? 'none'})`
		: 'holders unknown';
	return `${holders}, heldElsewhere ${commit.heldElsewhere}, followed ${commit.followed}`;
}

/**
 * Founder and joiner synced, the joiner stopped, then the founder writes one row alone. The founder
 * must report that commit held only on itself and followed, and once the joiner restarts over its
 * kept storage, report it held.
 */
async function runWriteMadeAloneReportedThenHeld(): Promise<void> {
	let relay: DedicatedRelay | undefined;
	let A: CadreNode | undefined;
	let B: CadreNode | undefined;
	const label = 'made alone';
	try {
		const runTag = Date.now();
		const strandId = `strand-commit-held-${runTag}`;
		const sApp = createSignedSAppConfig(SCHEMA, '0.1.0');
		relay = await startDedicatedRelay();
		const aHome = await partyHome(`held-a-${runTag}`);
		const bHome = await partyHome(`held-b-${runTag}`);

		A = await startPartyNode(aHome, relay);
		await makeOwnOwner(A, aHome.key);
		const founded = await A.foundStrand({ strandId, type: 'c', memberPrivateKey: await generateStrandMemberKey(), sAppConfig: sApp });
		const aStrand = founded.instance.database!;
		const aDb = aStrand.getDatabase();
		await aDb.exec(seatBatch('S', 'sid-a', 'key-a', 'Founder'), undefined, { transaction: true });
		const invitation = await A.createOpenInvitation(SAPP_ID, YEAR_MS);
		await A.publishFormationInvite(invitation.token, SAPP_ID, { strandId, expiresAtMs: Date.now() + YEAR_MS, totalUses: 1 });

		B = await startPartyNode(bHome, relay);
		await makeOwnOwner(B, bHome.key);
		const formResult = await B.formStrand(B.decodeInvitation(A.encodeInvitation(invitation)), {
			partyId: bHome.partyId,
			purpose: 'a write made alone is reported, then reported held',
		});
		await B.addStrand({
			strandRow: { Id: strandId, MemberPrivateKey: formResult.memberPrivateKey ?? null, Type: 'c', FounderOwnerKey: null },
			sAppConfig: sApp,
			awaitFirstSync: false,
		});
		const bStrandPeer = (await B.whenStrandWritable(strandId, { timeoutMs: FIRST_SYNC_MS })).libp2pNode!.peerId;
		const stopping = B;
		B = undefined;
		await stopping.stop();
		const aStrandNode = founded.instance.libp2pNode!;
		await waitUntil(() => !aStrandNode.getConnections().some(c => c.remotePeer.equals(bStrandPeer)),
			{ timeoutMs: 30_000, intervalMs: 100, description: "the founder's strand node to drop its connection to the stopped joiner's" });

		const held = new Set<string>();
		A.on('strand:commit-held', (event) => {
			if (event.strandId === strandId) held.add(event.transactionId);
		});
		// One statement is one commit, and its `returning` hands back that commit's id.
		const written = await aDb.get(`insert into App.Party (Sid, Name) values ('sid-a2', 'written alone') returning StampId() as Tx`);
		const tx = String(written!.Tx);
		const alone = aStrand.commitDurability(tx);
		console.log(`[first-commit ${label}] founder's write with the joiner stopped: ${describeCommit(alone)}`);
		expect({ heldElsewhere: alone?.heldElsewhere, followed: alone?.followed }, describeCommit(alone))
			.toEqual({ heldElsewhere: false, followed: true });

		const tRestart = Date.now();
		B = await startPartyNode(bHome, relay);
		const bInstance = await claimDiscoveredStrand(B, strandId, sApp);
		await waitUntil(() => held.has(tx),
			{ ...CONVERGE, description: "strand:commit-held for the founder's write made alone" })
			.catch(async (error: unknown) => {
				const joinerHolds = bInstance.database
					? (await rows(bInstance.database.getDatabase(), `select Sid from App.Party where Sid = 'sid-a2'`)).length > 0
					: 'not yet writable';
				console.log(`[first-commit ${label}] no strand:commit-held: founder records ${describeCommit(aStrand.commitDurability(tx))}; `
					+ `restarted joiner holds the row: ${joinerHolds}`);
				throw error;
			});
		console.log(`[first-commit ${label}] strand:commit-held ${since(tRestart)} after the joiner's restart began`);
		expect(aStrand.commitDurability(tx)?.heldElsewhere).toBe(true);
	} finally {
		await Promise.allSettled([B?.stop(), A?.stop()]);
		await relay?.stop();
	}
}

describe("a joiner's first transaction over a relayed link", () => {
	it('commits, and its rows outlive the joiner, on loopback', async () => {
		await runJoinerFirstCommit();
	}, 900_000);

	it('commits, and its rows outlive the joiner, with 100 ms of one-way latency', async () => {
		await runJoinerFirstCommit({ latency: { delayMs: 100, mode: 'pipelined' } });
	}, 1_800_000);

	// KNOWN FAILURE, kept as `it.fails` so the suite stays green while it reproduces: the joiner's
	// strand node holds only the relay connection when its strand becomes writable, commits with a
	// cohort of itself (`commit:solo-cohort`), and the rows are lost when it stops. When this arm
	// starts failing, the bug is fixed: make it a plain `it`.
	it.fails('commits, and its rows outlive the joiner, on a 20 ms frame cap with a 70%-busy event loop', async () => {
		await runJoinerFirstCommit({ latency: { delayMs: 20, mode: 'serial' }, eventLoopBusy: 0.7 });
	}, 1_800_000);

	it("delivers the rows of a commit made alone once the joiner restarts over its kept storage", async () => {
		await runJoinerRestartDelivers();
	}, 1_800_000);

	it("delivers the rows of a commit made alone once the joiner restarts over its kept storage, still on the slow link", async () => {
		await runJoinerRestartDelivers({ slowRestart: true });
	}, 1_800_000);

	it('tells the writer a commit made while the other member was stopped is held only here, then held once it returns', async () => {
		await runWriteMadeAloneReportedThenHeld();
	}, 900_000);
});
