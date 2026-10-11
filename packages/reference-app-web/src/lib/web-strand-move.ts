/**
 * web-strand-move.ts — carrying the strands of the party this tab founded into the party it
 * joins (docs/architecture.md → "An app joins an existing cadre" → "Moving the app's strands").
 * The browser counterpart of the phone kit's `strand-move.ts`
 * (`packages/cadre-rn/src/phone-node/strand-move.ts`), with the same record shape and rules.
 *
 * The tab runs one node, so cadre-core's two ends of a move run on two nodes, one after the
 * other: `exportStrandBundle` on the left party's node before the switch, `adoptStrandBundle` on
 * the joined party's node once the tab's key is wired as an owner there. Between them the bundle
 * is kept here, one record per left party, so a join interrupted by a closed tab, or an owner key
 * wired only on a later load, finishes the move on a later start.
 *
 * The bundle carries read secrets, party keys and bearer invitations. In a browser it sits in
 * the node-local IndexedDB database (`kv` store) beside the tab's private identity key, which is
 * that storage's existing trust level: anything that can read the one can read the other.
 */
import { adoptStrandBundle, StrandMoveNotOwnerError } from '@serfab/cadre-core';
import type { CadreInvitation, CadreNode, StrandBundle, StrandMoveReport } from '@serfab/cadre-core';
import type { OptimysticWebDBHandle } from '@optimystic/db-p2p-storage-web';

/** How a join's strand move settled: `JoinCadreResult.strandMove`. */
export type StrandMoveOutcome =
	/** Adopted. `partial`: `report.failed` lists what the next start retries. */
	| { state: 'done' | 'partial'; report: StrandMoveReport }
	/** Not adopted yet: the tab's key is not wired as an owner of the joined party. A start after it is adopts. */
	| { state: 'deferred'; reason: 'owner-key-not-wired' }
	/** Not adopted yet: the adoption threw (logged). The next start retries. */
	| { state: 'deferred'; reason: 'adoption-failed'; error: Error };

/**
 * A join refused before anything stopped: the party this tab founded holds strands, pending
 * joins or invitations, and the invitation does not make the tab an owner of the party it
 * joins. Every row a move seats there is owner-signed, so a member's join would leave them in a
 * party the tab no longer runs.
 */
export class StrandsNeedOwnerJoinError extends Error {
	readonly fromPartyId: string;
	readonly toPartyId: string;
	readonly strandCount: number;

	constructor(bundle: StrandBundle, toPartyId: string) {
		// The words the page shows; the phone app's `join-failure.ts` says the same of "this app".
		const held = bundle.strands.length > 0 ? `its ${strands(bundle.strands.length)}` : 'what its own cadre holds';
		super(`This invitation makes the tab a member, and only an owner can bring ${held} along. Ask for one with “Also an owner” on.`);
		this.name = 'StrandsNeedOwnerJoinError';
		this.fromPartyId = bundle.partyId;
		this.toPartyId = toPartyId;
		this.strandCount = bundle.strands.length;
	}
}

/** "1 strand", "3 strands". */
export function strands(n: number): string {
	return n === 1 ? '1 strand' : `${n} strands`;
}

/** What the `kv` store holds for one left party between the export and a complete adoption. */
export interface StrandMoveRecord {
	v: typeof RECORD_VERSION;
	targetPartyId: string;
	bundle: StrandBundle;
	/** Strand ids an earlier adoption seated. Never left out of a retry: an invitation bound to one needs it under `moved`. */
	moved: string[];
	/** Permanent refusals from earlier adoptions, left out of a retry and reported each time. */
	refused: StrandMoveReport['refused'];
}

const RECORD_VERSION = 1;

/** `kv` key prefix of every move record; the left party's id follows. */
const KEY_PREFIX = 'strand-move.';

export function strandMoveKvKey(fromPartyId: string): string {
	return KEY_PREFIX + fromPartyId;
}

/**
 * The move records, one `kv` key per left party. A read IndexedDB refuses throws; it is never
 * read as "no record".
 */
export class StrandMoveRecords {
	constructor(private readonly handle: OptimysticWebDBHandle) {}

	/** Replaces the left party's record: a newer export is the fuller one. */
	async save(record: StrandMoveRecord): Promise<void> {
		await this.handle.put('kv', JSON.stringify(record), strandMoveKvKey(record.bundle.partyId));
	}

	load(fromPartyId: string): Promise<StrandMoveRecord | undefined> {
		return this.read(strandMoveKvKey(fromPartyId));
	}

	remove(fromPartyId: string): Promise<void> {
		return this.handle.delete('kv', strandMoveKvKey(fromPartyId));
	}

	/**
	 * Every record naming `toPartyId`, in key order. Lists every key of the `kv` store: it holds
	 * the identity, the start record, four records per party and one move record per left party,
	 * a few dozen at most.
	 */
	async naming(toPartyId: string): Promise<StrandMoveRecord[]> {
		const keys = (await this.handle.getAllKeys('kv')).filter((key) => key.startsWith(KEY_PREFIX)).sort();
		const records: StrandMoveRecord[] = [];
		for (const key of keys) {
			const record = await this.read(key);
			if (record?.targetPartyId === toPartyId) records.push(record);
		}
		return records;
	}

	/**
	 * The record under `key`. One that does not parse is deleted with a warning: nothing can adopt
	 * it, and the strands are still in the left party's storage. Its absence then reads as
	 * "nothing waiting", so code that deletes that storage must not take a missing record alone
	 * as proof that every strand reached the joined party.
	 */
	private async read(key: string): Promise<StrandMoveRecord | undefined> {
		const raw = await this.handle.get('kv', key);
		if (raw === undefined) return undefined;
		const record = typeof raw === 'string' ? parseRecord(raw) : undefined;
		if (record !== undefined && strandMoveKvKey(record.bundle.partyId) === key) return record;
		console.warn(`[reference-app-web] deleting the strand move record under ${key}: it is not one this tab wrote`);
		try {
			await this.handle.delete('kv', key);
		} catch (err) {
			// Read as absent either way; failing every start over a record nothing can use would be worse.
			console.warn(`[reference-app-web] could not delete the strand move record under ${key}:`, err);
		}
		return undefined;
	}
}

/**
 * The record a join writes before the switch, or `undefined` when the bundle holds nothing to
 * move. Throws {@link StrandsNeedOwnerJoinError} when it does and the invitation does not make
 * the tab an owner of the party it joins.
 */
export function joinMoveRecord(bundle: StrandBundle, invitation: CadreInvitation): StrandMoveRecord | undefined {
	if (bundle.strands.length + bundle.pendingJoins.length + bundle.formationInvites.length === 0) return undefined;
	if (!invitation.invite.grantsOwner) throw new StrandsNeedOwnerJoinError(bundle, invitation.partyId);
	return { v: RECORD_VERSION, targetPartyId: invitation.partyId, bundle, moved: [], refused: [] };
}

/**
 * Adopt `record` on `node`, running in the record's target party, without the strands an earlier
 * attempt had refused; then delete the record when nothing failed, or save this attempt's
 * progress. The report lists every refusal so far. Throws what `adoptStrandBundle` throws. A
 * failure updating the record is only logged: the record left behind is adopted again, without
 * harm, by the next start.
 */
export async function adoptMoveRecord(node: CadreNode, records: StrandMoveRecords, record: StrandMoveRecord): Promise<StrandMoveReport> {
	const refused = new Set(record.refused.map((entry) => entry.strandId));
	const strands = record.bundle.strands.filter((entry) => !refused.has(entry.row.Id));
	const adopted = await adoptStrandBundle(node, { ...record.bundle, strands });
	const report: StrandMoveReport = { ...adopted, refused: [...record.refused, ...adopted.refused] };
	await keepWhatIsLeft(records, record, report);
	return report;
}

async function keepWhatIsLeft(records: StrandMoveRecords, record: StrandMoveRecord, report: StrandMoveReport): Promise<void> {
	const fromPartyId = record.bundle.partyId;
	try {
		if (report.failed.length === 0) {
			await records.remove(fromPartyId);
		} else {
			const moved = [...new Set([...record.moved, ...report.moved])];
			await records.save({ ...record, moved, refused: report.refused });
		}
	} catch (err) {
		console.warn(`[reference-app-web] could not update the strand move record of party ${fromPartyId}; the next start adopts it again:`, err);
	}
}

/**
 * Adopt every record naming the node's party, by left party. A record IndexedDB refuses to read
 * throws; an adoption that throws is logged and reported as deferred, and its record kept.
 */
export async function adoptMovesInto(node: CadreNode, records: StrandMoveRecords): Promise<Map<string, StrandMoveOutcome>> {
	const outcomes = new Map<string, StrandMoveOutcome>();
	for (const record of await records.naming(node.partyId)) {
		outcomes.set(record.bundle.partyId, await adoptOrDefer(node, records, record));
	}
	return outcomes;
}

async function adoptOrDefer(node: CadreNode, records: StrandMoveRecords, record: StrandMoveRecord): Promise<StrandMoveOutcome> {
	try {
		const report = await adoptMoveRecord(node, records, record);
		return { state: report.failed.length === 0 ? 'done' : 'partial', report };
	} catch (err) {
		console.warn(`[reference-app-web] moving the strands of party ${record.bundle.partyId} failed; the next start retries:`, err);
		return deferredOutcome(err);
	}
}

export function deferredOutcome(err: unknown): StrandMoveOutcome {
	if (err instanceof StrandMoveNotOwnerError) return { state: 'deferred', reason: 'owner-key-not-wired' };
	return { state: 'deferred', reason: 'adoption-failed', error: err instanceof Error ? err : new Error(String(err)) };
}

/** The strand ids of `record` not seated or refused yet. */
export function waitingStrandIds(record: StrandMoveRecord): string[] {
	const settled = new Set([...record.moved, ...record.refused.map((entry) => entry.strandId)]);
	return record.bundle.strands.map((entry) => entry.row.Id).filter((strandId) => !settled.has(strandId));
}

/** The record in `text`, or `undefined` (logged) when it is not one. */
function parseRecord(text: string): StrandMoveRecord | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		console.warn('[reference-app-web] a strand move record is not JSON:', err);
		return undefined;
	}
	return isRecord(raw) ? raw : undefined;
}

/** The record's shape down to the bundle's lists; their entries are cadre-core's export, written by this module. */
function isRecord(value: unknown): value is StrandMoveRecord {
	if (!isObject(value) || value.v !== RECORD_VERSION || typeof value.targetPartyId !== 'string') return false;
	if (!Array.isArray(value.moved) || !Array.isArray(value.refused)) return false;
	const bundle = value.bundle;
	return isObject(bundle)
		&& bundle.v === 1
		&& typeof bundle.partyId === 'string'
		&& Array.isArray(bundle.strands)
		&& Array.isArray(bundle.pendingJoins)
		&& Array.isArray(bundle.formationInvites);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
