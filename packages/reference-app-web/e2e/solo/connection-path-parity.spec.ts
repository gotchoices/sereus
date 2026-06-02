import { test, expect } from '@playwright/test';
import {
	classifyTransport,
	type ConnectionPathKind,
	type ConnectionTransport,
} from '../../src/lib/connection-path.js';

/**
 * Drift guard for the *deliberate duplicate* classifier.
 *
 * `reference-app-web/src/lib/connection-path.ts` is a hand-maintained copy of
 * the cadre-core original at
 * `packages/cadre-core/src/diagnostics/connection-path.ts` (the web app does not
 * depend on cadre-core). This table is identical to the one asserted by the
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
];

test.describe('web connection-path classifier parity', () => {
	for (const { addr, kind, transport } of CLASSIFIER_TABLE) {
		test(`classifies "${addr || '(empty)'}" as ${kind}/${transport}`, () => {
			expect(classifyTransport(addr)).toEqual({ kind, transport });
		});
	}
});
