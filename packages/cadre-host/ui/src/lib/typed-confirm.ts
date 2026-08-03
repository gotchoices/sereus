/**
 * The matching rule for a dialog that makes the operator type something before
 * it will act.
 *
 * It lives apart from both `ConfirmDialog.svelte` and any one caller's policy:
 * the component stays generic, and the rule stays unit testable — this package
 * has no Svelte component test harness, so anything left in a template is
 * covered only by a manual pass.
 */

/**
 * Whether what the operator typed authorises an action gated on `expected`.
 *
 * Exact match after trimming both sides — pasting is fine (the goal is
 * deliberateness, not recall), but a case difference or a substring is not a
 * match. A blank `expected` never matches, so a missing value cannot
 * accidentally enable the button.
 */
export function typedConfirmationMatches(expected: string, typed: string): boolean {
	const target = expected.trim();
	if (!target) return false;
	return typed.trim() === target;
}
