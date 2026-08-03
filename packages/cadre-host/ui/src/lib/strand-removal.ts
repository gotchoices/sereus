/**
 * The rules of leaving a strand: how hard the confirmation is, and what the
 * operator is told afterwards.
 *
 * They live here rather than inside `Strands.svelte` so the policy is unit
 * testable — this package has no Svelte component test harness, so anything
 * left in a template is covered only by a manual pass.
 */

import type { StrandRemovalResult } from './state.svelte.js';

/**
 * Whether leaving a strand of this type demands a typed confirmation.
 *
 * Only `'c'` (closed) does. A closed strand's row carries this party's
 * membership key for that network and it is stored nowhere else, so deleting
 * the row destroys it for good; an open strand can be re-joined by publishing
 * it again.
 *
 * The command line gates the same removal behind an explicit `--yes` flag: the
 * operator has to do something extra and specific. A click-through checkbox is
 * not the same weight, so the web equivalent is typing the id.
 */
export function requiresTypedConfirmation(type: 'o' | 'c'): boolean {
	return type === 'c';
}

/** Exactly one piece of feedback for one removal. */
export type RemovalFeedback =
	| { kind: 'toast'; tone: 'info' | 'success'; text: string }
	/** The removal committed while the machine saw no siblings; `strandId` names it. */
	| { kind: 'banner'; strandId: string };

/**
 * Decide what one removal result tells the operator.
 *
 * `alone` is sampled on every call, including one that wrote nothing, so it only
 * warrants the banner alongside a delete this call actually issued. The banner
 * is an inline dismissable element rather than a toast because it is the one
 * outcome an owner may need to act on after reading it.
 */
export function removalFeedback(result: StrandRemovalResult): RemovalFeedback {
	const id = result.strandId;
	if (!result.published) return { kind: 'toast', tone: 'info', text: `${id} was already removed` };
	if (result.removed && result.alone) return { kind: 'banner', strandId: id };
	return { kind: 'toast', tone: 'success', text: `Left ${id}` };
}
