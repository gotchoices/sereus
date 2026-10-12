/**
 * party-start.ts — the record that names the party this tab starts, and how it came to it
 * (docs/architecture.md → "An app joins an existing cadre"). The browser counterpart of the
 * phone kit's saved start (`cadre-rn/src/phone-node/options.ts`), without `autoStart`: a tab
 * always starts on load.
 *
 * One record per tab, not per party, under a dot-free `kv` key of the node-local database: it
 * is what names the party every per-party record (`node-local-slots.ts`) is read through. A
 * tab mints a party and writes `{ origin: 'founded' }` on its first load; a join rewrites the
 * record once a member admitted the tab, with `origin: 'joined'` and the founded party it
 * left as `formerPartyId`, until dissolving that party drops it (`web-dissolve.ts`). An owner
 * removing the tab from the party it names turns it back into the founded party's start, or
 * deletes it ({@link startAfterRemoval}; `web-join.ts` → `forgetRemovedParty`). A joined
 * party never runs owner genesis: genesis on a party whose control store has not arrived would
 * seat this tab as a second founder.
 */
import type { OptimysticWebDBHandle } from '@optimystic/db-p2p-storage-web';

/** Whether this tab founded its party, or joined it by invitation. */
export type PartyOrigin = 'founded' | 'joined';

export interface PartyStart {
	v: typeof RECORD_VERSION;
	partyId: string;
	origin: PartyOrigin;
	/** The party this tab founded and left by joining another; its data stays in IndexedDB under its own names until the tab dissolves it. */
	formerPartyId?: string;
}

const RECORD_VERSION = 1;

/** `kv` key of the start record. Dot-free, so it cannot collide with a `<record>.<partyId>` key. */
export const PARTY_START_KV_KEY = 'party-start';

/** A tab with no start record founds a party of its own. */
export function newFoundedStart(): PartyStart {
	return foundedStart(crypto.randomUUID());
}

export function foundedStart(partyId: string): PartyStart {
	return { v: RECORD_VERSION, partyId, origin: 'founded' };
}

/** `start` without `formerPartyId` when it names `partyId`. */
export function withoutFormerParty(start: PartyStart, partyId: string): PartyStart {
	if (start.formerPartyId !== partyId) return start;
	const { formerPartyId: _removed, ...rest } = start;
	return rest;
}

/** The start a join writes once a member admitted the tab into `partyId`. */
export function joinedStart(partyId: string, formerPartyId: string | undefined): PartyStart {
	return { v: RECORD_VERSION, partyId, origin: 'joined', ...(formerPartyId !== undefined && { formerPartyId }) };
}

/**
 * The start once an owner of its party removed this tab (the phone kit's `startAfterRemoval`): the
 * party the tab founded and left, founded again, or `undefined` when it left none, so the next start
 * founds a party of its own. Unlike the kit's, it cannot be kept from starting: a tab starts on load,
 * which is what "Go back to your own cadre" does.
 */
export function startAfterRemoval(start: PartyStart): PartyStart | undefined {
	const { partyId, formerPartyId } = start;
	if (formerPartyId === undefined || formerPartyId === partyId) return undefined;
	return foundedStart(formerPartyId);
}

/**
 * The stored record, or `undefined` when the tab has none yet. A record that is present but not
 * one this module wrote throws: starting a fresh party over an unreadable record would orphan
 * the party it names, the same posture as an unreadable trusted-owner anchor.
 */
export async function readPartyStart(handle: OptimysticWebDBHandle): Promise<PartyStart | undefined> {
	const raw = await handle.get('kv', PARTY_START_KV_KEY);
	if (raw === undefined) return undefined;
	if (typeof raw !== 'string') {
		throw new Error(`The start record (kv "${PARTY_START_KV_KEY}") is not text; clear this site's data to start over`);
	}
	return parsePartyStart(raw);
}

/** One `put`, so a reload between two writes cannot see half a record. */
export async function writePartyStart(handle: OptimysticWebDBHandle, start: PartyStart): Promise<void> {
	await handle.put('kv', JSON.stringify(start), PARTY_START_KV_KEY);
}

/** The next start then founds a party of the tab's own, as a first load does. */
export async function deletePartyStart(handle: OptimysticWebDBHandle): Promise<void> {
	await handle.delete('kv', PARTY_START_KV_KEY);
}

/** The record in `text`; throws, naming the fault, when it is not a version-1 record. */
export function parsePartyStart(text: string): PartyStart {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		throw new Error(`The start record (kv "${PARTY_START_KV_KEY}") is not JSON; clear this site's data to start over`, { cause: err });
	}
	if (!isPartyStart(raw)) {
		throw new Error(`The start record (kv "${PARTY_START_KV_KEY}") is malformed or of an unsupported version; clear this site's data to start over`);
	}
	return raw;
}

function isPartyStart(value: unknown): value is PartyStart {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const { v, partyId, origin, formerPartyId } = value as Record<string, unknown>;
	return v === RECORD_VERSION
		&& typeof partyId === 'string' && partyId.length > 0
		&& (origin === 'founded' || origin === 'joined')
		&& (formerPartyId === undefined || (typeof formerPartyId === 'string' && formerPartyId.length > 0));
}
