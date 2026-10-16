/**
 * Dissolving the party this app founded and left (docs/architecture.md → "An app joins an
 * existing cadre" → "Dissolving the party it left"): the check that the running party holds
 * everything the left one holds, and the removal of the left party's local storage. The same
 * removal deletes a party whose owner removed this app ("Removed from A"), with no check.
 *
 * The removal is local: it writes nothing to either party's control database. A marker in the
 * node-local database names the party from before the first deletion until after the saved
 * start stops naming it, so a removal that a crash or a failed step interrupts is finished by
 * the next start or the next dissolve without checking again: the decision to remove was made
 * before the marker was written. Every step deletes what may already be gone.
 */

import { controlStorageScope } from '../storage-scope.js';
import { exportStrandBundle, unheldBundleContent } from '../strand-move.js';
import type { StrandBundle, StrandHoldings } from '../strand-move.js';
import { KeyStoreJoinedStrandStore } from '../joined-strand-store.js';
import type { CadreNode } from '../cadre-node.js';
import type { KeyStore } from '../key-store.js';
import { bootstrapPeersKvKey, enrolledMachinesKvKey, strandNetworkKvKey, type NodeLocalKv } from './node-local.js';
import type { RemovableSlot } from './platform.js';
import { parseSavedStart, serializeSavedStart, type EdgeNodeOptions } from './options.js';
import { toError, type PendingStrandMove, type StrandMoveRecords } from './strand-move.js';

/** How `EdgeNode.dissolveFormerParty` runs. */
export interface DissolveFormerPartyOptions {
	/** Strand and pending-join ids of the former party to give up although the running party does not hold them; from a `FormerPartyNotEmptyError`. */
	discard?: readonly string[];
}

/**
 * `EdgeNode.dissolveFormerParty` refused, nothing stopped: moving the former party's strands has
 * not finished. A move into the running party finishes with `finishStrandMove()`; one into
 * another party is adopted only there.
 */
export class StrandMovePendingError extends Error {
	constructor(readonly pending: PendingStrandMove) {
		super(`Cannot dissolve party ${pending.fromPartyId}: moving its strands into party ${pending.toPartyId} has not finished`);
		this.name = 'StrandMovePendingError';
	}
}

/** What keeps a former party from being dissolved: `FormerPartyNotEmptyError`'s lists. */
interface FormerPartyRemains {
	otherMachines: string[];
	strandIds: string[];
	pendingJoinIds: string[];
}

/** `EdgeNode.dissolveFormerParty` refused, nothing deleted: the former party holds what the running party lacks, or has other machines. */
export class FormerPartyNotEmptyError extends Error {
	readonly partyId: string;
	/** Peer ids of `CadrePeer` rows other than this node's. Not discardable: removing them is the user's choice, made in that party. */
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

/** The former party's start for {@link readFormerParty}: nothing to dial or reserve on, the running Noise mode. */
export function formerPartyRead(partyId: string, running: EdgeNodeOptions): EdgeNodeOptions {
	return {
		partyId,
		bootstrapAddrs: [],
		relayAddrs: [],
		...(running.noiseCryptoMode !== undefined && { noiseCryptoMode: running.noiseCryptoMode }),
	};
}

/** `options` without `formerPartyId` when it names `partyId`. */
export function withoutFormerParty(options: EdgeNodeOptions, partyId: string | undefined): EdgeNodeOptions {
	if (partyId === undefined || options.formerPartyId !== partyId) return options;
	const { formerPartyId: _dissolved, ...rest } = options;
	return rest;
}

/** The edge node's storage a removal reaches. No handle on the party removed may be open. */
export interface PartyStorage {
	/** The node-local key-value store (`EdgeNodeStorage.nodeLocal`). */
	nodeLocal: NodeLocalKv;
	/** `EdgeNodeNames.dissolveMarkerKey`. */
	markerKey: string;
	/** `EdgeNodeNames.savedStartKey`. */
	savedStartKey: string;
	/** `EdgeNodeStorage.destroyScope`. */
	destroyScope: (scope: string) => Promise<void>;
	/** The party's trusted-owner anchor slot, the platform's own or the node-local default, for its removal. */
	trustedOwnerSlot: (partyId: string) => RemovableSlot;
	keyStore: KeyStore;
	moves: StrandMoveRecords;
}

const MARKER_VERSION = 1;

/** Mark `partyId` as being removed, then remove its local storage. Only once removing it is decided: a dissolve's check passed, or an owner removed this app. */
export async function removeParty(storage: PartyStorage, partyId: string): Promise<void> {
	await storage.nodeLocal.set(storage.markerKey, JSON.stringify({ v: MARKER_VERSION, partyId }));
	// On disk before the first deletion, so a crash during the removal leaves the marker that finishes it.
	await storage.nodeLocal.flush();
	await finishRemoving(storage, partyId);
}

/**
 * The party a begun dissolve names, or `undefined`. A marker that does not parse is deleted with
 * a warning: nothing can finish it, and the party it named keeps what is left of its storage.
 */
async function markedParty(storage: PartyStorage): Promise<string | undefined> {
	const text = await storage.nodeLocal.get(storage.markerKey);
	if (text === undefined) return undefined;
	const partyId = parseMarker(text);
	if (partyId === undefined) {
		console.warn(`[cadre-core/edge-node] deleting the dissolve marker ${storage.markerKey}: it is not one this kit wrote`);
		await storage.nodeLocal.delete(storage.markerKey);
	}
	return partyId;
}

/** Finish the removal a marker names, if any. */
export async function finishMarkedRemoval(storage: PartyStorage): Promise<void> {
	const partyId = await markedParty(storage);
	if (partyId !== undefined) await finishRemoving(storage, partyId);
}

/** What {@link finishRemovalAtStart} found: the party the marker named, if any, and why finishing its removal failed, if it did. */
export interface RemovalAtStart {
	/** Absent when there was no marker, or when it could not be read (`error` says so). */
	partyId?: string;
	error?: Error;
}

/**
 * {@link finishMarkedRemoval} before a start, which must then not keep the party it names as
 * `formerPartyId`, finished or not. A failure is logged and reported, and the start goes on; the
 * marker stays for the next.
 */
export async function finishRemovalAtStart(storage: PartyStorage): Promise<RemovalAtStart> {
	let partyId: string | undefined;
	try {
		partyId = await markedParty(storage);
		if (partyId !== undefined) await finishRemoving(storage, partyId);
		return { partyId };
	} catch (err) {
		console.warn('[cadre-core/edge-node] finishing the removal of a dissolved party failed; the next start retries:', err);
		return { partyId, error: toError(err) };
	}
}

/**
 * Delete what is left of `partyId`'s local storage, then the marker: its control database, its
 * node-local records, its trusted-owner anchor, its unpublished joined-strand records and its move
 * record; then the saved start stops naming it as `formerPartyId`.
 *
 * NOTE: strand databases stay. A strand's storage scope is its strand id, not the party, so a
 * moved strand's database is the running party's copy; a discarded strand's is left too, for the
 * running party to reuse if it joins that strand again. If discarded strands' storage ever needs
 * reclaiming, delete it here only for a strand no party on this device holds.
 */
async function finishRemoving(storage: PartyStorage, partyId: string): Promise<void> {
	await storage.destroyScope(controlStorageScope(partyId));
	for (const key of [bootstrapPeersKvKey(partyId), enrolledMachinesKvKey(partyId), strandNetworkKvKey(partyId)]) {
		await storage.nodeLocal.delete(key);
	}
	await storage.trustedOwnerSlot(partyId).remove();
	await forgetJoinedStrands(storage.keyStore, partyId);
	await storage.moves.remove(partyId);
	await dropFromSavedStart(storage, partyId);
	await storage.nodeLocal.delete(storage.markerKey);
	// One batch: the saved start stops naming the party in the same write that deletes the marker.
	await storage.nodeLocal.flush();
}

async function forgetJoinedStrands(keyStore: KeyStore, partyId: string): Promise<void> {
	const joins = new KeyStoreJoinedStrandStore(keyStore, partyId);
	for (const record of await joins.list()) await joins.forget(record.Id);
}

/** A write that throws, unlike the runtime's best-effort save, so a failure keeps the marker for the next start. */
async function dropFromSavedStart(storage: PartyStorage, partyId: string): Promise<void> {
	const saved = parseSavedStart(await storage.nodeLocal.get(storage.savedStartKey));
	if (saved?.options.formerPartyId !== partyId) return;
	await storage.nodeLocal.set(storage.savedStartKey, serializeSavedStart({ ...saved, options: withoutFormerParty(saved.options, partyId) }));
}

/** The party id in a marker's `text`, or `undefined` (logged) when it is not a marker. */
function parseMarker(text: string): string | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		console.warn('[cadre-core/edge-node] the dissolve marker is not JSON:', err);
		return undefined;
	}
	if (typeof raw !== 'object' || raw === null) return undefined;
	const { v, partyId } = raw as Record<string, unknown>;
	return v === MARKER_VERSION && typeof partyId === 'string' && partyId.length > 0 ? partyId : undefined;
}

/** "other machines are in it (…); the running party does not hold strands …": the non-empty lists. */
function describeRemains(remains: FormerPartyRemains): string {
	const parts = [
		listed('other machines are in it', remains.otherMachines),
		listed('the running party does not hold its strands', remains.strandIds),
		listed('the running party does not hold its open pending joins', remains.pendingJoinIds),
	].filter((part): part is string => part !== null);
	return parts.join('; ');
}

function listed(what: string, ids: readonly string[]): string | null {
	return ids.length === 0 ? null : `${what} (${ids.join(', ')})`;
}
