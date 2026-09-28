/**
 * Node-local record of the strands this node joined from ANOTHER party.
 *
 * A party's own strands come back after a restart through its control database: the
 * `Strand` table holds their rows, the strand watcher polls it, and each row no sApp
 * config claims is offered as `strand:discovered`. A strand joined through formation with
 * another party (`CadreNode.formStrand`) has no row there — the other party's control
 * database holds it — so nothing re-offered it after a restart, and every embedding app
 * kept its own list of joins, read secret included (gotchoices/sereus#18).
 *
 * `CadreNode` records each such join here, hands the records to its strand watcher beside
 * the control rows ({@link JoinedStrandRows}), and forgets one on `forgetJoinedStrand` or
 * when this party is removed from the strand.
 *
 * Two implementations:
 *  - {@link MemoryJoinedStrandStore} — joins die with the process. The default only for a
 *    node configured with no `keyStore`.
 *  - {@link KeyStoreJoinedStrandStore} — one {@link KeyStore} slot per join. A record holds
 *    the closed strand's shared read secret, and the KeyStore is the one seam every
 *    platform already routes secrets through (the platform enclave on React Native, the
 *    state directory for `FileKeyStore`), so the record goes there rather than into a
 *    `DurableSlot` like the bootstrap-peer store.
 *
 * Party-scoped like every other node-local store, because one KeyStore can serve several
 * parties: the React Native app keeps one per device and lets the user switch party. A
 * join made for one party must never be offered to a node started for another.
 *
 * Dependency-free beyond the KeyStore seam, so safe in every entry graph.
 */
import debug from 'debug';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import type { KeyId, KeyStore } from './key-store.js';
import { assertStrandScopeKey, isValidStrandScopeKey } from './storage-scope.js';
import type { StrandRow } from './types.js';

const log = debug('sereus:cadre:joined-strand-store');

/** One strand this node joined from ANOTHER party — nothing in this party's control DB names it. */
export interface JoinedStrandRecord {
	/** The strand id (a valid scope key, see storage-scope.ts). */
	Id: string;
	Type: 'o' | 'c';
	/** The closed strand's shared read secret the formation delivered; null for an open strand. */
	MemberPrivateKey: string | null;
	/** Wall-clock ms this node first recorded the join. Diagnostics only. */
	joinedAt: number;
}

export interface JoinedStrandStore {
	/** Party this store is scoped to. */
	readonly partyId: string;

	/** Every remembered join. A call reflects every {@link record}/{@link forget} that resolved before it was made. */
	list(): Promise<JoinedStrandRecord[]>;

	/** Remember a join, REPLACING any record with the same `Id`. */
	record(record: JoinedStrandRecord): Promise<void>;

	/** Forget a join. A no-op when there is no record for `strandId`. */
	forget(strandId: string): Promise<void>;
}

/**
 * The {@link StrandRow} a record stands for — the shape `addStrand` and `strand:discovered`
 * carry. `FounderOwnerKey` is null because a joiner never founds; `CadreNode.launchStrand`
 * reads null as "not mine" and joins.
 */
export function joinedStrandRow(record: JoinedStrandRecord): StrandRow {
	return { Id: record.Id, Type: record.Type, MemberPrivateKey: record.MemberPrivateKey, FounderOwnerKey: null };
}

/**
 * Ephemeral store for a node without a `keyStore`. Warns once, at the first join it is
 * asked to remember, because a join held only here is not re-offered after a restart —
 * exactly the gotchoices/sereus#18 shape, and it should show in a log rather than pass
 * silently.
 */
export class MemoryJoinedStrandStore implements JoinedStrandStore {
	private readonly records = new Map<string, JoinedStrandRecord>();
	private warned = false;

	constructor(readonly partyId: string) {}

	async list(): Promise<JoinedStrandRecord[]> {
		return [...this.records.values()];
	}

	async record(record: JoinedStrandRecord): Promise<void> {
		this.warnOnce();
		this.records.set(record.Id, { ...record });
	}

	async forget(strandId: string): Promise<void> {
		this.records.delete(strandId);
	}

	private warnOnce(): void {
		if (this.warned) {
			return;
		}
		this.warned = true;
		console.warn(
			'CadreNode has no keyStore and no joinedStrands.store, so strands joined from another party ' +
			'are remembered in memory only and will NOT be re-offered after a restart. Configure a keyStore, ' +
			'or inject joinedStrands: { store: new KeyStoreJoinedStrandStore(<a durable KeyStore>, partyId) }.'
		);
	}
}

/** Slot id prefix for every joined-strand record; the party segment and the strand id follow. */
const SLOT_PREFIX = 'cadre/joined-strand/';

/**
 * Durable store over a {@link KeyStore}: one slot per join, id
 * `cadre/joined-strand/<base64url party id>/<strand id>`, holding the record's UTF-8 JSON.
 * The party segment is base64url for the reason `controlStorageScope` gives: a party id is
 * arbitrary text, and base64url never contains the `/` that ends the segment.
 *
 * Loads every slot once, at the first {@link list}, then answers from memory and writes
 * through, so the strand watcher's five-second poll does not read the enclave on every
 * pass. A load that fails — `KeyStoreAccessError` from a refused unlock prompt, say —
 * is rethrown rather than read as "no joins" and retried at the next call, exactly as
 * `loadOrCreateIdentityKey` treats the identity slot. A slot that does not parse as a
 * record for its own id is dropped with a log and its siblings kept: refusing to start
 * repairs nothing, and the other joins are still good.
 */
export class KeyStoreJoinedStrandStore implements JoinedStrandStore {
	private readonly slotPrefix: string;
	/** The loaded records; null until a load succeeds. */
	private records: Map<string, JoinedStrandRecord> | null = null;
	/** Runs every KeyStore access in call order, so a load never interleaves with a write. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly keyStore: KeyStore, readonly partyId: string) {
		this.slotPrefix = SLOT_PREFIX + uint8ArrayToString(uint8ArrayFromString(partyId, 'utf8'), 'base64url') + '/';
	}

	list(): Promise<JoinedStrandRecord[]> {
		return this.inOrder(async () => [...(await this.loaded()).values()]);
	}

	/** Throws `InvalidStrandIdError` for an id that could never load back, before anything is written. */
	record(record: JoinedStrandRecord): Promise<void> {
		assertStrandScopeKey(record.Id);
		const stored: JoinedStrandRecord = { ...record };
		return this.inOrder(async () => {
			await this.keyStore.set(this.slotId(record.Id), uint8ArrayFromString(JSON.stringify(stored), 'utf8'));
			this.records?.set(record.Id, stored);
			log('joined strand remembered (party=%s, strand=%s, type=%s)', this.partyId, record.Id, record.Type);
		});
	}

	forget(strandId: string): Promise<void> {
		return this.inOrder(async () => {
			await this.keyStore.delete(this.slotId(strandId));
			this.records?.delete(strandId);
			log('joined strand forgotten (party=%s, strand=%s)', this.partyId, strandId);
		});
	}

	private slotId(strandId: string): KeyId {
		return this.slotPrefix + strandId;
	}

	private inOrder<T>(op: () => Promise<T>): Promise<T> {
		const result = this.queue.then(op);
		// The caller receives `result`, rejection included; the queue only needs to know it settled.
		this.queue = result.catch(() => undefined);
		return result;
	}

	// NOTE: a failed load is retried at the next list(), which is every strand-watcher poll;
	// over a backend that gates reads behind an unlock prompt the user keeps declining, that
	// is a prompt every five seconds. Every KeyStore shipped today is ungated for this reason
	// (see `SecureStoreKeyStoreOptions.requireAuthentication`); if one is ever gated, back
	// off the retry here.
	private async loaded(): Promise<Map<string, JoinedStrandRecord>> {
		if (this.records) {
			return this.records;
		}
		const records = new Map<string, JoinedStrandRecord>();
		for (const slot of await this.keyStore.list()) {
			if (!slot.startsWith(this.slotPrefix)) {
				continue;
			}
			const strandId = slot.slice(this.slotPrefix.length);
			const bytes = await this.keyStore.get(slot);
			if (!bytes) {
				continue;
			}
			const record = parseRecord(strandId, bytes);
			if (record) {
				records.set(strandId, record);
			}
		}
		this.records = records;
		log('joined strands loaded (party=%s, count=%d)', this.partyId, records.size);
		return records;
	}
}

/** The record a slot holds, or undefined (logged) when it is not one for `strandId`. */
function parseRecord(strandId: string, bytes: Uint8Array): JoinedStrandRecord | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(uint8ArrayToString(bytes, 'utf8'));
	} catch (error) {
		log('dropping joined-strand slot for %s: not JSON (%o)', strandId, error);
		return undefined;
	}
	const { Id, Type, MemberPrivateKey, joinedAt } = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
	const valid = Id === strandId
		&& isValidStrandScopeKey(strandId)
		&& (Type === 'o' || Type === 'c')
		&& (MemberPrivateKey === null || typeof MemberPrivateKey === 'string')
		&& typeof joinedAt === 'number';
	if (!valid) {
		log('dropping joined-strand slot for %s: not a joined-strand record for that id', strandId);
		return undefined;
	}
	return { Id: strandId, Type: Type as 'o' | 'c', MemberPrivateKey: MemberPrivateKey as string | null, joinedAt: joinedAt as number };
}

/**
 * What the strand watcher sees of the joined-strand store: the control rows plus one row per
 * remembered join, which is how a join comes back as `strand:discovered` (or auto-launches)
 * after a restart with no second offer path. One instance per node session.
 *
 * Holds the two pieces of state a plain union would get wrong, both of which would otherwise
 * make the watcher detach running strands, since a joined row missing from a poll reads to it
 * as a removal:
 *  - the last list the store answered, reused when a later list fails, so a read failure is
 *    not "every join was forgotten";
 *  - joins forgotten because this party was removed from the strand
 *    ({@link forgetAfterThisSession}): gone from the store, so the next start does not
 *    re-attach them, but still offered until this session ends, because `strand:revoked`
 *    promises that nothing is torn down for the app.
 */
export class JoinedStrandRows {
	private lastListed: JoinedStrandRecord[] = [];
	private readonly keptForSession = new Map<string, JoinedStrandRecord>();

	constructor(private readonly store: JoinedStrandStore) {}

	/**
	 * `control` plus a row for every remembered join. A control row wins an id collision: the
	 * strand is this party's own now (its founding party enrolled this machine, say), the
	 * control database remembers it, and the record is stale — so it is forgotten here.
	 */
	async withControlRows(control: readonly StrandRow[]): Promise<StrandRow[]> {
		const controlIds = new Set(control.map((row) => row.Id));
		const joined = new Map<string, JoinedStrandRecord>(this.keptForSession);
		for (const record of await this.listed()) {
			joined.set(record.Id, record);
		}
		const rows = [...control];
		for (const record of joined.values()) {
			if (controlIds.has(record.Id)) {
				await this.forgetSuperseded(record.Id);
			} else {
				rows.push(joinedStrandRow(record));
			}
		}
		return rows;
	}

	/** Forget a join for good: the app is leaving the strand. */
	async forget(strandId: string): Promise<void> {
		this.keptForSession.delete(strandId);
		await this.store.forget(strandId);
	}

	/**
	 * Forget a join durably, but keep offering it until this session ends. For a strand this
	 * party was removed from: it must not re-attach on every launch, and it must not be torn
	 * down underneath the app either. A no-op for a strand with no record.
	 */
	async forgetAfterThisSession(strandId: string): Promise<void> {
		const record = (await this.listed()).find((listed) => listed.Id === strandId);
		if (!record) {
			return;
		}
		// Kept BEFORE the store forgets, so no poll can list the store without it and union
		// without the kept copy.
		this.keptForSession.set(strandId, record);
		await this.store.forget(strandId);
	}

	private async listed(): Promise<JoinedStrandRecord[]> {
		try {
			this.lastListed = await this.store.list();
		} catch (error) {
			log('joined-strand store list failed; offering the last list it answered (%d join(s)): %o',
				this.lastListed.length, error);
		}
		return this.lastListed;
	}

	private async forgetSuperseded(strandId: string): Promise<void> {
		this.keptForSession.delete(strandId);
		try {
			await this.store.forget(strandId);
			log('joined strand %s now has a control row — record forgotten', strandId);
		} catch (error) {
			log('forgetting superseded joined strand %s failed; the next poll retries: %o', strandId, error);
		}
	}
}
