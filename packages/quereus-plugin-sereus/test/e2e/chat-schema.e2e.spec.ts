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
 * Signatures are produced through SQL (`select sign(digest(...), ?, 'ed25519')`),
 * never hand-built in JavaScript: the constraint's own `digest(...)` call is the
 * only definition of the field framing, and a JS re-implementation would drift
 * from it silently.
 *
 * Runs on the `local` transactor (real libp2p node + real FileRawStorage + the
 * optimystic local transactor) so it exercises the real apply/DML path in-process,
 * with no cohort and no peer round trips — the same shape as
 * `strand-schema.e2e.spec.ts`.
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

		const founderKey = newKeyPair();   // the founding member's own signing key
		const invite1 = newKeyPair();      // the bootstrap invitation
		const invite2 = newKeyPair();      // the invitation the founder mints for the joiner

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
		expect(await selectCount(chatDb, 'select count(*) as c from App.Invite')).toBe(1);

		// The founding member, likewise unsigned, redeeming the bootstrap invitation.
		// Member and UsedInvite go in ONE transaction: each table's constraint requires
		// the other's row, so neither can be written first on its own.
		await inTransaction(chatDb, async () => {
			await chatDb.exec(
				`insert into App.Member (Id, Name, CanInvite)
					with context InviteKey = null, InviteSignature = null, MemberKey = null, MemberSignature = null
					values ('m1', 'Alice', true)`,
			);
			await chatDb.exec('insert into App.UsedInvite (Key, MemberId) values (?, ?)', [invite1.publicKey, 'm1']);
		});
		expect(await selectCount(chatDb, 'select count(*) as c from App.Member')).toBe(1);
		expect(await selectCount(chatDb, 'select count(*) as c from App.UsedInvite')).toBe(1);

		// ── A member key, and a signed self-rename ────────────────────────────────
		await chatDb.exec('insert into App.MemberKey (MemberId, Key) values (?, ?)', ['m1', founderKey.publicKey]);

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

		// ── Messages ──────────────────────────────────────────────────────────────
		const nowMs = Date.now();
		const now = await canonicalNow(chatDb, nowMs);

		const msg0Sig = await signDigest(chatDb, '?, ?, ?', [0, 'm1', 'hello'], founderKey.privateKey);
		await chatDb.exec(
			`insert into App.Message (Id, Timestamp, MemberId, Content)
				with context MemberKey = ?, MemberSignature = ?, now = ?
				values (0, ?, 'm1', 'hello')`,
			[founderKey.publicKey, msg0Sig, now, now],
		);
		expect(await selectCount(chatDb, 'select count(*) as c from App.Message')).toBe(1);

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
		expect(await selectCount(chatDb, 'select count(*) as c from App.Message')).toBe(1);

		// An attachment and a response hang off the accepted message — the two tables
		// whose columns used to be typed as `string`/`datetime` for an integer key, and
		// which carried no referential constraint at all.
		await chatDb.exec(
			`insert into App.Attachment (MessageId, Sequence, Timestamp, Type, Filename, Content)
				with context now = ?
				values (0, 0, ?, 'text/plain', 'note.txt', ?)`,
			[now, now, new Uint8Array([1, 2, 3])],
		);
		await expectRefusedBy(
			() => chatDb.exec(
				`insert into App.Attachment (MessageId, Sequence, Timestamp, Type, Filename, Content)
					with context now = ?
					values (99, 0, ?, 'text/plain', null, ?)`,
				[now, now, new Uint8Array([1])],
			),
			'MessageExists',
		);

		const msg1Sig = await signDigest(chatDb, '?, ?, ?', [1, 'm1', 'replying'], founderKey.privateKey);
		await chatDb.exec(
			`insert into App.Message (Id, Timestamp, MemberId, Content)
				with context MemberKey = ?, MemberSignature = ?, now = ?
				values (1, ?, 'm1', 'replying')`,
			[founderKey.publicKey, msg1Sig, now, now],
		);
		await chatDb.exec('insert into App.Response (OriginalId, ResponseId) values (0, 1)');
		await expectRefusedBy(
			() => chatDb.exec('insert into App.Response (OriginalId, ResponseId) values (0, 42)'),
			'ResponseExists',
		);

		// ── A second, member-signed invitation ────────────────────────────────────
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
		expect(await selectCount(chatDb, 'select count(*) as c from App.Invite')).toBe(2);

		// An invitation signed by a non-member is refused.
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
		// the invite secret is what admits them.
		const m2Sig = await signDigest(chatDb, '?, ?, false', ['m2', 'Bob'], invite2.privateKey);
		await inTransaction(chatDb, async () => {
			await chatDb.exec(
				`insert into App.Member (Id, Name, CanInvite)
					with context InviteKey = ?, InviteSignature = ?, MemberKey = null, MemberSignature = null
					values ('m2', 'Bob', false)`,
				[invite2.publicKey, m2Sig],
			);
			await chatDb.exec('insert into App.UsedInvite (Key, MemberId) values (?, ?)', [invite2.publicKey, 'm2']);
		});
		expect(await selectCount(chatDb, 'select count(*) as c from App.Member')).toBe(2);

		// ── A one-time invitation cannot be redeemed twice ────────────────────────
		// `invite2` is OneTime and already spent by 'm2'. `UsedInvite.ValidUsage` must
		// compare its redemption count against a limit; the bare `count(1)` it used to
		// carry is truthy on every redemption, which made a one-time invite reusable
		// forever.
		const m3Sig = await signDigest(chatDb, '?, ?, false', ['m3', 'Carol'], invite2.privateKey);
		await expectRefusedBy(
			() => inTransaction(chatDb, async () => {
				await chatDb.exec(
					`insert into App.Member (Id, Name, CanInvite)
						with context InviteKey = ?, InviteSignature = ?, MemberKey = null, MemberSignature = null
						values ('m3', 'Carol', false)`,
					[invite2.publicKey, m3Sig],
				);
				await chatDb.exec('insert into App.UsedInvite (Key, MemberId) values (?, ?)', [invite2.publicKey, 'm3']);
			}),
			'ValidUsage',
		);
		expect(await selectCount(chatDb, 'select count(*) as c from App.Member')).toBe(2);
		expect(await selectCount(chatDb, 'select count(*) as c from App.UsedInvite')).toBe(2);

		// A member may not mint an invitation that grants a privilege they lack — and
		// 'm2' joined through a `CanInvite = false` invitation, so it holds none.
		const m2Key = newKeyPair();
		await chatDb.exec('insert into App.MemberKey (MemberId, Key) values (?, ?)', ['m2', m2Key.publicKey]);
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
});
