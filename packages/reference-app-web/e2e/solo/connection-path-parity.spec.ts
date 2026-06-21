import { test, expect } from '@playwright/test';
import {
	classifyTransport,
	classifyConnectionPath,
	type ConnectionLike,
	type ConnectionPathKind,
	type ConnectionTransport,
} from '../../src/lib/connection-path.js';

/**
 * Drift guard for the *deliberate duplicate* classifier.
 *
 * `reference-app-web/src/lib/connection-path.ts` is a hand-maintained copy of
 * the cadre-core original at
 * `packages/cadre-core/src/diagnostics/connection-path.ts`. The web app now
 * depends on cadre-core, so the copy could be collapsed into a direct import —
 * until it is, this guards the two against drift. This table is identical to the
 * one asserted by the
 * cadre-core unit spec (`test/connection-path.spec.ts` → `CLASSIFIER_TABLE`).
 * If the two classifiers ever diverge, one of these two specs fails.
 *
 * This is a pure Node-side assertion — it does not drive the browser. It lives
 * under the Playwright runner only because the web package ships no separate
 * unit-test runner.
 */
const CLASSIFIER_TABLE: Array<{
	addr: string;
	kind: ConnectionPathKind;
	transport: ConnectionTransport;
	// TURN-relay hint (see cadre-core CLASSIFIER_TABLE). Hint rows are asserted via
	// classifyConnectionPath; classifyTransport (pure string fn) cannot produce them.
	turnRelayed?: boolean;
}> = [
	{
		addr: '/ip4/1.2.3.4/tcp/443/wss/p2p/QmRelay/p2p-circuit/p2p/QmTarget',
		kind: 'relayed',
		transport: 'circuit-relay',
	},
	{
		// Browser-to-browser WebRTC over a relay keeps the circuit prefix but is
		// a direct data path — must classify direct/webrtc. Regression guard.
		addr: '/ip4/1.2.3.4/tcp/443/wss/p2p/QmRelay/p2p-circuit/webrtc/p2p/QmTarget',
		kind: 'direct',
		transport: 'webrtc',
	},
	{
		addr: '/ip4/1.2.3.4/udp/9/webrtc-direct/certhash/uEiAabc/p2p/QmTarget',
		kind: 'direct',
		transport: 'webrtc-direct',
	},
	{ addr: '/ip4/1.2.3.4/udp/9/webrtc/p2p/QmTarget', kind: 'direct', transport: 'webrtc' },
	{ addr: '/ip4/127.0.0.1/tcp/4001/ws/p2p/QmTarget', kind: 'direct', transport: 'websocket' },
	{ addr: '/ip4/127.0.0.1/tcp/4001/p2p/QmTarget', kind: 'direct', transport: 'tcp' },
	{ addr: '', kind: 'direct', transport: 'unknown' },
	{ addr: 'not-a-multiaddr', kind: 'direct', transport: 'unknown' },
	{
		// WebRTC whose ICE selected a TURN relay candidate: turnRelayed promotes it
		// to relayed/webrtc-turn. Mirrors the cadre-core row.
		addr: '/ip4/1.2.3.4/udp/9/webrtc/p2p/QmTurn',
		turnRelayed: true,
		kind: 'relayed',
		transport: 'webrtc-turn',
	},
];

/** Build a minimal synthetic connection for classifyConnectionPath assertions. */
function makeConn(addr: string, turnRelayed?: boolean): ConnectionLike {
	return {
		remotePeer: { toString: () => 'QmParity' },
		remoteAddr: { toString: () => addr },
		direction: 'outbound',
		turnRelayed,
	};
}

test.describe('web connection-path classifier parity', () => {
	// Pure addr→class rows drive classifyTransport (the TURN hint is not a string).
	for (const { addr, kind, transport, turnRelayed } of CLASSIFIER_TABLE) {
		if (turnRelayed) continue;
		test(`classifyTransport "${addr || '(empty)'}" → ${kind}/${transport}`, () => {
			expect(classifyTransport(addr)).toEqual({ kind, transport });
		});
	}

	// The full table (incl. the TURN-hint row) drives classifyConnectionPath.
	for (const { addr, kind, transport, turnRelayed } of CLASSIFIER_TABLE) {
		const label = turnRelayed ? ' (turnRelayed)' : '';
		test(`classifyConnectionPath "${addr || '(empty)'}"${label} → ${kind}/${transport}`, () => {
			expect(classifyConnectionPath(makeConn(addr, turnRelayed))).toEqual({ kind, transport });
		});
	}

	test('webrtc-direct is not promoted even with a turnRelayed hint', () => {
		const conn = makeConn('/ip4/1.2.3.4/udp/9/webrtc-direct/certhash/uEiAabc/p2p/QmX', true);
		expect(classifyConnectionPath(conn)).toEqual({ kind: 'direct', transport: 'webrtc-direct' });
	});
});
