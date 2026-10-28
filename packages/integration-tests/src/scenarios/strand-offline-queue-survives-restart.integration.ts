/**
 * Offline mode end to end (docs/strands.md → "Offline mode"): a phone-shaped party writes while
 * its only partner is down, restarts with the write still queued, and the write reaches the
 * partner exactly once when the partner returns.
 *
 * ── The parties ──
 *
 * Two parties share a closed strand: A, the partner, with no offline mode (as an always-on
 * node), and B, phone-shaped, whose strands start in offline mode and journal into a
 * `FileKVStore` (`CadreNodeConfig.strandOffline`). Each runs in its own `node` process over
 * on-disk stores (`harness/strand-restart-party.ts`), so B's restart is a real one: a new
 * process, the queue back only from the journal.
 *
 * Both are relay-only on one loopback relay, as in the two-process arm of
 * `strand-relay-only-restart-reconverges`. Direct connections cannot run this journey: a strand
 * node always listens on an ephemeral port (`strand-network-config.ts`), and here both parties
 * restart while the other is down, so each would come back remembering only the other's old
 * port (docs/strands.md → "a member whose address changed while it was connected to nobody is
 * unreachable"). A relayed address names the relay and the strand peer id, both stable across
 * a restart, so each side's saved network state can still dial the other.
 *
 * ── The flow ──
 *
 *   1. A founds, B forms and attaches; B reads A's row, so every collection is held on both.
 *      Control: B's own queued write reaches A while A is up, so a failure after the restart
 *      cannot be a queue that never sent anything.
 *   2. A's process exits; wait until B's strand node holds no connection to A's.
 *   3. B inserts a row. The statement resolves while nobody else can take it: `offline.status`
 *      is `queued` with `persisted: true`, and the row reads back on B.
 *   4. B's process exits and is respawned over the same directory, A still down. B's strand
 *      reaches `active` through the first-sync gate on its own copy, the row reads back, and
 *      `offline.entries()` still lists the transaction as queued: B remembers A (its saved
 *      network state) and so does not commit alone.
 *   5. A's process is respawned. B reports `committed` for the transaction (the forwarded
 *      `strand:offline-status`), exactly once and never before A returned, and A reads exactly
 *      the rows written: the queued one once, under its key, with its content.
 *
 * `[OFFLINE]` lines print the elapsed time of each step from the start of the journey. Four runs
 * (2026-10-28) took about 14 s each: B's insert resolved in 11–18 ms, its restored strand was
 * `active` about 2.1 s after its respawn began, and the queued write committed about 3 s after
 * A's respawn began.
 *
 * Not covered: B is alone for about 4 s after its restart, too briefly for FRET to drop the
 * restored A, so each send runs on a cohort of two and falls short. Once FRET drops A,
 * Optimystic's reachability gate (`absent-members`, optimystic `docs/offline-sync.md` → "When to
 * submit") is what keeps B from committing alone; no scenario holds B alone that long.
 *
 * ── Running it ──
 *
 *   yarn workspace @serfab/integration-tests exec vitest run strand-offline-queue-survives-restart
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	waitUntil,
	createSignedSAppConfig,
	startDedicatedRelay,
	startStrandRestartParty,
	type DataRow,
	type DedicatedRelay,
	type OfflineEntrySummary,
	type StrandRestartParty,
	type StrandRestartPartyOptions,
} from '../harness/index.js';

const SIMPLE_SCHEMA = `
table Data (
    Key text primary key,
    Val text
);
`;

const SAPP_ID = 'sapp-offline-queue-restart';

/** Budget for each gate while both parties are up: the two-process restart arm's. */
const GATE = { timeoutMs: 60_000, intervalMs: 250 } as const;

/**
 * Budget for each gate after a restart. The two-process restart arm reconverges in about 5 s
 * from respawn on this loopback relay; 180 s bounds a hang, the `[OFFLINE]` lines say what a run
 * took.
 */
const RESTART_GATE = { timeoutMs: 180_000, intervalMs: 250 } as const;

type PartyOptions = Omit<StrandRestartPartyOptions, 'relayAddr'>;

const byKey = (a: DataRow, b: DataRow): number => a.key.localeCompare(b.key);

/** How many statuses of `kind` `party` has forwarded for `transactionId`. */
function statusesOf(party: StrandRestartParty, transactionId: string, kind: string): number {
	return party.offlineStatuses.filter(({ status }) => status.transactionId === transactionId && status.kind === kind).length;
}

async function runOfflineQueueSurvivesRestart(): Promise<void> {
	const startedAt = Date.now();
	const say = (msg: string, ...args: unknown[]): void => {
		console.log(`[OFFLINE] ${Date.now() - startedAt} ms: ${msg}`, ...args);
	};
	const home = mkdtempSync(join(tmpdir(), 'sereus-offline-'));
	let relay: DedicatedRelay | undefined;
	let A: StrandRestartParty | undefined;
	let B: StrandRestartParty | undefined;
	try {
		const runTag = Date.now();
		const strandId = `strand-offline-${runTag}`;
		const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '0.1.0');
		relay = await startDedicatedRelay();
		const aParty: PartyOptions = { label: 'A', partyId: `offline-a-${runTag}`, stateDir: join(home, 'a'), profile: 'storage' };
		const bParty: PartyOptions = { label: 'B', partyId: `offline-b-${runTag}`, stateDir: join(home, 'b'), profile: 'transaction', offline: true };
		const start = (party: PartyOptions): Promise<StrandRestartParty> => startStrandRestartParty({ ...party, relayAddr: relay!.dialAddr });
		const aRow = { key: 'from-a', val: 'written-on-A' };
		const bOnlineRow = { key: 'from-b-online', val: 'queued-on-B-with-A-up' };
		const bQueuedRow = { key: 'from-b-queued', val: 'queued-on-B-with-A-down' };

		// ── 1. Both up: found, form, every collection held on both ──
		A = await start(aParty);
		const { strandPeerId: aStrandPeerId, encodedInvitation } = await A.request('found', { strandId, sApp, sAppId: SAPP_ID });
		B = await start(bParty);
		const { strandPeerId: bStrandPeerId } = await B.request('form', { strandId, sApp, encodedInvitation, timeoutMs: GATE.timeoutMs });
		say('A founded, B formed and is writable');

		await A.request('write', { strandId, ...aRow });
		await B.request('waitRow', { strandId, ...aRow, timeoutMs: GATE.timeoutMs });
		const { transactionId: onlineTx } = await B.request('write', { strandId, ...bOnlineRow });
		const firstB = B;
		await waitUntil(() => statusesOf(firstB, onlineTx, 'committed') === 1,
			{ ...GATE, description: "control: B's write made with A up is reported committed" });
		await A.request('waitRow', { strandId, ...bOnlineRow, timeoutMs: GATE.timeoutMs });
		// What B's restart in step 4 remembers A by, and A's in step 5 remembers B by.
		await A.request('waitSavedAddressRecord', { strandId, peerId: bStrandPeerId, timeoutMs: GATE.timeoutMs });
		await B.request('waitSavedAddressRecord', { strandId, peerId: aStrandPeerId, timeoutMs: GATE.timeoutMs });
		say("step 1: B read A's row, A read B's queued control row, both saved tables name the other");

		// ── 2. A goes down ──
		await A.exit();
		A = undefined;
		await waitUntil(async () => (await firstB.request('pathKinds', { strandId, peerId: aStrandPeerId })).kinds.length === 0,
			{ ...GATE, intervalMs: 100, description: "B's strand node to drop its connection to the stopped A's" });
		say('step 2: A exited and B holds no connection to it');

		// ── 3. B writes with nobody to take it ──
		const writeAt = Date.now();
		const { transactionId: tx } = await B.request('write', { strandId, ...bQueuedRow });
		say('step 3: B\'s write resolved in %d ms (%s)', Date.now() - writeAt, tx);
		const { status: queued } = await B.request('offlineStatus', { strandId, transactionId: tx });
		expect(queued, `offline.status(${tx}) right after the write`).toMatchObject({ kind: 'queued', persisted: true });
		expect((await B.request('rows', { strandId })).rows).toContainEqual(bQueuedRow);

		// ── 4. B restarts, A still down ──
		await B.exit();
		B = undefined;
		const bRestartAt = Date.now();
		B = await start(bParty);
		const bClaim = await B.request('claim', { strandId, sApp, timeoutMs: RESTART_GATE.timeoutMs });
		say('step 4: B respawned; its strand is %s %d ms after the respawn began', bClaim.status, Date.now() - bRestartAt);
		expect(bClaim.status).toBe('active');
		expect(bClaim.strandPeerId).toBe(bStrandPeerId);
		expect((await B.request('rows', { strandId })).rows).toContainEqual(bQueuedRow);
		// The restored queue submits at once: A, restored from the saved table, reads as serving
		// until its liveness drops it, so the attempt runs on a cohort of two and falls short.
		// Waiting for it to settle back to `queued` is what shows B did not commit it alone. A restore
		// lists it `queued` with no `waitingFor` before its first send, so the wait is for a
		// `waitingFor` only a send or the reachability gate sets.
		const secondB = B;
		let restored: OfflineEntrySummary | undefined;
		await waitUntil(async () => {
			restored = (await secondB.request('offlineEntries', { strandId })).entries.find((entry) => entry.transactionId === tx);
			return restored === undefined || (restored.status.kind === 'queued' && restored.status.waitingFor != null);
		}, { ...RESTART_GATE, description: `B's restored ${tx} to settle back to queued after a send` });
		say("step 4: B's restored entry: %s", JSON.stringify(restored));
		expect(restored, `offline.entries() after the restart lists ${tx}`).toMatchObject({ persisted: true, status: { kind: 'queued' } });

		// A commit before A is back would be one B made alone, the path offline mode exists to avoid.
		expect(statusesOf(firstB, tx, 'committed') + statusesOf(secondB, tx, 'committed'), `${tx} committed while A was down`).toBe(0);

		// ── 5. A returns ──
		const aReturnAt = Date.now();
		A = await start(aParty);
		const aClaim = await A.request('claim', { strandId, sApp, timeoutMs: RESTART_GATE.timeoutMs });
		expect(aClaim.status).toBe('active');
		say('step 5: A respawned and its strand is active %d ms after the respawn began', Date.now() - aReturnAt);
		await waitUntil(() => statusesOf(secondB, tx, 'committed') > 0,
			{ ...RESTART_GATE, description: `B to report ${tx} committed once A is back` });
		say('step 5: B reported %s committed %d ms after A\'s respawn began', tx, Date.now() - aReturnAt);
		await A.request('waitRow', { strandId, ...bQueuedRow, timeoutMs: RESTART_GATE.timeoutMs });
		say('step 5: A read the queued row %d ms after its respawn began', Date.now() - aReturnAt);

		const aRows = (await A.request('rows', { strandId })).rows;
		expect([...aRows].sort(byKey), 'the rows A holds').toEqual([aRow, bOnlineRow, bQueuedRow].sort(byKey));
		expect(statusesOf(secondB, tx, 'committed'), `${tx} reported committed`).toBe(1);
		expect(statusesOf(secondB, tx, 'failed'), `${tx} reported failed`).toBe(0);
		say('RESULT the queued write reached A exactly once');
	} finally {
		await Promise.allSettled([B?.exit(), A?.exit()]);
		await relay?.stop();
		// Children are gone before this, so nothing holds a file open (Windows refuses otherwise).
		// The temp dir holds only files the children wrote — no node_modules junctions.
		rmSync(home, { recursive: true, force: true });
	}
}

describe('offline mode on a strand', () => {
	it('a write queued while the only partner is down survives a restart and reaches the partner exactly once', async () => {
		await runOfflineQueueSurvivesRestart();
	}, 600_000);
});
