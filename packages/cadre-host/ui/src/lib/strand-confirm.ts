/**
 * The two rules governing how hard it is to leave a strand.
 *
 * They live here rather than inside `Strands.svelte` so the policy is unit
 * testable — this package has no Svelte component test harness, so anything
 * left in a template is covered only by a manual pass.
 *
 * The command line gates a closed-strand removal behind an explicit `--yes`
 * flag: the operator has to do something extra and specific. A click-through
 * checkbox is not the same weight, so the web equivalent is typing the id.
 */

/**
 * Whether leaving a strand of this type demands a typed confirmation.
 *
 * Only `'c'` (closed) does. A closed strand's row carries this party's
 * membership key for that network and it is stored nowhere else, so deleting
 * the row destroys it for good; an open strand can be re-joined by publishing
 * it again.
 */
export function requiresTypedConfirmation(type: 'o' | 'c'): boolean {
	return type === 'c';
}

/**
 * Whether what the operator typed authorises the removal of `expected`.
 *
 * Exact match after trimming both sides — pasting is fine (the goal is
 * deliberateness, not recall), but a case difference or a substring is not a
 * match. An empty `expected` never matches, so a missing id cannot accidentally
 * enable the button.
 */
export function typedConfirmationMatches(expected: string, typed: string): boolean {
	const target = expected.trim();
	if (!target) return false;
	return typed.trim() === target;
}
