/**
 * `EdgeNode.joinCadre`'s sequence: redeem in place on a node already running in the credential's
 * party, or stop the running node, start one in that party, redeem there and go back on any
 * failure (docs/architecture.md → "An app joins an existing cadre"). The credential is a machine
 * invitation, which admits the app as a machine, or an owner grant, which makes it a machine and
 * an owner at once ({@link JoinCredential}). Runs over a narrow view of the runtime
 * ({@link JoinRuntime}), inside one of its transitions.
 */

import type { CadreInvitation } from '../cadre-invite-protocol.js';
import type { CadreNode } from '../cadre-node.js';
import type { OwnerSigner } from '../owner-signer.js';
import { exportStrandBundle } from '../strand-move.js';
import type { RedeemCadreInvitationOptions, RedeemCadreInvitationResult } from '../types.js';
import type { OwnerGenesisResult } from './config.js';
import type { EdgeJoinProgress, EdgeNodeStatus, JoinCadreOptions, JoinCadreResult } from './edge-node.js';
import { isOwnerGrant, type JoinCredential } from './join-credential.js';
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
	/** The owner slot's key, created when the slot is empty: the key an owner grant seats. */
	ownerSlotSigner(): Promise<OwnerSigner>;
	/** `granted`: an owner grant has just seated the slot's key, so wait for the row. */
	wireJoinedOwner(node: CadreNode, granted: boolean): Promise<OwnerGenesisResult>;
	saveRunningStart(resolved: EdgeNodeOptions): Promise<void>;
	reportRunning(node: CadreNode, resolved: EdgeNodeOptions, owner: OwnerGenesisResult): void;
}

/** What redeeming either credential settles: the admitting member, and whether the app is an owner through it. */
interface Admission extends RedeemCadreInvitationResult {
	/** The credential was an owner grant: the owner slot's key is an owner of the party, its row on its way here when not here yet. */
	asOwner: boolean;
}

export async function joinCadre(
	runtime: JoinRuntime,
	credential: JoinCredential,
	options: JoinCadreOptions,
	signal: AbortSignal,
): Promise<JoinCadreResult> {
	signal.throwIfAborted();
	const running = runtime.node;
	if (running?.isRunning && runtime.runningOptions?.partyId === credential.partyId) {
		return redeemInPlace(runtime, running, runtime.runningOptions, credential, options, signal);
	}
	return switchParty(runtime, credential, options, signal);
}

/** Redeem on the node already running in the credential's party; nothing to switch or roll back. */
async function redeemInPlace(
	runtime: JoinRuntime,
	node: CadreNode,
	running: EdgeNodeOptions,
	credential: JoinCredential,
	options: JoinCadreOptions,
	signal: AbortSignal,
): Promise<JoinCadreResult> {
	const admission = await redeemOnRunningNode(runtime, node, credential, options, signal);
	reportProgress(options, { state: 'admitted', asOwner: admission.asOwner });
	const owner = await runtime.wireJoinedOwner(node, admission.asOwner);
	// An owner grant redeemed on a node that joined as a member finishes the move that join deferred.
	const strandMove = await settleJoinMove(runtime, node, running.formerPartyId, owner);
	if (owner === 'enrolled') runtime.setStatus({ state: 'running', node, owner });
	return joinResult(admission, running.formerPartyId, strandMove);
}

/**
 * A machine invitation is redeemed as on a fresh node (a device already admitted is answered as
 * such). An owner grant is redeemed for the owner slot's key: the node is a member of the party,
 * so `redeemOwnerGrant` writes the row in its own store and the key can be wired at once.
 */
async function redeemOnRunningNode(
	runtime: JoinRuntime,
	node: CadreNode,
	credential: JoinCredential,
	options: JoinCadreOptions,
	signal: AbortSignal,
): Promise<Admission> {
	if (!isOwnerGrant(credential)) return redeemInvitation(node, credential, options, signal);
	const redeemed = await node.redeemOwnerGrant(credential, await runtime.ownerSlotSigner(), redeemOptions(options, signal));
	return { peerId: redeemed.memberPeerId, redeemedAt: new Date().toISOString(), asOwner: true };
}

/**
 * Stop the running node, start one in the credential's party and redeem there; on any
 * failure, go back to what ran before. Nothing is saved until a member has admitted this app.
 * Leaving a party this app founded, its strands are recorded for the move first, so a refusal
 * leaves that party running and unchanged.
 */
async function switchParty(
	runtime: JoinRuntime,
	credential: JoinCredential,
	options: JoinCadreOptions,
	signal: AbortSignal,
): Promise<JoinCadreResult> {
	const restore = runtime.runningOptions;
	const leaving = restore ?? (await runtime.readSavedStart())?.options ?? null;
	const founded = foundedPartyLeft(credential.partyId, leaving);
	// The party this app founded, carried through any later join.
	// NOTE: leaving a joined party while the move from `formerPartyId` into it is still pending
	// (the key never wired as an owner there) leaves that record naming the party left, adopted
	// only if the app goes back; `pendingStrandMove` keeps reporting it. If apps need the move
	// to follow the app, retarget the record to the credential's party here.
	const formerPartyId = founded?.partyId ?? leaving?.formerPartyId;
	const joined: EdgeNodeOptions = {
		partyId: credential.partyId,
		// None needed: the redemption retains the member that admits this app as a dial
		// target in the party's bootstrap-peer store, which every later start reads.
		bootstrapAddrs: [],
		relayAddrs: options.relayAddrs ?? leaving?.relayAddrs ?? [],
		origin: 'joined',
	};
	const noiseCryptoMode = options.noiseCryptoMode ?? leaving?.noiseCryptoMode;
	if (noiseCryptoMode !== undefined) joined.noiseCryptoMode = noiseCryptoMode;
	if (formerPartyId !== undefined) joined.formerPartyId = formerPartyId;
	const movingFrom = founded ? await recordStrandMove(runtime, founded, credential) : undefined;
	try {
		await runtime.shutDown();
		return await startAndRedeem(runtime, joined, credential, options, signal, movingFrom);
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
async function recordStrandMove(runtime: JoinRuntime, founded: EdgeNodeOptions, credential: JoinCredential): Promise<string | undefined> {
	const running = runtime.node;
	const bundle = running?.isRunning
		? await exportStrandBundle(running)
		: await runtime.readAlone(founded, exportStrandBundle, 'export strands');
	const record = joinMoveRecord(bundle, credential);
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
	credential: JoinCredential,
	options: JoinCadreOptions,
	signal: AbortSignal,
	movingFrom: string | undefined,
): Promise<JoinCadreResult> {
	runtime.setStatus({ state: 'starting' });
	const { node, resolved } = await runtime.bringUp(joined);
	runtime.setStatus({ state: 'joining', node });
	const admission = await redeemOnJoinedNode(runtime, node, credential, options, signal);
	reportProgress(options, { state: 'admitted', asOwner: admission.asOwner });
	const owner = await runtime.wireJoinedOwner(node, admission.asOwner);
	await runtime.saveRunningStart(resolved);
	if (movingFrom !== undefined && owner === 'enrolled') reportProgress(options, { state: 'moving-strands' });
	const strandMove = await settleJoinMove(runtime, node, resolved.formerPartyId, owner);
	runtime.reportRunning(node, resolved, owner);
	return joinResult(admission, resolved.formerPartyId, strandMove);
}

/**
 * Redeem on the node started in the credential's party: a machine invitation admits the app, an
 * owner grant makes it a machine and an owner (`CadreNode.joinWithOwnerGrant`).
 *
 * The grant seats the owner slot's key, created now when the slot is empty: the app's one owner
 * key, which may already own the party the app founded and is leaving (one key, several cadres).
 * A fresh key would need a second owner slot and a second signer per node, which the kits do not
 * have, and replacing the slot's key would lose the left party, which a rollback restarts.
 * Created before the redemption, the key stays in the slot when the join fails, an owner of
 * nothing until the next founding or grant uses it.
 */
async function redeemOnJoinedNode(
	runtime: JoinRuntime,
	node: CadreNode,
	credential: JoinCredential,
	options: JoinCadreOptions,
	signal: AbortSignal,
): Promise<Admission> {
	if (!isOwnerGrant(credential)) return redeemInvitation(node, credential, options, signal);
	// NOTE: a rollback after the grant was redeemed but the self-invitation refused leaves the
	// slot's key an owner of the credential's party while the app is back in the party it left;
	// a later join there, with a machine invitation too, picks the ownership up through that key.
	const joined = await node.joinWithOwnerGrant(credential, await runtime.ownerSlotSigner(), redeemOptions(options, signal));
	return { peerId: joined.peerId, redeemedAt: joined.redeemedAt, asOwner: true };
}

async function redeemInvitation(node: CadreNode, invitation: CadreInvitation, options: JoinCadreOptions, signal: AbortSignal): Promise<Admission> {
	const redemption = await node.redeemCadreInvitation(invitation, redeemOptions(options, signal));
	return { ...redemption, asOwner: false };
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

/** Wait for a member: an app joining by invitation is often the only machine of the party up. The grant's options are the invitation's. */
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
	admission: Admission,
	formerPartyId: string | undefined,
	strandMove: StrandMoveOutcome | undefined,
): JoinCadreResult {
	return {
		...admission,
		...(formerPartyId !== undefined && { formerPartyId }),
		...(strandMove !== undefined && { strandMove }),
	};
}
