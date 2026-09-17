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
 * The SECOND defect from that device report lives here too. A joiner that wrote its
 * participant and a message straight after `addStrand` resolved — the chat app's shape —
 * created its own private copy of each table (its cohort was itself: no strand peer was
 * connected yet), and when the connection came up the joiner's message was silently
 * replaced by the host's copy of the table while its participant table stayed forked for
 * good. Both writes had reported success. `addStrand` now resolves only once the joiner
 * has received the strand's `Strand.Header` from a peer (the first-sync write gate,
 * `docs/strands.md` → "Joining"), so the write-immediately shape converges; and a joiner
 * that can reach nobody is told so instead of being handed a database it would fork.
 *
 * ── Topology ──
 *
 *   HOST   — its own party, sole owner. Founds the closed strand and writes its own
 *            participant + message BEFORE issuing the invitation.
 *   JOINER — a different party. Redeems the invitation (`formStrand`), stands the strand
 *            up, and writes its own participant + message — after an explicit wait for the
 *            host's rows (test 1, the belt-and-braces app), or IMMEDIATELY after
 *            `addStrand` resolves (test 2, the device shape).
 *
 * ── What is asserted ──
 *
 *   1. On the host alone, `App.Participant` holds exactly `host` — no phantom row.
 *   2. Both machines converge on participants exactly {host, joiner} and messages exactly
 *      {msg-host-1, msg-joiner-1} with their sender ids — and stay converged across a
 *      later write from each side.
 *   3. Both machines' `Strand.Member` keys are exactly {founder, joiner} — no app row
 *      leaked into the membership table either.
 *   4. A joiner whose host is unreachable is refused a writable strand within the node's
 *      first-sync budget (a retryable, named error), stays launched as `'syncing'`, and
 *      has written NOTHING into its store — no app collection exists to fork.
 *
 * Before the gate, test 2 lost `msg-joiner-1` on both machines (measured 2026-09-16,
 * direct connections, 30 s observation) — that loss is what gives it teeth.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Database } from '@quereus/quereus';
import {
	CadreNode,
	ControlFormationUsageRecorder,
	StrandAwaitingFirstSyncError,
	generateStrandMemberKey,
	strandMemberKeyPair,
} from '@serfab/cadre-core';
import type { OpenInvitation, StrandInstance } from '@serfab/cadre-core';
import {
	captureRawStorage,
	controlNodeConfig,
	createSignedSAppConfig,
	makeOwnOwner,
	controlAddrs,
	readBlockIndex,
	waitUntil,
	type RawStorageCapture,
} from '../harness/index.js';
import { loadChatSimpleSchema } from '../fixtures/index.js';

const SAPP_ID = 'sapp-chat-participants';
const YEAR_MS = 365 * 24 * 3600_000;
/** Budget for each replication wait; the wait's own timeout is the failure. */
const CONVERGE_MS = 30_000;
/**
 * The unreachable-host case's first-sync budget: short enough to keep the rejection
 * cheap, long enough that a slow loopback dial could not be mistaken for a dead host
 * (the seed is a stopped node — nothing answers, ever).
 */
const UNREACHABLE_FIRST_SYNC_MS = 5_000;

const EXPECTED_PARTICIPANTS = ['host', 'joiner'];
const EXPECTED_MESSAGES = [
	{ Id: 'msg-host-1', ParticipantId: 'host' },
	{ Id: 'msg-joiner-1', ParticipantId: 'joiner' },
];
/** After each side writes once more, in id order. */
const EXPECTED_MESSAGES_AFTER_SECOND_ROUND = [
	{ Id: 'msg-host-1', ParticipantId: 'host' },
	{ Id: 'msg-host-2', ParticipantId: 'host' },
	{ Id: 'msg-joiner-1', ParticipantId: 'joiner' },
	{ Id: 'msg-joiner-2', ParticipantId: 'joiner' },
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

async function insertMessage(db: Database, participantId: string, messageId: string): Promise<void> {
	await db.exec(
		'insert into App.Message (Id, ParticipantId, Content, Timestamp) values (?, ?, ?, ?)',
		[messageId, participantId, `${messageId} from ${participantId}`, new Date().toISOString()],
	);
}

async function insertParticipantAndMessage(db: Database, id: string, name: string, messageId: string): Promise<void> {
	await db.exec('insert into App.Participant (Id, Name) values (?, ?)', [id, name]);
	await insertMessage(db, id, messageId);
}

/** Wait for `db` to hold exactly the expected participants and messages, then assert it. */
async function expectConverged(
	db: Database,
	machine: string,
	expectedMessages: ReadonlyArray<{ Id: string; ParticipantId: string }> = EXPECTED_MESSAGES,
): Promise<void> {
	await waitUntil(
		async () => JSON.stringify(await participantIds(db)) === JSON.stringify(EXPECTED_PARTICIPANTS)
			&& JSON.stringify(await messages(db)) === JSON.stringify(expectedMessages),
		{
			timeoutMs: CONVERGE_MS,
			intervalMs: 500,
			description: `${machine} reads both participants and messages ${expectedMessages.map((m) => m.Id).join(', ')}`,
		},
	);
	expect(await participantIds(db)).toEqual(EXPECTED_PARTICIPANTS);
	expect(await messages(db)).toEqual(expectedMessages);
}

// ═════════════════════════════════════════════════════════════════════════════

/** The host side, brought up: a founded closed strand with `host` + `msg-host-1` written. */
interface HostSide {
	host: CadreNode;
	strandId: string;
	sApp: ReturnType<typeof createSignedSAppConfig>;
	hostDb: Database;
	founderMemberKey: string;
	invitation: OpenInvitation;
}

/** Found the closed chat strand on a fresh host party, write its rows, publish a bound invitation. */
async function bringUpHost(runTag: number): Promise<HostSide> {
	const strandId = `strand-chat-participants-${runTag}`;
	const sApp = createSignedSAppConfig(await loadChatSimpleSchema(), '0.1.0');

	const hostKey = await generateKeyPair('Ed25519');
	const host = new CadreNode(controlNodeConfig({
		partyId: `host-chat-${runTag}`,
		privateKey: hostKey,
		profile: 'storage',
		enableRelay: true,
	}));
	await host.start();
	try {
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

		// ── Invitation, bound to the live strand, for a different party to redeem ──
		const invitation: OpenInvitation = await host.createOpenInvitation(SAPP_ID, YEAR_MS);
		await host.publishFormationInvite(invitation.token, SAPP_ID, {
			strandId,
			expiresAtMs: Date.now() + YEAR_MS,
			totalUses: 1,
		});
		return { host, strandId, sApp, hostDb, founderMemberKey, invitation };
	} catch (error) {
		await host.stop();
		throw error;
	}
}

/** The joiner side, up to and including the formation handshake — nothing launched yet. */
interface JoinerSide {
	joiner: CadreNode;
	joinerMemberKey: string;
	memberPrivateKey: string;
	/** The joiner's raw stores, for the "nothing was written" claim. */
	capture: RawStorageCapture;
}

/** A fresh joiner party that redeems the host's invitation over the real handshake. */
async function redeemOnJoiner(
	side: HostSide,
	runTag: number,
	opts: { firstSyncTimeoutMs?: number } = {},
): Promise<JoinerSide> {
	const joinerKey = await generateKeyPair('Ed25519');
	const capture = captureRawStorage();
	const joiner = new CadreNode(controlNodeConfig({
		partyId: `joiner-chat-${runTag}`,
		privateKey: joinerKey,
		bootstrapNodes: controlAddrs(side.host),
		storageProvider: capture.provider,
		// No revocationPollMs override: the membership reconciler retries an unfinished
		// join on its own short ladder (1 s, doubling, capped at the poll interval), so a
		// joiner no longer needs the production cadence shortened to finish inside the
		// wait budget.
		...(opts.firstSyncTimeoutMs !== undefined ? { strandFirstSync: { timeoutMs: opts.firstSyncTimeoutMs } } : {}),
	}));
	await joiner.start();
	try {
		await makeOwnOwner(joiner, joinerKey);

		const formResult = await joiner.formStrand(side.invitation, {
			partyId: `joiner-chat-${runTag}`,
			purpose: 'chat participants convergence',
		});
		expect(formResult.strandId).toBe(side.strandId);
		expect(formResult.membershipInvite).toBeDefined();
		expect(formResult.memberPrivateKey).toBeTruthy();
		const joinerPartyKey = await joiner.getControlDatabase()!.queryStrandPartyKey(side.strandId);
		expect(joinerPartyKey).not.toBeNull();
		return {
			joiner,
			joinerMemberKey: strandMemberKeyPair(joinerPartyKey!).publicKeyB64,
			memberPrivateKey: formResult.memberPrivateKey!,
			capture,
		};
	} catch (error) {
		await joiner.stop();
		throw error;
	}
}

/** The joiner's `addStrand` — the device shape: a hand-built row, no founder knowledge. */
function launchOnJoiner(side: HostSide, joined: JoinerSide): Promise<StrandInstance> {
	return joined.joiner.addStrand({
		strandRow: {
			Id: side.strandId,
			MemberPrivateKey: joined.memberPrivateKey,
			Type: 'c',
			FounderOwnerKey: null,
		},
		sAppConfig: side.sApp,
	});
}

/** Both machines agree on {host, joiner} membership and hold {founder, joiner} seats only. */
async function expectMembershipConverged(side: HostSide, joinerDb: Database, joinerMemberKey: string): Promise<void> {
	const expectedMembers = [side.founderMemberKey, joinerMemberKey].sort();
	await waitUntil(
		async () => JSON.stringify(await memberKeys(side.hostDb)) === JSON.stringify(expectedMembers),
		{ timeoutMs: CONVERGE_MS, intervalMs: 500, description: "the joiner's Strand.Member seat replicates to the host" },
	);
	expect(await memberKeys(side.hostDb)).toEqual(expectedMembers);
	expect(await memberKeys(joinerDb)).toEqual(expectedMembers);
}

// ═════════════════════════════════════════════════════════════════════════════

describe('Chat participants on a closed cross-party strand', () => {
	it('converges participants and messages on both machines with exact ids (joiner waits for the host rows)', async () => {
		let side: HostSide | undefined;
		let joined: JoinerSide | undefined;
		try {
			const runTag = Date.now();
			side = await bringUpHost(runTag);
			joined = await redeemOnJoiner(side, runTag);

			const joinerStrand = await launchOnJoiner(side, joined);
			expect(joinerStrand.status).toBe('active');
			const joinerDb = joinerStrand.database!.getDatabase();

			// ── The joiner writes only once it has synced: its own seat plus the host's rows ──
			await waitUntil(
				async () => (await memberKeys(joinerDb)).includes(joined!.joinerMemberKey)
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
			await expectConverged(side.hostDb, 'host');

			// ── Subject 3: the membership table holds only real members ──
			await expectMembershipConverged(side, joinerDb, joined.joinerMemberKey);
		} finally {
			await joined?.joiner.stop();
			await side?.host.stop();
		}
	}, 180_000);

	it('a joiner that writes IMMEDIATELY after addStrand resolves still converges — nothing is lost (the device shape)', async () => {
		let side: HostSide | undefined;
		let joined: JoinerSide | undefined;
		try {
			const runTag = Date.now();
			side = await bringUpHost(runTag);
			joined = await redeemOnJoiner(side, runTag);

			// addStrand resolves only once the joiner holds the strand's Header — received
			// from the host over the formation-carried seed — so the writes below land in the
			// host's tables, not in a private copy the joiner invented alone.
			const joinerStrand = await launchOnJoiner(side, joined);
			expect(joinerStrand.status).toBe('active');
			const joinerDb = joinerStrand.database!.getDatabase();
			// Proof the gate did its job: the Header is already here, with no wait of ours.
			expect((await column(joinerDb, 'select Id from Strand.Header', 'Id'))).toEqual([side.strandId]);

			// No wait for the host's app rows — the chat app writes straight away.
			await insertParticipantAndMessage(joinerDb, 'joiner', 'Joiner', 'msg-joiner-1');

			// ── Both machines converge on exactly both participants and both messages ──
			// Before the gate, msg-joiner-1 vanished from BOTH machines here.
			await expectConverged(joinerDb, 'joiner');
			await expectConverged(side.hostDb, 'host');

			// ── …and stay converged across a later write from each side ──
			await insertMessage(side.hostDb, 'host', 'msg-host-2');
			await insertMessage(joinerDb, 'joiner', 'msg-joiner-2');
			await expectConverged(joinerDb, 'joiner', EXPECTED_MESSAGES_AFTER_SECOND_ROUND);
			await expectConverged(side.hostDb, 'host', EXPECTED_MESSAGES_AFTER_SECOND_ROUND);

			await expectMembershipConverged(side, joinerDb, joined.joinerMemberKey);
		} finally {
			await joined?.joiner.stop();
			await side?.host.stop();
		}
	}, 180_000);

	it('a joiner whose host is unreachable is refused a writable strand within its budget and has written nothing', async () => {
		let side: HostSide | undefined;
		let joined: JoinerSide | undefined;
		let hostStopped = false;
		try {
			const runTag = Date.now();
			side = await bringUpHost(runTag);
			joined = await redeemOnJoiner(side, runTag, { firstSyncTimeoutMs: UNREACHABLE_FIRST_SYNC_MS });

			// The host goes away between the handshake and the launch — the formation seed
			// the joiner carries now names a dead strand node, and nobody else runs the strand.
			await side.host.stop();
			hostStopped = true;

			const startedAt = Date.now();
			const rejection = await launchOnJoiner(side, joined).then(() => null, (error: unknown) => error);
			const elapsedMs = Date.now() - startedAt;

			// ── Subject 4a: a named, retryable rejection inside the budget ──
			expect(rejection).toBeInstanceOf(StrandAwaitingFirstSyncError);
			expect((rejection as StrandAwaitingFirstSyncError).strandId).toBe(side.strandId);
			expect((rejection as Error).message).toMatch(/no member of this strand has been reachable/);
			// Bounded by the budget, with slack for bring-up (the strand's libp2p node and
			// database come up before the wait starts).
			expect(elapsedMs).toBeLessThan(UNREACHABLE_FIRST_SYNC_MS + 20_000);

			// ── Subject 4b: the launch is still up, gated — a later call can complete it ──
			const instance = joined.joiner.getStrand(side.strandId);
			expect(instance).toBeDefined();
			expect(instance!.status).toBe('syncing');
			expect(instance!.database).toBeUndefined();
			expect(instance!.libp2pNode).toBeDefined();
			// The retry contract: the same call rejects the same way while the host is gone,
			// without tearing anything down (an app can keep calling until a member appears).
			await expect(launchOnJoiner(side, joined)).rejects.toThrow(StrandAwaitingFirstSyncError);
			expect(joined.joiner.getStrand(side.strandId)?.status).toBe('syncing');

			// ── Subject 4c: nothing was written — no collection exists to fork ──
			// The joiner's strand-scoped raw store holds no `default/<Table>` block — the id
			// every table's collection lives under (`tree://default/<Table>`): no
			// `default/Participant`, no `default/Message`, no `default/Member` either. What
			// it does hold is the schema catalog (`optimystic/schema` plus its hash-named
			// blocks), which `connectToStrand`'s schema apply writes on every launch, joiner
			// or founder, before any row exists — measured at 3 blocks here. (The control
			// store is a separate scope and is not consulted here.)
			const strandIndex = await readBlockIndex(joined.capture.forStrand(side.strandId));
			const blockIds = [...strandIndex.keys()];
			console.log(`[chat-participants] blocks in the unreachable joiner's strand store: ${blockIds.join(', ')}`);
			expect(blockIds.filter((id) => id.startsWith('default/'))).toEqual([]);
			expect(blockIds).toContain('optimystic/schema');
		} finally {
			await joined?.joiner.stop();
			if (!hostStopped) await side?.host.stop();
		}
	}, 180_000);
});
