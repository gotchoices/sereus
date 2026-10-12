/**
 * web-dissolve.ts — removing the party this tab founded and left (docs/architecture.md → "An app
 * joins an existing cadre" → "Dissolving the party it left"): the check that the running party
 * holds everything the left one holds, and the removal of the left party's IndexedDB storage. The
 * browser counterpart of the phone kit's `dissolve.ts` (`packages/cadre-rn/src/phone-node/dissolve.ts`),
 * with the same refusals, marker and removal order. The transition that stops and starts the node
 * around them is `web-join.ts`'s. The same marked removal deletes the storage of a party an owner
 * removed this tab from, with no check: that party is not the tab's to keep (`web-join.ts` →
 * `forgetRemovedParty`).
 *
 * The removal is local: it writes nothing to either party's control database. A marker in the
 * node-local database names the party from before the first deletion until after the start record
 * stops naming it, so a removal a closed tab or a failed step interrupts is finished by the next
 * start without checking again: the check passed before the marker was written. Every step
 * deletes what may already be gone.
 */
import { controlStorageScope, exportStrandBundle, unheldBundleContent } from '@serfab/cadre-core';
import type { CadreNode, StrandBundle, StrandHoldings } from '@serfab/cadre-core';
import type { OptimysticWebDBHandle } from '@optimystic/db-p2p-storage-web';
import { deleteStore } from './strand-storage.js';
import { PARTY_KV_KEYS, partyKvKey } from './node-local-slots.js';
import { readPartyStart, withoutFormerParty, writePartyStart, type PartyStart } from './party-start.js';
import { StrandMoveRecords, waitingStrandIds, type StrandMoveRecord } from './web-strand-move.js';

/**
 * The dissolve refused, nothing stopped: a move record from the former party still waits to be
 * adopted, so the running party may not hold its strands yet.
 */
export class StrandMovePendingError extends Error {
	readonly fromPartyId: string;
	readonly toPartyId: string;
	/** The strands not seated or refused yet. */
	readonly strandIds: string[];

	constructor(record: StrandMoveRecord) {
		super('Moving this tab’s strands has not finished');
		this.name = 'StrandMovePendingError';
		this.fromPartyId = record.bundle.partyId;
		this.toPartyId = record.targetPartyId;
		this.strandIds = waitingStrandIds(record);
	}
}

/** What keeps a former party from being dissolved: `FormerPartyNotEmptyError`'s lists. */
interface FormerPartyRemains {
	otherMachines: string[];
	strandIds: string[];
	pendingJoinIds: string[];
}

/** The dissolve refused, nothing deleted: the former party holds what the running party lacks, or has other machines. */
export class FormerPartyNotEmptyError extends Error {
	readonly partyId: string;
	/** Peer ids of `CadrePeer` rows other than this tab's. Not discardable: removing them is the user's choice, made in that party. */
	readonly otherMachines: string[];
	/** Not held by the running party and not in `discard`. */
	readonly strandIds: string[];
	/** Open pending joins the running party does not hold, and not in `discard`. */
	readonly pendingJoinIds: string[];

	constructor(partyId: string, remains: FormerPartyRemains) {
		super(`Cannot dissolve party ${partyId}: ${describeRemains(remains)}`);
		this.name = 'FormerPartyNotEmptyError';
		this.partyId = partyId;
		this.otherMachines = remains.otherMachines;
		this.strandIds = remains.strandIds;
		this.pendingJoinIds = remains.pendingJoinIds;
	}
}

/** What the former party holds, read from a node started for it alone. */
export interface FormerPartyContent {
	bundle: StrandBundle;
	/** Peer ids of its `CadrePeer` rows other than the reading node's. */
	otherMachines: string[];
}

export async function readFormerParty(node: CadreNode): Promise<FormerPartyContent> {
	const self = node.peerId?.toString();
	const machines = new Set((await node.listMembers()).map((member) => member.peerId));
	return { bundle: await exportStrandBundle(node), otherMachines: [...machines].filter((peerId) => peerId !== self) };
}

/** The refusal `content` earns against what the running party holds, or null when it may be dissolved. */
export function formerPartyRefusal(
	content: FormerPartyContent,
	holdings: StrandHoldings,
	discard: readonly string[],
	nowMs: number,
): FormerPartyNotEmptyError | null {
	const discarded = new Set(discard);
	const unheld = unheldBundleContent(content.bundle, holdings, nowMs);
	const remains: FormerPartyRemains = {
		otherMachines: content.otherMachines,
		strandIds: unheld.strandIds.filter((strandId) => !discarded.has(strandId)),
		pendingJoinIds: unheld.pendingJoinIds.filter((joinId) => !discarded.has(joinId)),
	};
	const empty = remains.otherMachines.length + remains.strandIds.length + remains.pendingJoinIds.length === 0;
	return empty ? null : new FormerPartyNotEmptyError(content.bundle.partyId, remains);
}

/** `kv` key of the marker. Dot-free, so it cannot collide with a `<record>.<partyId>` key. */
export const DISSOLVE_MARKER_KV_KEY = 'dissolving-party';

const MARKER_VERSION = 1;

/**
 * Mark `partyId` as being dissolved, then remove its storage. Only once the decision to remove it
 * is made (a dissolve's check passed, or an owner removed this tab from it), with no node of it
 * running and no start record naming it as the party to start.
 */
export async function removeParty(handle: OptimysticWebDBHandle, partyId: string): Promise<void> {
	await handle.put('kv', JSON.stringify({ v: MARKER_VERSION, partyId }), DISSOLVE_MARKER_KV_KEY);
	await finishRemoving(handle, partyId);
}

/** Finish the removal a marker names, if any, so a new {@link removeParty} does not replace its marker. Throws its failure, the marker kept. */
export async function finishMarkedRemoval(handle: OptimysticWebDBHandle): Promise<void> {
	const partyId = await markedParty(handle);
	if (partyId !== undefined) await finishRemoving(handle, partyId);
}

/** A removal a marker names that the start could not finish; the marker stays for the next start. */
export interface UnfinishedRemoval {
	partyId: string;
	error: Error;
}

/**
 * Before a start of `starting`: finish the removal a marker names, and return the start to run,
 * without `formerPartyId` when the marker names it, finished or not. A failure is logged and
 * returned, and the start goes on. A marker naming the party being started was written by neither
 * removal: a dissolve never names the running party, and the removal of a party that removed this
 * tab names it only once its node has stopped and the start record no longer names it. Such a
 * marker is deleted with a warning, not acted on.
 */
export async function finishRemovalAtStart(
	handle: OptimysticWebDBHandle,
	starting: PartyStart,
): Promise<{ start: PartyStart; unfinished: UnfinishedRemoval | null }> {
	const partyId = await markedParty(handle);
	if (partyId === undefined) return { start: starting, unfinished: null };
	if (partyId === starting.partyId) {
		console.warn(`[reference-app-web] deleting the dissolve marker: it names party ${partyId}, the one starting`);
		await handle.delete('kv', DISSOLVE_MARKER_KV_KEY);
		return { start: starting, unfinished: null };
	}
	const start = withoutFormerParty(starting, partyId);
	try {
		await finishRemoving(handle, partyId);
		return { start, unfinished: null };
	} catch (err) {
		console.warn(`[reference-app-web] finishing the removal of party ${partyId} failed; the next start retries:`, err);
		return { start, unfinished: { partyId, error: err instanceof Error ? err : new Error(String(err)) } };
	}
}

/**
 * The party a begun dissolve names, or `undefined`. A marker that does not parse is deleted with a
 * warning: nothing can finish it, and the party it named keeps what is left of its storage.
 */
async function markedParty(handle: OptimysticWebDBHandle): Promise<string | undefined> {
	const raw = await handle.get('kv', DISSOLVE_MARKER_KV_KEY);
	if (raw === undefined) return undefined;
	const partyId = typeof raw === 'string' ? parseMarker(raw) : undefined;
	if (partyId === undefined) {
		console.warn(`[reference-app-web] deleting the dissolve marker (kv "${DISSOLVE_MARKER_KV_KEY}"): it is not one this tab wrote`);
		await handle.delete('kv', DISSOLVE_MARKER_KV_KEY);
	}
	return partyId;
}

/**
 * Delete what is left of `partyId`'s storage, then the marker: its control block database, its
 * per-party node-local records and its move record; then the start record stops naming it as
 * `formerPartyId`.
 *
 * NOTE: strand block databases stay. A strand's database is named by its strand id, not the
 * party, so a moved strand's database is the running party's copy; a discarded strand's is left
 * too, for the running party to reuse if it joins that strand again. If discarded strands' storage
 * ever needs reclaiming, delete it here only for a strand no party in this browser holds.
 */
async function finishRemoving(handle: OptimysticWebDBHandle, partyId: string): Promise<void> {
	await deleteStore(controlStorageScope(partyId));
	for (const key of PARTY_KV_KEYS) await handle.delete('kv', partyKvKey(key, partyId));
	await new StrandMoveRecords(handle).remove(partyId);
	await dropFromStartRecord(handle, partyId);
	await handle.delete('kv', DISSOLVE_MARKER_KV_KEY);
}

async function dropFromStartRecord(handle: OptimysticWebDBHandle, partyId: string): Promise<void> {
	const stored = await readPartyStart(handle);
	if (stored?.formerPartyId !== partyId) return;
	await writePartyStart(handle, withoutFormerParty(stored, partyId));
}

/** The party id in a marker's `text`, or `undefined` (logged) when it is not a marker. */
function parseMarker(text: string): string | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		console.warn('[reference-app-web] the dissolve marker is not JSON:', err);
		return undefined;
	}
	if (typeof raw !== 'object' || raw === null) return undefined;
	const { v, partyId } = raw as Record<string, unknown>;
	return v === MARKER_VERSION && typeof partyId === 'string' && partyId.length > 0 ? partyId : undefined;
}

/** "other machines are in it (…); the running party does not hold its strands …": the non-empty lists. */
function describeRemains(remains: FormerPartyRemains): string {
	return [
		listed('other machines are in it', remains.otherMachines),
		listed('the running party does not hold its strands', remains.strandIds),
		listed('the running party does not hold its open pending joins', remains.pendingJoinIds),
	].filter((part): part is string => part !== null).join('; ');
}

function listed(what: string, ids: readonly string[]): string | null {
	return ids.length === 0 ? null : `${what} (${ids.join(', ')})`;
}
