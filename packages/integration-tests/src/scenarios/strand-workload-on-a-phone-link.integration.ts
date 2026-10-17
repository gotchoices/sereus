/**
 * An app's steady work on a two-party strand -- each side reading its tables, then writing a row --
 * on a phone-shaped link, against loopback. Reported as gotchoices/sereus#48, whose scenario this
 * is. What it shows: on the slow link, requests are abandoned to fixed deadlines while both members
 * are up and connected, and the abandoned requests are retried or re-asked, so the slower the link,
 * the more traffic.
 *
 * Found profiling Taleus (tallies on Sereus) with two Node clients on one machine:
 *
 * | Accepting an invitation | loopback | event loop 70% busy | 70% busy + 20 ms serial frame cap |
 * |---|---|---|---|
 * | time | 7.2 s | 20.1 s | 291 s (and later runs never finished) |
 * | reads asked of the cohort (both sides) | 599 | 678 | 1,198 |
 * | timeouts / retries | 0 / 2 | 0 / 2 | 241 / 184 |
 *
 * A busy CPU alone did the same work, slower. With the frame cap the counts grew. The 20 ms serial
 * cap with a 70%-busy event loop is `joiner-first-commit-over-slow-relay`'s phone arm: a phone's JS
 * thread, mostly occupied.
 *
 * Topology: the blind-relay pair (`blind-relay-phone-to-phone-e2e`): two relay-only parties, one
 * dedicated relay, a closed strand formed by bound invitation. Both arms are process-wide: the
 * frame cap (`harness/ws-latency.ts`) and the busy loop (`harness/event-loop-load.ts`) slow every
 * node and the relay alike.
 *
 * The workload: once both parties are seated (in `beforeAll`, so a setup failure fails the file
 * instead of passing the phone arm's `it.fails`; the joiner's seat is retried, `seatJoiner`),
 * `ROUNDS` rounds, alternating sides. One side writes a row; the other reads every table, one of
 * which (`CloseRequest`) nobody writes, as an app's often are. Each round is timed and every failed
 * operation recorded. Over the rounds, and only over them, the scenario counts:
 * - the stack's deadline events, from stderr, with `DEBUG` set (any copy of `debug` writes there,
 *   which is why stderr is hooked and not one `debug` instance), tallied by pattern and by the
 *   `debug` namespace of the line they appear in (`DEADLINE_EVENTS`);
 * - what the link carried: frames, the busiest dialed socket's frames, the worst observed send wait
 *   (`openWsFrameWindow`; on loopback only with `WS_FRAME_STATS=1`);
 * - the outbound streams each strand node opened, per protocol, libp2p's and FRET's upkeep included.
 * Afterwards it checks that each side holds every row the other committed.
 *
 * ── Running it ──
 *
 *   yarn workspace @serfab/integration-tests exec vitest run strand-workload-on-a-phone-link
 *   STRAND_WORKLOAD_PHONE=1 DEBUG='optimystic:*,libp2p:connection-monitor*' yarn workspace @serfab/integration-tests exec vitest run strand-workload-on-a-phone-link
 *   WS_FRAME_STATS=1 yarn workspace @serfab/integration-tests exec vitest run strand-workload-on-a-phone-link
 *
 * The loopback arm runs by default and takes seconds. The phone arm runs only with
 * `STRAND_WORKLOAD_PHONE=1`: minutes of seating, minutes of rounds and up to 180 s of convergence
 * waiting, about 10 minutes in all. It prints a line each minute a round is still running, so a
 * slow round does not leave a runner's idle timer with no output. `libp2p:connection-monitor*` is what logs the
 * ping failures. The debug lines are counted and dropped during the rounds; `WORKLOAD_SHOW_DEBUG=1`
 * passes them through as well, which matching events against the rounds' start times needs. The
 * third line is the workload's own demand on a link that holds nothing back; leave
 * `STRAND_WORKLOAD_PHONE` unset there, since `WS_FRAME_STATS` installs the frame counter when the
 * module loads and the phone arm's own install would then conflict with it.
 *
 * ── What the reporter measured (phone arm, two runs per stack) ──
 *
 * | | v1.15.0 (`a48cbdd4`), Optimystic 1.13.0 | v1.16.0, Optimystic 1.15.0, p2p-fret 1.1.0 |
 * |---|---|---|
 * | seated after joining | 103 s; 100 s | 108.0 s; 109.9 s |
 * | 8 rounds | 43, 75, 169, 11 s, then 0.01 s; 128, 167, 48, 20, 142, 0.7, 139, 0.8 s | 1 056.2 s; 602.6 s |
 * | failed operations | 5; 5 | rounds with one: 8; 6 |
 * | cohort silent / stream reset / commit retried / get retried | 72 / 32 / 10 / 8; 98 / 88 / 13 / 10 | 240 / 178 / 64 / 35; 184 / 75 / 29 / 20 |
 * | strand connections A→B after the rounds | not measured; 0 | 2; 0 |
 * | converged | not measured; no: B held two Invoice rows it had committed that A could not read | no; no |
 *
 * Loopback, every time: 8 rounds in 1-2 s, no deadline event, converged at once. Both stacks'
 * runs exempted failed reads of `CloseRequest`, the table nobody writes, which asked the network
 * (gotchoices/sereus#47); `strand-founder-commits-every-table-collection` gave it a collection from
 * founding, so reading it is local and the arms no longer exempt it.
 *
 * The failed operations: writes failing `Some peers did not complete: <peer>[block:…]` or `Block
 * default/app/<table> is unavailable (cohort-unreachable): the repo could not determine whether it
 * exists`, and reads failing the same way. In the Taleus runs, also `cohort-topic: protocol handler
 * failed … read timed out after 5000ms`.
 *
 * ── Measured 2026-10-17: sereus 1.16.0 (`9e16a3e8` plus this file), Optimystic 1.15.0 (`28e6e044`),
 *    p2p-fret 1.1.0 (`6c04166`), Node 24.2.0, one Windows machine ──
 *
 * The phone arm ran twice under `DEBUG='optimystic:*,libp2p:connection-monitor*'` with
 * `WORKLOAD_SHOW_DEBUG=1`. The first ended in setup failure before the seat was retried: the
 * joiner's seat transaction failed as a partial commit (`Seat` durable, `Party` not; "Failed to get
 * super-majority: 1/2 approvals", stream reset). The second:
 *
 * | | loopback | phone arm |
 * |---|---|---|
 * | seating | writable 0.7 s, seated 1.1-1.7 s after joining | writable 45.4 s after joining; seat transaction 94.4 s, first attempt; seated 163.9 s |
 * | rounds | 8 in 0.6-1.2 s | 90.6, 94.8, 3.1 s, then 0.01-0.02 s for each of the last five (188.6 s) |
 * | failed operations | 0 | 3: the writes of rounds 1-3, `Some peers did not complete`; no read failed |
 * | A's strand node's connections to B's after the rounds | 1 | 0 |
 * | converged within 180 s | at once | no: A held Ledger r5, r7; B held Invoice r4, r6, r8; r1-r3 on neither |
 *
 * Deadline events over the phone rounds, by `debug` namespace (node names as the run printed them;
 * FRET's and libp2p's namespaces carry no node). Zero: read timed out, get retried, transaction
 * expired, read-repair deferred, FRET peer revived (the peers FRET marked `dead` came back on a new
 * connection, logged as `peer:connect` then `contact run cleared`, which writes no `revived` line).
 * On loopback every count is zero except 7 read-repair consults on A's strand node.
 *
 * | event | count | where |
 * |---|---|---|
 * | read-repair consult | 309 | coordinator-repo: A control 116, B control 108 (every one `solo-self-skip`: each party's cadre is one machine, so none crossed the link), A strand 45, B strand 40 |
 * | FRET contact strike | 74 | fret:service:fret |
 * | cohort silent | 56 | coordinator-repo: A strand 32, B strand 24 |
 * | stream reset | 31 | sync-service:error 14, connection-monitor:error 5, cluster-service:error 5, fret 3, repo-service:error 3, batch-coordinator 1 |
 * | commit retried | 12 | batch-coordinator: 8 went to the next coordinator; 4 found none, the `no coordinator` row (the run printed 16, its pattern then also matching `retry:setup-failed`) |
 * | ping failure | 9 | connection-monitor:error |
 * | FRET peer marked dead | 5 | fret:service:fret (twice the relay, which FRET sees as a foreign peer; once A strand; twice B strand) |
 * | solo commit | 5 | coordinator-repo: B strand 3, A strand 2 |
 * | no coordinator | 4 | batch-coordinator |
 *
 * What the link carried over the rounds (`openWsFrameWindow`): loopback with `WS_FRAME_STATS=1`, two
 * runs, 7 427 and 7 503 frames (0.94 MB), busiest socket 3 778 and 3 806 frames (472 and 476 a
 * round); phone, 7 242 frames (0.27 MB), busiest socket 2 586 frames, worst observed send wait
 * 17 272 ms, though only rounds 1-3 crossed the link. `ws-latency`'s closing line for the whole phone
 * arm, seating and convergence included: 14 dialed sockets, 24 118 frames, busiest socket 5 211,
 * worst observed send wait 27 622 ms.
 *
 * Outbound streams the strand nodes opened over the rounds (the counter counts an open that
 * succeeded). Loopback: B sync 38, B cluster 32, A cluster 13, A sync 8, A dcutr 2, A block-transfer
 * 2, and one each of FRET ping, FRET neighbors and identify push from each side. Phone: circuit-relay
 * hop A 16, B 12; block-transfer B 9, A 5; sync B 8, A 2; libp2p ping A 7, B 5; cluster B 6, A 4;
 * repo 1 each; no FRET stream.
 *
 * The divergence, by the debug log's timestamps: through rounds 1-3 the connection monitor aborted a
 * strand or relay connection every 8-46 s (nine times), and the nodes redialled within about 5 s.
 * At 10:39:53.8 FRET marked A's strand node `dead` (its third contact strike), at 10:39:55.5 B's; the five
 * remaining rounds started at 10:39:57.0 and each committed with a cohort of only its writer
 * (`commit:solo-cohort`), which is every row that differs. The strand nodes reconnected at
 * 10:40:04, and the rows made alone were not exchanged in the 180 s that followed
 * (`blocked/optimystic-write-made-alone-owes-no-one`). Read repair did not heal them either: in
 * those 180 s every consult on both strand nodes (224) found the other silent, each block re-asked
 * about every 8 s, since a consult that finds the peer silent leaves the block unchecked.
 *
 * ── What the measurement calls for (`strand-workload-count-driven-fixes`) ──
 *
 * Seconds one round occupies the busiest socket at the cap's 20 ms a frame: loopback 9.4 and 9.5 s,
 * phone 17.2 s (2 586 frames over the 3 rounds that crossed the link, not 8). The busy event loop
 * releases fewer than 50 frames a second, so both understate. So 45% of what the phone socket
 * carried was beyond what the clean workload needed, and one clean round alone occupies the socket
 * longer than the 7 s a cohort peer gets to answer a read.
 *
 * Requests beyond the clean workload over those 3 rounds, both strand nodes, counting a consult as
 * one request and a retried write as three (pend, commit, broadcast). Shares exclude / include the
 * last two rows, FRET's and libp2p's own pings.
 *
 * | source | requests | share |
 * |---|---|---|
 * | read-repair consults beyond loopback's rate: 53 sent, all silent (32 more found a cohort of only the node itself and sent nothing; the other 3 `cohort silent` lines close consults started before round 1) | 50 | 43% / 26% |
 * | of those, re-asks of a block whose last consult to send a request went silent | 31 | 27% / 16% |
 * | of those, inside 81 s of the block's last check (what a strand read-repair window as long as the commit broadcast's retries would skip) | 16 | 14% / 8% |
 * | commit retries sent, 8 × 3 (an upper bound: one coordinated by a node whose ring had marked the peer `dead` commits alone) | 24 | 21% / 12% |
 * | read retries | 0 | 0 |
 * | circuit-relay hop streams: mostly the redials after the connection monitor's 9 aborts | 28 | 24% / 14% |
 * | block-transfer streams beyond loopback's rate | 13 | 11% / 7% |
 * | libp2p pings (streams opened) | 12 | excluded / 6% |
 * | FRET maintenance pings that failed against a strand node (contact strikes) | 67 | excluded / 35% |
 *
 * The streams the strand nodes opened for sync, cluster, repo and block transfer (36) were at the
 * rate the frame-counted loopback runs opened the same protocols for three rounds (35; the phone
 * run's own loopback arm opened 17): what grew was requests that never opened in time, redials and
 * pings. Proposals filed from this: `blocked/decide-link-deadlines-from-measured-response-time`
 * and `blocked/optimystic-retries-do-not-back-off`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { CadreNode, generateStrandMemberKey } from '@serfab/cadre-core';
import type { StrandInstance } from '@serfab/cadre-core';
import type { Database } from '@quereus/quereus';
import {
	waitUntil,
	controlNodeConfig,
	createSignedSAppConfig,
	makeOwnOwner,
	startDedicatedRelay,
	installWsLatency,
	openWsFrameWindow,
	occupyEventLoop,
	countOutboundStreams,
	type DedicatedRelay,
	type WsFrameWindowStats,
	type WsLatencyOptions,
} from '../harness/index.js';

const TABLES = ['Seat', 'Party', 'Ledger', 'Invoice', 'Terms', 'CloseRequest'] as const;
const SCHEMA = `
table Seat (Side text primary key, Sid text);
table Party (Sid text primary key, Name text);
table Ledger (Id text primary key, Body text);
table Invoice (Id text primary key, Body text);
table Terms (Id text primary key, Body text);
table CloseRequest (Id text primary key, Body text);
`;
const SAPP_ID = 'sapp-workload-phone-link';
const YEAR_MS = 365 * 24 * 3600_000;
/** Seating has taken 100-165 s on the phone arm. Bounds a hang; also the setup hook's timeout. */
const FIRST_SYNC_MS = 900_000;
/** Attempts at the joiner's seat; see {@link seatJoiner}. */
const SEAT_ATTEMPTS = 4;
const ROUNDS = 8;
const ROUNDS_TIMEOUT_MS = 3_600_000;
const CONVERGE_MS = 180_000;
/** Stopping two nodes and the relay on the phone link outlasts the default 30 s hook timeout. */
const TEARDOWN_MS = 120_000;
const PROGRESS_EVERY_MS = 60_000;

const PHONE_LINK: WsLatencyOptions = { delayMs: 20, mode: 'serial' };
const PHONE_EVENT_LOOP_BUSY = 0.7;

interface EventPattern {
	readonly label: string;
	readonly pattern: RegExp;
	/** A deadline fired, or what one leads to. Without `fault`, traffic or recovery to count beside them. */
	readonly fault: boolean;
}

/** The stack's signs of a request abandoned to a deadline, and of the traffic around them, as its debug output words them. */
const DEADLINE_EVENTS: readonly EventPattern[] = [
	{ label: 'read timed out', pattern: /read timed out after \d+ms/g, fault: true },
	{ label: 'get retried', pattern: /network-transactor get:retry/g, fault: true },
	{ label: 'cohort silent', pattern: /cluster-fetch:peers-silent/g, fault: true },
	{ label: 'stream reset', pattern: /StreamResetError/g, fault: true },
	{ label: 'transaction expired', pattern: /Transaction expired/g, fault: true },
	// Not `retry:setup-failed`: that retry found no coordinator and sent nothing (the `no coordinator` row).
	{ label: 'commit retried', pattern: /batch-coordinator retry peer=/g, fault: true },
	// A read of a held block last checked more than `readRepairWindowMs` ago (Optimystic's 10 s,
	// which cadre does not set) starts a background cohort consult: phone rounds outlast it. A
	// consult that finds the peer silent leaves the block unchecked, so the next read consults again.
	{ label: 'read-repair consult', pattern: /cluster-tx:read-repair-triggered/g, fault: false },
	{ label: 'read-repair deferred', pattern: /cluster-tx:read-repair-deferred/g, fault: false },
	// libp2p's connection monitor dropping a connection
	// (`blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline`).
	{ label: 'ping failure', pattern: /aborting connection due to ping failure/g, fault: true },
	{ label: 'no coordinator', pattern: /No coordinator available/g, fault: true },
	// A commit with a cohort of only itself: how the sides can end holding different rows while both run.
	{ label: 'solo commit', pattern: /commit:solo-cohort/g, fault: true },
	// FRET's 2 s maintenance ping failed (`blocked/fret-maintenance-deadlines-below-the-declared-link`).
	{ label: 'FRET contact strike', pattern: /change: contact strike/g, fault: true },
	// The strike that marks the peer `dead`, which takes it out of every cohort: FRET's
	// `deadAfterFailures` default, which Optimystic leaves. Also counted under the row above.
	{ label: 'FRET peer marked dead', pattern: /change: contact strike 3 on/g, fault: true },
	{ label: 'FRET peer revived', pattern: /revived - stabilization interval/g, fault: false },
];

/**
 * The start of a `debug` line written to a pipe: `<ISO time> <namespace> ` (no time under
 * `DEBUG_HIDE_DATE`). A message's later lines carry no prefix; they belong to the namespace above
 * them in the same write, since one `debug` call is one write.
 */
const DEBUG_LINE = /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z )?([\w.-]+(?::[\w.-]+)+) /;
const NO_NAMESPACE = '(no namespace)';
/** db-p2p's `createLogger` ends a namespace with the logging node's peer id, cut to this length. */
const NAMESPACE_PEER_ID_LENGTH = 12;

/** Peer-id prefixes as namespaces carry them, mapped to the node's name in this scenario. */
type NodeNames = ReadonlyMap<string, string>;

function nodeNames(nodes: ReadonlyArray<readonly [name: string, peerId: { toString(): string } | undefined]>): NodeNames {
	return new Map(nodes.flatMap(([name, peerId]) => peerId ? [[peerId.toString().substring(0, NAMESPACE_PEER_ID_LENGTH), name] as const] : []));
}

/** `optimystic:db-p2p:coordinator-repo:12D3KooWEYEn` → `optimystic:db-p2p:coordinator-repo [B strand]`. */
function nameNode(namespace: string, names: NodeNames): string {
	const segments = namespace.split(':');
	const named = segments.find(segment => names.has(segment));
	return named ? `${segments.filter(segment => segment !== named).join(':')} [${names.get(named)}]` : namespace;
}

/** Hits per event label, then per `debug` namespace. */
type EventHits = Map<string, Map<string, number>>;

function tallyChunk(hits: EventHits, text: string): void {
	let namespace = NO_NAMESPACE;
	for (const line of text.split('\n')) {
		namespace = DEBUG_LINE.exec(line)?.[1] ?? namespace;
		for (const { label, pattern } of DEADLINE_EVENTS) {
			const count = line.match(pattern)?.length ?? 0;
			if (count === 0) continue;
			const byNamespace = hits.get(label)!;
			byNamespace.set(namespace, (byNamespace.get(namespace) ?? 0) + count);
		}
	}
}

function countDeadlineEvents(): { hits: EventHits; stop(): void } {
	const hits: EventHits = new Map(DEADLINE_EVENTS.map(({ label }) => [label, new Map<string, number>()]));
	const write = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
		tallyChunk(hits, typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
		if (process.env.WORKLOAD_SHOW_DEBUG) return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
		// Keep the run readable: the counts are the point, not 100 000 debug lines. A writer
		// waiting on its callback still gets it.
		const callback = rest.find((arg): arg is () => void => typeof arg === 'function');
		if (callback) queueMicrotask(callback);
		return true;
	}) as typeof process.stderr.write;
	return { hits, stop: () => { process.stderr.write = write; } };
}

function sum(values: Iterable<number>): number {
	let total = 0;
	for (const value of values) total += value;
	return total;
}

function faultCount(hits: EventHits): number {
	return sum(DEADLINE_EVENTS.filter(e => e.fault).map(e => sum(hits.get(e.label)!.values())));
}

function describeEventHits(hits: EventHits, names: NodeNames): string {
	return [...hits].map(([label, byNamespace]) => {
		const where = [...byNamespace].sort((a, b) => b[1] - a[1]).map(([namespace, n]) => `${nameNode(namespace, names)} ${n}`).join(', ');
		return `  ${label}: ${sum(byNamespace.values())}${where ? ` (${where})` : ''}`;
	}).join('\n');
}

function describeFrames(frames: WsFrameWindowStats): string {
	if (!frames.instrumented) return 'not counted (set WS_FRAME_STATS=1 to count it on loopback)';
	return `${frames.frames} frames, ${frames.bytes} bytes; busiest socket ${frames.busiestSocketFrames} frames `
		+ `(${Math.round(frames.busiestSocketFrames / ROUNDS)} a round); worst observed send wait ${frames.worstSendWaitMs} ms`;
}

function describeStreams(streams: Map<string, number>): string {
	return [...streams].sort((a, b) => b[1] - a[1]).map(([key, n]) => `  ${key}: ${n}`).join('\n') || '  none';
}

async function rowCount(db: Database, sql: string): Promise<number> {
	let n = 0;
	for await (const _row of db.eval(sql)) n++;
	return n;
}

function since(t0: number): string {
	return `${((Date.now() - t0) / 1000).toFixed(1)} s`;
}

interface ArmOptions {
	/** Holds every outbound WebSocket frame in the process. */
	latency?: WsLatencyOptions;
	/** Fraction of every 100 ms this process's event loop is kept busy. */
	eventLoopBusy?: number;
}

/** Two parties seated on one strand, ready for the rounds. */
interface WorkloadFixture {
	readonly label: string;
	readonly aDb: Database;
	readonly bDb: Database;
	readonly aStrand: StrandInstance;
	readonly bStrand: StrandInstance;
	readonly names: NodeNames;
}

/** What setup started, undone in reverse. Filled as each piece starts, so a setup that times out still stops what it started. */
type Teardown = Array<() => unknown>;

async function tearDown(steps: Teardown): Promise<void> {
	for (const step of steps.splice(0).reverse()) {
		try {
			await step();
		} catch (error) {
			console.warn('[workload] teardown step failed: %s', error instanceof Error ? error.message : String(error));
		}
	}
}

async function startParty(partyId: string, relay: DedicatedRelay, teardown: Teardown): Promise<CadreNode> {
	const node = new CadreNode(controlNodeConfig({
		partyId,
		privateKey: await generateKeyPair('Ed25519'),
		listenAddrs: [],
		relayAddrs: [relay.dialAddr],
	}));
	teardown.push(() => node.stop());
	await node.start();
	await makeOwnOwner(node);
	return node;
}

/** Form the strand, seat both sides, and wait for B's seat to reach A. */
async function seatParties(label: string, opts: ArmOptions, teardown: Teardown): Promise<WorkloadFixture> {
	if (opts.latency) {
		const link = installWsLatency(opts.latency);
		teardown.push(() => link.restore());
	}
	if (opts.eventLoopBusy) teardown.push(occupyEventLoop(opts.eventLoopBusy));
	const runTag = Date.now();
	const strandId = `strand-workload-${runTag}`;
	const sApp = createSignedSAppConfig(SCHEMA, '0.1.0');
	const relay = await startDedicatedRelay();
	teardown.push(() => relay.stop());

	const A = await startParty(`workload-a-${runTag}`, relay, teardown);
	const founded = await A.foundStrand({ strandId, type: 'c', memberPrivateKey: await generateStrandMemberKey(), sAppConfig: sApp });
	const aDb = founded.instance.database!.getDatabase();
	await aDb.exec(`insert into App.Seat (Side, Sid) values ('S', 'sid-a'); insert into App.Party (Sid, Name) values ('sid-a', 'A'); insert into App.Terms (Id, Body) values ('t', 'terms');`, undefined, { transaction: true });
	const invitation = await A.createOpenInvitation(SAPP_ID, YEAR_MS);
	await A.publishFormationInvite(invitation.token, SAPP_ID, { strandId, expiresAtMs: Date.now() + YEAR_MS, totalUses: 1 });

	const bPartyId = `workload-b-${runTag}`;
	const B = await startParty(bPartyId, relay, teardown);
	const formed = await B.formStrand(B.decodeInvitation(A.encodeInvitation(invitation)), { partyId: bPartyId, purpose: 'workload on a phone link' });
	const tJoin = Date.now();
	await B.addStrand({
		strandRow: { Id: strandId, MemberPrivateKey: formed.memberPrivateKey ?? null, Type: 'c', FounderOwnerKey: null, FounderPeerId: null },
		sAppConfig: sApp,
		awaitFirstSync: false,
	});
	const bStrand = await B.whenStrandWritable(strandId, { timeoutMs: FIRST_SYNC_MS });
	console.log(`[workload ${label}] B writable ${since(tJoin)} after joining`);
	const bDb = bStrand.database!.getDatabase();
	await seatJoiner(label, bDb);
	await waitUntil(async () => (await rowCount(aDb, 'select Side from App.Seat')) === 2,
		{ timeoutMs: FIRST_SYNC_MS, intervalMs: 500, description: "B's seat reaches A" });
	console.log(`[workload ${label}] seated ${since(tJoin)} after joining`);
	const nodes = [
		['A strand', founded.instance.libp2pNode?.peerId],
		['B strand', bStrand.libp2pNode?.peerId],
		['A control', A.peerId],
		['B control', B.peerId],
		['relay', relay.peerId],
	] as const;
	// FRET's and libp2p's lines name peers in full and carry no node of their own, so a log is read against these.
	console.log(`[workload ${label}] nodes: ${nodes.map(([name, peerId]) => `${name} ${String(peerId)}`).join(', ')}`);
	return { label, aDb, bDb, aStrand: founded.instance, bStrand, names: nodeNames(nodes) };
}

/** The joiner's seat rows, each with the query that finds it already written. */
const JOINER_SEAT = [
	{ insert: `insert into App.Seat (Side, Sid) values ('F', 'sid-b');`, exists: `select Side from App.Seat where Side = 'F'` },
	{ insert: `insert into App.Party (Sid, Name) values ('sid-b', 'B');`, exists: `select Sid from App.Party where Sid = 'sid-b'` },
] as const;

/**
 * Write the joiner's seat in one transaction, retrying what is still missing. The joiner is
 * connected to the founder by the time it is writable, so on the phone link its first write can
 * fail like any round's (in the first measuring run it failed as a partial commit: `Seat` durable,
 * `Party` not), and without the seat there are no rounds to measure. Each failure is logged; the
 * last one fails setup.
 */
async function seatJoiner(label: string, db: Database): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		const started = Date.now();
		try {
			const missing: string[] = [];
			for (const row of JOINER_SEAT) {
				if ((await rowCount(db, row.exists)) === 0) missing.push(row.insert);
			}
			if (missing.length === 0) return;
			await db.exec(missing.join('\n'), undefined, { transaction: true });
			console.log(`[workload ${label}] B's seat written on attempt ${attempt}, in ${since(started)}`);
			return;
		} catch (error) {
			console.log(`[workload ${label}] B's seat, attempt ${attempt}, failed after ${since(started)}: ${(error as Error).message.slice(0, 200)}`);
			if (attempt >= SEAT_ATTEMPTS) throw error;
		}
	}
}

/**
 * Seat both parties in `beforeAll`, under the hook's own timeout, and stop everything in
 * `afterAll`. A seating step that throws is then a hook error that fails the file, where inside
 * an `it.fails` it would pass the arm while measuring nothing.
 */
function seatedWorkload(label: string, opts: ArmOptions = {}): () => WorkloadFixture {
	const teardown: Teardown = [];
	let fixture: WorkloadFixture | undefined;
	beforeAll(async () => { fixture = await seatParties(label, opts, teardown); }, FIRST_SYNC_MS);
	afterAll(() => tearDown(teardown), TEARDOWN_MS);
	return () => {
		if (!fixture) throw new Error(`[workload ${label}] not seated`);
		return fixture;
	};
}

interface RoundResult {
	startedAt: number;
	ms: number;
	failures: string[];
}

/** One round: `writer` writes one row, then `reader` reads every table. */
async function round(n: number, writer: Database, reader: Database): Promise<RoundResult> {
	const failures: string[] = [];
	const startedAt = Date.now();
	const table = n % 2 ? 'Ledger' : 'Invoice';
	try {
		await writer.exec(`insert into App.${table} (Id, Body) values ('r${n}', 'round ${n}');`, undefined, { transaction: true });
	} catch (error) {
		failures.push(`write ${table}: ${(error as Error).message.slice(0, 120)}`);
	}
	for (const name of TABLES) {
		try {
			await rowCount(reader, `select * from App.${name}`);
		} catch (error) {
			failures.push(`read ${name}: ${(error as Error).message.slice(0, 120)}`);
		}
	}
	return { startedAt, ms: Date.now() - startedAt, failures };
}

/** A round, with a line each minute it is still running: the debug output is swallowed meanwhile, and one round has taken 169 s. */
async function reportedRound(label: string, n: number, writer: Database, reader: Database): Promise<RoundResult> {
	const started = Date.now();
	const progress = setInterval(() => { console.log(`[workload ${label}] round ${n} still running, ${Math.round((Date.now() - started) / 1000)} s`); }, PROGRESS_EVERY_MS);
	try {
		return await round(n, writer, reader);
	} finally {
		clearInterval(progress);
	}
}

interface RoundsMeasured {
	hits: EventHits;
	frames: WsFrameWindowStats;
	streams: Map<string, number>;
}

/** Start every count the rounds are measured by; `stop` reads them and ends counting. */
function measureRounds(f: WorkloadFixture): { stop(): RoundsMeasured } {
	// Upkeep included: the question is what share of what the link carried the retries and consults took.
	// Started first: it is the one that can throw, and a throw after the stderr hook would leave it installed.
	const streams = countOutboundStreams([['A', f.aStrand.libp2pNode!], ['B', f.bStrand.libp2pNode!]], { ignore: () => false });
	const frames = openWsFrameWindow();
	const events = countDeadlineEvents();
	return {
		stop: () => {
			events.stop();
			const measured = { hits: events.hits, frames: frames.read(), streams: streams.take() };
			frames.close();
			streams.stop();
			return measured;
		},
	};
}

function reportRounds(f: WorkloadFixture, rounds: RoundResult[], measured: RoundsMeasured): void {
	const label = f.label;
	console.log(`[workload ${label}] ${rounds.length} rounds in ${(sum(rounds.map(r => r.ms)) / 1000).toFixed(1)} s`);
	console.log(`[workload ${label}] deadline events during the rounds, by debug namespace${process.env.DEBUG ? '' : ' (DEBUG unset, so none counted)'}:\n`
		+ describeEventHits(measured.hits, f.names));
	console.log(`[workload ${label}] link during the rounds: ${describeFrames(measured.frames)}`);
	console.log(`[workload ${label}] outbound streams the strand nodes opened during the rounds:\n${describeStreams(measured.streams)}`);
}

/** The rows of the two written tables, as one side sees them. */
async function written(db: Database): Promise<string> {
	const ids: string[] = [];
	for (const table of ['Ledger', 'Invoice']) {
		try {
			for await (const row of db.eval(`select Id from App.${table}`)) ids.push(`${table}:${String(row.Id)}`);
		} catch (error) {
			ids.push(`${table}:<${(error as Error).message.slice(0, 40)}>`);
		}
	}
	return ids.sort().join(',');
}

/** Whether, within `CONVERGE_MS`, each side holds every row the other committed. */
async function sidesConverge(f: WorkloadFixture): Promise<boolean> {
	const tConverge = Date.now();
	let converged = true;
	try {
		// A read that fails is not agreement, even when both sides fail alike.
		await waitUntil(async () => {
			const [a, b] = [await written(f.aDb), await written(f.bDb)];
			return a === b && !a.includes('<');
		}, { timeoutMs: CONVERGE_MS, intervalMs: 2000, description: 'both sides hold the same rows' });
	} catch (error) {
		console.log(`[workload ${f.label}] ${(error as Error).message}`);
		converged = false;
	}
	console.log(`[workload ${f.label}] ${converged ? `converged ${since(tConverge)} after the rounds` : `NOT converged after ${CONVERGE_MS / 1000} s`}`
		+ `\n  A sees ${await written(f.aDb)}\n  B sees ${await written(f.bDb)}`);
	return converged;
}

interface Workload {
	rounds: RoundResult[];
	/** Deadline events marked `fault` in {@link DEADLINE_EVENTS}; zero unless `DEBUG` is set. */
	faults: number;
	converged: boolean;
}

async function runWorkload(f: WorkloadFixture): Promise<Workload> {
	const measure = measureRounds(f);
	const rounds: RoundResult[] = [];
	let measured: RoundsMeasured;
	try {
		for (let n = 1; n <= ROUNDS; n++) {
			const result = n % 2 ? await reportedRound(f.label, n, f.aDb, f.bDb) : await reportedRound(f.label, n, f.bDb, f.aDb);
			rounds.push(result);
			console.log(`[workload ${f.label}] round ${n} (from ${new Date(result.startedAt).toISOString()}): ${result.ms} ms`
				+ (result.failures.length ? `; failed: ${result.failures.join(' | ')}` : ''));
		}
	} finally {
		measured = measure.stop();
	}
	reportRounds(f, rounds, measured);
	const aToB = f.aStrand.libp2pNode!.getConnections(f.bStrand.libp2pNode!.peerId).length;
	console.log(`[workload ${f.label}] after the rounds: A's strand node holds ${aToB} connection(s) to B's`);
	// Every committed row should end up on both sides; a commit made alone shows up here as a
	// difference that does not heal.
	const converged = await sidesConverge(f);
	return { rounds, faults: faultCount(measured.hits), converged };
}

describe("an app's steady work on a two-party strand, on loopback", () => {
	const seated = seatedWorkload('loopback');

	it('no operation fails, and both sides end holding the same rows', async () => {
		const workload = await runWorkload(seated());
		expect(workload.rounds.flatMap(r => r.failures)).toEqual([]);
		expect(workload.converged).toBe(true);
	}, ROUNDS_TIMEOUT_MS);
});

// Opt-in (see "Running it" above). Being opt-in, this `it.fails` does not flip by itself when a fix lands;
// the tickets that change a deadline name this run as their check.
describe.skipIf(!process.env.STRAND_WORKLOAD_PHONE)("an app's steady work on a two-party strand, on a phone-shaped link (20 ms serial frame cap, event loop 70% busy)", () => {
	const seated = seatedWorkload('phone', { latency: PHONE_LINK, eventLoopBusy: PHONE_EVENT_LOOP_BUSY });

	// Expected to fail today: with both members up and connected, requests are abandoned to fixed
	// deadlines and operations fail. When this passes, make it a plain `it`.
	it.fails('no operation fails while both members are up, and both sides end holding the same rows', async () => {
		const workload = await runWorkload(seated());
		expect(workload.rounds.flatMap(r => r.failures)).toEqual([]);
		expect(workload.converged).toBe(true);
		if (process.env.DEBUG) expect(workload.faults).toBe(0);
	}, ROUNDS_TIMEOUT_MS);
});
