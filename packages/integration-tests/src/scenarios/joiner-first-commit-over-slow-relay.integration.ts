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
 * What the third arm shows: on the slow link the joiner's strand becomes writable after about 45 s
 * while still connected to the founder's strand node, because the founder creates every declared
 * table's collection when it founds the strand (`strand-founder-commits-every-table-collection`).
 * The joiner's first commit therefore goes to a cohort of both members and needs both approvals.
 * The drop cycle below resets the founder's leg while the commit is in flight, and the commit
 * fails with "Failed to get super-majority: 1/2 approvals": the app is told, and can retry. It
 * logs how long each step took and every node's peer id, so a run's `DEBUG=optimystic:db-p2p:*`
 * log can be read against them.
 *
 * Why the strand nodes keep losing each other on that link: an outbound frame waits 10 to 22 s in
 * its socket's queue, so a liveness ping can outlast the pinging node's 30 s deadline, and its
 * monitor aborts the connection. Every node here answers pings for 60 s (Optimystic derives the
 * handler timeout from the monitor deadline), so the pinging side's own deadline is what fires:
 * 8 of the 14 aborts in one run on 2026-10-20 were that deadline, 4 were stream resets and 2 an
 * early end of stream, none traced further. A deadline that stretches to the measured response
 * time is `blocked/decide-link-deadlines-from-measured-response-time`. Between the two strand
 * nodes an abort drops their circuit; from the relay, whose monitor pings each strand node, it
 * drops that node's relay connection and every circuit on it, and the member redial
 * (`strand-peer-redial.ts`) reconnects them after its 21.5 s backoff. The harness relay carries
 * the deployed relay's monitor, limits and ping handler (`harness/dedicated-relay.ts`).
 *
 * The fourth arm is the restart the phones also tried, of a joiner that wrote alone. The lone
 * commit is made on purpose: once the joiner is writable, the founder takes its strand offline
 * (`hibernateStrand`, the mobile background-entry path, which stops its strand node and keeps its
 * store), and the joiner waits until its strand node has dropped the connection and its FRET ring
 * no longer holds the founder live. Optimystic builds a block's cohort from that ring, and the
 * founder's leave notice can be lost in the link's queue; a run of failed contacts then marks it
 * dead, about 19 s later in three runs. The joiner's seat batch is then a commit made alone, and
 * its report must say it is held nowhere else. The joiner stops; the founder wakes its strand over
 * its kept store; the joiner is rebuilt over the storage it kept (raw stores, saved strand network
 * state, joined-strand record) and re-claims the strand; and the founder must then hold every row.
 * Everything up to the joiner's stop runs on the slow link, the wake and the restart on an
 * undelayed one: there peer-join backfill from the restarted joiner delivered the rows 0.8 s after
 * the restart began, in two runs.
 *
 * The fifth arm runs the wake and the restart on the slow link too, the frame cap and the busy
 * event loop still in force. There FRET's maintenance pings cannot reconnect the two strand nodes
 * -- each is allowed 2 s, dial included, and a relayed dial on that link takes longer -- so what
 * reconnects them is the strand member redial, which dials with the relayed-dial budget the
 * declared link gives (`strand-peer-redial.ts`). The rows reached the founder 37 s and 38 s after
 * the restart began, in two runs.
 *
 * The sixth arm checks what the app is told about a write made alone (docs/strands.md, "A commit's
 * durability"), on an undelayed link: with the joiner stopped, the founder writes one row, and its
 * strand database must report that commit held only here and followed; once the joiner restarts
 * over its kept storage and takes the copies it is owed, the founder must emit `strand:commit-held`
 * for it.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Libp2p, PeerId, PrivateKey } from '@libp2p/interface';
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
	occupyEventLoop,
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

/**
 * Generous on purpose: the arm reports how long each step took; a gate only bounds a hang.
 *
 * NOTE: the slow-link arms' first sync takes about 45 s. If one times out here, look at the drop
 * cycle (the connection monitor's aborts, see the header) and the saturated link before raising
 * this. A first sync past 600 s would keep the third arm's `it.fails` green
 * for the wrong reason.
 */
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
		await makeOwnOwner(A);
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
		await makeOwnOwner(B);
		const formResult = await B.formStrand(B.decodeInvitation(encoded), {
			partyId: `first-commit-b-${runTag}`,
			purpose: 'joiner first commit over a slow relay',
		});
		const bStrandRow: StrandRow = {
			Id: strandId,
			MemberPrivateKey: formResult.memberPrivateKey ?? null,
			Type: 'c',
			FounderOwnerKey: null,
			FounderPeerId: null,
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
		// the joiner made alone (optimystic's `commit:solo-cohort`) exists nowhere else while the
		// joiner is stopped.
		await B.stop();
		const tReach = Date.now();
		await waitUntil(() => holdsJoinerSeat(aDb),
			{ ...CONVERGE, description: "every row of the joiner's committed transaction is readable on the founder after the joiner stops" });
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
	/** Keep the frame cap and the busy event loop through the founder's wake and the joiner's restart, instead of lifting them first. */
	slowRestart?: boolean;
}

/**
 * Run `sql` as one transaction on `node`'s strand database `db`, and return the report of the
 * commit that wrote `table` (qualified, as `schema.table`). A multi-statement batch has no
 * `returning StampId()` to name its commit, so the report is picked from the node's
 * `strand:commit-durability` events by the table it wrote; cadre-core's own membership writes
 * report there too.
 */
async function execReported(node: CadreNode, strandId: string, db: Database, sql: string, table: string): Promise<StrandCommitDurability | undefined> {
	let reported: StrandCommitDurability | undefined;
	const onCommit = (commit: StrandCommitDurability): void => {
		if (commit.strandId === strandId && [...commit.report.tables.keys()].some(t => t.toLowerCase() === table.toLowerCase())) {
			reported = commit;
		}
	};
	node.on('strand:commit-durability', onCommit);
	try {
		await db.exec(sql, undefined, { transaction: true });
	} finally {
		node.off('strand:commit-durability', onCommit);
	}
	return reported;
}

/** The slice of FRET's routing-table export read here (`SerializedTable` in `p2p-fret`). */
interface FretTableView {
	exportTable(): { entries: ReadonlyArray<{ id: string; state: string; membership?: string }> };
}

function isFretTableView(service: unknown): service is FretTableView {
	return typeof (service as Partial<FretTableView> | undefined)?.exportTable === 'function';
}

/**
 * Whether `node`'s FRET ring holds `peer` as a live member: FRET's `isLiveMember`, the rule
 * Optimystic assembles a block's cohort by. A peer this answers false for is left out of every
 * cohort, so a commit with no other live member is made alone.
 */
function ringHoldsLive(node: Libp2p, peer: PeerId): boolean {
	const fret = node.services.fret;
	if (!isFretTableView(fret)) throw new Error('the strand node runs no FRET service');
	const entry = fret.exportTable().entries.find(e => e.id === peer.toString());
	return entry?.membership === 'member' && entry.state !== 'dead';
}

/**
 * Take the founder's strand offline (`hibernateStrand`, the mobile background-entry path: its
 * strand node stops, its store and control node stay) and wait until the joiner's strand node has
 * lost it, so the joiner's next commit is made alone. Losing the connection is not enough: the
 * founder's leave notice can be lost in a slow link's queue, and until a run of failed contacts
 * marks it dead the joiner's ring still puts it in every cohort.
 */
async function hibernateFounderStrand(A: CadreNode, joiner: StrandInstance, founderStrandPeer: PeerId, label: string): Promise<void> {
	const strandId = joiner.strandId;
	const joinerNode = joiner.libp2pNode!;
	const tHibernate = Date.now();
	await A.hibernateStrand(strandId);
	// `hibernateStrand` does nothing to a strand whose latency hint never hibernates.
	expect(A.getStrand(strandId)?.status, "the founder's strand hibernated").toBe('hibernating');
	const hibernated = since(tHibernate);
	const tCut = Date.now();
	await waitUntil(() => !joinerNode.getConnections().some(c => c.remotePeer.equals(founderStrandPeer)),
		{ timeoutMs: 120_000, intervalMs: 100, description: "the joiner's strand node to drop its connection to the founder's hibernated one" });
	const disconnected = since(tCut);
	await waitUntil(() => !ringHoldsLive(joinerNode, founderStrandPeer),
		{ timeoutMs: 180_000, intervalMs: 100, description: "the joiner's FRET ring to stop holding the founder's hibernated strand node live" });
	console.log(`[first-commit ${label}] founder's strand (${founderStrandPeer}) hibernated in ${hibernated}; after that, `
		+ `the joiner lost its connection within ${disconnected} and left it out of its ring within ${since(tCut)}`);
}

/**
 * The founder hibernates its strand once the joiner is writable, so the joiner's seat batch is a
 * commit made alone; the joiner stops; the founder wakes its strand over its kept store; then the
 * joiner restarts over the storage it kept and re-claims the strand. The founder must then hold
 * every row. Everything up to the joiner's stop runs under the frame cap and the busy event loop;
 * the wake and the restart run on an undelayed link unless `slowRestart`.
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
		await makeOwnOwner(A);
		const founded = await A.foundStrand({ strandId, type: 'c', memberPrivateKey: await generateStrandMemberKey(), sAppConfig: sApp });
		const founderStrandPeer = founded.instance.libp2pNode!.peerId;
		await founded.instance.database!.getDatabase().exec(seatBatch('S', 'sid-a', 'key-a', 'Founder'), undefined, { transaction: true });
		const invitation = await A.createOpenInvitation(SAPP_ID, YEAR_MS);
		await A.publishFormationInvite(invitation.token, SAPP_ID, { strandId, expiresAtMs: Date.now() + YEAR_MS, totalUses: 1 });

		B = await startPartyNode(bHome, relay);
		await makeOwnOwner(B);
		const formResult = await B.formStrand(B.decodeInvitation(A.encodeInvitation(invitation)), {
			partyId: bHome.partyId,
			purpose: 'joiner restart delivers a write made alone',
		});
		const tJoin = Date.now();
		await B.addStrand({
			strandRow: { Id: strandId, MemberPrivateKey: formResult.memberPrivateKey ?? null, Type: 'c', FounderOwnerKey: null, FounderPeerId: null },
			sAppConfig: sApp,
			awaitFirstSync: false,
		});
		const bStrand = await B.whenStrandWritable(strandId, { timeoutMs: FIRST_SYNC_MS });
		console.log(`[first-commit ${label}] joiner writable after ${since(tJoin)}`);

		await hibernateFounderStrand(A, bStrand, founderStrandPeer, label);
		const alone = await execReported(B, strandId, bStrand.database!.getDatabase(), seatBatch('F', 'sid-b', 'key-b', 'Joiner'), 'App.Seat');
		console.log(`[first-commit ${label}] joiner's seat with the founder's strand hibernated: ${describeCommit(alone)}`);
		expect(alone?.heldElsewhere, describeCommit(alone)).toBe(false);
		const stopping = B;
		B = undefined;
		await stopping.stop();

		if (!opts.slowRestart) {
			release();
			release = undefined;
			link.restore();
			link = undefined;
		}
		const tWake = Date.now();
		await A.wakeStrand(strandId);
		console.log(`[first-commit ${label}] founder's strand awake after ${since(tWake)}`);
		// The wake rebuilt the founder's strand database over its kept store.
		const aDb = A.getStrand(strandId)!.database!.getDatabase();
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
		await makeOwnOwner(A);
		const founded = await A.foundStrand({ strandId, type: 'c', memberPrivateKey: await generateStrandMemberKey(), sAppConfig: sApp });
		const aStrand = founded.instance.database!;
		const aDb = aStrand.getDatabase();
		await aDb.exec(seatBatch('S', 'sid-a', 'key-a', 'Founder'), undefined, { transaction: true });
		const invitation = await A.createOpenInvitation(SAPP_ID, YEAR_MS);
		await A.publishFormationInvite(invitation.token, SAPP_ID, { strandId, expiresAtMs: Date.now() + YEAR_MS, totalUses: 1 });

		B = await startPartyNode(bHome, relay);
		await makeOwnOwner(B);
		const formResult = await B.formStrand(B.decodeInvitation(A.encodeInvitation(invitation)), {
			partyId: bHome.partyId,
			purpose: 'a write made alone is reported, then reported held',
		});
		await B.addStrand({
			strandRow: { Id: strandId, MemberPrivateKey: formResult.memberPrivateKey ?? null, Type: 'c', FounderOwnerKey: null, FounderPeerId: null },
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

	// KNOWN FAILURE, kept as `it.fails` so the suite stays green while it reproduces: on this link
	// the joiner is connected to the founder when its strand becomes writable, so its first commit
	// goes to both members, and it fails with "Failed to get super-majority: 1/2 approvals" when the
	// ping drop cycle (see the header) resets the founder's leg. When this `it.fails` turns red, the
	// arm passes: that drop cycle no longer cuts a commit on this link, so make it a plain `it`.
	// NOTE: failed in 2 of 2 runs (2026-10-17), and in the 2026-10-20 run with every node's ping
	// handler at 60 s, but only because a drop landed while the commit was in flight; if it turns red
	// once and not on a rerun, the commit missed a drop by timing.
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
