/**
 * An app schema change does not keep a strand closed while its other member is offline
 * (gotchoices/sereus#55; docs/strands.md → "An app schema upgrade waits for the queue or the cohort").
 *
 * ── The flow ──
 *
 *   1. A founds a closed strand with schema v1, B forms it, and each writes a row the other reads.
 *   2. A exits for good. B exits and is respawned over the same directory, and claims the strand
 *      with v2: the same table with one column tag and an index added, plus a new table.
 *   3. B's strand comes up, its rows read back, and `appSchemaState()` reports
 *      `waiting-for-cohort`: the apply writes the strand's catalog, which needs the absent A. A query
 *      that would use the new index still works, because B keeps running v1.
 *   4. A retry lands with A still offline: by then a run of failed contacts has marked A dead, so B
 *      commits without it (docs/strands.md), and `appSchemaState()` reports `applied`.
 *   5. B restarts with A still offline and finds nothing to send: the change is in its store, so
 *      `applied` was true. It serves a query through the index and takes a write.
 *   6. A is respawned with v2 and reads that write through the index.
 *
 * Two arms: B without offline mode (the reporter's arm), and B with it, where the failure was the
 * same because the catalog write is not a queued app transaction.
 *
 * Both parties are relay-only on one loopback relay, for the reason
 * `strand-offline-queue-survives-restart` gives: each restarts while the other is down.
 *
 * ── Running it ──
 *
 *   yarn workspace @serfab/integration-tests exec vitest run strand-app-schema-change-while-partner-offline
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
	type DedicatedRelay,
	type StrandRestartParty,
	type StrandRestartPartyOptions,
} from '../harness/index.js';

const schemaV1 = `
table Data (
    Key text primary key,
    Val text
);
`;

/** v1 with one column tag added (the change #55 reported), an index and a table. */
const schemaV2 = `
table Data (
    Key text primary key with tags ("optimystic.fresh" = true),
    Val text
);
index DataByVal on Data (Val);
table Later (
    Id integer primary key
);
`;

const SAPP_ID = 'sapp-schema-change-partner-offline';

const GATE = { timeoutMs: 60_000, intervalMs: 250 } as const;
const RESTART_GATE = { timeoutMs: 180_000, intervalMs: 500 } as const;

type PartyOptions = Omit<StrandRestartPartyOptions, 'relayAddr'>;

async function runSchemaChangeWhilePartnerOffline(offline: boolean): Promise<void> {
	const startedAt = Date.now();
	const say = (msg: string, ...args: unknown[]): void => {
		console.log(`[SCHEMA-55${offline ? ' offline' : ''}] ${Date.now() - startedAt} ms: ${msg}`, ...args);
	};
	const home = mkdtempSync(join(tmpdir(), 'sereus-schema55-'));
	let relay: DedicatedRelay | undefined;
	let A: StrandRestartParty | undefined;
	let B: StrandRestartParty | undefined;
	try {
		const runTag = Date.now();
		const strandId = `strand-schema55-${runTag}`;
		const v1 = createSignedSAppConfig(schemaV1, '1.0.0');
		const v2 = createSignedSAppConfig(schemaV2, '1.1.0');
		relay = await startDedicatedRelay();
		const aParty: PartyOptions = { label: 'A', partyId: `schema55-a-${runTag}`, stateDir: join(home, 'a'), profile: 'transaction' };
		const bParty: PartyOptions = { label: 'B', partyId: `schema55-b-${runTag}`, stateDir: join(home, 'b'), profile: 'transaction', offline };
		const start = (party: PartyOptions): Promise<StrandRestartParty> => startStrandRestartParty({ ...party, relayAddr: relay!.dialAddr });
		const aRow = { key: 'from-a', val: 'written-on-A' };
		const bRow = { key: 'from-b', val: 'written-on-B' };

		// ── 1. Both up on v1 ──
		A = await start(aParty);
		const { strandPeerId: aStrandPeerId, encodedInvitation } = await A.request('found', { strandId, sApp: v1, sAppId: SAPP_ID });
		B = await start(bParty);
		const { strandPeerId: bStrandPeerId } = await B.request('form', { strandId, sApp: v1, encodedInvitation, timeoutMs: GATE.timeoutMs });
		await A.request('write', { strandId, ...aRow });
		await B.request('waitRow', { strandId, ...aRow, timeoutMs: GATE.timeoutMs });
		await B.request('write', { strandId, ...bRow });
		await A.request('waitRow', { strandId, ...bRow, timeoutMs: GATE.timeoutMs });
		await A.request('waitSavedAddressRecord', { strandId, peerId: bStrandPeerId, timeoutMs: GATE.timeoutMs });
		await B.request('waitSavedAddressRecord', { strandId, peerId: aStrandPeerId, timeoutMs: GATE.timeoutMs });
		say('step 1: both rows on both parties');

		// ── 2. A down; B restarts with v2 ──
		await A.exit();
		A = undefined;
		await B.exit();
		B = undefined;
		B = await start(bParty);
		const claimAt = Date.now();
		const bClaim = await B.request('claim', { strandId, sApp: v2, timeoutMs: RESTART_GATE.timeoutMs });
		say('step 2: B claimed with v2 and is %s after %d ms', bClaim.status, Date.now() - claimAt);

		// ── 3. B is open, the apply waiting for the cohort ──
		expect(bClaim.status).toBe('active');
		const rows = (await B.request('rows', { strandId })).rows;
		expect(rows).toContainEqual(aRow);
		expect(rows).toContainEqual(bRow);
		expect((await B.request('appSchemaState', { strandId })).state).toBe('waiting-for-cohort');
		expect((await B.request('keysByVal', { strandId, val: aRow.val })).keys).toEqual([aRow.key]);

		// ── 4. A retry lands with A still offline, once B has marked A dead ──
		const claimedB = B;
		await waitUntil(async () => (await claimedB.request('appSchemaState', { strandId })).state === 'applied',
			{ ...RESTART_GATE, description: "B's deferred v2 apply to land with A offline" });
		say('step 4: B reported applied %d ms after the claim, with A offline', Date.now() - claimAt);

		// ── 5. The change is in B's store: a restart with A still offline finds nothing to send ──
		await B.exit();
		B = undefined;
		B = await start(bParty);
		const reclaim = await B.request('claim', { strandId, sApp: v2, timeoutMs: RESTART_GATE.timeoutMs });
		expect(reclaim.status).toBe('active');
		expect((await B.request('appSchemaState', { strandId })).state).toBe('applied');
		expect((await B.request('keysByVal', { strandId, val: aRow.val })).keys).toEqual([aRow.key]);
		const laterRow = { key: 'from-b-on-v2', val: 'written-on-B-with-A-offline' };
		await B.request('write', { strandId, ...laterRow });
		say('step 5: B restarted on v2 from its store');

		// ── 6. A returns and converges ──
		A = await start(aParty);
		const aClaim = await A.request('claim', { strandId, sApp: v2, timeoutMs: RESTART_GATE.timeoutMs });
		expect(aClaim.status).toBe('active');
		await A.request('waitRow', { strandId, ...laterRow, timeoutMs: RESTART_GATE.timeoutMs });
		expect((await A.request('keysByVal', { strandId, val: laterRow.val })).keys).toEqual([laterRow.key]);
		say('step 6: A is on v2 and holds the row B wrote while it was away');
	} finally {
		await Promise.allSettled([B?.exit(), A?.exit()]);
		await relay?.stop();
		rmSync(home, { recursive: true, force: true });
	}
}

describe('an app schema change while the strand partner is offline (sereus#55)', () => {
	it('opens the strand and settles the apply when the partner returns', async () => {
		await runSchemaChangeWhilePartnerOffline(false);
	}, 600_000);

	it('does the same with offline mode on', async () => {
		await runSchemaChangeWhilePartnerOffline(true);
	}, 600_000);
});
