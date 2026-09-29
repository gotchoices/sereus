/**
 * The records of strands joined from ANOTHER party (`joined-strand-store.ts`): the party-wide
 * `JoinedStrand` row and the machine-local record of a join not yet published. The founding
 * party's control database holds such a strand's `Strand` row, so these records are the only
 * thing that brings it back after a restart (gotchoices/sereus#18).
 *
 *  - The KeyStore-backed store reads its joins back through a fresh instance, drops a slot
 *    that is not a record for its own id while keeping the rest, and never lists another
 *    party's joins from a KeyStore two parties share (the React Native app keeps one per
 *    device).
 *  - The session unions control rows over party-wide joins over local ones, forgets a local
 *    record either table names, and keeps offering the last party-wide list when a read
 *    fails without forgetting anything on its word; it publishes local records party-wide,
 *    keeping one whose publish failed, and never lands one after a leave of it; and a
 *    self-revocation removes the party-wide row while the strand stays offered until the
 *    session ends — `strand:revoked` tears nothing down.
 *  - End to end on a real node: a join `formStrand` recorded comes back as
 *    `strand:discovered` after a restart over the same `keyStore`, with no app-side list,
 *    until `forgetJoinedStrand`.
 */
import { describe, it, expect } from 'vitest';
import { fromString as uint8ArrayFromString } from 'uint8arrays';
import { CadreNode } from '../src/cadre-node.js';
import { InMemoryKeyStore } from '../src/key-store.js';
import {
	JoinedStrandSession,
	KeyStoreJoinedStrandStore,
	joinedStrandRow,
	type JoinedStrandRecord,
	type PartyJoinedStrandLedger
} from '../src/joined-strand-store.js';
import type { StrandWatcher } from '../src/strand-watcher.js';
import type { FormStrandResult, StrandRow } from '../src/types.js';
import {
	controlNodeConfig,
	freshPartyId,
	memoryStorageProvider,
	scopedWithin
} from './control-db-node-helpers.js';

const PARTY = 'party-alpha';

const closedJoin: JoinedStrandRecord = { Id: 'joined-closed', Type: 'c', MemberPrivateKey: 'read-secret', joinedAt: 1 };
const openJoin: JoinedStrandRecord = { Id: 'joined-open', Type: 'o', MemberPrivateKey: null, joinedAt: 2 };

const byId = (records: JoinedStrandRecord[]) => [...records].sort((a, b) => a.Id.localeCompare(b.Id));
const utf8 = (text: string) => uint8ArrayFromString(text, 'utf8');

describe('KeyStoreJoinedStrandStore', () => {
	it('reads its joins back through a fresh store, dropping a junk slot and keeping its siblings', async () => {
		const keyStore = new InMemoryKeyStore();
		await keyStore.set('cadre/identity', utf8('not a join'));
		const writer = new KeyStoreJoinedStrandStore(keyStore, PARTY);
		await writer.record(closedJoin);
		await writer.record(openJoin);

		// Plant junk under this party's own prefix: text that is not JSON, and a record
		// whose Id disagrees with the slot it sits in.
		const closedSlot = (await keyStore.list()).find((id) => id.endsWith(`/${closedJoin.Id}`))!;
		const partyPrefix = closedSlot.slice(0, -closedJoin.Id.length);
		await keyStore.set(`${partyPrefix}junk-text`, utf8('{not json'));
		await keyStore.set(`${partyPrefix}junk-id`, utf8(JSON.stringify({ ...openJoin, Id: 'someone-else' })));

		const reader = new KeyStoreJoinedStrandStore(keyStore, PARTY);
		expect(byId(await reader.list())).toEqual(byId([closedJoin, openJoin]));

		await reader.forget(openJoin.Id);
		expect(await new KeyStoreJoinedStrandStore(keyStore, PARTY).list()).toEqual([closedJoin]);
	});

	it("never lists another party's joins from a KeyStore the parties share", async () => {
		const keyStore = new InMemoryKeyStore();
		await new KeyStoreJoinedStrandStore(keyStore, 'party-a').record(closedJoin);

		expect(await new KeyStoreJoinedStrandStore(keyStore, 'party-b').list()).toEqual([]);
		// 'party-' encodes to a prefix of 'party-a''s segment; the segment's closing '/'
		// is what keeps it from matching.
		expect(await new KeyStoreJoinedStrandStore(keyStore, 'party-').list()).toEqual([]);
	});
});

/**
 * A stand-in for the party-wide `JoinedStrand` table over a map — the seam, not a mock of
 * `ControlDatabase`. `controlIds` are the party's own `Strand` rows, which `names` also reports.
 */
class MapLedger implements PartyJoinedStrandLedger {
	readonly rows: Map<string, StrandRow>;
	listFails = false;
	readonly refusedPublishes = new Set<string>();

	constructor(rows: StrandRow[] = [], private readonly controlIds: string[] = []) {
		this.rows = new Map(rows.map((row) => [row.Id, row]));
	}

	async list(): Promise<StrandRow[]> {
		if (this.listFails) {
			throw new Error('cohort-unreachable');
		}
		return [...this.rows.values()];
	}

	async names(strandId: string): Promise<boolean> {
		return this.controlIds.includes(strandId) || this.rows.has(strandId);
	}

	async canSign(): Promise<boolean> {
		return true;
	}

	async publish(record: JoinedStrandRecord): Promise<void> {
		if (this.refusedPublishes.has(record.Id)) {
			throw new Error(`publish of ${record.Id} refused`);
		}
		this.rows.set(record.Id, joinedStrandRow(record));
	}

	async remove(strandId: string): Promise<boolean> {
		return this.rows.delete(strandId);
	}
}

const joinedRow = (Id: string, MemberPrivateKey: string): StrandRow => ({ Id, Type: 'c', MemberPrivateKey, FounderOwnerKey: null });
const localJoin = (Id: string, MemberPrivateKey: string): JoinedStrandRecord => ({ Id, Type: 'c', MemberPrivateKey, joinedAt: 1 });

describe('JoinedStrandSession', () => {
	it('offers control rows over party-wide joins over local ones, drains the stale local records, and survives a failed party-wide read', async () => {
		const store = new KeyStoreJoinedStrandStore(new InMemoryKeyStore(), PARTY);
		const control: StrandRow[] = [{ Id: 'a', Type: 'o', MemberPrivateKey: null, FounderOwnerKey: 'owner-key' }];
		const ledger = new MapLedger([joinedRow('a', 'ledger-a'), joinedRow('b', 'ledger-b')], ['a']);
		for (const record of [localJoin('a', 'local-a'), localJoin('b', 'local-b'), localJoin('c', 'local-c')]) {
			await store.record(record);
		}
		const session = new JoinedStrandSession(store, ledger);

		expect(await session.withControlRows(control)).toEqual([
			control[0],
			joinedRow('b', 'ledger-b'),
			joinedRow('c', 'local-c')
		]);
		expect((await store.list()).map((record) => record.Id),
			'a local record the party-wide table or the control table already names was kept — it would be published again'
		).toEqual(['c']);

		ledger.listFails = true;
		await store.record(localJoin('b', 'rejoined-b'));
		expect((await session.withControlRows(control)).map((row) => row.Id),
			'a failed party-wide read dropped the join — the watcher would read that as a removal and detach the strand'
		).toEqual(['a', 'b', 'c']);
		expect((await store.list()).map((record) => record.Id).sort(),
			'a local record named only by the stale last-good list was forgotten — a re-join after a leave would be lost'
		).toEqual(['b', 'c']);
	});

	it('publishes each unpublished join, keeping a record whose publish failed for the next pass', async () => {
		const store = new KeyStoreJoinedStrandStore(new InMemoryKeyStore(), PARTY);
		const ledger = new MapLedger();
		ledger.refusedPublishes.add('e');
		await store.record(localJoin('d', 'secret-d'));
		await store.record(localJoin('e', 'secret-e'));

		await new JoinedStrandSession(store, ledger).syncWithParty();

		expect((await store.list()).map((record) => record.Id)).toEqual(['e']);
		expect([...ledger.rows.values()]).toEqual([joinedRow('d', 'secret-d')]);
	});

	it('does not let a publish already checking for the row land it after a leave', async () => {
		const store = new KeyStoreJoinedStrandStore(new InMemoryKeyStore(), PARTY);
		const ledger = new MapLedger();
		let releaseCheck!: () => void;
		const checkHeld = new Promise<void>((resolve) => { releaseCheck = resolve; });
		const names = ledger.names.bind(ledger);
		ledger.names = async (strandId) => {
			await checkHeld;
			return names(strandId);
		};
		await store.record(localJoin('f', 'secret-f'));
		const session = new JoinedStrandSession(store, ledger);

		const sync = session.syncWithParty();
		const leave = session.leave('f');
		releaseCheck();
		await Promise.all([sync, leave]);

		expect(ledger.rows.has('f'), 'the party still holds a strand the app left').toBe(false);
	});

	it('keeps offering a party-wide join after self-revocation removes its row, until the session ends', async () => {
		const store = new KeyStoreJoinedStrandStore(new InMemoryKeyStore(), PARTY);
		const ledger = new MapLedger([joinedRow(closedJoin.Id, 'read-secret')]);
		const session = new JoinedStrandSession(store, ledger);
		await session.withControlRows([]);

		await session.forgetAfterThisSession(closedJoin.Id);
		await session.syncWithParty();

		expect(ledger.rows.has(closedJoin.Id),
			'the party-wide row of a strand this party was removed from survived, so every machine re-attaches it on every start'
		).toBe(false);
		expect((await session.withControlRows([])).map((row) => row.Id),
			'a revoked join vanished mid-session — the watcher would read that as a removal and tear the strand down'
		).toEqual([closedJoin.Id]);
		expect(await new JoinedStrandSession(store, ledger).withControlRows([])).toEqual([]);
	});
});

describe('CadreNode remembers strands joined from another party', () => {
	const within = scopedWithin('joined-strand-restart');
	const LIFECYCLE_TIMEOUT_MS = 60_000;
	const OP_TIMEOUT_MS = 15_000;

	/** Stub the formation dial: the wire round-trip is not what this arm is about. */
	async function stubFormation(node: CadreNode, result: FormStrandResult): Promise<void> {
		await node.initializeStrandSolicitation();
		node.getStrandSolicitationService()!.formStrand = async () => result;
	}

	function watcherOf(node: CadreNode): StrandWatcher {
		return (node as unknown as { strandWatcher: StrandWatcher }).strandWatcher;
	}

	it('re-offers a formed join after a restart over the same keyStore, until forgetJoinedStrand', async () => {
		const partyId = freshPartyId('joined-strand-restart');
		const keyStore = new InMemoryKeyStore();
		const storage = memoryStorageProvider();
		const config = () => controlNodeConfig({ partyId, profile: 'transaction', keyStore, storage });
		const strandId = `joined-${Math.random().toString(36).slice(2)}`;

		const first = new CadreNode(config());
		try {
			await within('first.start()', LIFECYCLE_TIMEOUT_MS, () => first.start());
			await stubFormation(first, {
				memberKey: 'joiner-member-key',
				invitePrivateKey: '',
				strandId,
				memberPrivateKey: 'shared-read-secret',
				strandAddrs: []
			});
			await within('formStrand()', OP_TIMEOUT_MS, () => first.formStrand({
				token: 'token',
				sAppId: 'sapp-joined',
				expiration: new Date(Date.now() + 3600_000),
				bootstrap: ['/ip4/127.0.0.1/tcp/1']
			}));
		} finally {
			await within('first.stop()', LIFECYCLE_TIMEOUT_MS, () => first.stop());
		}

		const second = new CadreNode(config());
		try {
			await within('second.start()', LIFECYCLE_TIMEOUT_MS, () => second.start());
			await within('forcePoll()', OP_TIMEOUT_MS, () => watcherOf(second).forcePoll());

			expect(second.getDiscoveredStrands().get(strandId),
				'the restarted node did not offer the strand it joined — nothing but an app-side list would bring it back'
			).toEqual({ Id: strandId, Type: 'c', MemberPrivateKey: 'shared-read-secret', FounderOwnerKey: null });

			await within('forgetJoinedStrand()', OP_TIMEOUT_MS, () => second.forgetJoinedStrand(strandId));

			expect(second.getDiscoveredStrands().has(strandId)).toBe(false);
			expect((await keyStore.list()).filter((id) => id.startsWith('cadre/joined-strand/')),
				'the join is still in the keyStore, so the next start offers the strand the app left'
			).toEqual([]);
		} finally {
			await within('second.stop()', LIFECYCLE_TIMEOUT_MS, () => second.stop());
		}
	}, 180_000);
});
