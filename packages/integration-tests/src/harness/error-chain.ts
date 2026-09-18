/**
 * Flatten an error's `.cause` chain into one searchable string.
 *
 * Every layer between a scenario and the storage engine wraps the failure it saw — Quereus
 * wraps the transactor, `ControlDatabase` wraps Quereus — and the typed engine error does not
 * survive the trip out of optimystic. Matching on the outermost message alone therefore
 * under-reports, and so does printing it: a scenario that asserts on `UNIQUE constraint
 * failed: …` is matching text the engine put several layers down.
 *
 * Cycle-guarded (a `cause` that points back at an ancestor stops the walk) and tolerant of a
 * non-`Error` link, so a rejection with a string reason still names itself in a diff.
 *
 * Display and matching only — never parse this to make a control-flow decision. The
 * production classifiers (`isRetriableControlWriteFailure`, `isStrandIdConflict`) own that
 * job, and a scenario asserting on their answer should call them instead.
 */
export function errorChainText(error: unknown): string {
	const parts: string[] = [];
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (current != null && !seen.has(current)) {
		seen.add(current);
		if (current instanceof Error) {
			parts.push(current.message);
			current = current.cause;
		} else {
			parts.push(String(current));
			break;
		}
	}
	return parts.join(' | ');
}

/**
 * Every settled outcome of a race, in order, rejections carrying their full chain — an
 * assertion-failure message that names WHAT each writer was told rather than just the shape
 * of the status array.
 */
export function describeOutcomes(outcomes: PromiseSettledResult<unknown>[]): string {
	return outcomes
		.map((o) => (o.status === 'rejected' ? `rejected(${errorChainText(o.reason)})` : 'fulfilled'))
		.join(', ');
}
