/**
 * Relay round-trip MEASUREMENT — opt-in, and never part of `yarn test`.
 *
 * It answers one recurring question: what does one chat-shaped strand operation cost
 * two people who reach each other only through a relay? The answer is reported as
 * wall-clock time, streams opened per protocol per side, and direction changes on the
 * relayed party's link. `tickets/blocked/optimystic-strand-operations-cost-dozens-of-relay-round-trips`
 * is where the numbers land, and its dated paragraphs are the history.
 *
 * It is committed because the same measurement had been written from scratch three
 * times (optimystic `012573a2`, `cadcb919`, `9e5c1e85`), each copy deleted after use,
 * and the third re-measure could not tell a real change from a scenario difference
 * because of it. Comparability between runs is the whole point of the file: **change
 * what it measures only when you mean to make older numbers incomparable**, and say so
 * in the ticket that does it.
 *
 * It reproduces the numbers published before this file existed, including the one that
 * first looked like a break. The commit cost (4 `/cluster` streams per insert from
 * either party), the timings, the exchanges and the proxy totals all match. The split
 * between `/repo` and `/db-p2p/sync` on the joiner's insert LOOKS unstable — the first
 * session with this file recorded 1 `/repo` plus 1–3 sync where the deleted scenario
 * had recorded 2–3 `/repo` plus 0–1 sync — but that is the same per-run pattern the
 * `/cluster` counts show, not a scenario difference: two runs of `config1` on
 * 2026-09-23 produced `repo=3–4, sync=0` in one and `repo=1, sync=1–3` in the other,
 * reproducing BOTH published bands from one file. The split is fixed once per run at
 * bring-up and every rep of that run repeats it, so read it per run and compare bands,
 * never single reps.
 *
 * ── Running it ──
 *
 *   RELAY_RRT_MEASURE=1 yarn workspace @serfab/integration-tests exec vitest run relay-round-trip-measure
 *
 * Without `RELAY_RRT_MEASURE=1` the whole suite is skipped, which is what keeps it out
 * of the default run: four configurations at their default reps cost roughly seven
 * minutes. `RELAY_RRT_CONFIG=<name>[,<name>…]` runs a subset (the usual way to use it:
 * one config, several times), `RELAY_RRT_RUNS=<n>` repeats each selected config that
 * many times as separate runs — separate nodes, separate relay — which is the only
 * honest way to see run-to-run spread, and `RELAY_RRT_REPS` / `RELAY_RRT_DELAY_MS`
 * override a config's reps and its injected one-way delay.
 *
 * SKIPPED, not excluded. The default run still collects this file and imports it,
 * which costs one file slot — measured at 11 s of import on a Windows developer
 * machine, the same as any other scenario file, with no test body run. Excluding it
 * from `vitest.config.ts` unless the variable is set would buy that back and cost
 * more: `scripts/check-test-file-typecheck-coverage.mjs` only sees files Vitest
 * collects, so an excluded file silently leaves the gate that proves test files are
 * type-checked.
 *
 * ── The topology ──
 *
 * `blind-relay-phone-to-phone-e2e.integration.ts`'s, reduced to its measurable core:
 * a dedicated loopback relay; parties A and B, each ONE `CadreNode` with
 * `listenAddrs: []` and `enableRelay: false` (a phone relays for nobody and can accept
 * nothing), so every byte between them is relayed. A founds a closed strand on the
 * real chat schema and B, a stranger, forms and joins. A is always `profile:
 * 'transaction'`; B's profile is what config 2 varies.
 *
 * A's `relayAddrs` name a counting TCP proxy in front of the relay's WebSocket port
 * (`harness/counting-proxy.ts`), so "exchanges" are A's link only, and A carries a
 * gater that refuses direct dials to the relay's real port. B always talks to the relay
 * directly: only one party is instrumented, which is also what makes the delayed
 * configuration a SLOW PHONE talking to a fast peer rather than two slow ones.
 *
 * The gater is INSURANCE, not a reproduction. The ad-hoc measurements this file
 * replaces saw A open a second connection straight to the relay, after which the
 * proxy's counters went quiet — but that does not reproduce here: removing the gater
 * and running `config1` (1 and 3 reps) and `delayed` (2 reps) on 2026-09-23 left every
 * one of A's paths on the proxy port. It is kept because a bypass turns a delayed run
 * into an undelayed one without saying so, and because every published number was
 * taken with it. Do not expect deleting it to fail a run.
 *
 * ── What it asserts ──
 *
 * Only what makes a run invalid: that A went through the proxy (the relay's real port
 * appears in none of A's connection paths, and the proxy accepted at least one socket).
 * It has never been seen to fire — see the gater note above — and is checked at two
 * instants, setup and end, so a connection that opened and closed between them would
 * slip past it; the proxy totals are the cross-check for that.
 * Nothing here asserts a count or a duration. A budget test would have to be re-pinned
 * on every optimystic change, which is the opposite of what this file is for;
 * `docs/testing.md` → "Where measurements live" lists the budgets that do assert.
 * Operation failures — a `TornActionError` on a concurrent pair, say — are RECORDED and
 * printed, not thrown: an error rate is part of the measurement.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Libp2p } from 'libp2p';
import type { Database } from '@quereus/quereus';
import {
	CadreNode,
	ControlFormationUsageRecorder,
	generateStrandMemberKey,
	strandMemberKeyPair,
	summarizeConnectionPaths,
} from '@serfab/cadre-core';
import type { StrandRow } from '@serfab/cadre-core';
import {
	waitUntil,
	sleep,
	errorChainText,
	controlNodeConfig,
	createSignedSAppConfig,
	makeOwnOwner,
	startDedicatedRelay,
	startCountingProxy,
	denyDirectPortGate,
	tcpPortOf,
	countOutboundStreams,
	type DedicatedRelay,
	type CountingProxy,
	type StreamTally,
} from '../harness/index.js';
import { loadChatSimpleSchema } from '../fixtures/index.js';

const MEASURE = process.env.RELAY_RRT_MEASURE === '1';

interface MeasureConfig {
	/** One line for the run header — what this configuration is for. */
	readonly measures: string;
	/** The joining party's profile. A is always `transaction`. */
	readonly bProfile: 'transaction' | 'storage';
	/** Route A's relay link through the counting proxy? Required for `delayMs`. */
	readonly proxy: boolean;
	/** One-way delay injected on A's link, each direction (so 2× per round trip). */
	readonly delayMs: number;
	/** How many times the operation list runs. */
	readonly reps: number;
	/** Also time a sequential and a concurrent insert pair each rep. */
	readonly pairs: boolean;
}

/**
 * The four configurations the round-trip tickets report. Their names are the names the
 * tickets use, and their defaults are the reps those numbers were taken at — changing
 * a default silently makes a new run incomparable with the published ones.
 */
const CONFIGS: Record<string, MeasureConfig> = {
	config1: {
		measures: 'per-operation cost of a relayed two-party strand, both parties transaction',
		bProfile: 'transaction', proxy: true, delayMs: 0, reps: 5, pairs: false
	},
	delayed: {
		measures: 'the same, with 150 ms each way on A\'s link — what a phone on a real link pays per round trip',
		bProfile: 'transaction', proxy: true, delayMs: 150, reps: 3, pairs: false
	},
	config2: {
		measures: 'a storage-profile joiner, off the proxy, with concurrent insert pairs — the torn-write case',
		bProfile: 'storage', proxy: false, delayMs: 0, reps: 4, pairs: true
	},
	control: {
		measures: 'the control for config2: the same concurrent pairs with both parties transaction',
		bProfile: 'transaction', proxy: false, delayMs: 0, reps: 4, pairs: true
	},
};

/**
 * An integer override, or undefined when the variable is unset. Parsed strictly, and
 * only under `MEASURE` so a leftover variable cannot fail the skipped default run.
 * Leniency here has the one failure mode a measurement tool cannot afford: `Number`
 * turns a typo into `NaN`, `run <= NaN` is false, and the run reports a PASSING test
 * that measured nothing and printed nothing.
 */
function integerEnv(name: string, min: number): number | undefined {
	const raw = process.env[name];
	if (!MEASURE || raw === undefined || raw.trim() === '') return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min) {
		throw new Error(`${name} must be an integer >= ${min}, not ${JSON.stringify(raw)}`);
	}
	return value;
}

const SELECTED = (process.env.RELAY_RRT_CONFIG ?? Object.keys(CONFIGS).join(','))
	.split(',').map((name) => name.trim()).filter((name) => name.length > 0);
const RUNS = integerEnv('RELAY_RRT_RUNS', 1) ?? 1;
const REPS_OVERRIDE = integerEnv('RELAY_RRT_REPS', 1);
const DELAY_OVERRIDE_MS = integerEnv('RELAY_RRT_DELAY_MS', 0);

if (MEASURE) {
	const unknown = SELECTED.filter((name) => !(name in CONFIGS));
	if (unknown.length > 0) {
		throw new Error(`RELAY_RRT_CONFIG names no such configuration: ${unknown.join(', ')} (have: ${Object.keys(CONFIGS).join(', ')})`);
	}
}

/** Quiet window after each operation, in which trailing traffic is attributed to it. */
const SETTLE_MS = 3_000;
/** Quiet window between the end of setup and the first measured operation. */
const PRE_MEASURE_QUIET_MS = 5_000;
/** Budget for every setup gate. Generous: a delayed run's bring-up is slow by design. */
const GATE = { timeoutMs: 120_000, intervalMs: 250 } as const;
/** How long the run waits, after the last rep, for both sides to hold the same rows. */
const CONVERGE_MS = 30_000;

// ═════════════════════════════════════════════════════════════════════════════
// Reporting

interface OperationSample {
	readonly label: string;
	readonly ms: number;
	readonly exchanges: number;
	/** Streams opened during the operation, keyed `<side> <short protocol>`. */
	readonly streams: Map<string, number>;
	/** Exchanges in the settle window that followed the operation. */
	readonly settleExchanges: number;
	/** Streams opened in that settle window, same keys as {@link streams}. */
	readonly settleStreams: Map<string, number>;
}

/** `/optimystic/strand-<strandId>/db-p2p/sync/1.0.0` → `db-p2p/sync`. */
function shortProtocol(protocol: string, strandId: string): string {
	const withoutNetwork = protocol.startsWith(`/optimystic/strand-${strandId}/`)
		? protocol.slice(`/optimystic/strand-${strandId}/`.length)
		: protocol.replace(/^\//, '');
	return withoutNetwork.replace(/\/1\.0\.0$/, '');
}

function shortenKeys(counts: Map<string, number>, strandId: string): Map<string, number> {
	const short = new Map<string, number>();
	for (const [key, count] of counts) {
		const [side, ...protocolParts] = key.split(' ');
		const label = `${side} ${shortProtocol(protocolParts.join(' '), strandId)}`;
		short.set(label, (short.get(label) ?? 0) + count);
	}
	return short;
}

function formatStreams(counts: Map<string, number>): string {
	if (counts.size === 0) return '-';
	return [...counts].map(([key, count]) => `${key}=${count}`).join(' ');
}

function formatRange(values: number[]): string {
	const min = Math.min(...values);
	const max = Math.max(...values);
	return min === max ? String(min) : `${min}–${max}`;
}

/**
 * One cell: every protocol any rep opened in `pick`'s window, each with its range over
 * the reps. A protocol some reps did not open counts as zero in those reps, so `0–2`
 * and `2` mean different things.
 */
function streamCell(group: OperationSample[], pick: (sample: OperationSample) => Map<string, number>): string {
	const protocols = new Set<string>();
	for (const sample of group) for (const key of pick(sample).keys()) protocols.add(key);
	const cells = [...protocols].sort().map((key) =>
		`${key} ${formatRange(group.map((sample) => pick(sample).get(key) ?? 0))}`);
	return cells.length === 0 ? 'none' : cells.join(', ');
}

function groupByLabel(samples: OperationSample[]): Map<string, OperationSample[]> {
	const byLabel = new Map<string, OperationSample[]>();
	for (const sample of samples) {
		const group = byLabel.get(sample.label);
		if (group === undefined) byLabel.set(sample.label, [sample]);
		else group.push(sample);
	}
	return byLabel;
}

/**
 * The per-operation table the round-trip tickets are written from: one row per
 * operation, each column a range over this run's reps.
 *
 * The settle columns are the traffic that arrived in the quiet window AFTER the
 * operation returned — replication the commit caused but did not wait for. It belongs
 * in the table because the settle window exists to attribute it to the operation, and
 * it is a separate column because the operation's own cost is what the earlier
 * published numbers measured.
 */
function printSummary(samples: OperationSample[], say: (msg: string, ...args: unknown[]) => void): void {
	say('summary — each cell is the range over this run\'s reps');
	say('| Operation | ms | exchanges | streams opened | settle exch | settle streams |');
	say('|---|---|---|---|---|---|');
	for (const [label, group] of groupByLabel(samples)) {
		say('| %s | %s | %s | %s | %s | %s |',
			label,
			formatRange(group.map((sample) => sample.ms)),
			formatRange(group.map((sample) => sample.exchanges)),
			streamCell(group, (sample) => sample.streams),
			formatRange(group.map((sample) => sample.settleExchanges)),
			streamCell(group, (sample) => sample.settleStreams));
	}
}

// ═════════════════════════════════════════════════════════════════════════════
// Strand helpers

function nowTimestamp(): string {
	return new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

/**
 * Every `App.Message` id on one strand database, read by an unfiltered scan. A
 * where-equality on the primary key can MISS on a networked strand
 * (`debt-composite-pk-point-lookup-unreliable-untracked`), so row-presence checks here
 * scan and test membership rather than asking for one row.
 */
async function messageIds(db: Database): Promise<Set<string>> {
	const ids = new Set<string>();
	for await (const row of db.eval('select Id from App.Message')) ids.add(row.Id as string);
	return ids;
}

/** Row count of a scan — what a read costs is the point, not what it returns. */
async function scan(db: Database, sql: string): Promise<number> {
	let rows = 0;
	for await (const _row of db.eval(sql)) rows += 1;
	return rows;
}

async function insertMessage(db: Database, id: string, participantId: string): Promise<void> {
	await db.exec(
		`insert into App.Message (Id, ParticipantId, Content, Timestamp) values (?, ?, ?, ?)`,
		[id, participantId, id, nowTimestamp()],
	);
}

/** A node's connection paths as multiaddr strings, for the bypass check. */
function connectionPaths(node: Libp2p): string[] {
	return summarizeConnectionPaths(node.getConnections()).paths.map((path) => path.remoteAddr);
}

// ═════════════════════════════════════════════════════════════════════════════

/**
 * One measurement run: bring the topology up, wait for it to go quiet, then time each
 * operation in isolation with a settle window after it. Everything the run learned is
 * printed; nothing but an invalid run fails.
 */
async function measureRun(label: string, config: MeasureConfig): Promise<void> {
	const say = (msg: string, ...args: unknown[]): void => { console.log(`[RRT ${label}] ${msg}`, ...args); };
	const runTag = Date.now();
	const strandId = `strand-rrt-${runTag}`;
	const errors: string[] = [];
	const samples: OperationSample[] = [];

	let relay: DedicatedRelay | undefined;
	let proxy: CountingProxy | undefined;
	let streams: StreamTally | undefined;
	let A: CadreNode | undefined;
	let B: CadreNode | undefined;
	try {
		if (config.delayMs > 0 && !config.proxy) {
			throw new Error('delayMs needs the proxy: the delay is injected by the counting proxy on A\'s link');
		}
		const sApp = createSignedSAppConfig(await loadChatSimpleSchema(), '0.1.0');

		relay = await startDedicatedRelay();
		const relayPort = tcpPortOf(relay.dialAddr);
		proxy = config.proxy ? await startCountingProxy({ targetPort: relayPort, delayMs: config.delayMs }) : undefined;
		const aRelayAddr = proxy === undefined
			? relay.dialAddr
			: relay.dialAddr.replace(`/tcp/${relayPort}/`, `/tcp/${proxy.port}/`);
		say('%s', config.measures);
		say('relay real port %d, proxy port %s, delay %d ms, B profile %s, reps %d, pairs %s, strand %s',
			relayPort, proxy === undefined ? 'none' : String(proxy.port),
			config.delayMs, config.bProfile, config.reps, config.pairs, strandId);

		// ── A: founder, relay-only, its link instrumented ────────────────────
		const aKey = await generateKeyPair('Ed25519');
		A = new CadreNode(controlNodeConfig({
			partyId: `rrt-a-${runTag}`,
			privateKey: aKey,
			profile: 'transaction',
			enableRelay: false,
			listenAddrs: [],
			relayAddrs: [aRelayAddr],
			...(proxy === undefined ? {} : { connectionGater: denyDirectPortGate(relayPort) }),
		}));
		await A.start();
		await makeOwnOwner(A, aKey);
		A.initializeStrandSolicitation({
			formationUsageRecorder: new ControlFormationUsageRecorder(A.getControlDatabase()!),
		});

		const memberPrivateKey = await generateStrandMemberKey();
		const founded = await A.foundStrand({ strandId, type: 'c', memberPrivateKey, sAppConfig: sApp });
		const aStrandNode = founded.instance.libp2pNode!;
		const aDb = founded.instance.database!.getDatabase();

		const invitation = await A.createOpenInvitation('sapp-rrt', 365 * 24 * 3600_000);
		await A.publishFormationInvite(invitation.token, 'sapp-rrt', {
			strandId, expiresAtMs: Date.now() + 365 * 24 * 3600_000, totalUses: 1,
		});

		// ── B: the joiner, straight to the relay, profile per config ─────────
		const bKey = await generateKeyPair('Ed25519');
		B = new CadreNode(controlNodeConfig({
			partyId: `rrt-b-${runTag}`,
			privateKey: bKey,
			profile: config.bProfile,
			enableRelay: false,
			listenAddrs: [],
			relayAddrs: [relay.dialAddr],
			// The delayed configuration puts 300 ms of round trip under every message of
			// the join; the first-sync gate's default is a bring-up budget, not part of
			// what is measured, so it is pinned to this scenario's own budget rather than
			// left to track a library default the run does not control.
			strandFirstSync: { timeoutMs: GATE.timeoutMs },
		}));
		await B.start();
		await makeOwnOwner(B, bKey);

		const formResult = await B.formStrand(B.decodeInvitation(A.encodeInvitation(invitation)), {
			partyId: `rrt-b-${runTag}`, purpose: 'relay round-trip measurement',
		});
		const bStrandRow: StrandRow = {
			Id: strandId, MemberPrivateKey: formResult.memberPrivateKey ?? null, Type: 'c', FounderOwnerKey: null,
		};
		const bStrand = await B.addStrand({ strandRow: bStrandRow, sAppConfig: sApp, awaitFirstSync: false });
		const bStrandNode = bStrand.libp2pNode!;
		await B.whenStrandWritable(strandId, { timeoutMs: GATE.timeoutMs });
		const bDb = bStrand.database!.getDatabase();

		// Counting starts only once the JOIN has finished, not once the strand is
		// writable: the membership reconciler's own writes are bring-up traffic, and a
		// run that starts counting before them attributes them to its first operation.
		const bMemberKey = strandMemberKeyPair(
			(await B.getControlDatabase()!.queryStrandPartyKey(strandId))!).publicKeyB64;
		await waitUntil(
			async () => {
				for await (const row of bDb.eval('select MemberKey, PeerId from Strand.MemberPeer')) {
					if (row.MemberKey === bMemberKey && row.PeerId === bStrandNode.peerId.toString()) return true;
				}
				return false;
			},
			{ ...GATE, description: "B's own MemberPeer binding lands (the join is finished)" },
		);

		// The two chat participants every measured insert refers to. `App.Message` has a
		// foreign key to `App.Participant`, so these must be in place — and settled on
		// both sides — before the first insert is timed.
		await aDb.exec('insert into App.Participant (Id, Name, Role) values (?, ?, ?)', ['pa', 'A', 'owner']);
		await bDb.exec('insert into App.Participant (Id, Name, Role) values (?, ?, ?)', ['pb', 'B', 'member']);
		const bothParticipantsVisible = async (db: Database): Promise<boolean> =>
			await scan(db, 'select Id from App.Participant') >= 2;
		await waitUntil(async () => await bothParticipantsVisible(aDb) && await bothParticipantsVisible(bDb),
			{ ...GATE, description: 'both participants are visible on both sides' });

		say('quiet for %d s before counting', PRE_MEASURE_QUIET_MS / 1000);
		await sleep(PRE_MEASURE_QUIET_MS);

		// ── The instruments ──────────────────────────────────────────────────
		streams = countOutboundStreams([['A', aStrandNode], ['B', bStrandNode]]);
		// `streams` is the teardown's handle and so is nullable for its whole scope;
		// `tally` is the same object, non-null, for the code below to use.
		const tally = streams;

		/**
		 * A run where A reached the relay directly measured a link nobody was watching,
		 * so its numbers mean nothing — the one thing worth failing on.
		 */
		const expectNoBypass = (when: string): void => {
			const paths = [...connectionPaths(aStrandNode), ...connectionPaths(A!.getControlNode()!)];
			say('A paths %s: %s', when, paths.join(' | '));
			if (proxy === undefined) return;
			for (const path of paths) {
				expect(path, `A bypassed the counting proxy ${when}`).not.toContain(`/tcp/${relayPort}/`);
			}
			expect(proxy.socketCount(), 'A opened no socket through the counting proxy').toBeGreaterThan(0);
		};
		expectNoBypass('at setup');

		const measure = async (operationLabel: string, rep: number, run: () => Promise<void>): Promise<void> => {
			tally.take();
			const errorsBefore = errors.length;
			const exchangesBefore = proxy?.exchanges() ?? 0;
			const started = Date.now();
			try {
				await run();
			} catch (error) {
				errors.push(`${operationLabel}: ${errorChainText(error)}`);
			}
			const ms = Date.now() - started;
			const during = shortenKeys(tally.take(), strandId);
			const exchanges = (proxy?.exchanges() ?? 0) - exchangesBefore;
			const settleFrom = proxy?.exchanges() ?? 0;
			await sleep(SETTLE_MS);
			const after = shortenKeys(tally.take(), strandId);
			const settleExchanges = (proxy?.exchanges() ?? 0) - settleFrom;
			const raised = errors.slice(errorsBefore);
			say('rep%d %s | %d ms | exch %d | during: %s | after(%d exch): %s%s',
				rep, operationLabel, ms, exchanges, formatStreams(during),
				settleExchanges, formatStreams(after),
				raised.length === 0 ? '' : ` | ERROR ${raised.join('; ')}`);
			samples.push({ label: operationLabel, ms, exchanges, streams: during, settleExchanges, settleStreams: after });
		};

		// ── The operation list, one rep at a time ────────────────────────────
		for (let rep = 1; rep <= config.reps; rep++) {
			say('── rep %d ──', rep);
			await measure('A-insert', rep, () => insertMessage(aDb, `a-${rep}-${runTag}`, 'pa'));
			await measure('B-insert', rep, () => insertMessage(bDb, `b-${rep}-${runTag}`, 'pb'));
			await measure('A-read-Message', rep, async () => { await scan(aDb, 'select Id, Content from App.Message'); });
			await measure('B-read-Message', rep, async () => { await scan(bDb, 'select Id, Content from App.Message'); });
			await measure('B-read-Participant', rep, async () => { await scan(bDb, 'select Id, Name from App.Participant'); });
			await measure('B-read-Message-again', rep, async () => { await scan(bDb, 'select Id, Content from App.Message'); });
			if (!config.pairs) continue;

			// A sequential pair is the yardstick the concurrent pair is read against:
			// the same two inserts, one after the other, so the extra cost of the
			// concurrent one is the cost of losing and re-driving a commit.
			await measure('seq-pair', rep, async () => {
				await insertMessage(aDb, `sa-${rep}-${runTag}`, 'pa');
				await insertMessage(bDb, `sb-${rep}-${runTag}`, 'pb');
			});
			const concurrentIds = [`ca-${rep}-${runTag}`, `cb-${rep}-${runTag}`];
			await measure('conc-pair', rep, async () => {
				const outcomes = await Promise.allSettled([
					insertMessage(aDb, concurrentIds[0]!, 'pa'),
					insertMessage(bDb, concurrentIds[1]!, 'pb'),
				]);
				for (const outcome of outcomes) {
					if (outcome.status === 'rejected') errors.push(`conc-pair rep${rep}: ${errorChainText(outcome.reason)}`);
				}
			});
			// A commit that REPORTED failure may still have landed, and one that reported
			// success may not have — both have been seen here, so each pair's rows are
			// checked by id on both sides rather than inferred from the outcome.
			const [onA, onB] = [await messageIds(aDb), await messageIds(bDb)];
			say('rep%d conc-pair rows: on A %s, on B %s', rep,
				concurrentIds.map((id) => `${id}:${onA.has(id)}`).join(' '),
				concurrentIds.map((id) => `${id}:${onB.has(id)}`).join(' '));
		}

		// ── Closing state ────────────────────────────────────────────────────
		let converged = false;
		await waitUntil(async () => {
			const [idsA, idsB] = [await messageIds(aDb), await messageIds(bDb)];
			converged = idsA.size === idsB.size && [...idsA].every((id) => idsB.has(id));
			return converged;
		}, { timeoutMs: CONVERGE_MS, intervalMs: 500, description: 'both sides hold the same Message rows' })
			.catch(() => { /* a run that never converges still reports everything it measured */ });
		say('final convergence: %s (A %d rows, B %d rows)', converged,
			(await messageIds(aDb)).size, (await messageIds(bDb)).size);
		if (proxy !== undefined) {
			say('proxy totals: %d exchanges, %d bytes, %d sockets', proxy.exchanges(), proxy.bytes(), proxy.socketCount());
		}
		say('errors (%d):%s', errors.length, errors.length === 0 ? '' : `\n  ${errors.join('\n  ')}`);
		printSummary(samples, say);
		// Last, not first: a bypassed run's numbers are void, but they are also the only
		// evidence for where it went wrong, so print everything before failing on it.
		expectNoBypass('at the end');
	} finally {
		// Before the nodes stop, so no wrapper outlives the tally it writes into.
		streams?.stop();
		await Promise.allSettled([B?.stop(), A?.stop()]);
		await proxy?.stop();
		await relay?.stop();
	}
}

describe.runIf(MEASURE)('relay round-trip measurement (opt-in: RELAY_RRT_MEASURE=1)', () => {
	for (const name of SELECTED) {
		const config: MeasureConfig = {
			...CONFIGS[name]!,
			...(REPS_OVERRIDE === undefined ? {} : { reps: REPS_OVERRIDE }),
			...(DELAY_OVERRIDE_MS === undefined ? {} : { delayMs: DELAY_OVERRIDE_MS }),
		};
		// An upper bound on a run that has hung, not a target: a healthy run is a few
		// minutes. Each operation costs its own time plus the settle window, and bring-up
		// dominates the constant.
		const budgetMs = RUNS * (120_000 + config.reps * (config.pairs ? 8 : 6) * (SETTLE_MS + 7_000));
		it(`${name}: ${config.measures}`, async () => {
			for (let run = 1; run <= RUNS; run++) {
				await measureRun(RUNS === 1 ? name : `${name}/run${run}`, config);
			}
		}, budgetMs);
	}
});
