import { describe, it, expect } from 'vitest';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import {
	WEBRTC_UPGRADE_BACKOFF_MS,
	WEBRTC_UPGRADE_MAX_BACKOFF_MS,
	decideWebrtcUpgrade,
	nextWebrtcUpgradeBackoffMs,
	type WebrtcUpgradeInputs
} from '../src/webrtc-upgrade.js';

/**
 * `decideWebrtcUpgrade`: whether one `peer:identify` over a relayed connection becomes a
 * background WebRTC upgrade dial.
 *
 * Tested as a table over the pure function because the two rules that carry real judgement live
 * there and nowhere else: the TIE-BREAK that makes exactly one of the two sides dial (without
 * it, two machines upgrade each other at the same moment), and the BACKOFF that stops two
 * networks with no direct path between them from paying a 23-second ICE timeout on every
 * reconnect. Everything the service does around it — subscribing, dialing, recording the
 * outcome — is wiring, and the scenario
 * `webrtc-ice-failure-falls-back-to-relay.integration.ts` exercises it end to end over a real
 * relay.
 */

const RELAY = '12D3KooWRelayAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const RELAY_2 = '12D3KooWRelayBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
/** Two peer ids whose STRING order is what the tie-break compares. `AAA…` sorts below `ZZZ…`. */
const LOWER = '12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const HIGHER = '12D3KooWZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';

/**
 * A remote's identified listen addresses as libp2p delivers them: the trailing `/p2p/<self>` is
 * stripped by identify, so a WebRTC address arrives ending in `/webrtc`.
 */
const webrtcAddr = (relay: string): Multiaddr => multiaddr(`/ip4/9.9.9.9/tcp/4001/ws/p2p/${relay}/p2p-circuit/webrtc`);
const relayedAddr = (relay: string): Multiaddr => multiaddr(`/ip4/9.9.9.9/tcp/4001/ws/p2p/${relay}/p2p-circuit`);
const lanAddr = multiaddr('/ip4/192.168.1.5/tcp/4002/ws');

const NOW = 1_700_000_000_000;

/**
 * The case this module exists for: a peer reached only through a relay, publishing both address
 * shapes, with this side advertising no WebRTC address of its own — so this side dials.
 */
const baseline: WebrtcUpgradeInputs = {
	localPeerId: HIGHER,
	remotePeerId: LOWER,
	openConnections: ['relayed'],
	remoteAddrs: [relayedAddr(RELAY), webrtcAddr(RELAY)],
	localAdvertisesWebrtc: false,
	nowMs: NOW,
};

describe('decideWebrtcUpgrade', () => {
	it.each([
		// The baseline, stated as a row so the table reads as a contrast against it.
		['a relay-only peer publishing a WebRTC address', {}, true],
		// Two relays, so two relayed connections and still nothing direct: upgrade.
		['two relayed connections to the peer', { openConnections: ['relayed', 'relayed'] as const }, true],
		// Nothing to upgrade: the connection closed between the identify and this judgement.
		['no connection left', { openConnections: [] as const }, false],
		// A WebRTC connection IS the upgraded state, so it is not a trigger either.
		['an established WebRTC connection', { openConnections: ['webrtc'] as const }, false],
		// Reachable directly anyway, with the relayed connection still open.
		['a direct connection already open beside the relayed one', { openConnections: ['relayed', 'direct'] as const }, false],
		// A dialer needs the WebRTC transport, not an address of its own, so advertising none
		// does not stop this side dialing — only the remote's address matters here.
		['the remote publishing no WebRTC address', { remoteAddrs: [relayedAddr(RELAY), lanAddr] }, false],
		// The tie-break. Both advertise one, so exactly one side dials: the lower peer id.
		['both advertising one, this side lower', { localAdvertisesWebrtc: true, localPeerId: LOWER, remotePeerId: HIGHER }, true],
		// The backoff's boundary: the wait is over at the instant it expires, not after it.
		['a wait that has just expired', { backoffUntilMs: NOW }, true],
		// Every remaining declining case is a row of the reason table below, which asserts the
		// same `attempt: false` plus the reason, so it is not repeated here.
	] as const)('%s: attempt=%o', (_name, overrides, attempt) => {
		expect(decideWebrtcUpgrade({ ...baseline, ...overrides }).attempt).toBe(attempt);
	});

	it.each([
		['not-relayed', { openConnections: ['direct'] as const }],
		['already-direct', { openConnections: ['relayed', 'webrtc'] as const }],
		['no-webrtc-addr', { remoteAddrs: [] }],
		['remote-dials', { localAdvertisesWebrtc: true, localPeerId: HIGHER, remotePeerId: LOWER }],
		['in-backoff', { backoffUntilMs: NOW + 1 }],
	] as const)('reports %s', (reason, overrides) => {
		const decision = decideWebrtcUpgrade({ ...baseline, ...overrides });
		expect(decision.attempt).toBe(false);
		expect(decision.attempt === false && decision.reason).toBe(reason);
	});

	it('dials the first WebRTC address in identify order, one relay per attempt', () => {
		const decision = decideWebrtcUpgrade({
			...baseline,
			remoteAddrs: [relayedAddr(RELAY), webrtcAddr(RELAY_2), webrtcAddr(RELAY)],
		});

		// Two relays mean two WebRTC addresses. Only one is dialed — fanning out would multiply
		// the ICE cost for a peer no direct path reaches at all.
		expect(decision.attempt).toBe(true);
		expect(decision.attempt === true && decision.addr.toString()).toBe(webrtcAddr(RELAY_2).toString());
	});
});

/**
 * The ladder behind the `in-backoff` deadline above. Pinned because its ceiling is the only
 * thing stopping a peer no direct path reaches from being re-attempted forever at a cost that
 * stays constant — and because `Math.min` is the kind of clamp an edit silently turns into a
 * `Math.max`.
 */
describe('nextWebrtcUpgradeBackoffMs', () => {
	it('starts at the first wait, doubles, and holds at the ceiling', () => {
		expect(nextWebrtcUpgradeBackoffMs()).toBe(WEBRTC_UPGRADE_BACKOFF_MS);
		expect(nextWebrtcUpgradeBackoffMs(WEBRTC_UPGRADE_BACKOFF_MS)).toBe(2 * WEBRTC_UPGRADE_BACKOFF_MS);

		// Climb from the first wait and assert the ladder never overshoots, reaches the ceiling,
		// and then stays there however many more failures the peer collects.
		let wait = nextWebrtcUpgradeBackoffMs();
		for (let failure = 0; failure < 20; failure++) {
			const next = nextWebrtcUpgradeBackoffMs(wait);
			expect(next).toBeGreaterThanOrEqual(wait);
			expect(next).toBeLessThanOrEqual(WEBRTC_UPGRADE_MAX_BACKOFF_MS);
			wait = next;
		}
		expect(wait).toBe(WEBRTC_UPGRADE_MAX_BACKOFF_MS);
		expect(nextWebrtcUpgradeBackoffMs(WEBRTC_UPGRADE_MAX_BACKOFF_MS)).toBe(WEBRTC_UPGRADE_MAX_BACKOFF_MS);
	});
});
