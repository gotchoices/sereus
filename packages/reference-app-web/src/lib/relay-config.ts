/**
 * relay-config.ts — resolve the optional circuit-relay multiaddr(s) the browser
 * dials so it becomes **dialable** for strand formation.
 *
 * Phase 1 ran solo with no listen addresses: a browser tab can't open a TCP/WS
 * listener, so without a relay it has no multiaddr and is unreachable. Strand
 * formation needs the dialable side (the responder, and the initiator's return
 * path) to advertise a `/p2p-circuit` address, which only exists once the tab
 * holds a circuit-relay-v2 **reservation** against a known relay. That relay is
 * deployment-specific infrastructure (see `ops/`), so — exactly like the ICE
 * manifest (`ice-config.ts`) — its address is resolved at runtime rather than
 * baked into the bundle.
 *
 * Framework-free and self-contained (no `@serfab/cadre-core` / node deps): the
 * only platform touch-points are `localStorage` and `import.meta.env`, each
 * guarded so a non-DOM host degrades to "no relay configured" rather than
 * throwing. When nothing is configured the app stays in the Phase-1 solo posture
 * (`listenAddrs: []`); formation then surfaces a clear "not dialable — configure
 * a relay" error instead of silently failing.
 */

const LOG_PREFIX = '[reference-app-web] relay-config:';

/** localStorage key for a runtime relay-multiaddr override (debug / per-device). */
export const RELAY_ADDR_STORAGE_KEY = 'relay-addr';

/** Read the build-time relay addrs (`VITE_RELAY_ADDR`, comma-separated). */
function envRelayAddrs(): string[] {
	const raw = import.meta.env.VITE_RELAY_ADDR;
	return typeof raw === 'string' ? splitAddrs(raw) : [];
}

/** Read the runtime override from localStorage, guarded for non-DOM hosts. */
function storedRelayAddrs(): string[] {
	try {
		if (typeof localStorage === 'undefined') return [];
		return splitAddrs(localStorage.getItem(RELAY_ADDR_STORAGE_KEY) ?? '');
	} catch (err) {
		// localStorage can throw (privacy mode, disabled storage) — log, don't fail.
		console.warn(`${LOG_PREFIX} localStorage read failed`, err);
		return [];
	}
}

/** Split a comma/whitespace-separated list into trimmed, non-empty multiaddrs. */
function splitAddrs(raw: string): string[] {
	return raw
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * Resolve the relay multiaddr(s): explicit arg → env (`VITE_RELAY_ADDR`) →
 * localStorage (`relay-addr`) → none. An explicit non-empty list always wins;
 * otherwise the first source that yields any address is used.
 */
export function resolveRelayAddrs(explicit?: string[]): string[] {
	if (explicit && explicit.length > 0) return explicit;
	const env = envRelayAddrs();
	if (env.length > 0) return env;
	return storedRelayAddrs();
}
