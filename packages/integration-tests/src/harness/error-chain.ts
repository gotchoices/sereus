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
	const links = errorChainLinks(error);
	const parts = links.map((link) => link.message);
	// The walk stops at the first link that is not an `Error`; name it anyway, so a rejection with
	// a string reason still appears in a diff.
	const tail = links.length > 0 ? links[links.length - 1].cause : error;
	if (tail != null && !(tail instanceof Error)) {
		parts.push(String(tail));
	}
	return parts.join(' | ');
}

/**
 * `error` and every `cause` below it as OBJECTS, outermost first — for an assertion about which
 * typed error a chain carries, where {@link errorChainText} only answers what it says.
 *
 * The one walk both helpers use, so they can never disagree on where a chain ends: it stops at a
 * repeat (a `cause` pointing back at an ancestor) and at a non-`Error` link, which can carry no
 * further `cause` worth trusting. The production classifiers have their own chain walk (`causeChain` in
 * `cadre-core/src/control-retry.ts`) and a scenario asking "is this retriable?" should still call
 * the classifier rather than re-deciding from these links.
 */
export function errorChainLinks(error: unknown): Error[] {
	const links: Error[] = [];
	let current: unknown = error;
	while (current instanceof Error && !links.includes(current)) {
		links.push(current);
		current = current.cause;
	}
	return links;
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
