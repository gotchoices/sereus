/**
 * Carrying the strands of the party this app founded into the party it joins
 * (docs/architecture.md → "An app joins an existing cadre" → "Moving the app's strands").
 *
 * The app runs one node, so cadre-core's two ends of a move run on two nodes, one after the
 * other: `exportStrandBundle` on the left party's node before the switch, `adoptStrandBundle` on
 * the joined party's node once the app's key is wired as an owner there. Between them the bundle
 * is kept here, one record per left party, so a join killed partway, or an owner key wired only
 * on a later launch, finishes the move on a later start. The bundle carries read secrets, party
 * keys and bearer invitations, so the record lives in the secure store beside the identity.
 */

import { adoptStrandBundle, StrandMoveNotOwnerError } from '@serfab/cadre-core';
import type { CadreInvitation, CadreNode, KeyId, KeyStore, StrandBundle, StrandMoveReport } from '@serfab/cadre-core';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { secureStoreKeySegment } from '../key-store.js';

/** How a join's strand move settled: `JoinCadreResult.strandMove`. */
export type StrandMoveOutcome =
	/** Adopted. `partial`: `report.failed` lists what the next start, or `finishStrandMove`, retries. */
	| { state: 'done' | 'partial'; report: StrandMoveReport }
	/** Not adopted yet: the app's key is not wired as an owner of the joined party. A start after it is adopts. */
	| { state: 'deferred'; reason: 'owner-key-not-wired' }
	/** Not adopted yet: the adoption threw (logged). The next start, or `finishStrandMove`, retries. */
	| { state: 'deferred'; reason: 'adoption-failed'; error: Error };

/** A move still waiting: `PhoneNode.pendingStrandMove`. */
export interface PendingStrandMove {
	fromPartyId: string;
	/** The party the strands move into; the record is adopted there and nowhere else. */
	toPartyId: string;
	/** Strands of `fromPartyId` not seated in `toPartyId` yet. */
	strandIds: string[];
	/** Strands `toPartyId` refused permanently so far: it participates in them under its own identity. */
	refused: StrandMoveReport['refused'];
}

/**
 * `PhoneNode.joinCadre` refused before anything stopped: the party this app founded holds strands,
 * pending joins or invitations, and the invitation does not make the app an owner of the party it
 * joins. Every row a move seats there is owner-signed, so a member's join would leave them in a
 * party the app no longer runs.
 */
export class StrandsNeedOwnerJoinError extends Error {
	readonly fromPartyId: string;
	readonly toPartyId: string;
	readonly strandCount: number;

	constructor(bundle: StrandBundle, toPartyId: string) {
		super(
			`Cannot join party ${toPartyId} as a member: ${describeContent(bundle)} of party ${bundle.partyId} ` +
			'would be left behind, and only an owner can move them. Ask for an invitation that grants owner.',
		);
		this.name = 'StrandsNeedOwnerJoinError';
		this.fromPartyId = bundle.partyId;
		this.toPartyId = toPartyId;
		this.strandCount = bundle.strands.length;
	}
}

/** What the secure store holds for one left party between the export and a complete adoption. */
interface StrandMoveRecord {
	v: typeof RECORD_VERSION;
	targetPartyId: string;
	bundle: StrandBundle;
	/** Strand ids an earlier adoption seated. Never left out of a retry: an invitation bound to one needs it under `moved`. */
	moved: string[];
	/** Permanent refusals from earlier adoptions, left out of a retry and reported each time. */
	refused: StrandMoveReport['refused'];
}

const RECORD_VERSION = 1;

/** Key-store id prefix of every move record; the left party's id follows, base64url. */
const SLOT_PREFIX = 'cadre/strand-move/';

function slotId(fromPartyId: string): KeyId {
	return SLOT_PREFIX + secureStoreKeySegment(fromPartyId);
}

/** The move records, one key-store slot per left party. A read the key store refuses throws; it is never read as "no record". */
export class StrandMoveRecords {
	constructor(private readonly keyStore: KeyStore) {}

	/**
	 * Replaces the left party's record: a newer export is the fuller one.
	 *
	 * NOTE: a bundle with a routing table per strand runs past expo-secure-store's 2048-byte
	 * value guideline; version 14 warns and stores it, and the iOS Keychain and Android's
	 * encrypted preferences hold more. If a later SDK throws instead, keep the routing tables
	 * (not secret) in the node-local LevelDB and only the secrets here.
	 */
	save(record: StrandMoveRecord): Promise<void> {
		return this.keyStore.set(slotId(record.bundle.partyId), uint8ArrayFromString(JSON.stringify(record), 'utf8'));
	}

	load(fromPartyId: string): Promise<StrandMoveRecord | undefined> {
		return this.read(slotId(fromPartyId));
	}

	remove(fromPartyId: string): Promise<void> {
		return this.keyStore.delete(slotId(fromPartyId));
	}

	/** Every record naming `toPartyId`, in slot order. */
	async naming(toPartyId: string): Promise<StrandMoveRecord[]> {
		const slots = (await this.keyStore.list()).filter((slot) => slot.startsWith(SLOT_PREFIX)).sort();
		const records: StrandMoveRecord[] = [];
		for (const slot of slots) {
			const record = await this.read(slot);
			if (record?.targetPartyId === toPartyId) records.push(record);
		}
		return records;
	}

	/**
	 * The record in `slot`. One that does not parse is deleted with a warning: nothing can adopt
	 * it, and the strands are still in the left party's storage. Its absence then reads as
	 * "nothing waiting", so code that deletes that storage must not take a missing record alone
	 * as proof that every strand reached the joined party.
	 */
	private async read(slot: KeyId): Promise<StrandMoveRecord | undefined> {
		const bytes = await this.keyStore.get(slot);
		if (bytes === undefined) return undefined;
		const record = parseRecord(uint8ArrayToString(bytes, 'utf8'));
		if (record !== undefined && slotId(record.bundle.partyId) === slot) return record;
		console.warn(`[cadre-rn/phone-node] deleting the strand move record in ${slot}: it is not one this kit wrote`);
		try {
			await this.keyStore.delete(slot);
		} catch (err) {
			// Read as absent either way; failing every start over a record nothing can use would be worse.
			console.warn(`[cadre-rn/phone-node] could not delete the strand move record in ${slot}:`, err);
		}
		return undefined;
	}
}

/**
 * The record a join writes before the switch, or `undefined` when the bundle holds nothing to
 * move. Throws {@link StrandsNeedOwnerJoinError} when it does and the invitation does not make
 * the app an owner of the party it joins.
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
		console.warn(`[cadre-rn/phone-node] could not update the strand move record of party ${fromPartyId}; the next start adopts it again:`, err);
	}
}

/**
 * Adopt every record naming the node's party, by left party. A record the key store refuses to
 * read throws; an adoption that throws is logged and reported as deferred, and its record kept.
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
		console.warn(`[cadre-rn/phone-node] moving the strands of party ${record.bundle.partyId} failed; the next start retries:`, err);
		return deferredOutcome(err);
	}
}

export function deferredOutcome(err: unknown): StrandMoveOutcome {
	if (err instanceof StrandMoveNotOwnerError) return { state: 'deferred', reason: 'owner-key-not-wired' };
	return { state: 'deferred', reason: 'adoption-failed', error: err instanceof Error ? err : new Error(String(err)) };
}

export function pendingMove(record: StrandMoveRecord): PendingStrandMove {
	const settled = new Set([...record.moved, ...record.refused.map((entry) => entry.strandId)]);
	return {
		fromPartyId: record.bundle.partyId,
		toPartyId: record.targetPartyId,
		strandIds: record.bundle.strands.map((entry) => entry.row.Id).filter((strandId) => !settled.has(strandId)),
		refused: record.refused,
	};
}

/** The record in `text`, or `undefined` (logged) when it is not one. */
function parseRecord(text: string): StrandMoveRecord | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		console.warn('[cadre-rn/phone-node] a strand move record is not JSON:', err);
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

/** "2 strands and 1 invitation": the bundle's non-empty lists. */
function describeContent(bundle: StrandBundle): string {
	const parts = [
		count(bundle.strands.length, 'strand'),
		count(bundle.pendingJoins.length, 'pending join'),
		count(bundle.formationInvites.length, 'invitation'),
	].filter((part): part is string => part !== null);
	return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts.join('');
}

function count(n: number, noun: string): string | null {
	if (n === 0) return null;
	return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
