/**
 * join-flow.ts — the steps "Join my existing cadre" shows once Join is pressed, the plain
 * words for each, and the words for each way a join can fail before a member admits the tab.
 * No Svelte: `join-cadre.svelte.ts` holds the flow and `JoinCadre.svelte` renders it.
 *
 * The wording is the phone app's (`reference-app-rn/src/join-flow.ts` and `join-failure.ts`),
 * with "this app" changed to "this tab" and "chats" to "strands": the two apps share no code
 * by design. The steps after admission that remove the old cadre are the dissolve ticket's.
 */
import {
	CadreInviteRejectedError,
	CadreInviteReplyInvalidError,
	CadreInviteUnreachableError,
} from '@serfab/cadre-core';
import type { WebJoinProgress } from './cadre-web.js';
import { strands, StrandsNeedOwnerJoinError } from './web-strand-move.js';

export type JoinFlow =
	/** Redeeming the invitation; `wait` while no member of the cadre is ready, until `retryAtMs`. Cancellable. */
	| { step: 'joining'; wait?: 'no-member-answered' | 'member-not-ready'; retryAtMs?: number }
	| { step: 'admitted'; grantsOwner: boolean }
	| { step: 'moving-strands' }
	/** Some of the old cadre's strands are not in the joined one yet; the next start, or Restart on Home, adopts them. */
	| { step: 'move-incomplete'; moved: number; waiting: string[]; reason: 'owner-key-not-wired' | 'adoption-failed' | 'partial'; message?: string }
	| { step: 'done'; grantsOwner: boolean; moved: number };

export interface JoinFlowText {
	line: string;
	detail?: string;
}

/**
 * Thrown by `joinExistingCadre` when the user cancelled the join while it waited. The tab is
 * back in the cadre it ran before, unchanged.
 */
export class JoinCancelledError extends Error {
	constructor() {
		super('The join was cancelled');
		this.name = 'JoinCancelledError';
	}
}

/** The step a join's progress report puts the flow in. */
export function flowForProgress(progress: WebJoinProgress): JoinFlow {
	switch (progress.state) {
		case 'redeeming':
			return { step: 'joining' };
		case 'waiting':
			return { step: 'joining', wait: progress.reason, retryAtMs: progress.retryAtMs };
		case 'admitted':
			return { step: 'admitted', grantsOwner: progress.grantsOwner };
		case 'moving-strands':
			return { step: 'moving-strands' };
	}
}

const INCOMPLETE_REASON: Record<Extract<JoinFlow, { step: 'move-incomplete' }>['reason'], string> = {
	'owner-key-not-wired': 'This tab is not an owner of your cadre yet, so its strands cannot move. They move at the next start after it is.',
	'adoption-failed': 'Moving stopped. The next start tries again.',
	partial: 'Some could not be moved this time. The next start tries again.',
};

export function joinFlowText(flow: JoinFlow): JoinFlowText {
	switch (flow.step) {
		case 'joining':
			return { line: joiningLine(flow) };
		case 'admitted':
			return { line: flow.grantsOwner ? 'Admitted. Setting this tab up as an owner…' : 'Admitted as a member. Finishing the setup…' };
		case 'moving-strands':
			return { line: 'Moving this tab’s strands into your cadre…' };
		case 'move-incomplete':
			return {
				line: incompleteMoveLine(flow.moved, flow.waiting.length),
				detail: flow.reason === 'adoption-failed' && flow.message ? `Moving stopped: ${flow.message}` : INCOMPLETE_REASON[flow.reason],
			};
		case 'done':
			return { line: doneLine(flow.grantsOwner, flow.moved) };
	}
}

function joiningLine(flow: Extract<JoinFlow, { step: 'joining' }>): string {
	const next = flow.retryAtMs === undefined ? '' : ` Next try at ${clockTime(flow.retryAtMs)}.`;
	switch (flow.wait) {
		case 'no-member-answered':
			return `Waiting for an always-on machine of your cadre to answer.${next}`;
		case 'member-not-ready':
			return `Your cadre is catching up.${next}`;
		default:
			return 'Joining your cadre…';
	}
}

/** `waiting` is 0 when the record of the move could not be read. */
function incompleteMoveLine(moved: number, waiting: number): string {
	const still = waiting === 0 ? 'some' : String(waiting);
	if (moved > 0) return `${strands(moved)} moved; ${still} still waiting.`;
	if (waiting === 0) return 'Some of this tab’s strands are still waiting to move.';
	return `${strands(waiting)} ${waiting === 1 ? 'is' : 'are'} still waiting to move.`;
}

/** The count is left out when nothing moved: a join with nothing to move. */
function doneLine(grantsOwner: boolean, moved: number): string {
	const joined = `This tab is now part of your cadre, as ${grantsOwner ? 'an owner' : 'a member'}.`;
	return moved > 0 ? `${joined} ${strands(moved)} moved.` : joined;
}

function clockTime(ms: number): string {
	return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const TRY_AGAIN = 'The member could not complete the join right now; try again';

/**
 * One line per rejection code the member can answer with. Keyed by the error's own
 * `code` type, so a code added to cadre-core fails typecheck here until it has words.
 */
const REJECTION_TEXT: Record<CadreInviteRejectedError['code'], string> = {
	'invite-spent': 'This invitation is expired, withdrawn or used up',
	'invite-invalid': 'This invitation is not valid for this tab',
	'party-mismatch': 'That member serves a different cadre',
	'issuer-unknown': 'That member does not know the owner who issued this invitation yet; try again shortly',
	busy: TRY_AGAIN,
	conflict: TRY_AGAIN,
	internal: TRY_AGAIN,
	unrecognized: TRY_AGAIN,
};

/** What to tell the person at the tab about `err`, thrown by a join attempt. */
export function describeJoinFailure(err: unknown): string {
	if (err instanceof CadreInviteRejectedError) return REJECTION_TEXT[err.code];
	if (err instanceof CadreInviteUnreachableError) return 'No member named in the invitation could be reached';
	if (err instanceof CadreInviteReplyInvalidError) return 'A member answered, but its answer did not verify';
	// Its message is already the page's words (see the class).
	if (err instanceof StrandsNeedOwnerJoinError) return err.message;
	return err instanceof Error ? err.message : String(err);
}

/** The notice for a join that did not happen: the user cancelled it, or it failed. */
export function joinFailureNotice(err: unknown): { title: string; message: string } {
	if (err instanceof JoinCancelledError) return { title: 'Join cancelled', message: 'This tab is back in its own cadre.' };
	return { title: 'Join failed', message: describeJoinFailure(err) };
}
