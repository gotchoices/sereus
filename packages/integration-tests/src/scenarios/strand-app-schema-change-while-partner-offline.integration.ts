/**
 * An app schema change does not keep a strand closed while its other member is offline
 * (gotchoices/sereus#55; docs/strands.md → "An app schema upgrade waits for the queue or the cohort").
 *
 * ── The flow ──
 *
 *   1. A founds a closed strand with schema v1, B forms it, and each writes a row the other reads.
 *   2. A exits for good. B exits and is respawned over the same directory, and claims the strand
 *      with v2: the same table with one column tag added, which changes no row.
 *   3. B's strand comes up, its rows read back, and `appSchemaState()` reports
 *      `waiting-for-cohort`: the apply writes the strand's catalog, which needs the absent A.
 *   4. A is respawned with v2, and `appSchemaState()` reports `applied`. This does not show that B's
 *      catalog write landed (`app-schema-refused-at-catalog-commit-is-not-unwound`).
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

/** v1 with one column tag added: a catalog change, no row change (the tag #55 reported). */
const schemaV2 = `
table Data (
    Key text primary key with tags ("optimystic.fresh" = true),
    Val text
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

		// ── 4. A returns; B reports the apply settled ──
		A = await start(aParty);
		const aClaim = await A.request('claim', { strandId, sApp: v2, timeoutMs: RESTART_GATE.timeoutMs });
		expect(aClaim.status).toBe('active');
		const returnedAt = Date.now();
		const secondB = B;
		await waitUntil(async () => (await secondB.request('appSchemaState', { strandId })).state === 'applied',
			{ ...RESTART_GATE, description: "B's deferred v2 apply to settle once A is back" });
		say('step 4: B reported applied %d ms after A was active again', Date.now() - returnedAt);
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
