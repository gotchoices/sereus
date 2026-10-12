/**
 * The `fetch` a cross-platform HTTP caller in this package uses: the one injected for tests
 * and embedders, else the runtime's global. Shared by the formation-approval client and the
 * provider client, so both resolve it the same way.
 *
 * Bound to `globalThis` because an unbound global `fetch` is an illegal invocation in browsers
 * (and in any runtime whose `fetch` is a branded method rather than a plain function).
 */

/** The injected `fetch`, else the bound global; undefined when the runtime has none. */
export function resolveFetch(fetchImpl?: typeof fetch): typeof fetch | undefined {
	if (fetchImpl) return fetchImpl;
	return typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined;
}

/** {@link resolveFetch}, throwing when the runtime has no `fetch` and none was injected. */
export function requireFetch(fetchImpl?: typeof fetch): typeof fetch {
	const resolved = resolveFetch(fetchImpl);
	if (!resolved) {
		throw new Error('No fetch implementation: globalThis.fetch is missing and none was supplied');
	}
	return resolved;
}
