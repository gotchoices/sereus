/**
 * join-flow.ts — the steps "Join my existing cadre" shows once Join is tapped, and the plain
 * words for each (docs/reference-app-rn.md → "Joining an existing cadre"). No React: the hook
 * (`use-join-flow.ts`, part of `use-cadre.ts`) holds the flow, so it survives a tab switch,
 * and `join-cadre-section.tsx` renders it.
 */

import type { PhoneJoinProgress } from '@serfab/cadre-rn/phone-node';

export type JoinFlow =
	/** Redeeming the invitation; `wait` while no member of the cadre is ready, until `retryAtMs`. Cancellable. */
	| { step: 'joining'; wait?: 'no-member-answered' | 'member-not-ready'; retryAtMs?: number }
	/** `asOwner`: the app joined with an owner grant, so it is being set up as an owner. */
	| { step: 'admitted'; asOwner: boolean }
	| { step: 'moving-strands' }
	| { step: 'removing-old-cadre' }
	/** Some of the old cadre's strands are not in the joined one yet; the old cadre cannot be removed until they are. */
	| { step: 'move-incomplete'; moved: number; waiting: string[]; reason: 'owner-key-not-wired' | 'adoption-failed' | 'partial'; message?: string }
	/** The old cadre stays on this phone: it has other machines, or (none listed) the user chose to keep what only it holds. */
	| { step: 'old-cadre-kept'; otherMachines: string[] }
	/** The old cadre holds strands or pending joins the joined cadre does not; removing it deletes them. */
	| { step: 'confirm-discard'; strandIds: string[]; pendingJoinIds: string[] }
	/** The old cadre is on this phone and nothing is removing it; `error` when the last removal failed. */
	| { step: 'old-cadre-remains'; error?: string }
	| { step: 'done'; asOwner: boolean; moved: number };

export interface JoinFlowText {
	line: string;
	detail?: string;
}

/**
 * Thrown by the hook's `joinExistingCadre` when the user cancelled the join while it waited. The
 * kit has put the app back in the cadre it ran before (or left it stopped), unchanged.
 */
export class JoinCancelledError extends Error {
	constructor() {
		super('The join was cancelled');
		this.name = 'JoinCancelledError';
	}
}

/** The step a join's progress report puts the flow in. */
export function flowForProgress(progress: PhoneJoinProgress): JoinFlow {
	switch (progress.state) {
		case 'redeeming':
			return { step: 'joining' };
		case 'waiting':
			return { step: 'joining', wait: progress.reason, retryAtMs: progress.retryAtMs };
		case 'admitted':
			return { step: 'admitted', asOwner: progress.asOwner };
		case 'moving-strands':
			return { step: 'moving-strands' };
	}
}

const INCOMPLETE_REASON: Record<Extract<JoinFlow, { step: 'move-incomplete' }>['reason'], string> = {
	'owner-key-not-wired': 'This app is not an owner of your cadre yet, so its chats cannot move. They move as soon as it is.',
	'adoption-failed': 'Moving stopped.',
	partial: 'Some could not be moved this time.',
};

export function joinFlowText(flow: JoinFlow): JoinFlowText {
	switch (flow.step) {
		case 'joining':
			return { line: joiningLine(flow) };
		case 'admitted':
			return { line: flow.asOwner ? 'Admitted. Setting this app up as an owner…' : 'Admitted as a member. Finishing the setup…' };
		case 'moving-strands':
			return { line: 'Moving this app\'s chats into your cadre…' };
		case 'removing-old-cadre':
			return { line: 'Removing this app\'s old cadre from this phone…' };
		case 'move-incomplete':
			return {
				line: incompleteMoveLine(flow.moved, flow.waiting.length),
				detail: flow.reason === 'adoption-failed' && flow.message ? `Moving stopped: ${flow.message}` : INCOMPLETE_REASON[flow.reason],
			};
		case 'old-cadre-kept':
			return {
				line: flow.otherMachines.length > 0
					? `This app's old cadre also has other machines (${flow.otherMachines.length}), so it was kept on this phone. Nothing was lost; you can ignore this.`
					: 'This app\'s old cadre was kept on this phone.',
			};
		case 'confirm-discard':
			return { line: discardQuestion(flow.strandIds.length + flow.pendingJoinIds.length) };
		case 'old-cadre-remains':
			return {
				line: 'This app\'s old cadre is still on this phone.',
				...(flow.error ? { detail: `Removing it failed: ${flow.error}` } : {}),
			};
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
			return 'Joining your cadre…';
	}
}

/** `waiting` is 0 when the kit's record of the move could not be read. */
function incompleteMoveLine(moved: number, waiting: number): string {
	const still = waiting === 0 ? 'some' : String(waiting);
	if (moved > 0) return `${chats(moved)} moved; ${still} still waiting.`;
	if (waiting === 0) return 'Some of this app\'s chats are still waiting to move.';
	return `${chats(waiting)} ${waiting === 1 ? 'is' : 'are'} still waiting to move.`;
}

function discardQuestion(count: number): string {
	const items = count === 1 ? '1 item from this app\'s old cadre is' : `${count} items from this app's old cadre are`;
	return `${items} not in your cadre (they may have been removed there). Delete them with the old cadre?`;
}

/** The count is left out when nothing moved: a join with nothing to move, or a removal finished after a relaunch. */
function doneLine(asOwner: boolean, moved: number): string {
	const joined = `This app is now part of your cadre, as ${asOwner ? 'an owner' : 'a member'}.`;
	return moved > 0 ? `${joined} ${chats(moved)} moved.` : joined;
}

/** "1 chat", "3 chats": a strand is a chat in this app's words. */
export function chats(n: number): string {
	return n === 1 ? '1 chat' : `${n} chats`;
}

function clockTime(ms: number): string {
	return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
