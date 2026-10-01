/**
 * ice-config.ts — the STUN servers for the WebRTC transport's
 * `rtcConfiguration.iceServers`.
 *
 * A Sereus relay also answers STUN (`ops/docs/ice-servers.md`), so each relay this
 * node uses is its STUN server too: `/dns4/relay.example.org/tcp/4011/ws/p2p/…` gives
 * `stun:relay.example.org:3478`. `VITE_STUN_URLS` (comma-separated `stun:` URLs)
 * replaces that derivation, for a relay whose STUN is published on another port or
 * host.
 *
 * No TURN: a WebRTC upgrade that fails stays on the circuit relay. No third-party
 * fallback either — with no relay and no override the list is empty, which is
 * degraded but safe (host/LAN candidates only; relayed connections are unaffected)
 * and tells nobody else who this node talks to.
 *
 * Framework-free, like `relay-config.ts`. The React Native mirror is
 * `reference-app-rn/src/ice-config.ts`.
 */

import { multiaddr } from '@multiformats/multiaddr';

const LOG_PREFIX = '[reference-app-web] ice-config:';

/** The UDP port a Sereus relay answers STUN on. */
export const RELAY_STUN_PORT = 3478;

/** Multiaddr protocols that name a host a `stun:` URL can carry. */
const HOST_PROTOCOLS = new Set(['dns', 'dns4', 'dns6', 'ip4', 'ip6']);

/** Read the build-time override (`VITE_STUN_URLS`, comma-separated). */
function envStunUrls(): string[] {
	const raw = import.meta.env.VITE_STUN_URLS;
	if (typeof raw !== 'string') return [];
	return raw
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * The `stun:` URL for the relay at `relayAddr`, or `undefined` when the address names
 * no host (or does not parse — cadre-core rejects such a relay address itself, so this
 * only logs).
 */
export function relayStunUrl(relayAddr: string): string | undefined {
	let first;
	try {
		first = multiaddr(relayAddr).getComponents()[0];
	} catch (err) {
		console.warn(`${LOG_PREFIX} no STUN server for unparseable relay address ${relayAddr}`, err);
		return undefined;
	}
	if (first?.value === undefined || !HOST_PROTOCOLS.has(first.name)) return undefined;
	const host = first.name === 'ip6' ? `[${first.value}]` : first.value;
	return `stun:${host}:${RELAY_STUN_PORT}`;
}

/**
 * The ICE servers for this node: `VITE_STUN_URLS` when set, otherwise one STUN server
 * per distinct relay host. Never throws.
 */
export function resolveIceServers(relayAddrs: readonly string[]): RTCIceServer[] {
	const override = envStunUrls();
	const urls = override.length > 0
		? override
		: relayAddrs.map(relayStunUrl).filter((url): url is string => url !== undefined);
	return [...new Set(urls)].map((url) => ({ urls: url }));
}
