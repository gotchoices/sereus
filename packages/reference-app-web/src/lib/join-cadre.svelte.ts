/**
 * join-cadre.svelte.ts — state of the Cadre page's "Join my existing cadre" card: this tab
 * joins the cadre another Sereus app already holds, carrying what its own cadre held, then
 * removes the cadre it left (docs/architecture.md → "An app joins an existing cadre"). The
 * browser counterpart of the phone app's `use-join-flow.ts`.
 *
 * Module state, not component state: the router unmounts the page on every route change, and
 * a join waits for a member for as long as the invitation allows, so the flow has to survive
 * a visit to Home. The node it switches is the edge node's (`store.svelte.ts` → `joinCadre`,
 * `retryStrandMove`, `dissolveFormerParty`).
 */
import { StrandMoveNotOwnerError, type StrandMoveReport } from '@serfab/cadre-core';
import {
	FormerPartyNotEmptyError,
	StrandMovePendingError,
	type EdgeNodeOptions,
	type JoinCadreResult,
	type StrandMoveOutcome,
	type UnfinishedRemoval,
} from '@serfab/cadre-core/edge-node';
import { edgeNode, ownerKeyWired } from './cadre-web.js';
import { joinRequestText } from './web-join.js';
import { dissolveFormerParty, joinCadre, nodeState, retryStrandMove as retryMoveOnNode } from './store.svelte.js';
import { pushError } from './diagnostics.svelte.js';
import { flowForProgress, JoinCancelledError, joinFailureNotice, type JoinFlow } from './join-flow.js';
import { StoreDeleteBlockedError } from './strand-storage.js';
import { errorMessage } from './cadre-format.js';

/** This tab's join request, read off the running node; it is the same in every party. */
export type JoinRequest =
	| { state: 'none' }
	| { state: 'ready'; text: string; peerId: string }
	| { state: 'failed'; error: string };

interface JoinCadreState {
	request: JoinRequest;
	invitationText: string;
	/** Where the join is, from Join on; null when nothing is on screen. */
	flow: JoinFlow | null;
	/** Why the last join did not happen; replaced by the next Join. */
	failure: { title: string; message: string } | null;
}

const state = $state<JoinCadreState>({
	request: { state: 'none' },
	invitationText: '',
	flow: null,
	failure: null,
});

/** Cancels the join; set while it waits for a member. */
let joinAbort: AbortController | null = null;
/**
 * Strands the join on screen has moved so far, for the `done` step. 0 when the flow resumed a
 * join an earlier start left, which recorded no count.
 */
let movedSoFar = 0;
/** The start {@link resumeUnfinishedJoin} last looked at: it shows what a start left once, not on every visit. */
let resumedFor: EdgeNodeOptions | null = null;

export function joinCadreState(): JoinCadreState {
	return state;
}

/** Re-read this tab's join request from the running node; called on every `running`. */
export function refreshJoinRequest(): void {
	const peerId = nodeState().peerId;
	if (!peerId) {
		state.request = { state: 'none' };
		return;
	}
	try {
		state.request = { state: 'ready', text: joinRequestText(), peerId };
	} catch (err) {
		console.warn('[cadre] could not encode this tab’s join request:', err);
		state.request = { state: 'failed', error: errorMessage(err) };
	}
}

/**
 * Join the cadre the pasted response or invitation names, each step shown in `flow`, through
 * moving this tab's strands and removing the cadre it left. Resolves when the join settled
 * either way: admitted (the flow shows how far the move and the removal went) or not (the
 * failure shows, with the tab back in the cadre it ran before). Ignored while a flow is on screen.
 */
export async function joinExistingCadre(): Promise<void> {
	const encoded = state.invitationText.trim();
	if (!encoded || state.flow) return;
	const controller = new AbortController();
	joinAbort = controller;
	state.failure = null;
	state.flow = { step: 'joining' };
	let joined: JoinCadreResult;
	try {
		joined = await joinCadre(encoded, {
			signal: controller.signal,
			onProgress: (progress) => {
				state.flow = flowForProgress(progress);
			},
		});
	} catch (err) {
		state.flow = null;
		const failure = controller.signal.aborted ? new JoinCancelledError() : err;
		if (!(failure instanceof JoinCancelledError)) {
			console.warn('[cadre] joining a cadre failed:', err);
			pushError('joinCadre', err);
		}
		state.failure = joinFailureNotice(failure);
		return;
	} finally {
		joinAbort = null;
	}
	state.invitationText = '';
	await settleAfterJoin(joined);
}

/**
 * Admitted: finish the move the join reported, then remove the cadre the tab left, as far as each
 * goes now; what is left shows as a step.
 */
async function settleAfterJoin(joined: JoinCadreResult): Promise<void> {
	const move = joined.strandMove;
	movedSoFar = move && 'report' in move ? move.report.moved.length : 0;
	const stall = moveStall(move);
	if (stall) {
		state.flow = await incompleteMoveFlow(stall);
	} else if (joined.formerPartyId !== undefined) {
		await dissolveOldCadre();
	} else {
		state.flow = doneFlow();
	}
}

type MoveStall = Pick<Extract<JoinFlow, { step: 'move-incomplete' }>, 'reason' | 'message'>;

/** Why a move did not finish, or null when it did or there was none. */
function moveStall(move: StrandMoveOutcome | undefined): MoveStall | null {
	if (!move || move.state === 'done') return null;
	if (move.state !== 'deferred') return { reason: 'partial' };
	if (move.reason === 'owner-key-not-wired') return { reason: 'owner-key-not-wired' };
	return { reason: 'adoption-failed', message: move.error.message };
}

/** Why a retried move threw: the tab's key is still no owner of the joined party, or the adoption failed (or the node stopped meanwhile). */
function retryStall(err: unknown): MoveStall {
	if (err instanceof StrandMoveNotOwnerError) return { reason: 'owner-key-not-wired' };
	return { reason: 'adoption-failed', message: errorMessage(err) };
}

/**
 * Why a move the tab still records has not finished, when nothing reported it: the tab's key is
 * not an owner of the joined party yet, or an adoption failed.
 */
function recordedMoveStall(): MoveStall {
	return { reason: ownerKeyWired() ? 'partial' : 'owner-key-not-wired' };
}

/** The `move-incomplete` step, with the strands the move record still lists. */
async function incompleteMoveFlow(stall: MoveStall): Promise<JoinFlow> {
	let waiting: string[] = [];
	try {
		waiting = (await edgeNode.pendingStrandMove())?.strandIds ?? [];
	} catch (err) {
		// The step still shows, its count read as "some".
		console.warn('[cadre] could not read the strands still waiting to move:', err);
	}
	return { step: 'move-incomplete', moved: movedSoFar, waiting, ...stall };
}

/** The last step. Standing is the running node's, which a dissolve has restarted. */
function doneFlow(): JoinFlow {
	return { step: 'done', grantsOwner: ownerKeyWired(), moved: movedSoFar };
}

/** The steps during which a join, a move or a removal runs; a button pressed twice must not start another. */
function flowRunning(flow: JoinFlow | null): boolean {
	return flow !== null && ['joining', 'admitted', 'moving-strands', 'removing-old-cadre'].includes(flow.step);
}

async function dissolveOldCadre(discard?: string[]): Promise<void> {
	state.flow = { step: 'removing-old-cadre' };
	try {
		await dissolveFormerParty(discard);
		state.flow = doneFlow();
	} catch (err) {
		state.flow = flowAfterRefusedDissolve(err);
	}
}

/** The step a refused or failed dissolve leaves the flow at. */
function flowAfterRefusedDissolve(err: unknown): JoinFlow {
	if (err instanceof StrandMovePendingError) {
		return { step: 'move-incomplete', moved: movedSoFar, waiting: err.pending.strandIds, ...recordedMoveStall() };
	}
	if (err instanceof FormerPartyNotEmptyError) {
		// Other machines may hold the old cadre's data, so they are never discarded from here.
		if (err.otherMachines.length > 0) return { step: 'old-cadre-kept', otherMachines: err.otherMachines };
		return { step: 'confirm-discard', strandIds: err.strandIds, pendingJoinIds: err.pendingJoinIds };
	}
	console.warn('[cadre] removing the old cadre failed:', err);
	pushError('dissolveFormerParty', err);
	return flowAfterFailedDissolve(err);
}

/**
 * A dissolve that failed rather than refused, read off the start after it: a failure after the
 * marker was written is finished by that start, unless it could not finish either.
 *
 * NOTE: a removal that finished and whose start then failed lands on `old-cadre-remains` (no node
 * runs, so nothing says the old cadre is gone; Home shows the start's error). If that shows up in
 * practice, read the saved start here to tell the two apart.
 */
function flowAfterFailedDissolve(err: unknown): JoinFlow {
	if (err instanceof StoreDeleteBlockedError) return { step: 'removal-unfinished', blocked: true };
	const unfinished = edgeNode.unfinishedRemoval;
	if (unfinished) return unfinishedRemovalFlow(unfinished);
	const start = edgeNode.options;
	if (start && start.formerPartyId === undefined) return doneFlow();
	return { step: 'old-cadre-remains', error: errorMessage(err) };
}

function unfinishedRemovalFlow(unfinished: UnfinishedRemoval): JoinFlow {
	if (unfinished.error instanceof StoreDeleteBlockedError) return { step: 'removal-unfinished', blocked: true };
	return { step: 'removal-unfinished', blocked: false, error: unfinished.error.message };
}

/**
 * Show what an earlier start left unfinished, once per start of the node: a removal it could not
 * finish, strands still waiting to move, or the old cadre itself. Nothing while a flow is on
 * screen; the start is then taken as seen, so a flow dismissed later does not come back on the
 * next visit to the page, only after the next start.
 *
 * NOTE: an old cadre kept on purpose (it has other machines, or the user kept what only it holds)
 * is still named, so every reload shows it again, with Later to dismiss. If that nags, remember
 * the answer per old party in the node-local database.
 */
export async function resumeUnfinishedJoin(): Promise<void> {
	const start = edgeNode.options;
	if (!start || start === resumedFor) return;
	resumedFor = start;
	if (state.flow) return;
	const unfinished = edgeNode.unfinishedRemoval;
	if (unfinished) {
		movedSoFar = 0;
		state.flow = unfinishedRemovalFlow(unfinished);
		return;
	}
	if (start.formerPartyId === undefined) return;
	let waiting: string[] | undefined;
	try {
		waiting = (await edgeNode.pendingStrandMove())?.strandIds;
	} catch (err) {
		// Removing the old cadre reads the same record, and says what failed.
		console.warn('[cadre] could not read the strand move a join left:', err);
	}
	if (state.flow) return;
	movedSoFar = 0;
	state.flow = waiting
		? { step: 'move-incomplete', moved: 0, waiting, ...recordedMoveStall() }
		: { step: 'old-cadre-remains' };
}

/** Adopt the strands a join left waiting, then remove the old cadre once none waits. Ignored while a step runs. */
export async function retryStrandMove(): Promise<void> {
	if (flowRunning(state.flow)) return;
	state.flow = { step: 'moving-strands' };
	let report: StrandMoveReport | undefined;
	try {
		report = await retryMoveOnNode();
	} catch (err) {
		state.flow = await incompleteMoveFlow(retryStall(err));
		return;
	}
	// An adoption counts as moved every strand seated so far, those an earlier attempt seated included.
	if (report) movedSoFar = report.moved.length;
	if (report && report.failed.length > 0) {
		state.flow = await incompleteMoveFlow({ reason: 'partial' });
	} else {
		await dissolveOldCadre();
	}
}

/**
 * Remove the cadre this tab founded and left; `discard` gives up the strand and join ids the
 * joined cadre does not hold. Ignored while a step runs.
 */
export async function removeOldCadre(discard?: string[]): Promise<void> {
	if (!flowRunning(state.flow)) await dissolveOldCadre(discard);
}

/** Keep the old cadre with what only it holds (the other answer to `confirm-discard`). */
export function keepOldCadre(): void {
	state.flow = { step: 'old-cadre-kept', otherMachines: [] };
}

/** Cancel the join while it waits for a member; does nothing once admitted, which is never rolled back. */
export function cancelJoin(): void {
	if (state.flow?.step === 'joining') joinAbort?.abort(new JoinCancelledError());
}

/** Clear the outcome off the screen. */
export function dismissJoinFlow(): void {
	state.flow = null;
}

export function dismissJoinFailure(): void {
	state.failure = null;
}
