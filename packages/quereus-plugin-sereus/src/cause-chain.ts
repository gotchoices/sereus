/**
 * The first error in `err`'s `cause` chain that is a `type` — `err` itself included — so a wrapper
 * added between a throw and an app's `catch` cannot hide the error the app is looking for.
 *
 * Shared by this package's error finders (`appSchemaRefusalOf`, `cohortOutOfSpaceOf`), each of which
 * is one call of this: a chain walk that gains a rule gains it for every finder at once, rather than
 * for whichever one its author remembered. Internal — the finders are the published surface, because
 * each names the one type an app should ask about and carries why that type is worth asking about.
 */
export function causeOf<T extends Error>(err: unknown, type: new (...args: never[]) => T): T | undefined {
	for (let at = err; at instanceof Error; at = at.cause) {
		if (at instanceof type) {
			return at;
		}
	}
	return undefined;
}
