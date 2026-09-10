import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Database, type SqlValue } from '@quereus/quereus';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { connectToStrand } from '../../src/connect.js';
import type { SereusPluginResult } from '../../src/types.js';
import { extractDeclareSchemaBody } from '../helpers/qsql-body.js';

/**
 * End-to-end suite for the reference chat schemas in `schemas/`.
 *
 * WHY THIS TEST WRITES ROWS. Applying DDL does not plan a table's CHECK
 * constraints, so a call to a function that does not exist, a name that binds to
 * the wrong table, and a wrong signature curve all LOAD perfectly and only fail
 * when somebody writes a row. `schemas/chat.qsql` shipped for a long time with all
 * three, plus bootstrap branches that made it impossible to seat the first member,
 * because nothing in the product ever loaded it and no test ever wrote through it.
 * A load-only guard would have stayed green through every one of those defects but
 * the missing primary-key column. So this suite drives real writes through every
 * constraint, signing with real ed25519 keys.
 *
 * WHY THE SWEEP EXISTS. Positive-path tests only prove the constraints that are
 * there; they say nothing about the writes no constraint covers. The schema
 * shipped with six wide-open write paths — unauthenticated message edits and
 * deletes, key registration in anyone's name, invitation burning, attachment and
 * response forgery — and every one survived because nothing ever ATTEMPTED the
 * operation. So the sweep attempts an unauthenticated insert, update and delete
 * against every table the schema declares and asserts each is refused by a named
 * constraint. A future table (or a removed one) fails the sweep's coverage check
 * the moment it arrives, before anyone has to notice its missing rules the hard
 * way. No cell is allow-listed as "expected to succeed" — if a change ever seems
 * to want one, that is a signal to re-examine the schema, not to add the entry.
 *
 * Signatures are produced through SQL (`select sign(digest(...), ?, 'ed25519')`),
 * never hand-built in JavaScript: the constraint's own `digest(...)` call is the
 * only definition of the field framing, and a JS re-implementation would drift
 * from it silently.
 *
 * Runs on the `local` transactor (real libp2p node + real FileRawStorage + the
 * optimystic local transactor) so it exercises the real apply/DML path in-process,
 * with no cohort and no peer round trips — the same shape as
 * `strand-schema.e2e.spec.ts`.
 *
 * NOTE: single-writer, single-session by design. It never opens a second peer and
 * never reopens the strand, so nothing here proves the chat schema survives a warm
 * restart (`strand-schema.e2e.spec.ts` proves that for `Strand`) or that two
 * concurrent redeemers of one invitation are serialized. Neither matters while
 * `schemas/chat.qsql` has no runtime consumer; if an app ever loads it, add a
 * reopen case and a concurrent-writer case before trusting it.
 */

// Repo-root `schemas/` relative to this source file. vitest runs the `.ts` under
// packages/quereus-plugin-sereus/test/e2e/, so four levels up reaches the repo root
// (e2e/ -> test/ -> quereus-plugin-sereus/ -> packages/ -> root).
const CHAT_QSQL_URL = new URL('../../../../schemas/chat.qsql', import.meta.url);
const CHAT_SIMPLE_QSQL_URL = new URL('../../../../schemas/chat-simple.qsql', import.meta.url);

/**
 * `composeStrand` wraps whatever it is handed in `declare schema App { ... }`, so
 * `chat.qsql`'s own `declare schema Chat { ... }` wrapper has to come off first.
 * The extraction is comment/string-aware (shared with the strand drift guard) —
 * a naive `indexOf('{')` would anchor on a brace inside the file's comment header.
 */
async function loadChatSchemaBody(): Promise<string> {
	const source = await fs.readFile(CHAT_QSQL_URL, 'utf-8');
	return extractDeclareSchemaBody(source, 'Chat');
}

/** `chat-simple.qsql` is a bare table list with no `declare schema` wrapper. */
async function loadChatSimpleSchema(): Promise<string> {
	return await fs.readFile(CHAT_SIMPLE_QSQL_URL, 'utf-8');
}

/**
 * Every table `schemas/chat.qsql` declares, read from the file itself so the
 * sweep's coverage check tracks the schema rather than a hand-maintained list.
 * Anchored to line starts: `table` inside a comment never begins a line here.
 */
async function declaredTables(): Promise<string[]> {
	const source = await fs.readFile(CHAT_QSQL_URL, 'utf-8');
	return [...source.matchAll(/^\s*table\s+(\w+)\s*\(/gm)].map((m) => m[1]!);
}

interface KeyPair {
	/** ed25519 private seed, base64url. Never stored in the strand. */
	privateKey: string;
	/** ed25519 public key, base64url. This is the value stored in a Key column. */
	publicKey: string;
}

function newKeyPair(): KeyPair {
	const privateKey = generatePrivateKey('ed25519', 'base64url') as string;
	return {
		privateKey,
		publicKey: getPublicKey(privateKey, 'ed25519', 'base64url', 'base64url') as string,
	};
}

async function evalOne(db: Database, sql: string, params: SqlValue[] = []): Promise<Record<string, SqlValue>> {
	for await (const row of db.eval(sql, params)) {
		return row as Record<string, SqlValue>;
	}
	throw new Error(`query returned no rows: ${sql}`);
}

async function selectCount(db: Database, sql: string, params: SqlValue[] = []): Promise<number> {
	const row = await evalOne(db, sql, params);
	return row.c as number;
}

/**
 * Sign `digest(<fieldSql>)` with `privateKey`.
 *
 * `fieldSql` is the literal argument list handed to `digest(...)` — boolean fields
 * are written as SQL `true` / `false` literals rather than bound parameters so the
 * signer's digest sees the same BOOLEAN-tagged field the constraint's
 * `digest(new.CanInvite, ...)` sees. `digest` tags INTEGER 1 and BOOLEAN true
 * differently, so a bound JS boolean that arrived as an integer would produce a
 * digest no constraint could ever match.
 */
async function signDigest(
	db: Database,
	fieldSql: string,
	fieldParams: SqlValue[],
	privateKey: string,
): Promise<string> {
	const row = await evalOne(
		db,
		`select sign(digest(${fieldSql}), ?, 'ed25519') as Sig`,
		[...fieldParams, privateKey],
	);
	return row.Sig as string;
}

/**
 * Canonicalise an epoch-ms instant to the exact `datetime` string the engine stores,
 * by round-tripping through its own `datetime(?)` scalar. `Message.TimeValid`
 * compares a `datetime` column against the `context.now` value, so both sides must
 * come from the same transform. (Local copy of cadre-core's `canonicalDatetime` —
 * cadre-core depends on THIS package, so the import cannot go the other way.)
 */
async function canonicalNow(db: Database, epochMs: number): Promise<string> {
	const row = await evalOne(db, 'select datetime(?) as Canonical', [epochMs]);
	return row.Canonical as string;
}

/**
 * Assert that `run()` is REFUSED, and that the refusal is the named CHECK
 * constraint firing.
 *
 * Naming the constraint is what makes a negative case load-bearing: a bare
 * `rejects.toThrow()` also passes when the statement never reached the engine at
 * all — a typo in a column name, a `with context` clause in a position the parser
 * rejects — and would keep passing after the constraint it was meant to prove was
 * deleted outright.
 */
async function expectRefusedBy(run: () => Promise<unknown>, constraint: string): Promise<void> {
	let message: string | null = null;
	try {
		await run();
	} catch (err) {
		message = err instanceof Error ? err.message : String(err);
	}
	expect(message, `expected a ${constraint} refusal, but the statement succeeded`).not.toBeNull();
	expect(message).toContain(`CHECK constraint failed: ${constraint}`);
}
/** Run `fn` inside one explicit transaction, rolling back on failure. */
async function inTransaction(db: Database, fn: () => Promise<void>): Promise<void> {
	await db.beginTransaction();
	try {
		await fn();
		await db.commit();
	} catch (error) {
		try {
			await db.rollback();
		} catch {
			// A failed commit() already tore the transaction down; rollback is then a no-op.
		}
		throw error;
	}
}

/** What `seedChat` leaves behind, for the caller to sign follow-on writes with. */
interface SeededChat {
	/** The founding member 'm1''s registered signing key. */
	founderKey: KeyPair;
	/** The spent bootstrap invitation 'm1' joined under. */
	invite1: KeyPair;
	/** A founder-minted one-time invitation, still UNSPENT. */
	invite2: KeyPair;
	/** Canonical `datetime` both sides of every TimeValid comparison use. */
	now: string;
	/** The epoch-ms instant `now` was derived from, for deriving offsets. */
	nowMs: number;
}

/**
 * Seed a freshly connected chat strand with one populated row per table:
 * the bootstrap invitation, the founding member 'm1' with its first key,
 * messages 0..2, an attachment on message 0, a response (0 -> 1), and a second
 * one-time invitation left unspent. Shared between the lifecycle test (which
 * continues the story from here) and the sweep (which needs populated tables —
 * an update or delete against an empty table matches no rows and fires nothing).
 */
async function seedChat(chatDb: Database): Promise<SeededChat> {
	const founderKey = newKeyPair();
	const invite1 = newKeyPair();
	const invite2 = newKeyPair();

	// ── Bootstrap ─────────────────────────────────────────────────────────────
	// The first invitation is unsigned: no member exists yet to sign it. A CHECK
	// sees the row it is judging, so this only passes because `Invite.InsertValid`
	// tests the COMMITTED invite/member counts against zero rather than asking
	// `not exists (select 1 from Invite)` — which is false even for row one.
	await chatDb.exec(
		`insert into App.Invite (Key, OneTime, CanInvite)
			with context MemberKey = null, MemberSignature = null
			values (?, true, true)`,
		[invite1.publicKey],
	);

	// The founding member, likewise unsigned, redeeming the bootstrap invitation.
	// Member and UsedInvite go in ONE transaction: each table's constraint requires
	// the other's row, so neither can be written first on its own. The redemption
	// itself IS signed — `UsedInvite.RedemptionAuthorized` demands the invitation's
	// own private key over digest(Key, MemberId), bootstrap or not.
	const m1RedemptionSig = await signDigest(chatDb, '?, ?', [invite1.publicKey, 'm1'], invite1.privateKey);
	await inTransaction(chatDb, async () => {
		await chatDb.exec(
			`insert into App.Member (Id, Name, CanInvite)
				with context InviteKey = null, InviteSignature = null, MemberKey = null, MemberSignature = null
				values ('m1', 'Alice', true)`,
		);
		await chatDb.exec(
			`insert into App.UsedInvite (Key, MemberId)
				with context InviteSignature = ?
				values (?, ?)`,
			[m1RedemptionSig, invite1.publicKey, 'm1'],
		);
	});

	// ── The founder's first key ───────────────────────────────────────────────
	// A member's FIRST key is vouched for by the invitation they joined under
	// (`MemberKey.InsertValid`, first branch): the invitation's private key signs
	// digest(MemberId, Key).
	const m1FirstKeySig = await signDigest(chatDb, '?, ?', ['m1', founderKey.publicKey], invite1.privateKey);
	await chatDb.exec(
		`insert into App.MemberKey (MemberId, Key)
			with context InviteKey = ?, InviteSignature = ?, MemberKey = null, MemberSignature = null
			values ('m1', ?)`,
		[invite1.publicKey, m1FirstKeySig, founderKey.publicKey],
	);

	// ── Messages 0..2, signed by the founder ──────────────────────────────────
	const nowMs = Date.now();
	const now = await canonicalNow(chatDb, nowMs);
	for (const [id, content] of [[0, 'hello'], [1, 'replying'], [2, 'third']] as const) {
		const sig = await signDigest(chatDb, '?, ?, ?', [id, 'm1', content], founderKey.privateKey);
		await chatDb.exec(
			`insert into App.Message (Id, Timestamp, MemberId, Content)
				with context MemberKey = ?, MemberSignature = ?, now = ?
				values (?, ?, 'm1', ?)`,
			[founderKey.publicKey, sig, now, id, now, content],
		);
	}

	// ── An attachment and a response, signed by their message's author ────────
	const attachmentContent = new Uint8Array([1, 2, 3]);
	const attachSig = await signDigest(
		chatDb, '?, ?, ?, ?, ?', [0, 0, 'text/plain', 'note.txt', attachmentContent], founderKey.privateKey,
	);
	await chatDb.exec(
		`insert into App.Attachment (MessageId, Sequence, Timestamp, Type, Filename, Content)
			with context now = ?, MemberKey = ?, MemberSignature = ?
			values (0, 0, ?, 'text/plain', 'note.txt', ?)`,
		[now, founderKey.publicKey, attachSig, now, attachmentContent],
	);
	const responseSig = await signDigest(chatDb, '?, ?', [0, 1], founderKey.privateKey);
	await chatDb.exec(
		`insert into App.Response (OriginalId, ResponseId)
			with context MemberKey = ?, MemberSignature = ?
			values (0, 1)`,
		[founderKey.publicKey, responseSig],
	);

	// ── A second, member-signed invitation, left unspent ──────────────────────
	// The digest covers the NEW invitation's own (Key, OneTime, CanInvite). Before
	// the repair those names bound to the INVITING member's key and CanInvite flag
	// (both are columns of the constraint subquery's own `from` clause), so no
	// correctly produced signature could ever match.
	const invite2Sig = await signDigest(chatDb, '?, true, false', [invite2.publicKey], founderKey.privateKey);
	await chatDb.exec(
		`insert into App.Invite (Key, OneTime, CanInvite)
			with context MemberKey = ?, MemberSignature = ?
			values (?, true, false)`,
		[founderKey.publicKey, invite2Sig, invite2.publicKey],
	);

	return { founderKey, invite1, invite2, now, nowMs };
}

describe('Chat reference schemas (write-through e2e)', () => {
	let storageDir: string;
	let db: Database | null = null;
	let result: SereusPluginResult | null = null;

	beforeEach(async () => {
		storageDir = path.join(os.tmpdir(), 'sereus-chat-schema-e2e', randomUUID());
		await fs.mkdir(storageDir, { recursive: true });
	});

	afterEach(async () => {
		try {
			if (result) {
				await result.shutdown();
				result = null;
			}
		} catch (err) {
			console.error('shutdown error in afterEach:', err);
		}
		try {
			if (db) {
				db.close();
				db = null;
			}
		} catch (err) {
			console.error('db.close error in afterEach:', err);
		}
		await fs.rm(storageDir, { recursive: true, force: true });
	});

	/** Open a strand whose sApp schema is the given `.qsql` body. */
	async function connectWithSchema(schema: string): Promise<Database> {
		const storage = new FileRawStorage(storageDir);
		db = new Database();
		result = await connectToStrand(db, {
			strandId: randomUUID(),
			transactor: 'local',
			storage,
			schema,
		});
		return db;
	}

	it('applies schemas/chat-simple.qsql cleanly', async () => {
		const chatDb = await connectWithSchema(await loadChatSimpleSchema());

		expect(await selectCount(chatDb, 'select count(*) as c from App.Member')).toBe(0);
		expect(await selectCount(chatDb, 'select count(*) as c from App.Message')).toBe(0);
	});

	it('applies schemas/chat.qsql cleanly, with every declared table present', async () => {
		const chatDb = await connectWithSchema(await loadChatSchemaBody());

		// Every table the file declares. `Attachment` is the one that used to fail the
		// whole load — its primary key named a `Sequence` column that did not exist.
		for (const table of ['Invite', 'UsedInvite', 'Member', 'MemberKey', 'Message', 'Attachment', 'Response']) {
			expect(await selectCount(chatDb, `select count(*) as c from App.${table}`)).toBe(0);
		}
	});

	it('runs the full chat lifecycle: bootstrap, sign, post, invite, join, and refuse', async () => {
		const chatDb = await connectWithSchema(await loadChatSchemaBody());
		const { founderKey, invite1, invite2, now, nowMs } = await seedChat(chatDb);

		expect(await selectCount(chatDb, 'select count(*) as c from App.Invite')).toBe(2);
		expect(await selectCount(chatDb, 'select count(*) as c from App.Member')).toBe(1);
		expect(await selectCount(chatDb, 'select count(*) as c from App.UsedInvite')).toBe(1);
		expect(await selectCount(chatDb, 'select count(*) as c from App.Message')).toBe(3);

		// An hour off the collective clock — outside every `± 5 min` TimeValid window.
		const staleNow = await canonicalNow(chatDb, nowMs - 60 * 60 * 1000);

		// ── A signed self-rename ──────────────────────────────────────────────────
		const renameSig = await signDigest(chatDb, '?, ?, true', ['m1', 'Alicia'], founderKey.privateKey);
		// `with context` on an UPDATE goes before `set` or after `where`, never between.
		await chatDb.exec(
			`update App.Member set Name = ? where Id = ?
				with context InviteKey = null, InviteSignature = null, MemberKey = ?, MemberSignature = ?`,
			['Alicia', 'm1', founderKey.publicKey, renameSig],
		);
		const renamed = await evalOne(chatDb, 'select Name from App.Member where Id = ?', ['m1']);
		expect(renamed.Name).toBe('Alicia');

		// A rename signed with the WRONG key is refused — proof the verify(...) gate is
		// doing work rather than passing everything.
		const impostor = newKeyPair();
		const forgedSig = await signDigest(chatDb, '?, ?, true', ['m1', 'Mallory'], impostor.privateKey);
		await expectRefusedBy(
			() => chatDb.exec(
				`update App.Member set Name = ? where Id = ?
					with context InviteKey = null, InviteSignature = null, MemberKey = ?, MemberSignature = ?`,
				['Mallory', 'm1', founderKey.publicKey, forgedSig],
			),
			'UpdateValid',
		);

		// ── Message refusals ──────────────────────────────────────────────────────
		// Id = 5 over a gap is refused by the gapless IdValid rule, even though the
		// signature is perfectly good.
		const msg5Sig = await signDigest(chatDb, '?, ?, ?', [5, 'm1', 'skipped ahead'], founderKey.privateKey);
		await expectRefusedBy(
			() => chatDb.exec(
				`insert into App.Message (Id, Timestamp, MemberId, Content)
					with context MemberKey = ?, MemberSignature = ?, now = ?
					values (5, ?, 'm1', 'skipped ahead')`,
				[founderKey.publicKey, msg5Sig, now, now],
			),
			'IdValid',
		);
		// A message whose timestamp is an hour off the collective clock is refused, even
		// though its Id is next in sequence and its signature is good — the signature
		// covers (Id, MemberId, Content) and never the timestamp.
		const msg3Sig = await signDigest(chatDb, '?, ?, ?', [3, 'm1', 'time traveller'], founderKey.privateKey);
		await expectRefusedBy(
			() => chatDb.exec(
				`insert into App.Message (Id, Timestamp, MemberId, Content)
					with context MemberKey = ?, MemberSignature = ?, now = ?
					values (3, ?, 'm1', 'time traveller')`,
				[founderKey.publicKey, msg3Sig, now, staleNow],
			),
			'TimeValid',
		);
		expect(await selectCount(chatDb, 'select count(*) as c from App.Message')).toBe(3);

		// ── Attachment refusals, and the digest-over-NULL positive ────────────────
		// The referential and clock constraints are declared AHEAD of
		// AttachmentAuthorized, so these two report the specific rule, not a generic
		// authorization failure.
		await expectRefusedBy(
			() => chatDb.exec(
				`insert into App.Attachment (MessageId, Sequence, Timestamp, Type, Filename, Content)
					with context now = ?, MemberKey = null, MemberSignature = null
					values (99, 0, ?, 'text/plain', null, ?)`,
				[now, now, new Uint8Array([1])],
			),
			'MessageExists',
		);
		// An attachment whose timestamp is an hour off the collective clock is refused by
		// the `TimeValid` window `Attachment` gained alongside `Message`'s.
		await expectRefusedBy(
			() => chatDb.exec(
				`insert into App.Attachment (MessageId, Sequence, Timestamp, Type, Filename, Content)
					with context now = ?, MemberKey = null, MemberSignature = null
					values (0, 1, ?, 'text/plain', null, ?)`,
				[now, staleNow, new Uint8Array([1])],
			),
			'TimeValid',
		);
		// A signed attachment with a NULL Filename is ACCEPTED: `digest` tags SQL NULL
		// as its own canonical field rather than propagating it, so the signer's
		// digest(?, ?, ?, null-bound, ?) and the constraint's digest(new.Filename)
		// agree. This is the one field framing the seeded attachment cannot cover.
		const nullFileContent = new Uint8Array([4, 5, 6]);
		const nullFileSig = await signDigest(
			chatDb, '?, ?, ?, ?, ?', [1, 0, 'text/plain', null, nullFileContent], founderKey.privateKey,
		);
		await chatDb.exec(
			`insert into App.Attachment (MessageId, Sequence, Timestamp, Type, Filename, Content)
				with context now = ?, MemberKey = ?, MemberSignature = ?
				values (1, 0, ?, 'text/plain', null, ?)`,
			[now, founderKey.publicKey, nullFileSig, now, nullFileContent],
		);
		expect(await selectCount(chatDb, 'select count(*) as c from App.Attachment')).toBe(2);

		// ── Response refusals ─────────────────────────────────────────────────────
		// Both ends of a Response must name a real message; the referential rules are
		// declared ahead of ResponseAuthorized and win the report.
		await expectRefusedBy(
			() => chatDb.exec(
				`insert into App.Response (OriginalId, ResponseId)
					with context MemberKey = null, MemberSignature = null
					values (99, 2)`,
			),
			'OriginalExists',
		);
		await expectRefusedBy(
			() => chatDb.exec(
				`insert into App.Response (OriginalId, ResponseId)
					with context MemberKey = null, MemberSignature = null
					values (0, 42)`,
			),
			'ResponseExists',
		);

		// ── Additional device keys ────────────────────────────────────────────────
		// A second key for 'm1', signed by a key the member ALREADY holds
		// (`MemberKey.InsertValid`, second branch), is accepted.
		const m1Device = newKeyPair();
		const deviceSig = await signDigest(chatDb, '?, ?', ['m1', m1Device.publicKey], founderKey.privateKey);
		await chatDb.exec(
			`insert into App.MemberKey (MemberId, Key)
				with context InviteKey = null, InviteSignature = null, MemberKey = ?, MemberSignature = ?
				values ('m1', ?)`,
			[founderKey.publicKey, deviceSig, m1Device.publicKey],
		);
		expect(await selectCount(chatDb, "select count(*) as c from App.MemberKey where MemberId = 'm1'")).toBe(2);

		// A brand-new key vouching for ITSELF is refused: the second branch reads the
		// existing key from `committed.MemberKey`, where the in-flight row is not yet
		// visible.
		const selfVoucher = newKeyPair();
		const selfVouchSig = await signDigest(chatDb, '?, ?', ['m1', selfVoucher.publicKey], selfVoucher.privateKey);
		await expectRefusedBy(
			() => chatDb.exec(
				`insert into App.MemberKey (MemberId, Key)
					with context InviteKey = null, InviteSignature = null, MemberKey = ?, MemberSignature = ?
					values ('m1', ?)`,
				[selfVoucher.publicKey, selfVouchSig, selfVoucher.publicKey],
			),
			'InsertValid',
		);

		// A spent invitation secret is NOT a permanent credential: the first-key
		// branch is closed once any key is committed for the member, so invite1
		// cannot add 'm1' a further key.
		const extraKey = newKeyPair();
		const spentInviteKeySig = await signDigest(chatDb, '?, ?', ['m1', extraKey.publicKey], invite1.privateKey);
		await expectRefusedBy(
			() => chatDb.exec(
				`insert into App.MemberKey (MemberId, Key)
					with context InviteKey = ?, InviteSignature = ?, MemberKey = null, MemberSignature = null
					values ('m1', ?)`,
				[invite1.publicKey, spentInviteKeySig, extraKey.publicKey],
			),
			'InsertValid',
		);

		// ── An invitation signed by a non-member is refused ───────────────────────
		const rogueInvite = newKeyPair();
		const rogueSig = await signDigest(chatDb, '?, true, false', [rogueInvite.publicKey], impostor.privateKey);
		await expectRefusedBy(
			() => chatDb.exec(
				`insert into App.Invite (Key, OneTime, CanInvite)
					with context MemberKey = ?, MemberSignature = ?
					values (?, true, false)`,
				[impostor.publicKey, rogueSig, rogueInvite.publicKey],
			),
			'InsertValid',
		);
		expect(await selectCount(chatDb, 'select count(*) as c from App.Invite')).toBe(2);

		// ── The second member joins ───────────────────────────────────────────────
		// The joiner's row is signed with the INVITATION's private key — possession of
		// the invite secret is what admits them — and so is the redemption itself.
		const m2Sig = await signDigest(chatDb, '?, ?, false', ['m2', 'Bob'], invite2.privateKey);
		const m2RedemptionSig = await signDigest(chatDb, '?, ?', [invite2.publicKey, 'm2'], invite2.privateKey);
		await inTransaction(chatDb, async () => {
			await chatDb.exec(
				`insert into App.Member (Id, Name, CanInvite)
					with context InviteKey = ?, InviteSignature = ?, MemberKey = null, MemberSignature = null
					values ('m2', 'Bob', false)`,
				[invite2.publicKey, m2Sig],
			);
			await chatDb.exec(
				`insert into App.UsedInvite (Key, MemberId)
					with context InviteSignature = ?
					values (?, ?)`,
				[m2RedemptionSig, invite2.publicKey, 'm2'],
			);
		});
		expect(await selectCount(chatDb, 'select count(*) as c from App.Member')).toBe(2);

		// 'm2''s first key, vouched for by the invitation it joined under.
		const m2Key = newKeyPair();
		const m2KeySig = await signDigest(chatDb, '?, ?', ['m2', m2Key.publicKey], invite2.privateKey);
		await chatDb.exec(
			`insert into App.MemberKey (MemberId, Key)
				with context InviteKey = ?, InviteSignature = ?, MemberKey = null, MemberSignature = null
				values ('m2', ?)`,
			[invite2.publicKey, m2KeySig, m2Key.publicKey],
		);

		// ── A one-time invitation cannot be redeemed twice ────────────────────────
		// `invite2` is OneTime and already spent by 'm2'. `UsedInvite.ValidUsage` must
		// compare its redemption count against a limit; the bare `count(1)` it used to
		// carry is truthy on every redemption, which made a one-time invite reusable
		// forever. The redemption is correctly signed so the refusal can only be
		// ValidUsage, not RedemptionAuthorized.
		const m3Sig = await signDigest(chatDb, '?, ?, false', ['m3', 'Carol'], invite2.privateKey);
		const m3RedemptionSig = await signDigest(chatDb, '?, ?', [invite2.publicKey, 'm3'], invite2.privateKey);
		await expectRefusedBy(
			() => inTransaction(chatDb, async () => {
				await chatDb.exec(
					`insert into App.Member (Id, Name, CanInvite)
						with context InviteKey = ?, InviteSignature = ?, MemberKey = null, MemberSignature = null
						values ('m3', 'Carol', false)`,
					[invite2.publicKey, m3Sig],
				);
				await chatDb.exec(
					`insert into App.UsedInvite (Key, MemberId)
						with context InviteSignature = ?
						values (?, ?)`,
					[m3RedemptionSig, invite2.publicKey, 'm3'],
				);
			}),
			'ValidUsage',
		);
		expect(await selectCount(chatDb, 'select count(*) as c from App.Member')).toBe(2);
		expect(await selectCount(chatDb, 'select count(*) as c from App.UsedInvite')).toBe(2);

		// Minting an invitation at all requires the INVITING member to hold `CanInvite`
		// (`Invite.InsertValid` joins through `Member M ... and M.CanInvite`). 'm2' joined
		// through a `CanInvite = false` invitation, so it holds none and is refused even
		// for an invitation that would itself grant nothing.
		const m2InviteAttempt = newKeyPair();
		const m2InviteSig = await signDigest(chatDb, '?, true, false', [m2InviteAttempt.publicKey], m2Key.privateKey);
		await expectRefusedBy(
			() => chatDb.exec(
				`insert into App.Invite (Key, OneTime, CanInvite)
					with context MemberKey = ?, MemberSignature = ?
					values (?, true, false)`,
				[m2Key.publicKey, m2InviteSig, m2InviteAttempt.publicKey],
			),
			'InsertValid',
		);

		// ── Members are never deleted ─────────────────────────────────────────────
		await expectRefusedBy(
			() => chatDb.exec(
				`delete from App.Member where Id = ?
					with context InviteKey = null, InviteSignature = null, MemberKey = null, MemberSignature = null`,
				['m2'],
			),
			'CantDelete',
		);
		expect(await selectCount(chatDb, 'select count(*) as c from App.Member')).toBe(2);
	});

	it('refuses an unauthenticated insert, update and delete on every declared table', async () => {
		const chatDb = await connectWithSchema(await loadChatSchemaBody());
		const seed = await seedChat(chatDb);

		// The attacker holds a real key pair and signs everything correctly — with a
		// key no member has registered. "Unauthenticated" means unauthorized by the
		// schema, not malformed.
		const attacker = newKeyPair();
		const attackerMsgSig = await signDigest(chatDb, '?, ?, ?', [3, 'm1', 'forged'], attacker.privateKey);

		interface SweepCell {
			constraint: string;
			sql: string;
			params?: SqlValue[];
		}
		// Every cell must be refused BY A NAMED CONSTRAINT. There is deliberately no
		// "expected to succeed" escape hatch: if a future change makes one of these
		// cells acceptable, re-examine the schema before touching this test.
		//
		// `Message` and `Attachment` declare NOT NULL context variables, so their
		// insert/update cells supply them (junk values for the signature pair) —
		// otherwise the statement is refused for the missing variable before any
		// CHECK runs and the cell would prove nothing about the constraints.
		// Deletes carry no new row, reference no context, and need none.
		const cells: Record<string, Record<'insert' | 'update' | 'delete', SweepCell>> = {
			Invite: {
				insert: {
					constraint: 'InsertValid',
					sql: `insert into App.Invite (Key, OneTime, CanInvite)
						with context MemberKey = null, MemberSignature = null
						values (?, true, true)`,
					params: [attacker.publicKey],
				},
				update: {
					constraint: 'InsertOnly',
					sql: `update App.Invite set CanInvite = false where Key = ?
						with context MemberKey = null, MemberSignature = null`,
					params: [seed.invite2.publicKey],
				},
				delete: {
					constraint: 'InsertOnly',
					sql: `delete from App.Invite where Key = ?
						with context MemberKey = null, MemberSignature = null`,
					params: [seed.invite2.publicKey],
				},
			},
			UsedInvite: {
				insert: {
					// Burning the unspent invite2 against an existing member: ValidUsage and
					// MemberValid both pass, so only the missing holder consent refuses it.
					constraint: 'RedemptionAuthorized',
					sql: `insert into App.UsedInvite (Key, MemberId)
						with context InviteSignature = null
						values (?, 'm1')`,
					params: [seed.invite2.publicKey],
				},
				update: {
					constraint: 'InsertOnly',
					sql: `update App.UsedInvite set MemberId = 'intruder' where Key = ?
						with context InviteSignature = null`,
					params: [seed.invite1.publicKey],
				},
				delete: {
					constraint: 'InsertOnly',
					sql: `delete from App.UsedInvite where Key = ?
						with context InviteSignature = null`,
					params: [seed.invite1.publicKey],
				},
			},
			Member: {
				insert: {
					constraint: 'InsertValid',
					sql: `insert into App.Member (Id, Name, CanInvite)
						with context InviteKey = null, InviteSignature = null, MemberKey = null, MemberSignature = null
						values ('intruder', 'Eve', true)`,
				},
				update: {
					constraint: 'UpdateValid',
					sql: `update App.Member set Name = 'tampered' where Id = 'm1'
						with context InviteKey = null, InviteSignature = null, MemberKey = null, MemberSignature = null`,
				},
				delete: {
					constraint: 'CantDelete',
					sql: `delete from App.Member where Id = 'm1'
						with context InviteKey = null, InviteSignature = null, MemberKey = null, MemberSignature = null`,
				},
			},
			MemberKey: {
				insert: {
					// The hole that used to defeat the whole signature scheme: registering
					// the attacker's key in 'm1''s name.
					constraint: 'InsertValid',
					sql: `insert into App.MemberKey (MemberId, Key)
						with context InviteKey = null, InviteSignature = null, MemberKey = null, MemberSignature = null
						values ('m1', ?)`,
					params: [attacker.publicKey],
				},
				update: {
					constraint: 'InsertOnly',
					sql: `update App.MemberKey set Key = ? where MemberId = 'm1'
						with context InviteKey = null, InviteSignature = null, MemberKey = null, MemberSignature = null`,
					params: [attacker.publicKey],
				},
				delete: {
					constraint: 'InsertOnly',
					sql: `delete from App.MemberKey where MemberId = 'm1'
						with context InviteKey = null, InviteSignature = null, MemberKey = null, MemberSignature = null`,
				},
			},
			Message: {
				insert: {
					// Gapless next Id, in-window timestamp, correctly signed — by a key no
					// member registered.
					constraint: 'MessageAuthorized',
					sql: `insert into App.Message (Id, Timestamp, MemberId, Content)
						with context MemberKey = ?, MemberSignature = ?, now = ?
						values (3, ?, 'm1', 'forged')`,
					params: [attacker.publicKey, attackerMsgSig, seed.now, seed.now],
				},
				update: {
					constraint: 'InsertOnly',
					sql: `update App.Message set Content = 'tampered' where Id = 0
						with context MemberKey = ?, MemberSignature = ?, now = ?`,
					params: [attacker.publicKey, attackerMsgSig, seed.now],
				},
				delete: {
					constraint: 'InsertOnly',
					sql: 'delete from App.Message where Id = 2',
				},
			},
			Attachment: {
				insert: {
					constraint: 'AttachmentAuthorized',
					sql: `insert into App.Attachment (MessageId, Sequence, Timestamp, Type, Filename, Content)
						with context now = ?, MemberKey = null, MemberSignature = null
						values (0, 5, ?, 'text/plain', null, ?)`,
					params: [seed.now, seed.now, new Uint8Array([9])],
				},
				update: {
					// `now` must be supplied: `TimeValid` reads the NOT NULL context
					// variable on update, so without it the statement is refused for the
					// missing variable before InsertOnly ever runs.
					constraint: 'InsertOnly',
					sql: `update App.Attachment set Type = 'image/png' where MessageId = 0 and Sequence = 0
						with context now = ?, MemberKey = null, MemberSignature = null`,
					params: [seed.now],
				},
				delete: {
					constraint: 'InsertOnly',
					sql: 'delete from App.Attachment where MessageId = 0 and Sequence = 0',
				},
			},
			Response: {
				insert: {
					// Both ends name real messages, so the referential rules pass and the
					// refusal is the missing authorship proof.
					constraint: 'ResponseAuthorized',
					sql: `insert into App.Response (OriginalId, ResponseId)
						with context MemberKey = null, MemberSignature = null
						values (0, 2)`,
				},
				update: {
					constraint: 'InsertOnly',
					sql: `update App.Response set OriginalId = 1 where ResponseId = 1
						with context MemberKey = null, MemberSignature = null`,
				},
				delete: {
					constraint: 'InsertOnly',
					sql: `delete from App.Response where ResponseId = 1
						with context MemberKey = null, MemberSignature = null`,
				},
			},
		};

		// Coverage check, both directions: a table the schema declares but the sweep
		// does not cover fails here the moment it lands, and a stale cell for a
		// removed (or regex-missed) table fails equally loudly.
		const tables = await declaredTables();
		expect(Object.keys(cells).sort(), 'sweep cells out of sync with the tables schemas/chat.qsql declares — every table needs an unauthenticated insert/update/delete cell, each refused by a named constraint').toEqual([...tables].sort());

		const countBefore: Record<string, number> = {};
		for (const table of tables) {
			countBefore[table] = await selectCount(chatDb, `select count(*) as c from App.${table}`);
		}

		// Once every cell is refused, cell order cannot matter — no accepted write is
		// left to mutate the state a later cell reads. (On the unfixed schema it did:
		// an accepted Message delete changed which constraint refused a later
		// Response insert.) Running the full grid in a fixed order is itself the
		// assertion that no cell leaks state into another.
		for (const table of tables) {
			for (const op of ['insert', 'update', 'delete'] as const) {
				const cell = cells[table]![op];
				await expectRefusedBy(() => chatDb.exec(cell.sql, cell.params ?? []), cell.constraint);
			}
		}

		// Nothing anywhere changed: no row added, removed — or altered in place, which
		// a count alone cannot see.
		for (const table of tables) {
			expect(await selectCount(chatDb, `select count(*) as c from App.${table}`), `row count of ${table} changed under the sweep`).toBe(countBefore[table]);
		}
		const msg0 = await evalOne(chatDb, 'select Content from App.Message where Id = 0');
		expect(msg0.Content).toBe('hello');
	});
});
