/**
 * `EdgeNode.joinCadre`'s sequence: redeem in place on a node already running in the invitation's
 * party, or stop the running node, start one in that party, redeem there and go back on any
 * failure (docs/architecture.md → "An app joins an existing cadre"). Runs over a narrow view of
 * the runtime ({@link JoinRuntime}), inside one of its transitions.
 */

import type { CadreInvitation } from '../cadre-invite-protocol.js';
import type { CadreNode } from '../cadre-node.js';
import { exportStrandBundle } from '../strand-move.js';
import type { RedeemCadreInvitationOptions, RedeemCadreInvitationResult } from '../types.js';
import type { OwnerGenesisResult } from './config.js';
import type { EdgeJoinProgress, EdgeNodeStatus, JoinCadreOptions, JoinCadreResult } from './edge-node.js';
import type { EdgeNodeOptions, SavedStart } from './options.js';
import {
	adoptMovesInto,
	deferredOutcome,
	joinMoveRecord,
	toError,
	type StrandMoveOutcome,
	type StrandMoveRecords,
} from './strand-move.js';

/** The part of the edge-node runtime a join drives. Every call runs inside the join's own transition. */
export interface JoinRuntime {
	/** The running node, or null. */
	readonly node: CadreNode | null;
	/** The options the running node was started with; null unless running. */
	readonly runningOptions: EdgeNodeOptions | null;
	readonly moves: StrandMoveRecords;
	readonly status: EdgeNodeStatus;
	setStatus(status: EdgeNodeStatus): void;
	readSavedStart(): Promise<SavedStart | undefined>;
	/** Stop the node and close every store; nothing runs afterwards. */
	shutDown(): Promise<void>;
	/** Build and start the node for `options`, subscriptions attached; nothing saved, nothing reported. */
	bringUp(options: EdgeNodeOptions): Promise<{ node: CadreNode; resolved: EdgeNodeOptions }>;
	/** Start a node for `options`' party only to run `read` on it, then stop it. */
	readAlone<T>(options: EdgeNodeOptions, read: (node: CadreNode) => Promise<T>, purpose: string): Promise<T>;
	/** A full start: bring up, settle the owner key, adopt waiting moves, save and report `running`. */
	buildAndStart(options: EdgeNodeOptions): Promise<CadreNode>;
	/** `granted`: a redemption has just granted owner, so wait for the row. */
	wireJoinedOwner(node: CadreNode, granted: boolean): Promise<OwnerGenesisResult>;
	saveRunningStart(resolved: EdgeNodeOptions): Promise<void>;
	reportRunning(node: CadreNode, resolved: EdgeNodeOptions, owner: OwnerGenesisResult): void;
}

export async function joinCadre(
	runtime: JoinRuntime,
	invitation: CadreInvitation,
	options: JoinCadreOptions,
	signal: AbortSignal,
): Promise<JoinCadreResult> {
	signal.throwIfAborted();
	const running = runtime.node;
	if (running?.isRunning && runtime.runningOptions?.partyId === invitation.partyId) {
		return redeemInPlace(runtime, running, runtime.runningOptions, invitation, options, signal);
	}
	return switchParty(runtime, invitation, options, signal);
}

/** Redeem on the node already running in the invitation's party; nothing to switch or roll back. */
async function redeemInPlace(
	runtime: JoinRuntime,
	node: CadreNode,
	running: EdgeNodeOptions,
	invitation: CadreInvitation,
	options: JoinCadreOptions,
	signal: AbortSignal,
): Promise<JoinCadreResult> {
	const redemption = await node.redeemCadreInvitation(invitation, redeemOptions(options, signal));
	reportProgress(options, { state: 'admitted', grantsOwner: redemption.grantsOwner });
	const owner = await runtime.wireJoinedOwner(node, redemption.grantsOwner);
	// An owner grant arriving by a second invitation finishes a move an earlier join deferred.
	const strandMove = await settleJoinMove(runtime, node, running.formerPartyId, owner);
	if (owner === 'enrolled') runtime.setStatus({ state: 'running', node, owner });
	return joinResult(redemption, running.formerPartyId, strandMove);
}

/**
 * Stop the running node, start one in the invitation's party and redeem there; on any
 * failure, go back to what ran before. Nothing is saved until a member has admitted this app.
 * Leaving a party this app founded, its strands are recorded for the move first, so a refusal
 * leaves that party running and unchanged.
 */
async function switchParty(
	runtime: JoinRuntime,
	invitation: CadreInvitation,
	options: JoinCadreOptions,
	signal: AbortSignal,
): Promise<JoinCadreResult> {
	const restore = runtime.runningOptions;
	const leaving = restore ?? (await runtime.readSavedStart())?.options ?? null;
	const founded = foundedPartyLeft(invitation.partyId, leaving);
	// The party this app founded, carried through any later join.
	// NOTE: leaving a joined party while the move from `formerPartyId` into it is still pending
	// (the key never wired as an owner there) leaves that record naming the party left, adopted
	// only if the app goes back; `pendingStrandMove` keeps reporting it. If apps need the move
	// to follow the app, retarget the record to the invitation's party here.
	const formerPartyId = founded?.partyId ?? leaving?.formerPartyId;
	const joined: EdgeNodeOptions = {
		partyId: invitation.partyId,
		// None needed: the redemption retains the member that admits this app as a dial
		// target in the party's bootstrap-peer store, which every later start reads.
		bootstrapAddrs: [],
		relayAddrs: options.relayAddrs ?? leaving?.relayAddrs ?? [],
		origin: 'joined',
	};
	const noiseCryptoMode = options.noiseCryptoMode ?? leaving?.noiseCryptoMode;
	if (noiseCryptoMode !== undefined) joined.noiseCryptoMode = noiseCryptoMode;
	if (formerPartyId !== undefined) joined.formerPartyId = formerPartyId;
	const movingFrom = founded ? await recordStrandMove(runtime, founded, invitation) : undefined;
	try {
		await runtime.shutDown();
		return await startAndRedeem(runtime, joined, invitation, options, signal, movingFrom);
	} catch (err) {
		await returnToLeftParty(runtime, restore, movingFrom);
		throw err;
	}
}

/**
 * Export the founded party's strands and keep them in the key store for the joined party to
 * adopt; the party's id when there was anything to move. Throws `StrandsNeedOwnerJoinError`, or
 * the export's or the write's error: switching without the record would lose the strands.
 * An empty export removes the party's record instead: one left by an earlier join that never
 * finished describes strands the party no longer holds, and adopting it would bring them back.
 */
async function recordStrandMove(runtime: JoinRuntime, founded: EdgeNodeOptions, invitation: CadreInvitation): Promise<string | undefined> {
	const running = runtime.node;
	const bundle = running?.isRunning
		? await exportStrandBundle(running)
		: await runtime.readAlone(founded, exportStrandBundle, 'export strands');
	const record = joinMoveRecord(bundle, invitation);
	if (!record) {
		await runtime.moves.remove(founded.partyId);
		return undefined;
	}
	await runtime.moves.save(record);
	return founded.partyId;
}

/**
 * Admitted, the start is saved before the strands are adopted, so an app killed mid-adoption
 * relaunches into the joined party and finishes the move there; `running` is reported after.
 */
async function startAndRedeem(
	runtime: JoinRuntime,
	joined: EdgeNodeOptions,
	invitation: CadreInvitation,
	options: JoinCadreOptions,
	signal: AbortSignal,
	movingFrom: string | undefined,
): Promise<JoinCadreResult> {
	runtime.setStatus({ state: 'starting' });
	const { node, resolved } = await runtime.bringUp(joined);
	runtime.setStatus({ state: 'joining', node });
	const redemption = await node.redeemCadreInvitation(invitation, redeemOptions(options, signal));
	reportProgress(options, { state: 'admitted', grantsOwner: redemption.grantsOwner });
	const owner = await runtime.wireJoinedOwner(node, redemption.grantsOwner);
	await runtime.saveRunningStart(resolved);
	if (movingFrom !== undefined && owner === 'enrolled') reportProgress(options, { state: 'moving-strands' });
	const strandMove = await settleJoinMove(runtime, node, resolved.formerPartyId, owner);
	runtime.reportRunning(node, resolved, owner);
	return joinResult(redemption, resolved.formerPartyId, strandMove);
}

/**
 * The move from `formerPartyId` as an admitted join reports it: adopted with every other move
 * naming this party once the app's key is wired as its owner, deferred otherwise. Never throws:
 * the app is admitted, and what is not adopted now is adopted by the next start.
 */
async function settleJoinMove(
	runtime: JoinRuntime,
	node: CadreNode,
	formerPartyId: string | undefined,
	owner: OwnerGenesisResult,
): Promise<StrandMoveOutcome | undefined> {
	try {
		if (owner === 'enrolled') {
			const outcomes = await adoptMovesInto(node, runtime.moves);
			return formerPartyId === undefined ? undefined : outcomes.get(formerPartyId);
		}
		const record = formerPartyId === undefined ? undefined : await runtime.moves.load(formerPartyId);
		return record?.targetPartyId === node.partyId ? { state: 'deferred', reason: 'owner-key-not-wired' } : undefined;
	} catch (err) {
		console.warn('[cadre-core/edge-node] reading the strand move records failed; the next start retries:', err);
		return formerPartyId === undefined ? undefined : deferredOutcome(err);
	}
}

/**
 * After a failed join: discard the move record it wrote, stop the joined party's node and start
 * again what ran before, if anything did.
 */
async function returnToLeftParty(runtime: JoinRuntime, restore: EdgeNodeOptions | null, movingFrom: string | undefined): Promise<void> {
	await discardStrandMove(runtime.moves, movingFrom);
	try {
		await runtime.shutDown();
		if (restore) await runtime.buildAndStart(restore);
	} catch (err) {
		// The join's own error is the one its caller gets; this one is only logged.
		console.warn('[cadre-core/edge-node] going back to the party a failed join left failed:', err);
		if (runtime.status.state !== 'failed') runtime.setStatus({ state: 'failed', error: toError(err) });
	}
}

async function discardStrandMove(moves: StrandMoveRecords, fromPartyId: string | undefined): Promise<void> {
	if (fromPartyId === undefined) return;
	try {
		await moves.remove(fromPartyId);
	} catch (err) {
		// Harmless when left: it names the party the join failed to reach, and the next join from
		// this party replaces it.
		console.warn(`[cadre-core/edge-node] could not discard the strand move record of party ${fromPartyId}:`, err);
	}
}

/** Wait for a member: an app joining by invitation is often the only machine of the party up. */
function redeemOptions(options: JoinCadreOptions, signal: AbortSignal): RedeemCadreInvitationOptions {
	return { waitForMember: true, signal, ...(options.onProgress ? { onProgress: options.onProgress } : {}) };
}

/** Tell the join's listener; one that throws must not fail a join a member has already admitted. */
function reportProgress(options: JoinCadreOptions, progress: EdgeJoinProgress): void {
	try {
		options.onProgress?.(progress);
	} catch (err) {
		console.warn('[cadre-core/edge-node] join progress listener threw:', err);
	}
}

/**
 * The start a join to `partyId` leaves, when it is of a party this app founded: the party whose
 * strands move and which is kept as `formerPartyId` for clean-up. Null when the join leaves no
 * start, a party this app joined, or the party it joins.
 */
function foundedPartyLeft(partyId: string, leaving: EdgeNodeOptions | null): EdgeNodeOptions | null {
	return leaving && leaving.origin !== 'joined' && leaving.partyId !== partyId ? leaving : null;
}

function joinResult(
	redemption: RedeemCadreInvitationResult,
	formerPartyId: string | undefined,
	strandMove: StrandMoveOutcome | undefined,
): JoinCadreResult {
	return {
		...redemption,
		...(formerPartyId !== undefined && { formerPartyId }),
		...(strandMove !== undefined && { strandMove }),
	};
}
