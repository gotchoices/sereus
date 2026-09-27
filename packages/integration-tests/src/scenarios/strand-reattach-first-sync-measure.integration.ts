/**
 * Strand RE-ATTACH first-sync MEASUREMENT — opt-in, and never part of `yarn test`.
 *
 * It answers one question: how long does a machine that has been away from a strand take
 * to become writable on it again, over a slow relayed link, compared with a machine
 * joining it for the first time? `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS`
 * (`cadre-core/src/strand-first-sync-gate.ts`) is sized from that answer, and its doc
 * comment is where the numbers live — not here.
 *
 * ── The topology ──
 *
 * `blind-relay-phone-to-phone-e2e.integration.ts`'s, which is the one the fresh-join band
 * in that constant's comment was measured on: a dedicated loopback relay; parties A and B,
 * each ONE relay-only `CadreNode` (`listenAddrs: []`, `enableRelay: false`), so every byte
 * between them is relayed. A founds a CLOSED strand on a one-table schema and B, a
 * stranger, forms against a bound invitation. Formation runs on an undelayed link — its
 * own per-step budgets are what break if the link is slow from the start — and the delay
 * is raised afterwards on every dialed WebSocket in the process (`harness/ws-latency.ts`,
 * `pipelined`, so latency only; bandwidth stays unlimited).
 *
 * ── The arms ──
 *
 * - `fresh` — B has never attached. Raise the delay, then `addStrand`. The yardstick: the
 *   shape the constant's fresh-join band was taken on.
 * - `reattach-kept` — B attaches, reads a row, and `stopStrand`s. A writes while B is
 *   away. Raise the delay, then `addStrand` again over the SAME raw store (a
 *   `captureRawStorage` capture, which hands a strand scope the same store every time it
 *   is asked — the shape of a phone with durable storage).
 * - `reattach-empty` — the same, but B's provider mints a fresh `MemoryRawStorage` per
 *   request (the harness default, and cadre's own when no provider is configured), so the
 *   re-attach starts from nothing: the shape of an app that keeps its strand store in
 *   memory.
 *
 * Each arm prints, relative to the `addStrand` call: when the launch returned, whether it
 * came up gated (`'syncing'`), when B's strand node first held a connection to A's, when
 * the strand became writable, and when the row written while B was away became readable.
 * Run with `DEBUG=sereus:cadre:strand-first-sync,sereus:cadre:timing` to see each gate
 * probe's failure and the launch's phase timings, and add
 * `optimystic:db-p2p:coordinator-repo*` to see how each block read was served (locally,
 * from a peer, or declined as `cluster-fetch:peers-silent` / `cluster-fetch:no-quorum`).
 *
 * ── Running it ──
 *
 *   REATTACH_SYNC_MEASURE=1 yarn workspace @serfab/integration-tests exec vitest run strand-reattach-first-sync-measure
 *
 * `REATTACH_ARMS=<arm>[,<arm>…]` selects arms (all three by default), `REATTACH_RUNS=<n>`
 * repeats each as separate runs (separate nodes, separate relay), `REATTACH_DELAY_MS`
 * overrides the 900 ms one-way delay, `REATTACH_MISSED_WRITES` how many rows A writes
 * while B is away (default 1), and `REATTACH_COHORT_READ_MS` both parties'
 * `network.cohortQueryTimeoutMs` (default: cadre's own, `COHORT_READ_DEADLINE_MS`).
 *
 * Nothing here asserts a duration: a budget test would gate on this machine's speed. The
 * only failure is an arm that never becomes writable inside {@link WRITABLE_WAIT_MS}.
 */

import { describe, it } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Libp2p } from 'libp2p';
import type { Database } from '@quereus/quereus';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import {
	CadreNode,
	ControlFormationUsageRecorder,
	generateStrandMemberKey,
} from '@serfab/cadre-core';
import type { CadreNodeConfig, StrandRow } from '@serfab/cadre-core';
import {
	waitUntil,
	sleep,
	errorChainText,
	controlNodeConfig,
	createSignedSAppConfig,
	makeOwnOwner,
	startDedicatedRelay,
	installWsLatency,
	captureRawStorage,
	type DedicatedRelay,
	type WsLatencyHandle,
} from '../harness/index.js';

const MEASURE = process.env.REATTACH_SYNC_MEASURE === '1';

const SIMPLE_SCHEMA = `
table Data (
    Key text primary key,
    Val text
);
`;

type Arm = 'fresh' | 'reattach-kept' | 'reattach-empty';
const ARMS: readonly Arm[] = ['fresh', 'reattach-kept', 'reattach-empty'];

/** Strict integer override, parsed only under `MEASURE` so a stray variable cannot fail the skipped run. */
function integerEnv(name: string, min: number): number | undefined {
	const raw = process.env[name];
	if (!MEASURE || raw === undefined || raw.trim() === '') return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min) {
		throw new Error(`${name} must be an integer >= ${min}, not ${JSON.stringify(raw)}`);
	}
	return value;
}

const SELECTED = (process.env.REATTACH_ARMS ?? ARMS.join(','))
	.split(',').map((name) => name.trim()).filter((name) => name.length > 0);
const RUNS = integerEnv('REATTACH_RUNS', 1) ?? 1;
const DELAY_MS = integerEnv('REATTACH_DELAY_MS', 0) ?? 900;
const MISSED_WRITES = integerEnv('REATTACH_MISSED_WRITES', 1) ?? 1;
const COHORT_READ_MS = integerEnv('REATTACH_COHORT_READ_MS', 1);

if (MEASURE) {
	const unknown = SELECTED.filter((name) => !(ARMS as readonly string[]).includes(name));
	if (unknown.length > 0) throw new Error(`REATTACH_ARMS names no such arm: ${unknown.join(', ')} (have: ${ARMS.join(', ')})`);
}

/** Setup gates on the undelayed link. */
const GATE = { timeoutMs: 60_000, intervalMs: 250 } as const;
/** How long the measured attach may take before the arm is called failed — well past any budget under study. */
const WRITABLE_WAIT_MS = 600_000;
const YEAR_MS = 365 * 24 * 3600_000;

async function readDataRows(db: Database): Promise<Map<string, string>> {
	const rows = new Map<string, string>();
	for await (const row of db.eval('select Key, Val from App.Data')) rows.set(row.Key as string, row.Val as string);
	return rows;
}

/** A party's config with the `REATTACH_COHORT_READ_MS` override, when one was given. */
function withCohortReadDeadline(config: CadreNodeConfig): CadreNodeConfig {
	return COHORT_READ_MS === undefined ? config : { ...config, network: { ...config.network, cohortQueryTimeoutMs: COHORT_READ_MS } };
}

function connectedTo(node: Libp2p, peerId: string): boolean {
	return node.getConnections().some((connection) => connection.remotePeer.toString() === peerId);
}

/**
 * A's write while B is away. A's first attempts can be refused while its cohort view still
 * counts B's stopped node, so it retries for a while and reports how long that took.
 */
async function writeWhileAway(aDb: Database, key: string, say: (msg: string, ...args: unknown[]) => void): Promise<void> {
	const started = Date.now();
	let attempts = 0;
	for (;;) {
		attempts++;
		try {
			await aDb.exec('insert into App.Data (Key, Val) values (?, ?)', [key, `written-while-away-${key}`]);
			say('A wrote %s after %d attempt(s), %d ms', key, attempts, Date.now() - started);
			return;
		} catch (error) {
			if (Date.now() - started > GATE.timeoutMs) throw error;
			say('A write of %s refused (attempt %d): %s', key, attempts, errorChainText(error));
			await sleep(1_000);
		}
	}
}

async function measureArm(label: string, arm: Arm): Promise<void> {
	const say = (msg: string, ...args: unknown[]): void => { console.log(`[REATTACH ${label}] ${msg}`, ...args); };
	const runTag = Date.now();
	const strandId = `strand-reattach-${runTag}`;
	const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '0.1.0');

	// Installed undelayed before any node dials, so every socket is one the shim can hold later.
	let link: WsLatencyHandle | undefined = installWsLatency({ delayMs: 0, mode: 'pipelined' });
	let relay: DedicatedRelay | undefined;
	let A: CadreNode | undefined;
	let B: CadreNode | undefined;
	try {
		relay = await startDedicatedRelay();

		const aKey = await generateKeyPair('Ed25519');
		A = new CadreNode(withCohortReadDeadline(controlNodeConfig({
			partyId: `reattach-a-${runTag}`, privateKey: aKey, profile: 'storage', enableRelay: false,
			listenAddrs: [], relayAddrs: [relay.dialAddr],
		})));
		await A.start();
		await makeOwnOwner(A, aKey);
		A.initializeStrandSolicitation({
			formationUsageRecorder: new ControlFormationUsageRecorder(A.getControlDatabase()!),
		});
		const memberPrivateKey = await generateStrandMemberKey();
		const founded = await A.foundStrand({ strandId, type: 'c', memberPrivateKey, sAppConfig: sApp });
		const aStrandPeerId = founded.instance.libp2pNode!.peerId.toString();
		const aDb = founded.instance.database!.getDatabase();
		await aDb.exec("insert into App.Data (Key, Val) values ('before', 'written-before-B-left')");

		const invitation = await A.createOpenInvitation('sapp-reattach', YEAR_MS);
		await A.publishFormationInvite(invitation.token, 'sapp-reattach', {
			strandId, expiresAtMs: Date.now() + YEAR_MS, totalUses: 1,
		});

		const bKey = await generateKeyPair('Ed25519');
		const bStorage = arm === 'reattach-kept' ? captureRawStorage().provider : () => new MemoryRawStorage();
		B = new CadreNode(withCohortReadDeadline(controlNodeConfig({
			partyId: `reattach-b-${runTag}`, privateKey: bKey, enableRelay: false,
			listenAddrs: [], relayAddrs: [relay.dialAddr], storageProvider: bStorage,
			strandFirstSync: { timeoutMs: WRITABLE_WAIT_MS },
		})));
		await B.start();
		await makeOwnOwner(B, bKey);
		const formResult = await B.formStrand(B.decodeInvitation(A.encodeInvitation(invitation)), {
			partyId: `reattach-b-${runTag}`, purpose: 'strand re-attach first-sync measurement',
		});
		const bStrandRow: StrandRow = {
			Id: strandId, MemberPrivateKey: formResult.memberPrivateKey ?? null, Type: 'c', FounderOwnerKey: null,
		};

		let expectKey = 'before';
		if (arm !== 'fresh') {
			// The first attach, undelayed: B holds the strand, then leaves.
			const first = await B.addStrand({ strandRow: bStrandRow, sAppConfig: sApp, awaitFirstSync: false });
			await B.whenStrandWritable(strandId, { timeoutMs: GATE.timeoutMs });
			const firstDb = first.database!.getDatabase();
			await waitUntil(async () => (await readDataRows(firstDb)).has('before'),
				{ ...GATE, description: "B reads A's row on its first attach" });
			say('first attach done; stopping B\'s strand');
			await B.stopStrand(strandId);
			for (let i = 1; i <= MISSED_WRITES; i++) {
				expectKey = `away-${i}`;
				await writeWhileAway(aDb, expectKey, say);
			}
		}

		link.restore();
		link = installWsLatency({ delayMs: DELAY_MS, mode: 'pipelined' });
		say('arm %s: one-way delay now %d ms (%s); B attaches', arm, link.delayMs, link.mode);

		const t0 = Date.now();
		const since = (): number => Date.now() - t0;
		const instance = await B.addStrand({ strandRow: bStrandRow, sAppConfig: sApp, awaitFirstSync: false });
		const bStrandNode = instance.libp2pNode!;
		say('addStrand returned at %d ms, status %s (B strand %s, A strand %s)',
			since(), instance.status, bStrandNode.peerId.toString(), aStrandPeerId);

		let connectedAt: number | undefined;
		const connectionWatch = waitUntil(() => connectedTo(bStrandNode, aStrandPeerId),
			{ timeoutMs: WRITABLE_WAIT_MS, intervalMs: 100, description: "B's strand node connects to A's" })
			.then(() => { connectedAt = since(); say('B strand node connected to A at %d ms', connectedAt); })
			.catch((error: unknown) => { say('B strand node never connected: %s', errorChainText(error)); });

		await B.whenStrandWritable(strandId, { timeoutMs: WRITABLE_WAIT_MS });
		const writableAt = since();
		say('writable at %d ms', writableAt);
		const bDb = instance.database!.getDatabase();
		await waitUntil(async () => (await readDataRows(bDb)).has(expectKey),
			{ timeoutMs: WRITABLE_WAIT_MS, intervalMs: 500, description: `B reads ${expectKey}` });
		const rowAt = since();
		await connectionWatch;
		say('RESULT arm=%s delay=%d missed=%d cohortRead=%s | launch->connected %s ms | launch->writable %d ms | launch->row %d ms',
			arm, link.delayMs, arm === 'fresh' ? 0 : MISSED_WRITES, COHORT_READ_MS ?? 'default',
			connectedAt === undefined ? 'never' : String(connectedAt), writableAt, rowAt);
	} finally {
		await Promise.allSettled([B?.stop(), A?.stop()]);
		await relay?.stop();
		link?.restore();
	}
}

describe.runIf(MEASURE)('strand re-attach first-sync measurement (opt-in: REATTACH_SYNC_MEASURE=1)', () => {
	for (const arm of SELECTED as Arm[]) {
		it(`${arm}: time to writable at ${DELAY_MS} ms one-way`, async () => {
			for (let run = 1; run <= RUNS; run++) {
				await measureArm(RUNS === 1 ? arm : `${arm}/run${run}`, arm);
			}
		}, RUNS * (WRITABLE_WAIT_MS + 180_000));
	}
});
