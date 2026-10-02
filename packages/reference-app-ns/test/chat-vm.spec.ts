/**
 * `chat-vm.ts` — the chat screen's view model: the poll, the participant
 * registration, and the send rule with its retry key.
 *
 * `src/chat-operations.ts` runs UNMOCKED against a real in-memory Quereus
 * `Database` carrying the app's own chat schema (`getChatSAppConfig().schema`,
 * applied the way `applyAppSchema` in quereus-plugin-sereus does). A query that
 * stops matching the schema, a duplicate primary key, a message from an
 * unregistered participant — the database refuses each for real. Mocking
 * `chat-operations` instead would put these tests at the wrong layer.
 *
 * The only scripted part is {@link ScriptedDatabase}, a thin decorator the fake
 * strand hands out in place of the real database. It records every statement by
 * the table it touches, and lets a test hold one open, refuse it, or apply it and
 * then throw — "stored, then the outcome was lost", the failure the send rule
 * exists for.
 *
 * Only the poll timer is faked (`setInterval`/`clearInterval`), so Quereus and
 * the held statements run on real microtasks and timers. {@link POLL_MS} is far
 * larger than anything `vi.waitFor` advances the fake clock by (it steps 50 ms
 * per check while fake timers are on), so a poll fires only when a test calls
 * {@link poll}.
 *
 * `getCadreVm()` caches a module-level singleton over the shared fake node, so
 * every test loads through {@link loadChat} (`H.reset()` + `vi.resetModules()`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
// Side-effect import, and load-bearing — see `cadre-vm.spec.ts`: evaluating the
// cadre-core graph takes seconds, and here it is charged to the import phase
// instead of the first test's timeout.
import '@serfab/cadre-core';
import { Database, type SqlParameters, type SqlValue } from '@quereus/quereus';
import type { StrandInstance } from '@serfab/cadre-core';
import type { ChatRow, ChatViewModel } from '../src/chat-vm';
import type { FakeNode } from './stubs/fake-cadre-node';

/** The shared fake node — see `test/stubs/fake-cadre-node.ts` for why it is hoisted. */
const stubs = vi.hoisted(async () => import('./stubs/fake-cadre-node'));

vi.mock('../src/cadre-phone', async () => (await stubs).phoneNodeMock());
vi.mock('../src/chat-strand', async () => (await stubs).chatStrandMock());

const POLL_MS = 60_000;

// ── The scripted database ─────────────────────────────────────────────────────

/** A statement, named by the table it touches — never by its full SQL text. */
type StatementKind = 'participant-insert' | 'participant-list' | 'message-insert' | 'message-list' | 'message-lookup';

function classify(sql: string): StatementKind | undefined {
	if (/^\s*insert\b[^;]*\binto\s+App\.Participant\b/i.test(sql)) return 'participant-insert';
	if (/^\s*insert\b[^;]*\binto\s+App\.Message\b/i.test(sql)) return 'message-insert';
	// The poll's list joins Participant; the resend's point lookup does not.
	if (/\bfrom\s+App\.Message\b[^;]*\bjoin\b/i.test(sql)) return 'message-list';
	if (/\bfrom\s+App\.Message\b/i.test(sql)) return 'message-lookup';
	if (/\bfrom\s+App\.Participant\b/i.test(sql)) return 'participant-list';
	return undefined;
}

/** What happens to the next statement of one kind. */
interface Script {
	/** Awaited before the statement reaches the database; a rejection means it never does. */
	before?: () => Promise<void>;
	/** Run once an `exec` has been applied; a throw is an outcome lost after the write. */
	after?: () => void;
}

/** A statement parked before it reaches the database. */
interface Held {
	release(): void;
	fail(error: Error): void;
}

/**
 * The real database behind a recorder and a per-kind queue of one-shot scripts.
 * Everything not scripted passes straight through.
 */
class ScriptedDatabase {
	/** Every statement started, in order. */
	readonly started: StatementKind[] = [];
	/** SQL {@link classify} did not recognise; refused, and reported by `afterEach`. */
	readonly unrecognised: string[] = [];
	/** Statements that reached the database and have not finished. A held one is not counted until released. */
	private active = 0;
	private readonly scripts = new Map<StatementKind, Script[]>();
	private readonly releases: (() => void)[] = [];

	constructor(readonly real: Database) {}

	/** What the fake strand hands `chat-operations` — the decorator, typed as the real thing. */
	get asDatabase(): Database {
		return this as unknown as Database;
	}

	count(kind: StatementKind): number {
		return this.started.filter((k) => k === kind).length;
	}

	/** Park the next `kind` statement until the test releases or fails it. */
	hold(kind: StatementKind): Held {
		let held!: Held;
		const gate = new Promise<void>((release, fail) => {
			held = { release: () => release(), fail };
		});
		this.releases.push(held.release);
		this.script(kind, { before: () => gate });
		return held;
	}

	/** Refuse the next `kind` statement before it reaches the database. */
	refuse(kind: StatementKind, error: Error): void {
		this.script(kind, { before: () => Promise.reject(error) });
	}

	/** Apply the next `kind` statement, then throw as though its outcome never came back. */
	loseOutcome(kind: StatementKind): void {
		this.script(kind, {
			after: () => {
				throw new Error('TornActionError: commit outcome unknown');
			},
		});
	}

	/** Let every held statement through, so none outlives its test. */
	releaseAll(): void {
		for (const release of this.releases) release();
	}

	/**
	 * Resolves once nothing is running — held statements aside — across a
	 * macrotask boundary, so whatever the view model does with each outcome
	 * (including starting its next statement) has already happened.
	 *
	 * NOTE: assumes `chat-vm.ts` starts a follow-up statement on a microtask, which holds while
	 * its only timer is the poll; if it ever waits on a timer between two statements, this can
	 * resolve early and a count assertion after it reads short.
	 */
	async idle(): Promise<void> {
		await vi.waitFor(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(this.active).toBe(0);
		});
	}

	/** Stored message contents, read from the real table and sorted. */
	async storedMessages(): Promise<string[]> {
		const contents: string[] = [];
		for await (const row of this.real.eval('select Content from App.Message order by Content')) {
			contents.push(String(row.Content));
		}
		return contents;
	}

	/** Store a message from another participant, straight into the real table. */
	async seedMessage(content: string): Promise<void> {
		await this.real.exec("insert or ignore into App.Participant (Id, Name) values ('peer-seed', 'Seed')");
		await this.real.exec(
			'insert into App.Message (Id, ParticipantId, Content, Timestamp) values (?, ?, ?, ?)',
			[crypto.randomUUID(), 'peer-seed', content, new Date().toISOString()],
		);
	}

	async exec(sql: string, params?: SqlParameters): Promise<void> {
		const script = await this.admit(sql);
		try {
			await this.real.exec(sql, params);
		} finally {
			this.active -= 1;
		}
		script?.after?.();
	}

	async *eval(sql: string, params?: SqlParameters | SqlValue[]): AsyncIterableIterator<Record<string, SqlValue>> {
		await this.admit(sql);
		try {
			yield* this.real.eval(sql, params);
		} finally {
			this.active -= 1;
		}
	}

	private script(kind: StatementKind, script: Script): void {
		const queue = this.scripts.get(kind) ?? [];
		queue.push(script);
		this.scripts.set(kind, queue);
	}

	private async admit(sql: string): Promise<Script | undefined> {
		const kind = classify(sql);
		if (!kind) {
			this.unrecognised.push(sql);
			throw new Error(`ScriptedDatabase got a statement it does not recognise: ${sql}`);
		}
		this.started.push(kind);
		const script = this.scripts.get(kind)?.shift();
		await script?.before?.();
		this.active += 1;
		return script;
	}
}

// ── Loading ───────────────────────────────────────────────────────────────────

/** What `afterEach` tears down: the poll timer and every held statement. */
const live: { vm: ChatViewModel | null; databases: ScriptedDatabase[] } = { vm: null, databases: [] };

afterEach(() => {
	const unrecognised = live.databases.flatMap((db) => db.unrecognised);
	live.vm?.stop();
	for (const db of live.databases) db.releaseAll();
	live.vm = null;
	live.databases = [];
	vi.useRealTimers();
	vi.restoreAllMocks();
	// A refused statement otherwise surfaces only as a view-model error or a (possibly silenced)
	// registration warning, and the test fails on a count that names neither.
	expect(unrecognised, 'statements the scripted database could not classify').toEqual([]);
});

/** A fresh in-memory database holding the app's chat schema, as a strand would. */
async function chatDatabase(): Promise<Database> {
	const { getChatSAppConfig } = await vi.importActual<typeof import('../src/chat-strand')>('../src/chat-strand');
	const db = new Database();
	await db.exec(`declare schema App { ${getChatSAppConfig().schema} }`);
	await db.exec('apply schema App;');
	return db;
}

/** A writable strand over its own scripted chat database. */
async function chatStrand(strandId = 'strand-a'): Promise<{ strand: StrandInstance; db: ScriptedDatabase }> {
	const H = await stubs;
	const db = new ScriptedDatabase(await chatDatabase());
	live.databases.push(db);
	return { strand: H.fakeStrand('active', { strandId, database: db.asDatabase }), db };
}

/**
 * A fresh chat view model over a fresh cadre view model that adopted a running
 * fake node offering `strands`. Not yet started.
 */
async function loadChat(strands: StrandInstance[]): Promise<{ vm: ChatViewModel; node: FakeNode }> {
	const H = await stubs;
	H.reset();
	const node = H.presentRunningNode();
	for (const strand of strands) node.strands.set(strand.strandId, strand);
	vi.resetModules();
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
	const { ChatViewModel } = await import('../src/chat-vm');
	const vm = new ChatViewModel(POLL_MS);
	live.vm = vm;
	return { vm, node };
}

/** Started, registered, and through its first read — ready to send. */
async function readyChat(): Promise<{ vm: ChatViewModel; db: ScriptedDatabase }> {
	const { strand, db } = await chatStrand();
	const { vm } = await loadChat([strand]);
	vm.start();
	await db.idle();
	return { vm, db };
}

/** The node now offers `strand` instead of whatever it offered before. */
function offerOnly(node: FakeNode, strand: StrandInstance): void {
	node.strands.clear();
	node.strands.set(strand.strandId, strand);
	node.emit('strand:started', { strandId: strand.strandId });
}

function poll(): void {
	vi.advanceTimersByTime(POLL_MS);
}

/** The message texts the list shows, oldest first. */
function shown(vm: ChatViewModel): string[] {
	const rows: ChatRow[] = [];
	vm.messages.forEach((row) => rows.push(row));
	return rows.map((row) => row.content);
}

// ── The poll's single-flight guard ────────────────────────────────────────────

describe('the poll', () => {
	it('starts no second read of a strand while one is still running', async () => {
		const { strand, db } = await chatStrand();
		const { vm } = await loadChat([strand]);
		db.hold('message-list');

		vm.start();
		await vi.waitFor(() => expect(db.count('message-list')).toBe(1));
		poll();
		poll();
		poll();
		await db.idle();

		expect(db.count('message-list')).toBe(1);
	});

	it('shows a failed read, and reads again on the next tick', async () => {
		const { strand, db } = await chatStrand();
		const { vm } = await loadChat([strand]);
		db.refuse('message-list', new Error('read timed out'));

		vm.start();
		await vi.waitFor(() => expect(vm.error).toBe('read timed out'));
		await db.idle();
		poll();
		await db.idle();

		expect(db.count('message-list')).toBe(2);
		expect(vm.error).toBe('');
	});

	it('reads a strand it re-attached to at once, and drops the late read of the old one', async () => {
		const a = await chatStrand('strand-a');
		const b = await chatStrand('strand-b');
		await a.db.seedMessage('from a');
		await b.db.seedMessage('from b');
		const { vm, node } = await loadChat([a.strand]);
		const readA = a.db.hold('message-list');
		vm.start();
		await vi.waitFor(() => expect(a.db.count('message-list')).toBe(1));

		offerOnly(node, b.strand);
		vm.start();
		await vi.waitFor(() => expect(shown(vm)).toEqual(['from b']));
		readA.release();
		await a.db.idle();

		expect(shown(vm)).toEqual(['from b']);
	});

	it('clears the list the moment it re-attaches to no strand', async () => {
		const { strand, db } = await chatStrand();
		await db.seedMessage('hello');
		const { vm, node } = await loadChat([strand]);
		vm.start();
		await db.idle();
		expect(vm.messages.length).toBe(1);

		node.strands.clear();
		node.emit('strand:stopped', { strandId: strand.strandId });
		vm.start();

		expect(vm.messages.length).toBe(0);
	});
});

// ── Registering the local participant ─────────────────────────────────────────

describe('participant registration', () => {
	it('starts no second insert while the first is still running', async () => {
		const { strand, db } = await chatStrand();
		const { vm } = await loadChat([strand]);
		db.hold('participant-insert');

		vm.start();
		await db.idle();
		poll();
		await db.idle();
		poll();
		await db.idle();

		expect(db.count('message-list')).toBe(3);
		expect(db.count('participant-insert')).toBe(1);
	});

	it('retries a failed insert on the next poll, and stops once one lands', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const { strand, db } = await chatStrand();
		const { vm } = await loadChat([strand]);
		db.refuse('participant-insert', new Error('commit refused'));

		vm.start();
		await db.idle();
		poll();
		await db.idle();
		expect(db.count('participant-insert')).toBe(2);

		poll();
		await db.idle();
		expect(db.count('participant-insert')).toBe(2);
	});

	it('waits for a joining strand to become writable before registering or reading', async () => {
		const { strand, db } = await chatStrand();
		const writable = strand.database;
		strand.database = undefined;
		const { vm } = await loadChat([strand]);

		vm.start();
		await vi.waitFor(() => expect(vm.loading).toBe(false));
		expect(db.started).toEqual([]);
		// Waiting for the first sync is not a failure to read.
		expect(vm.error).toBe('');

		strand.database = writable;
		poll();
		await db.idle();

		expect(db.count('participant-insert')).toBe(1);
		expect(db.count('message-list')).toBe(1);
	});

	it('attaches to a strand created after the screen opened, on the next poll', async () => {
		const { strand, db } = await chatStrand();
		const { vm, node } = await loadChat([]);

		vm.start();
		await vi.waitFor(() => expect(vm.loading).toBe(false));
		expect(vm.inputEnabled).toBe(false);

		offerOnly(node, strand);
		poll();
		await db.idle();

		expect(db.count('participant-insert')).toBe(1);
		expect(db.count('message-list')).toBe(1);
		expect(vm.inputEnabled).toBe(true);
	});
});

// ── The send rule (RN counterpart: reference-app-rn/test/chat-send.spec.ts) ───

describe('send', () => {
	it('stores one row when the unchanged draft is sent again after an uncertain failure', async () => {
		const { vm, db } = await readyChat();
		db.loseOutcome('message-insert');
		vm.draft = 'hello';

		await expect(vm.send()).rejects.toThrow(/outcome unknown/);
		expect(vm.error).toMatch(/^Not confirmed sent/);
		await vm.send();

		expect(await db.storedMessages()).toEqual(['hello']);
		expect(vm.draft).toBe('');
		expect(vm.error).toBe('');
	});

	it('stores edited text as a new message', async () => {
		const { vm, db } = await readyChat();
		db.loseOutcome('message-insert');
		vm.draft = 'hello';

		await expect(vm.send()).rejects.toThrow(/outcome unknown/);
		vm.draft = 'hello there';
		await vm.send();

		expect(await db.storedMessages()).toEqual(['hello', 'hello there']);
	});

	it('ignores a second Send while the first is still in flight', async () => {
		const { vm, db } = await readyChat();
		const insert = db.hold('message-insert');
		vm.draft = 'hello';

		const first = vm.send();
		await vi.waitFor(() => expect(db.count('message-insert')).toBe(1));
		await vm.send();
		expect(db.count('message-insert')).toBe(1);

		insert.release();
		await first;
		expect(await db.storedMessages()).toEqual(['hello']);
		expect(vm.draft).toBe('');
	});
});

// ── Releasing the retry key ───────────────────────────────────────────────────

describe('the retry key', () => {
	it('is retired when the draft changes, so the same text typed again is a new message', async () => {
		const { vm, db } = await readyChat();
		db.loseOutcome('message-insert');
		vm.draft = 'ok';

		await expect(vm.send()).rejects.toThrow(/outcome unknown/);
		vm.draft = '';
		vm.draft = 'ok';
		await vm.send();

		expect(await db.storedMessages()).toEqual(['ok', 'ok']);
	});

	it('is settled by a poll that shows its row: the banner and the draft clear', async () => {
		const { vm, db } = await readyChat();
		db.loseOutcome('message-insert');
		vm.draft = 'ok';

		await expect(vm.send()).rejects.toThrow(/outcome unknown/);
		poll();
		await db.idle();

		expect(vm.error).toBe('');
		expect(vm.draft).toBe('');
	});

	it('is not settled by a poll while a resend is in flight', async () => {
		const { vm, db } = await readyChat();
		db.loseOutcome('message-insert');
		vm.draft = 'ok';
		await expect(vm.send()).rejects.toThrow(/outcome unknown/);

		const lookup = db.hold('message-lookup');
		const resend = vm.send();
		await vi.waitFor(() => expect(db.count('message-lookup')).toBe(1));
		// This poll returns the stored row while the resend's outcome is still open.
		poll();
		await db.idle();
		lookup.fail(new Error('lookup timed out'));
		await expect(resend).rejects.toThrow('lookup timed out');
		expect(vm.error).toMatch(/^Not confirmed sent/);

		// The box reads "ok" when the user presses Send again. Had the poll retired the key it
		// would also have emptied the box, and the user would have typed "ok" back in — a new id.
		vm.draft = 'ok';
		await vm.send();

		expect(await db.storedMessages()).toEqual(['ok']);
	});
});
