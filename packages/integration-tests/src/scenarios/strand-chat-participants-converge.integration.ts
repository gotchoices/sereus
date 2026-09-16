/**
 * Two parties chat on one CLOSED strand and both machines read the same participants
 * and messages — the reference chat schema, end to end, across a formation.
 *
 * ── Why this scenario exists ──
 *
 * The chat schema used to name its participant table `Member`. A strand database also
 * holds the built-in `Strand.Member` membership table, and optimystic stores a table
 * declared without an explicit location at `tree://default/<TableName>` — no schema
 * name — so `App.Member` and `Strand.Member` were ONE collection. On a device run the
 * founder read a null-id "participant" (its own `Strand.Member` row decoded through the
 * app's columns), the joiner's own participant insert reported success and never read
 * back, and its next message failed the foreign key. Renamed to `Participant`, the same
 * run converged. `composeStrand` now refuses the colliding name outright (plugin unit
 * suite); this scenario pins the working shape: the canonical `schemas/chat-simple.qsql`,
 * a closed strand, two parties, exact ids on both machines.
 *
 * ── Topology ──
 *
 *   HOST   — its own party, sole owner. Founds the closed strand and writes its own
 *            participant + message BEFORE issuing the invitation.
 *   JOINER — a different party. Redeems the invitation (`formStrand`), stands the strand
 *            up, waits until it has synced the host's rows and holds its own
 *            `Strand.Member` seat, then writes its own participant + message.
 *
 * ── What is asserted ──
 *
 *   1. On the host alone, `App.Participant` holds exactly `host` — no phantom row.
 *   2. Both machines converge on participants exactly {host, joiner} and messages exactly
 *      {msg-host-1, msg-joiner-1} with their sender ids.
 *   3. Both machines' `Strand.Member` keys are exactly {founder, joiner} — no app row
 *      leaked into the membership table either.
 *
 * ── Deliberately not covered ──
 *
 * A joiner that writes BEFORE its first sync is `joining-machine-writes-before-first-sync-fork-tables`.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Database } from '@quereus/quereus';
import {
	CadreNode,
	ControlFormationUsageRecorder,
	generateStrandMemberKey,
	strandMemberKeyPair,
} from '@serfab/cadre-core';
import type { OpenInvitation } from '@serfab/cadre-core';
import {
	controlNodeConfig,
	createSignedSAppConfig,
	makeOwnOwner,
	controlAddrs,
	waitUntil,
} from '../harness/index.js';
import { loadChatSimpleSchema } from '../fixtures/index.js';

const SAPP_ID = 'sapp-chat-participants';
const YEAR_MS = 365 * 24 * 3600_000;
/** Budget for each replication wait; the wait's own timeout is the failure. */
const CONVERGE_MS = 30_000;

const EXPECTED_PARTICIPANTS = ['host', 'joiner'];
const EXPECTED_MESSAGES = [
	{ Id: 'msg-host-1', ParticipantId: 'host' },
	{ Id: 'msg-joiner-1', ParticipantId: 'joiner' },
];

/** Every row's value of `column`, in the order the query returns them (nulls kept). */
async function column(db: Database, sql: string, name: string): Promise<unknown[]> {
	const values: unknown[] = [];
	for await (const row of db.eval(sql)) {
		values.push(row[name]);
	}
	return values;
}

function participantIds(db: Database): Promise<unknown[]> {
	return column(db, 'select Id from App.Participant order by Id', 'Id');
}

async function messages(db: Database): Promise<Array<{ Id: unknown; ParticipantId: unknown }>> {
	const rows: Array<{ Id: unknown; ParticipantId: unknown }> = [];
	for await (const row of db.eval('select Id, ParticipantId from App.Message order by Id')) {
		rows.push({ Id: row.Id, ParticipantId: row.ParticipantId });
	}
	return rows;
}

async function memberKeys(db: Database): Promise<unknown[]> {
	return (await column(db, 'select Key from Strand.Member', 'Key')).sort();
}

async function insertParticipantAndMessage(db: Database, id: string, name: string, messageId: string): Promise<void> {
	await db.exec('insert into App.Participant (Id, Name) values (?, ?)', [id, name]);
	await db.exec(
		'insert into App.Message (Id, ParticipantId, Content, Timestamp) values (?, ?, ?, ?)',
		[messageId, id, `hello from ${name}`, new Date().toISOString()],
	);
}

/** Wait for `db` to hold exactly the expected participants and messages, then assert it. */
async function expectConverged(db: Database, machine: string): Promise<void> {
	await waitUntil(
		async () => JSON.stringify(await participantIds(db)) === JSON.stringify(EXPECTED_PARTICIPANTS)
			&& JSON.stringify(await messages(db)) === JSON.stringify(EXPECTED_MESSAGES),
		{ timeoutMs: CONVERGE_MS, intervalMs: 500, description: `${machine} reads both participants and both messages` },
	);
	expect(await participantIds(db)).toEqual(EXPECTED_PARTICIPANTS);
	expect(await messages(db)).toEqual(EXPECTED_MESSAGES);
}

// ═════════════════════════════════════════════════════════════════════════════

describe('Chat participants on a closed cross-party strand', () => {
	it('converges participants and messages on both machines with exact ids', async () => {
		let host: CadreNode | undefined;
		let joiner: CadreNode | undefined;
		try {
			const runTag = Date.now();
			const strandId = `strand-chat-participants-${runTag}`;
			const sApp = createSignedSAppConfig(await loadChatSimpleSchema(), '0.1.0');

			// ── HOST: found the closed strand ──
			const hostKey = await generateKeyPair('Ed25519');
			host = new CadreNode(controlNodeConfig({
				partyId: `host-chat-${runTag}`,
				privateKey: hostKey,
				profile: 'storage',
				enableRelay: true,
			}));
			await host.start();
			await makeOwnOwner(host, hostKey);
			host.initializeStrandSolicitation({
				formationUsageRecorder: new ControlFormationUsageRecorder(host.getControlDatabase()!),
			});

			const founded = await host.foundStrand({
				strandId,
				type: 'c',
				memberPrivateKey: await generateStrandMemberKey(),
				sAppConfig: sApp,
			});
			expect(founded.founded).toBe(true);
			const founderPartyKey = await host.getControlDatabase()!.queryStrandPartyKey(strandId);
			expect(founderPartyKey).not.toBeNull();
			const founderMemberKey = strandMemberKeyPair(founderPartyKey!).publicKeyB64;
			const hostDb = founded.instance.database!.getDatabase();

			// ── Subject 1: the founder's own participant row reads back alone ──
			// The founder bootstrap has already seated Strand.Member; a table sharing its
			// storage would surface that row here as a second, null-id participant.
			await insertParticipantAndMessage(hostDb, 'host', 'Host', 'msg-host-1');
			expect(await participantIds(hostDb)).toEqual(['host']);
			expect(await memberKeys(hostDb)).toEqual([founderMemberKey]);

			// ── Invitation, redeemed by a different party ──
			const invitation: OpenInvitation = await host.createOpenInvitation(SAPP_ID, YEAR_MS);
			await host.publishFormationInvite(invitation.token, SAPP_ID, {
				strandId,
				expiresAtMs: Date.now() + YEAR_MS,
				totalUses: 1,
			});

			const joinerKey = await generateKeyPair('Ed25519');
			joiner = new CadreNode(controlNodeConfig({
				partyId: `joiner-chat-${runTag}`,
				privateKey: joinerKey,
				bootstrapNodes: controlAddrs(host),
				// Keeps the membership reconciler's "invite row not replicated yet" retry
				// inside the wait budget (see strand-formation-cross-party-seed).
				revocationPollMs: 2_000,
			}));
			await joiner.start();
			await makeOwnOwner(joiner, joinerKey);

			const formResult = await joiner.formStrand(invitation, {
				partyId: `joiner-chat-${runTag}`,
				purpose: 'chat participants convergence',
			});
			expect(formResult.strandId).toBe(strandId);
			expect(formResult.membershipInvite).toBeDefined();
			const joinerPartyKey = await joiner.getControlDatabase()!.queryStrandPartyKey(strandId);
			expect(joinerPartyKey).not.toBeNull();
			const joinerMemberKey = strandMemberKeyPair(joinerPartyKey!).publicKeyB64;

			const joinerStrand = await joiner.addStrand({
				strandRow: {
					Id: strandId,
					MemberPrivateKey: formResult.memberPrivateKey!,
					Type: 'c',
					FounderOwnerKey: null,
				},
				sAppConfig: sApp,
			});
			const joinerDb = joinerStrand.database!.getDatabase();

			// ── The joiner writes only once it has synced: its own seat plus the host's rows ──
			await waitUntil(
				async () => (await memberKeys(joinerDb)).includes(joinerMemberKey)
					&& JSON.stringify(await participantIds(joinerDb)) === JSON.stringify(['host'])
					&& (await messages(joinerDb)).some((m) => m.Id === 'msg-host-1'),
				{
					timeoutMs: CONVERGE_MS,
					intervalMs: 500,
					description: "the joiner holds its Strand.Member seat and has synced the host's participant + message",
				},
			);
			await insertParticipantAndMessage(joinerDb, 'joiner', 'Joiner', 'msg-joiner-1');

			// ── Subject 2: both machines read exactly both participants and both messages ──
			await expectConverged(joinerDb, 'joiner');
			await expectConverged(hostDb, 'host');

			// ── Subject 3: the membership table holds only real members ──
			const expectedMembers = [founderMemberKey, joinerMemberKey].sort();
			await waitUntil(
				async () => JSON.stringify(await memberKeys(hostDb)) === JSON.stringify(expectedMembers),
				{ timeoutMs: CONVERGE_MS, intervalMs: 500, description: "the joiner's Strand.Member seat replicates to the host" },
			);
			expect(await memberKeys(hostDb)).toEqual(expectedMembers);
			expect(await memberKeys(joinerDb)).toEqual(expectedMembers);
		} finally {
			await joiner?.stop();
			await host?.stop();
		}
	}, 180_000);
});
