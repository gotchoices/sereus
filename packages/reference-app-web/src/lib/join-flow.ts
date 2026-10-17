/**
 * join-flow.ts — the steps "Join my existing cadre" shows once Join is pressed, through moving
 * this tab's strands and removing the cadre it left, the plain words for each, and the words
 * for each way a join can fail before a member admits the tab. No Svelte:
 * `join-cadre.svelte.ts` holds the flow and `JoinCadre.svelte` renders it.
 *
 * The wording is the phone app's (`reference-app-rn/src/join-flow.ts` and `join-failure.ts`),
 * with "this app" changed to "this tab", "chats" to "strands" and "this phone" to "this
 * browser": the two apps share no code by design. An owner grant's refusals are worded by
 * `owner-grants.ts`, since the Owner keys card shows them too.
 */
import {
	CadreInviteRejectedError,
	CadreInviteReplyInvalidError,
	CadreInviteUnreachableError,
} from '@serfab/cadre-core';
import { StrandsNeedOwnerJoinError, type EdgeJoinProgress } from '@serfab/cadre-core/edge-node';
import { describeOwnerGrantFailure } from './owner-grants.js';

export type JoinFlow =
	/**
	 * Redeeming the credential; `wait` while no member of the cadre is ready, until `retryAtMs`.
	 * `asOwner`: it is an owner grant, so the tab joins as an owner. Cancellable.
	 */
	| { step: 'joining'; asOwner: boolean; wait?: 'no-member-answered' | 'member-not-ready'; retryAtMs?: number }
	/** `asOwner`: the tab joined with an owner grant. */
	| { step: 'admitted'; asOwner: boolean }
	| { step: 'moving-strands' }
	| { step: 'removing-old-cadre' }
	/**
	 * Some of the old cadre's strands are not in the joined one yet, so the old cadre cannot be
	 * removed. Retry adopts them now; the next start, or Restart on Home, does too.
	 */
	| { step: 'move-incomplete'; moved: number; waiting: string[]; reason: 'owner-key-not-wired' | 'adoption-failed' | 'partial'; message?: string }
	/** The old cadre stays in this browser: it has other machines, or (none listed) the user chose to keep what only it holds. */
	| { step: 'old-cadre-kept'; otherMachines: string[] }
	/** The old cadre holds strands or pending joins the joined cadre does not; removing it deletes them. */
	| { step: 'confirm-discard'; strandIds: string[]; pendingJoinIds: string[] }
	/** The old cadre is in this browser and nothing is removing it; `error` when the last removal failed. */
	| { step: 'old-cadre-remains'; error?: string }
	/**
	 * A removal began and could not finish; the next start of the tab's node finishes it.
	 * `blocked`: another tab of this site holds the old cadre's database open.
	 */
	| { step: 'removal-unfinished'; blocked: boolean; error?: string }
	/** `asOwner`: the tab is an owner of the cadre it joined. */
	| { step: 'done'; asOwner: boolean; moved: number };

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

/** The step a join's progress report puts the flow in; `asOwner` says whether the credential is an owner grant. */
export function flowForProgress(progress: EdgeJoinProgress, asOwner: boolean): JoinFlow {
	switch (progress.state) {
		case 'redeeming':
			return { step: 'joining', asOwner };
		case 'waiting':
			return { step: 'joining', asOwner, wait: progress.reason, retryAtMs: progress.retryAtMs };
		case 'admitted':
			return { step: 'admitted', asOwner: progress.asOwner };
		case 'moving-strands':
			return { step: 'moving-strands' };
	}
}

const INCOMPLETE_REASON: Record<Extract<JoinFlow, { step: 'move-incomplete' }>['reason'], string> = {
	'owner-key-not-wired': 'This tab is not an owner of your cadre yet, so its strands cannot move. Once it is, Retry moving or the next start moves them.',
	'adoption-failed': 'Moving stopped. Retry moving, or the next start tries again.',
	partial: 'Some could not be moved this time. Retry moving, or the next start tries again.',
};

export function joinFlowText(flow: JoinFlow): JoinFlowText {
	switch (flow.step) {
		case 'joining':
			return { line: joiningLine(flow) };
		case 'admitted':
			return { line: flow.asOwner ? 'Admitted. Setting this tab up as an owner…' : 'Admitted as a member. Finishing the setup…' };
		case 'moving-strands':
			return { line: 'Moving this tab’s strands into your cadre…' };
		case 'removing-old-cadre':
			return { line: 'Removing this tab’s old cadre from this browser…' };
		case 'move-incomplete':
			return {
				line: incompleteMoveLine(flow.moved, flow.waiting.length),
				detail: flow.reason === 'adoption-failed' && flow.message ? `Moving stopped: ${flow.message}` : INCOMPLETE_REASON[flow.reason],
			};
		case 'old-cadre-kept':
			return {
				line: flow.otherMachines.length > 0
					? `This tab’s old cadre also has other machines (${flow.otherMachines.length}), so it was kept in this browser. Nothing was lost; you can ignore this.`
					: 'This tab’s old cadre was kept in this browser.',
			};
		case 'confirm-discard':
			return { line: discardQuestion(flow.strandIds.length + flow.pendingJoinIds.length) };
		case 'old-cadre-remains':
			return {
				line: 'This tab’s old cadre is still in this browser.',
				...(flow.error ? { detail: `Removing it failed: ${flow.error}` } : {}),
			};
		case 'removal-unfinished':
			return unfinishedRemovalText(flow);
		case 'done':
			return { line: doneLine(flow.asOwner, flow.moved) };
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
			return flow.asOwner ? 'Joining your cadre, and setting this tab up as an owner…' : 'Joining your cadre…';
	}
}

/** "1 strand", "3 strands". */
function strands(n: number): string {
	return n === 1 ? '1 strand' : `${n} strands`;
}

/** `waiting` is 0 when the record of the move could not be read. */
function incompleteMoveLine(moved: number, waiting: number): string {
	const still = waiting === 0 ? 'some' : String(waiting);
	if (moved > 0) return `${strands(moved)} moved; ${still} still waiting.`;
	if (waiting === 0) return 'Some of this tab’s strands are still waiting to move.';
	return `${strands(waiting)} ${waiting === 1 ? 'is' : 'are'} still waiting to move.`;
}

function discardQuestion(count: number): string {
	const items = count === 1 ? '1 item from this tab’s old cadre is' : `${count} items from this tab’s old cadre are`;
	return `${items} not in your cadre (they may have been removed there). Delete them with the old cadre?`;
}

const NEXT_START = 'The next start of this tab’s node finishes it: reload this page, or Restart node on Home.';

function unfinishedRemovalText(flow: Extract<JoinFlow, { step: 'removal-unfinished' }>): JoinFlowText {
	if (flow.blocked) return { line: 'Close this site’s other tabs to finish removing the old cadre.', detail: NEXT_START };
	return {
		line: 'Removing this tab’s old cadre did not finish.',
		detail: flow.error ? `${NEXT_START} It stopped at: ${flow.error}` : NEXT_START,
	};
}

/** The count is left out when nothing moved: a join with nothing to move, or a removal finished after a reload. */
function doneLine(asOwner: boolean, moved: number): string {
	const joined = `This tab is now part of your cadre, as ${asOwner ? 'an owner' : 'a member'}.`;
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
	if (err instanceof StrandsNeedOwnerJoinError) return ownerJoinNeededLine(err.strandCount);
	return describeOwnerGrantFailure(err) ?? (err instanceof Error ? err.message : String(err));
}

/** The edge node refused a member join that would leave the founded party's strands behind; the phone app's `join-failure.ts` says the same of "this app". */
function ownerJoinNeededLine(strandCount: number): string {
	const held = strandCount > 0 ? `its ${strands(strandCount)}` : 'what its own cadre holds';
	return `This invitation makes the tab a member, and only an owner can bring ${held} along. In the app that holds your cadre, make an owner grant under Owner keys → Add an owner key, and paste it here.`;
}

/** The notice for a join that did not happen: the user cancelled it, or it failed. */
export function joinFailureNotice(err: unknown): { title: string; message: string } {
	if (err instanceof JoinCancelledError) return { title: 'Join cancelled', message: 'This tab is back in its own cadre.' };
	return { title: 'Join failed', message: describeJoinFailure(err) };
}
