/**
 * The node-local record of strands joined from ANOTHER party (`joined-strand-store.ts`):
 * nothing in this party's control database names such a strand, so this record is the only
 * thing that brings it back after a restart (gotchoices/sereus#18).
 *
 *  - The KeyStore-backed store reads its joins back through a fresh instance, drops a slot
 *    that is not a record for its own id while keeping the rest, and never lists another
 *    party's joins from a KeyStore two parties share (the React Native app keeps one per
 *    device).
 *  - The strand watcher's view unions the joins with the control rows, lets a control row
 *    win (and forgets the stale record), and keeps offering a join forgotten on
 *    self-revocation until the session ends — `strand:revoked` tears nothing down.
 *  - End to end on a real node: a join `formStrand` recorded comes back as
 *    `strand:discovered` after a restart over the same `keyStore`, with no app-side list,
 *    until `forgetJoinedStrand`.
 */
import { describe, it, expect } from 'vitest';
import { fromString as uint8ArrayFromString } from 'uint8arrays';
import { CadreNode } from '../src/cadre-node.js';
import { InMemoryKeyStore } from '../src/key-store.js';
import {
	JoinedStrandRows,
	KeyStoreJoinedStrandStore,
	type JoinedStrandRecord
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

describe('JoinedStrandRows', () => {
	it('offers each join beside the control rows, and forgets one a control row now names', async () => {
		const store = new KeyStoreJoinedStrandStore(new InMemoryKeyStore(), PARTY);
		const control: StrandRow[] = [
			{ Id: 'own', Type: 'o', MemberPrivateKey: null, FounderOwnerKey: 'owner-key' },
			{ Id: 'adopted', Type: 'c', MemberPrivateKey: 'control-secret', FounderOwnerKey: null }
		];
		await store.record(closedJoin);
		await store.record({ Id: 'adopted', Type: 'c', MemberPrivateKey: 'stale-secret', joinedAt: 3 });

		expect(await new JoinedStrandRows(store).withControlRows(control)).toEqual([
			...control,
			{ Id: closedJoin.Id, Type: 'c', MemberPrivateKey: 'read-secret', FounderOwnerKey: null }
		]);
		expect(await store.list()).toEqual([closedJoin]);
	});

	it('keeps offering a join forgotten on self-revocation until the session ends', async () => {
		const store = new KeyStoreJoinedStrandStore(new InMemoryKeyStore(), PARTY);
		await store.record(closedJoin);
		const session = new JoinedStrandRows(store);

		await session.forgetAfterThisSession(closedJoin.Id);

		expect((await session.withControlRows([])).map((row) => row.Id),
			'a revoked join vanished mid-session — the watcher would read that as a removal and tear the strand down'
		).toEqual([closedJoin.Id]);
		expect(await new JoinedStrandRows(store).withControlRows([]),
			'a revoked join is still offered by the next session, so the removed party re-attaches it on every launch'
		).toEqual([]);
	});
});

describe('CadreNode remembers strands joined from another party', () => {
	const within = scopedWithin('joined-strand-restart');
	const LIFECYCLE_TIMEOUT_MS = 60_000;
	const OP_TIMEOUT_MS = 15_000;

	/** Stub the formation dial: the wire round-trip is not what this arm is about. */
	function stubFormation(node: CadreNode, result: FormStrandResult): void {
		node.initializeStrandSolicitation();
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
			stubFormation(first, {
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
