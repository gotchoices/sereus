/**
 * Tiny hash-based router — pure parsing/serialisation helpers.
 *
 * Reactive route state lives in `router.svelte.ts` so this module stays
 * testable in a plain Vitest environment (no Svelte compiler required).
 *
 * Hash routes (`#/`, `#/nodes/:id`, ...) avoid having to configure an SPA
 * fallback rewrite on the Fastify side, and keep the bundle usable when
 * loaded via `file://`.
 */

export type RouteName =
	| 'home'
	| 'trust-circle'
	| 'connectivity'
	| 'nodes'
	| 'node-detail'
	| 'settings';

export interface ParsedRoute {
	name: RouteName;
	params: Record<string, string>;
}

export const DEFAULT_ROUTE: ParsedRoute = { name: 'home', params: {} };

export function parseHash(hash: string): ParsedRoute {
	const raw = hash.startsWith('#') ? hash.slice(1) : hash;
	const trimmed = raw.startsWith('/') ? raw.slice(1) : raw;
	if (!trimmed) return DEFAULT_ROUTE;
	const segments = trimmed.split('/').filter(Boolean);
	switch (segments[0]) {
		case 'trust-circle':
			return { name: 'trust-circle', params: {} };
		case 'connectivity':
			return { name: 'connectivity', params: {} };
		case 'nodes':
			if (segments.length >= 2 && segments[1]) {
				return { name: 'node-detail', params: { id: decodeURIComponent(segments[1]) } };
			}
			return { name: 'nodes', params: {} };
		case 'settings':
			return { name: 'settings', params: {} };
		default:
			return DEFAULT_ROUTE;
	}
}

export function hrefFor(name: RouteName, params: Record<string, string> = {}): string {
	switch (name) {
		case 'home': return '#/';
		case 'trust-circle': return '#/trust-circle';
		case 'connectivity': return '#/connectivity';
		case 'nodes': return '#/nodes';
		case 'node-detail': return `#/nodes/${encodeURIComponent(params['id'] ?? '')}`;
		case 'settings': return '#/settings';
	}
}

export function navigate(href: string): void {
	if (typeof window === 'undefined') return;
	const normalized = href.startsWith('#')
		? href
		: `#${href.startsWith('/') ? href : `/${href}`}`;
	if (window.location.hash !== normalized) {
		window.location.hash = normalized;
	}
}
