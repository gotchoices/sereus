/**
 * Runes-backed reactive route store. Components call `routeState()` and read
 * `route.name` / `route.params` directly in markup. `startRouter()` /
 * `stopRouter()` are exposed for `App.svelte` to call from `onMount` so the
 * listener stays installed for the app's lifetime.
 */

import { DEFAULT_ROUTE, parseHash, type ParsedRoute } from './router.js';

const state = $state<{ route: ParsedRoute }>({
	route: typeof window === 'undefined' ? DEFAULT_ROUTE : parseHash(window.location.hash),
});
let listening = false;

function refresh(): void {
	state.route = parseHash(window.location.hash);
}

export function routeState(): { route: ParsedRoute } {
	return state;
}

export function startRouter(): void {
	if (listening || typeof window === 'undefined') return;
	listening = true;
	window.addEventListener('hashchange', refresh);
	refresh();
}

export function stopRouter(): void {
	if (!listening || typeof window === 'undefined') return;
	listening = false;
	window.removeEventListener('hashchange', refresh);
}
