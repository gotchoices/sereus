/**
 * web-join.ts — the tab joins the user's existing cadre, finishes moving its strands there, and
 * removes the cadre it left (docs/architecture.md → "An app joins an existing cadre"). The web app
 * has no kit, so this follows the phone kit's sequence (`cadre-core/src/edge-node/edge-node.ts` →
 * `joinCadre`, `finishStrandMove`, `dissolveFormerParty`) itself, as steps the store's actions run
 * in order over `cadre-web.ts`'s lifecycle exports, which own the one node.
 *
 * The join: `decodeInvitationForThisTab`, then either `redeemInPlace` (already in A) or
 * `recordStrandMove` + `switchToParty`, with `returnToStoredParty` as the rollback. The tab's one
 * node moves from the party it runs (B, usually the one it founded) to the party an invitation
 * names (A), keeping its identity.
 *
 * The dissolve: `planDissolve` on the running node, then `removeFormerParty`; the store starts the
 * stored party again after either outcome. Its checks and removal steps are `web-dissolve.ts`'s.
 *
 * The removal: when an owner removes this tab from the party it runs, `forgetRemovedParty` stops the
 * node, points the start record back at the party the tab founded and deletes the removed party's
 * storage, as the kit's `forgetRemovedParty` does. Nothing starts afterwards.
 */
import {
	decodeCadreInvitation,
	encodeCadreJoinRequest,
	exportStrandBundle,
	readStrandHoldings,
} from '@serfab/cadre-core';
import type {
	CadreInvitation,
	CadreJoinProgress,
	CadreNode,
	RedeemCadreInvitationOptions,
	RedeemCadreInvitationResult,
	StrandHoldings,
} from '@serfab/cadre-core';
import type { OptimysticWebDBHandle } from '@optimystic/db-p2p-storage-web';
import {
	bringUp,
	getCadreNode,
	getNodeLocalDbHandle,
	ownerKeyWired,
	readPartyAlone,
	requireMoveRecords,
	requireStart,
	startCadre,
	stopCadre,
	wireJoinedOwnerKey,
} from './cadre-web.js';
import { closeStores, openStores, NODE_LOCAL_STORE_KEY } from './strand-storage.js';
import { deletePartyStart, joinedStart, readPartyStart, startAfterRemoval, writePartyStart } from './party-start.js';
import {
	adoptMovesInto,
	deferredOutcome,
	joinMoveRecord,
	StrandMoveRecords,
	waitingStrandIds,
	type StrandMoveOutcome,
} from './web-strand-move.js';
import { finishMarkedRemoval, formerPartyRefusal, readFormerParty, removeParty, StrandMovePendingError } from './web-dissolve.js';

/** The name this tab gives in its join request, for the owner's approval prompt. */
export const WEB_APP_NAME = 'Sereus web reference';

// ── Joining an existing cadre ─────────────────────────────────────────────────

/** A join's progress: the redemption's passes and pauses, then the steps after a member admitted the tab. */
export type WebJoinProgress =
	| CadreJoinProgress
	/** A member admitted the tab; its owner key is being wired and the start record saved. */
	| { state: 'admitted'; grantsOwner: boolean }
	/** The tab's key is wired as an owner and the strands this join recorded are being adopted. */
	| { state: 'moving-strands' };

export interface JoinOptions {
	/** Cancels the join while it waits for a member; the caller then goes back to the party it left. */
	signal?: AbortSignal;
	/** A listener that throws is logged and ignored. */
	onProgress?: (progress: WebJoinProgress) => void;
}

/** What an admitted join reports. */
export interface JoinOutcome {
	redemption: RedeemCadreInvitationResult;
	/** The party this tab founded and has left, when it founded one; kept in the start record until the tab dissolves it. */
	formerPartyId?: string;
	/** How moving that party's strands into this one settled; absent when there was nothing to move. */
	strandMove?: StrandMoveOutcome;
}

/** The words the page shows for a response the owner app made from another app's request. */
const RESPONSE_FOR_ANOTHER_APP = 'This response was made for another app. Copy this tab’s request again and ask for a new one.';

/** The join request this tab shows under "Join my existing cadre": its peer id and name. */
export function joinRequestText(): string {
	return encodeCadreJoinRequest({ v: 1, peerId: requirePeerId(), appName: WEB_APP_NAME });
}

/**
 * Decode a pasted invitation, refusing one targeted at another peer id before anything
 * stops: the members would refuse it too, but only after this tab had left its own cadre to ask.
 */
export function decodeInvitationForThisTab(encoded: string): CadreInvitation {
	const peerId = requirePeerId();
	const invitation = decodeCadreInvitation(encoded);
	const target = invitation.invite.peerId;
	if (target && target !== peerId) throw new Error(RESPONSE_FOR_ANOTHER_APP);
	return invitation;
}

function requirePeerId(): string {
	const peerId = getCadreNode()?.peerId?.toString();
	if (!peerId) throw new Error('CadreNode not started');
	return peerId;
}

/**
 * Redeem on the node already running in the invitation's party; nothing to switch or roll
 * back. An owner grant arriving by a second invitation finishes a move an earlier join deferred.
 */
export async function redeemInPlace(invitation: CadreInvitation, options: JoinOptions = {}): Promise<JoinOutcome> {
	const cadre = getCadreNode();
	const start = requireStart();
	if (!cadre || start.partyId !== invitation.partyId) {
		throw new Error(`The invitation is for party ${invitation.partyId}; this tab runs ${start.partyId}`);
	}
	const redemption = await cadre.redeemCadreInvitation(invitation, redeemOptions(options));
	reportProgress(options, { state: 'admitted', grantsOwner: redemption.grantsOwner });
	await wireJoinedOwnerKey(cadre, redemption.grantsOwner);
	const strandMove = await settleJoinMove(cadre, start.formerPartyId);
	return joinOutcome(redemption, start.formerPartyId, strandMove);
}

/**
 * Before leaving the running party for the invitation's: export the strands of a party this
 * tab founded and keep them in the node-local database for the joined party to adopt; the
 * party's id when there was anything to move. Throws `StrandsNeedOwnerJoinError`, or the
 * export's or the write's error: switching without the record would lose the strands. An
 * empty export removes the party's record instead: one left by an earlier join that never
 * finished describes strands the party no longer holds, and adopting it would bring them back.
 * Leaving a party the tab joined exports nothing: that party's strands are its owners'.
 */
export async function recordStrandMove(invitation: CadreInvitation): Promise<string | undefined> {
	const cadre = getCadreNode();
	const start = requireStart();
	if (!cadre) throw new Error('CadreNode not started');
	if (start.origin === 'joined') return undefined;
	const record = joinMoveRecord(await exportStrandBundle(cadre), invitation);
	if (!record) {
		await requireMoveRecords().remove(start.partyId);
		return undefined;
	}
	await requireMoveRecords().save(record);
	return start.partyId;
}

/**
 * Stop the running node, start one in the invitation's party and redeem there, waiting for
 * a member to answer. Nothing is written until a member has admitted this tab; admitted, the
 * start record is written before the strands are adopted, so a tab closed mid-adoption
 * reloads into the joined party and finishes the move there. The caller runs
 * {@link returnToStoredParty} when this throws.
 *
 * `movingFrom` is what {@link recordStrandMove} returned: the founded party whose strands
 * wait, if any, reported as `moving-strands` once the tab's key is wired.
 */
export async function switchToParty(
	invitation: CadreInvitation,
	options: JoinOptions,
	movingFrom: string | undefined,
): Promise<JoinOutcome> {
	options.signal?.throwIfAborted();
	const leaving = requireStart();
	// The party this tab founded, carried through any later join.
	// NOTE: leaving a joined party while the move from `formerPartyId` into it is still pending
	// (the key never wired as an owner there) leaves that record naming the party left, as in the
	// phone kit; the card then offers *Retry moving*, which adopts only into the running party, and
	// the old cadre is never removed. If that is ever hit, retarget the record to the invitation's
	// party here, and in the kit.
	const formerPartyId = leaving.origin === 'founded' ? leaving.partyId : leaving.formerPartyId;
	await stopCadre();
	const cadre = await bringUp(joinedStart(invitation.partyId, formerPartyId));
	// The start as it runs, which drops `formerPartyId` when a dissolve marker named that party.
	const joined = requireStart();
	const redemption = await cadre.redeemCadreInvitation(invitation, redeemOptions(options));
	reportProgress(options, { state: 'admitted', grantsOwner: redemption.grantsOwner });
	await wireJoinedOwnerKey(cadre, redemption.grantsOwner);
	// NOTE: written after the owner key is wired, as the phone kit's `startAndRedeem` does. With
	// an owner grant whose row is slow to arrive, that wait can run up to `GRANTED_OWNER_WAIT_MS`
	// (`cadre-web.ts`) after the member admitted the tab; a tab closed inside it reloads into the
	// party it left while the joined party already lists it, and its targeted invitation is spent.
	// If that is ever hit, write the record right after the redemption, here and in the kit.
	await writePartyStart(requireNodeLocalHandle(), joined);
	if (movingFrom !== undefined && ownerKeyWired()) reportProgress(options, { state: 'moving-strands' });
	const strandMove = await settleJoinMove(cadre, joined.formerPartyId);
	return joinOutcome(redemption, joined.formerPartyId, strandMove);
}

/**
 * After a failed or cancelled {@link switchToParty}: discard the move record the join wrote,
 * stop whatever runs and start the stored party again (the record is unchanged, so that is
 * the party the tab left). Throws the restart's error; the join's own error is the one to show.
 */
export async function returnToStoredParty(movingFrom: string | undefined): Promise<CadreNode> {
	try {
		await stopCadre();
	} catch (err) {
		// The stores are closed either way (see `stopCadre`); the restart below reopens them.
		console.warn('[reference-app-web] stopping the joined party’s node after a failed join failed:', err);
	}
	await openStores([NODE_LOCAL_STORE_KEY]);
	await discardStrandMove(new StrandMoveRecords(requireNodeLocalHandle()), movingFrom);
	return startCadre();
}

async function discardStrandMove(records: StrandMoveRecords, fromPartyId: string | undefined): Promise<void> {
	if (fromPartyId === undefined) return;
	try {
		await records.remove(fromPartyId);
	} catch (err) {
		// Harmless when left: it names the party the join failed to reach, and the next join
		// from this party replaces it.
		console.warn(`[reference-app-web] could not discard the strand move record of party ${fromPartyId}:`, err);
	}
}

/**
 * The move from `formerPartyId` as an admitted join reports it: adopted with every other move
 * naming this party once the tab's key is wired as its owner, deferred otherwise. Never throws:
 * the tab is admitted, and what is not adopted now is adopted by the next start.
 */
async function settleJoinMove(cadre: CadreNode, formerPartyId: string | undefined): Promise<StrandMoveOutcome | undefined> {
	const records = requireMoveRecords();
	try {
		if (ownerKeyWired()) {
			const outcomes = await adoptMovesInto(cadre, records);
			return formerPartyId === undefined ? undefined : outcomes.get(formerPartyId);
		}
		const record = formerPartyId === undefined ? undefined : await records.load(formerPartyId);
		return record?.targetPartyId === cadre.partyId ? { state: 'deferred', reason: 'owner-key-not-wired' } : undefined;
	} catch (err) {
		console.warn('[reference-app-web] reading the strand move records failed; the next start retries:', err);
		return formerPartyId === undefined ? undefined : deferredOutcome(err);
	}
}

/**
 * The strands of the party this tab founded and left that are not seated in the running party
 * yet, or `undefined` when none wait. A read IndexedDB refuses throws.
 */
export async function pendingStrandMove(): Promise<{ fromPartyId: string; strandIds: string[] } | undefined> {
	const formerPartyId = requireStart().formerPartyId;
	if (formerPartyId === undefined) return undefined;
	const record = await requireMoveRecords().load(formerPartyId);
	return record && { fromPartyId: formerPartyId, strandIds: waitingStrandIds(record) };
}

/** Wait for a member: a tab joining by invitation may be the only machine of the party up. */
function redeemOptions(options: JoinOptions): RedeemCadreInvitationOptions {
	return {
		waitForMember: true,
		...(options.signal ? { signal: options.signal } : {}),
		...(options.onProgress ? { onProgress: options.onProgress } : {}),
	};
}

/** Tell the join's listener; one that throws must not fail a join a member has already admitted. */
function reportProgress(options: JoinOptions, progress: WebJoinProgress): void {
	try {
		options.onProgress?.(progress);
	} catch (err) {
		console.warn('[reference-app-web] join progress listener threw:', err);
	}
}

function joinOutcome(
	redemption: RedeemCadreInvitationResult,
	formerPartyId: string | undefined,
	strandMove: StrandMoveOutcome | undefined,
): JoinOutcome {
	return {
		redemption,
		...(formerPartyId !== undefined && { formerPartyId }),
		...(strandMove !== undefined && { strandMove }),
	};
}

// ── After the join: finishing the move, dissolving the party left ─────────────

/**
 * Adopt, on the running node, the move from the party this tab founded and left, as a start
 * would: Retry for a move a join left incomplete. Asks first whether the joined party lists the
 * tab's key as an owner, so an owner grant whose row arrived after the join stopped waiting is
 * picked up. `undefined` when no move from that party names the running party. Throws only when
 * no node runs; an adoption failure is reported as `deferred`, as a join's is.
 */
export async function finishStrandMove(): Promise<StrandMoveOutcome | undefined> {
	const cadre = requireNode();
	const start = requireStart();
	if (start.formerPartyId === undefined) return undefined;
	if (start.origin === 'joined') await wireJoinedOwnerKey(cadre, false);
	return settleJoinMove(cadre, start.formerPartyId);
}

/** What a dissolve read on the running node before stopping it. */
export interface DissolvePlan {
	formerPartyId: string;
	holdings: StrandHoldings;
}

/**
 * The dissolve's first steps, on the running node (architecture.md → "Dissolving the party it
 * left"): refuse before anything stops, then read what the running party holds. Throws an `Error`
 * unless the running start names a `formerPartyId` other than its own party, and
 * `StrandMovePendingError` while a move record from that party exists, whichever party it names.
 */
export async function planDissolve(): Promise<DissolvePlan> {
	const cadre = requireNode();
	const { partyId, formerPartyId } = requireStart();
	if (formerPartyId === undefined) throw new Error('Nothing to remove: this tab has not left a cadre it founded');
	// Only a hand-edited start record names its own party; removing it would delete the running party's control database.
	if (formerPartyId === partyId) throw new Error(`Cannot remove party ${partyId}: it is the party this tab runs`);
	const record = await requireMoveRecords().load(formerPartyId);
	if (record) throw new StrandMovePendingError(record);
	return { formerPartyId, holdings: await readStrandHoldings(cadre) };
}

/**
 * The rest of the dissolve but the restart: stop the running node, read the former party from a
 * node started for it alone, and remove its storage when the running party holds everything it
 * does (`discard` aside) and no other machine is in it. Leaves no node running, whatever happens:
 * the caller starts the stored party again, which also finishes a removal a failure interrupted.
 * Throws `FormerPartyNotEmptyError` with nothing deleted, `StoreDeleteBlockedError` with the marker
 * kept for the next start, or the failure.
 */
export async function removeFormerParty(plan: DissolvePlan, discard: readonly string[] = []): Promise<void> {
	await stopCadre();
	const content = await readPartyAlone(plan.formerPartyId, readFormerParty);
	const refusal = formerPartyRefusal(content, plan.holdings, discard, Date.now());
	if (refusal) throw refusal;
	await openStores([NODE_LOCAL_STORE_KEY]);
	await removeParty(requireNodeLocalHandle(), plan.formerPartyId);
}

// ── Removed from the cadre by an owner ────────────────────────────────────────

/**
 * Act on an owner of `partyId`, the party the tab runs, removing this tab from it (architecture.md →
 * "Removing a machine"): stop the node, point the start record away from the party, then delete the
 * party's storage with the dissolve's marked removal. Returns the party the start record now names,
 * the one this tab founded and left, or `undefined` when the record was deleted and the next start
 * founds a party of the tab's own. Leaves no node running and no store open.
 *
 * The start record is rewritten first, as the kit's saved start is: a start reading it while it still
 * named the party would delete the marker as one naming the party being started, and run the party on
 * what is left of its storage. A failure reading or rewriting it throws, with the storage left as the
 * record still names it. A failure deleting is logged; once the marker is written, the next start
 * finishes the removal.
 */
export async function forgetRemovedParty(partyId: string): Promise<string | undefined> {
	try {
		await stopCadre();
	} catch (err) {
		// The stores are closed either way (see `stopCadre`).
		console.warn(`[reference-app-web] stopping the node of party ${partyId}, which removed this tab, failed:`, err);
	}
	try {
		await openStores([NODE_LOCAL_STORE_KEY]);
		const handle = requireNodeLocalHandle();
		const formerPartyId = await leaveRemovedStart(handle, partyId);
		await removeLocalParty(handle, partyId);
		return formerPartyId;
	} finally {
		await closeStores();
	}
}

/**
 * Replace a start record naming `partyId` with {@link startAfterRemoval}'s, or delete it; returns
 * the party the new record names. A record naming another party is left alone.
 */
async function leaveRemovedStart(handle: OptimysticWebDBHandle, partyId: string): Promise<string | undefined> {
	const stored = await readPartyStart(handle);
	if (stored?.partyId !== partyId) return undefined;
	const next = startAfterRemoval(stored);
	if (next) await writePartyStart(handle, next);
	else await deletePartyStart(handle);
	return next?.partyId;
}

/**
 * Delete `partyId`'s storage with the marked removal, after finishing one a failure left, so this
 * marker does not replace it. A failure is logged, not thrown: the tab has left the party either way.
 */
async function removeLocalParty(handle: OptimysticWebDBHandle, partyId: string): Promise<void> {
	try {
		await finishMarkedRemoval(handle);
		await removeParty(handle, partyId);
	} catch (err) {
		console.warn(`[reference-app-web] deleting the storage of party ${partyId}, which removed this tab, failed:`, err);
	}
}

// ── The running node ──────────────────────────────────────────────────────────

function requireNode(): CadreNode {
	const cadre = getCadreNode();
	if (!cadre) throw new Error('CadreNode not started');
	return cadre;
}

function requireNodeLocalHandle(): OptimysticWebDBHandle {
	const handle = getNodeLocalDbHandle();
	if (!handle) throw new Error('node-local database not open');
	return handle;
}
