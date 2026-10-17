/**
 * What a READ costs on a two-party strand over a relay — the read path of an app whose every
 * screen and background step queries a handful of tables, some of which nobody has written yet.
 *
 * Found on two phones (a Galaxy S7 and an Android emulator) running the Taleus tally app over the
 * public relay (gotchoices/sereus#47): reads of tables nobody had written each consulted the other
 * member, so with both connected a query took seconds, and with the other member offline it threw
 * `BlockUnavailableError` (`cohort-unreachable`). A table with no collection cannot be shown empty
 * by any one machine: only the block's cohort can say it is absent, and Optimystic asks it again on
 * every read. The founder therefore commits an empty collection for every declared table before it
 * writes the strand's Header (docs/strands.md, "Joining: no writes before the first sync"), and
 * peer-join backfill hands those collections to every joiner.
 *
 * What it asserts: with the other member connected, no read of any `App` or `Strand` table on
 * either side is slower than {@link LOCAL_READ_MS}, which a relayed round trip on the 100 ms link
 * cannot meet; and with the joiner stopped, every read on the founder succeeds. `App.CloseRequest`,
 * `Strand.Revocation` and `Strand.CancelledInvite` are the tables nothing in the journey writes.
 *
 * Topology: the blind-relay pair (`blind-relay-phone-to-phone-e2e`): two relay-only parties,
 * one dedicated relay, a closed strand formed by bound invitation. The founder writes a row into
 * most tables, the joiner syncs and takes its seat, so both hold every block before anything is
 * measured. The offline half runs on the 100 ms link too: on loopback, whether a lone founder
 * answers a never-written table "absent" or "unknown" depends on timing.
 *
 * Arms: 100 ms pipelined (`harness/ws-latency.ts`), and, opt-in with `READ_COST_PHONE=1` because
 * its first sync takes minutes, the phone-shaped link of `joiner-first-commit-over-slow-relay`:
 * a 20 ms serial frame cap and a 70%-busy event loop.
 *
 *   yarn workspace @serfab/integration-tests exec vitest run strand-read-cost-over-relay
 *   READ_COST_PHONE=1 yarn workspace @serfab/integration-tests exec vitest run strand-read-cost-over-relay -t phone
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { CadreNode, generateStrandMemberKey } from '@serfab/cadre-core';
import type { StrandRow } from '@serfab/cadre-core';
import type { Database } from '@quereus/quereus';
import type { Libp2p } from 'libp2p';
import {
	waitUntil,
	controlNodeConfig,
	createSignedSAppConfig,
	makeOwnOwner,
	startDedicatedRelay,
	installWsLatency,
	countOutboundStreams,
	type DedicatedRelay,
	type WsLatencyOptions,
} from '../harness/index.js';

const APP_TABLES = ['Seat', 'Party', 'PartyKey', 'Terms', 'Contract', 'Ledger', 'Invoice', 'CloseRequest', 'Trading'] as const;
const STRAND_TABLES = ['Header', 'Member', 'Manager', 'MemberPeer', 'Invite', 'ConsumedInvite', 'CancelledInvite', 'Revocation'] as const;
/** Every table a read pass reads, as the SQL names it. */
const TABLES = [
	...APP_TABLES.map(table => `App.${table}`),
	...STRAND_TABLES.map(table => `Strand."${table}"`),
];

const SCHEMA = `
table Seat (Side text primary key, Sid text);
table Party (Sid text primary key, Name text);
table PartyKey (Sid text, PublicKey text, primary key (Sid, PublicKey));
table Terms (Id text primary key, Body text);
table Contract (Id text primary key, Body text);
table Ledger (Id text primary key, Body text);
table Invoice (Id text primary key, Body text);
table CloseRequest (Id text primary key, Body text);
table Trading (Id text primary key, Body text);
`;

const SAPP_ID = 'sapp-read-cost';
const YEAR_MS = 365 * 24 * 3600_000;
const FIRST_SYNC_MS = 600_000;
/** Every table read this many times per pass, so one slow outlier does not decide a pass. */
const ROUNDS = 3;

/** The founder's writes: one row in every table but `CloseRequest`, which nobody writes. */
const FOUNDER_BATCH = [
	`insert into App.Seat (Side, Sid) values ('S', 'sid-a');`,
	`insert into App.Party (Sid, Name) values ('sid-a', 'Founder');`,
	`insert into App.PartyKey (Sid, PublicKey) values ('sid-a', 'key-a');`,
	...['Terms', 'Contract', 'Ledger', 'Invoice', 'Trading'].map(t => `insert into App.${t} (Id, Body) values ('a-1', 'founder');`),
].join('\n');

const JOINER_BATCH = [
	`insert into App.Seat (Side, Sid) values ('F', 'sid-b');`,
	`insert into App.Party (Sid, Name) values ('sid-b', 'Joiner');`,
	`insert into App.PartyKey (Sid, PublicKey) values ('sid-b', 'key-b');`,
].join('\n');

async function rows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	for await (const row of db.eval(sql)) out.push({ ...row });
	return out;
}

function occupyEventLoop(fraction: number): () => void {
	const busyMs = Math.round(fraction * 100);
	const timer = setInterval(() => {
		const until = Date.now() + busyMs;
		while (Date.now() < until) { /* a phone's JS thread, busy elsewhere */ }
	}, 100);
	return () => clearInterval(timer);
}

interface PassResult {
	/** Milliseconds per `select * from <table>`, every round. */
	ms: number[];
	/** Slowest read of each table, in ms. */
	byTable: Map<string, number>;
	/** Reads that threw, as `<table>: <message>`. */
	failures: string[];
	/** Outbound non-maintenance streams the reads opened, by protocol. */
	streams: Map<string, number>;
}

/** Read every table `ROUNDS` times on `db`, timing each read and counting the streams opened. */
async function readPass(db: Database, label: string, node: Libp2p): Promise<PassResult> {
	const tally = countOutboundStreams([[label, node]]);
	tally.take();
	const ms: number[] = [];
	const byTable = new Map<string, number>();
	const failures: string[] = [];
	try {
		for (let round = 0; round < ROUNDS; round++) {
			for (const table of TABLES) {
				const t = Date.now();
				try {
					await rows(db, `select * from ${table}`);
				} catch (error) {
					failures.push(`${table}: ${error instanceof Error ? error.message : String(error)}`);
				}
				const took = Date.now() - t;
				ms.push(took);
				byTable.set(table, Math.max(byTable.get(table) ?? 0, took));
			}
		}
		return { ms, byTable, failures, streams: tally.take() };
	} finally {
		tally.stop();
	}
}

function summarize(pass: PassResult): string {
	const sorted = [...pass.ms].sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)];
	const total = pass.ms.reduce((sum, n) => sum + n, 0);
	const streams = [...pass.streams].map(([k, n]) => `${k.split(' ').slice(1).join(' ')}×${n}`).join(', ') || 'none';
	const slow = [...pass.byTable].filter(([, n]) => n >= 50).map(([t, n]) => `${t} ${n}`).join(', ') || 'none';
	const failed = pass.failures.length ? `; ${pass.failures.length} FAILED (${[...new Set(pass.failures.map(f => f.split(':')[0]))].join(', ')})` : '';
	return `${pass.ms.length} reads, total ${total} ms, median ${median} ms, max ${sorted[sorted.length - 1]} ms; slow tables (ms): ${slow}; streams: ${streams}${failed}`;
}

interface RunOptions {
	latency?: WsLatencyOptions;
	eventLoopBusy?: number;
}

interface ReadCost {
	joinerConnected: PassResult;
	founderConnected: PassResult;
	founderAlone: PassResult;
}

async function measureReadCost(opts: RunOptions = {}): Promise<ReadCost> {
	const link = opts.latency === undefined ? undefined : installWsLatency(opts.latency);
	const release = opts.eventLoopBusy ? occupyEventLoop(opts.eventLoopBusy) : undefined;
	const label = (link ? `${link.delayMs} ms ${link.mode}` : 'loopback') + (opts.eventLoopBusy ? `, event loop ${opts.eventLoopBusy * 100}% busy` : '');
	let relay: DedicatedRelay | undefined;
	let A: CadreNode | undefined;
	let B: CadreNode | undefined;
	try {
		const runTag = Date.now();
		const strandId = `strand-read-cost-${runTag}`;
		const sApp = createSignedSAppConfig(SCHEMA, '0.1.0');
		relay = await startDedicatedRelay();

		const aKey = await generateKeyPair('Ed25519');
		A = new CadreNode(controlNodeConfig({ partyId: `read-cost-a-${runTag}`, privateKey: aKey, listenAddrs: [], relayAddrs: [relay.dialAddr] }));
		await A.start();
		await makeOwnOwner(A);
		const tFound = Date.now();
		const founded = await A.foundStrand({ strandId, type: 'c', memberPrivateKey: await generateStrandMemberKey(), sAppConfig: sApp });
		console.log(`[read-cost ${label}] founded in ${Date.now() - tFound} ms`);
		const aDb = founded.instance.database!.getDatabase();
		await aDb.exec(FOUNDER_BATCH, undefined, { transaction: true });
		const invitation = await A.createOpenInvitation(SAPP_ID, YEAR_MS);
		await A.publishFormationInvite(invitation.token, SAPP_ID, { strandId, expiresAtMs: Date.now() + YEAR_MS, totalUses: 1 });

		const bKey = await generateKeyPair('Ed25519');
		B = new CadreNode(controlNodeConfig({ partyId: `read-cost-b-${runTag}`, privateKey: bKey, listenAddrs: [], relayAddrs: [relay.dialAddr] }));
		await B.start();
		await makeOwnOwner(B);
		const formed = await B.formStrand(B.decodeInvitation(A.encodeInvitation(invitation)), { partyId: `read-cost-b-${runTag}`, purpose: 'read cost over a relay' });
		const bRow: StrandRow = { Id: strandId, MemberPrivateKey: formed.memberPrivateKey ?? null, Type: 'c', FounderOwnerKey: null, FounderPeerId: null };
		const tJoin = Date.now();
		await B.addStrand({ strandRow: bRow, sAppConfig: sApp, awaitFirstSync: false });
		const bStrand = await B.whenStrandWritable(strandId, { timeoutMs: FIRST_SYNC_MS });
		const bDb = bStrand.database!.getDatabase();
		await bDb.exec(JOINER_BATCH, undefined, { transaction: true });
		console.log(`[read-cost ${label}] joiner writable and seated ${((Date.now() - tJoin) / 1000).toFixed(1)} s after joining`);

		// Both sides hold every block, and the two strand nodes are connected, before anything is timed.
		const aNode = founded.instance.libp2pNode!;
		const bNode = bStrand.libp2pNode!;
		await waitUntil(async () => (await rows(aDb, 'select Side from App.Seat')).length === 2, { timeoutMs: 180_000, intervalMs: 500, description: "the joiner's seat reaches the founder" });
		await waitUntil(async () => bNode.getConnections(aNode.peerId).length > 0, { timeoutMs: 180_000, intervalMs: 500, description: 'the strand nodes are connected' });
		// A warm-up pass on each side; the passes below are what is reported.
		await readPass(aDb, 'founder', aNode);
		await readPass(bDb, 'joiner', bNode);

		const joinerConnected = await readPass(bDb, 'joiner', bNode);
		console.log(`[read-cost ${label}] joiner, founder connected:  ${summarize(joinerConnected)}`);
		const founderConnected = await readPass(aDb, 'founder', aNode);
		console.log(`[read-cost ${label}] founder, joiner connected:  ${summarize(founderConnected)}`);

		// The same reads with the other member gone: what a read of held data costs alone.
		await B.stop();
		await waitUntil(async () => aNode.getConnections(bNode.peerId).length === 0, { timeoutMs: 60_000, intervalMs: 250, description: 'the founder sees the joiner gone' });
		const founderAlone = await readPass(aDb, 'founder', aNode);
		console.log(`[read-cost ${label}] founder, joiner stopped:    ${summarize(founderAlone)}`);
		return { joinerConnected, founderConnected, founderAlone };
	} finally {
		await Promise.allSettled([B?.stop(), A?.stop()]);
		await relay?.stop();
		release?.();
		link?.restore();
	}
}

/** Slowest single read on any table in the pass, in ms. */
function slowest(pass: PassResult): number {
	return Math.max(...pass.byTable.values());
}

/**
 * On the 100 ms link any read that consults the other member costs at least one relayed round trip,
 * which is over 200 ms; a read answered from this node's own store takes a few ms.
 */
const LOCAL_READ_MS = 100;

describe('reading a strand table nobody has written', () => {
	// One journey serves both assertions below: each costs the joiner's whole first sync over the link.
	let pipelined: Promise<ReadCost> | undefined;
	const onPipelinedLink = (): Promise<ReadCost> => pipelined ??= measureReadCost({ latency: { delayMs: 100, mode: 'pipelined' } });

	it('costs no round trip to the other member (100 ms pipelined link)', async () => {
		const cost = await onPipelinedLink();
		expect(slowest(cost.joinerConnected)).toBeLessThan(LOCAL_READ_MS);
		expect(slowest(cost.founderConnected)).toBeLessThan(LOCAL_READ_MS);
	}, 900_000);

	it('can be read on the founder while the joiner is offline (100 ms pipelined link)', async () => {
		const cost = await onPipelinedLink();
		expect(cost.founderAlone.failures).toEqual([]);
	}, 900_000);

	// Measurement only, opt-in: its first sync takes minutes. The magnitude on a phone-shaped link.
	it.runIf(process.env.READ_COST_PHONE === '1')('on a phone-shaped link: 20 ms serial frame cap, event loop 70% busy', async () => {
		const cost = await measureReadCost({ latency: { delayMs: 20, mode: 'serial' }, eventLoopBusy: 0.7 });
		expect(cost.founderAlone.ms.length).toBe(TABLES.length * ROUNDS);
	}, 1_800_000);
});
