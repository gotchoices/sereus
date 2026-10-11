/**
 * join-cadre.svelte.ts — state of the Cadre page's "Join my existing cadre" card: this tab
 * joins the cadre another Sereus app already holds, carrying what its own cadre held
 * (docs/architecture.md → "An app joins an existing cadre"). The browser counterpart of the
 * phone app's `use-join-flow.ts`, as far as the join itself; removing the cadre the tab left
 * is the dissolve ticket's.
 *
 * Module state, not component state: the router unmounts the page on every route change, and
 * a join waits for a member for as long as the invitation allows, so the flow has to survive
 * a visit to Home. The node it switches is the store's (`store.svelte.ts` → `joinCadre`).
 */
import { joinRequestText, type JoinOutcome } from './cadre-web.js';
import { joinCadre, nodeState } from './store.svelte.js';
import { pushError } from './diagnostics.svelte.js';
import { flowForProgress, JoinCancelledError, joinFailureNotice, type JoinFlow } from './join-flow.js';
import type { StrandMoveOutcome } from './web-strand-move.js';

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
		state.request = { state: 'failed', error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Join the cadre the pasted response or invitation names, each step shown in `flow`. Resolves
 * when the join settled either way: admitted (the flow shows the outcome) or not (the failure
 * shows, with the tab back in the cadre it ran before). Ignored while a join is on screen.
 */
export async function joinExistingCadre(): Promise<void> {
	const encoded = state.invitationText.trim();
	if (!encoded || state.flow) return;
	const controller = new AbortController();
	joinAbort = controller;
	state.failure = null;
	state.flow = { step: 'joining' };
	let joined: JoinOutcome;
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
	state.flow = flowAfterJoin(joined);
}

/** The last step: the outcome of the move, or done. Standing is the redemption's grant. */
function flowAfterJoin(joined: JoinOutcome): JoinFlow {
	const move = joined.strandMove;
	const moved = move && 'report' in move ? move.report.moved.length : 0;
	const stall = moveStall(move);
	if (stall) return { step: 'move-incomplete', moved, waiting: waitingOf(move), ...stall };
	return { step: 'done', grantsOwner: joined.redemption.grantsOwner, moved };
}

type MoveStall = Pick<Extract<JoinFlow, { step: 'move-incomplete' }>, 'reason' | 'message'>;

/** Why the move a join reported did not finish, or null when it did or there was none. */
function moveStall(move: StrandMoveOutcome | undefined): MoveStall | null {
	if (!move || move.state === 'done') return null;
	if (move.state !== 'deferred') return { reason: 'partial' };
	if (move.reason === 'owner-key-not-wired') return { reason: 'owner-key-not-wired' };
	return { reason: 'adoption-failed', message: move.error.message };
}

/** The strand ids a partial adoption could not seat; empty (read as "some") when the move was deferred whole. */
function waitingOf(move: StrandMoveOutcome | undefined): string[] {
	if (!move || move.state !== 'partial') return [];
	return move.report.failed.filter((entry) => entry.kind === 'strand').map((entry) => entry.id);
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
