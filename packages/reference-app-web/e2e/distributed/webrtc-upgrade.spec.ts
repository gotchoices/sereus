import { test, expect, type Page } from '@playwright/test';
import {
	loadFixtureState,
	requireFixture,
	connectToBootstrap,
	collectBootstrapMultiaddrs,
	gotoMessages,
	sendOne,
} from './_helpers.js';

/**
 * WebRTC upgrade flip-point assertion (the consumer of the FLIP POINT marker
 * formerly in `connection-path.spec.ts`).
 *
 * Two NAT-to-NAT browser tabs reserve a slot on the Tier-2 relay, dial each
 * other in over `/p2p-circuit`, exchange SDP over that circuit, and then upgrade
 * to a **direct** `webrtc` connection — at which point the relay drops out of the
 * data path. This spec drives a cross-browser dial, then asserts the upgrade:
 *
 *   - at least one side reports a `direct` / `transport === 'webrtc'` path, and
 *   - `stuckOnRelay === 0` on both sides (no relay older than the settle window
 *     without a direct path to the same peer), and
 *   - the pair's relayed-connection count trends to ~0 (the circuit between the
 *     two browsers is torn down once the direct path forms).
 *
 * ── NOT AGENT-RUNNABLE under tess ──────────────────────────────────────────────
 * This needs `yarn build && yarn preview` (or `yarn dev`) serving the app,
 * Chromium, AND the Tier-2 reference-peer fixture (a relay + service peers).
 * The implement agent authors + typechecks it; a human / CI runs it.
 *
 * Realistic risk: the upgrade only fires if the dialing peer has the target's
 * `/…/p2p-circuit/webrtc/p2p/<peer>` address in its peerStore. The relayed path
 * already propagates today, and adding `/webrtc` to `listenAddrs` advertises the
 * webrtc variant over the same identify/cohort flow — so this is expected to be
 * self-sufficient. If this spec shows the upgrade does NOT fire, do **not**
 * expand the transport ticket: see backlog `web-webrtc-signaling-addr-resolution`
 * (wire a db-p2p peerStore address-resolver seam, or consume `resolvePeerAddrs`).
 */

interface ConnectionPathSummaryShape {
	total: number;
	relayed: number;
	direct: number;
	stuckOnRelay: number;
	byTransport: Record<string, number>;
	bytesOverRelay: number | null;
	paths: Array<{
		peerId: string;
		remoteAddr: string;
		kind: 'relayed' | 'direct';
		transport: string;
		direction: 'inbound' | 'outbound';
		openedAtMs: number | null;
		ageMs: number | null;
		stuckOnRelay: boolean;
	}>;
	settleWindowMs: number;
}

async function getConnectionPaths(page: Page): Promise<ConnectionPathSummaryShape> {
	return page.evaluate(() => {
		const hook = (
			window as unknown as {
				__optimystic?: { getConnectionPaths?: () => ConnectionPathSummaryShape };
			}
		).__optimystic;
		if (!hook?.getConnectionPaths) throw new Error('__optimystic.getConnectionPaths missing');
		return hook.getConnectionPaths();
	});
}

/** A `direct` connection tagged with the `webrtc` transport on this side. */
function hasDirectWebrtc(summary: ConnectionPathSummaryShape): boolean {
	return summary.paths.some((p) => p.kind === 'direct' && p.transport === 'webrtc');
}

test.describe('Tier 2 / distributed / webrtc upgrade', () => {
	let bootstrapList: string[];

	test.beforeAll(({}, testInfo) => {
		const fixture = requireFixture(loadFixtureState(), testInfo);
		bootstrapList = collectBootstrapMultiaddrs(fixture);
	});

	test('relayed browser↔browser pair upgrades to a direct webrtc path', async ({ browser }) => {
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const pageA = await ctxA.newPage();
		const pageB = await ctxB.newPage();

		try {
			await connectToBootstrap(pageA, bootstrapList);
			await connectToBootstrap(pageB, bootstrapList);
			await gotoMessages(pageA);
			await gotoMessages(pageB);

			// Cross-browser dial: A writes, B converges on the same message id. This
			// forces a live connection between the two browser peers — initially over
			// the relay, then (the point of this spec) upgraded to direct webrtc.
			const tag = `webrtc-${Date.now()}`;
			const id = await sendOne(pageA, 'alice', tag);
			const rowOnB = pageB.locator(`[data-testid="message-row"][data-message-id="${id}"]`);
			await expect(rowOnB).toBeVisible({ timeout: 30_000 });

			// Flip point: poll until at least one side holds a direct webrtc path AND
			// neither side is stuck on a relay. Generous, ramping window — the SDP
			// exchange + ICE gathering + DTLS handshake take several seconds after the
			// relayed dial lands, and depend on the manifest's STUN servers for NAT
			// traversal.
			await expect
				.poll(
					async () => {
						const [a, b] = await Promise.all([
							getConnectionPaths(pageA),
							getConnectionPaths(pageB),
						]);
						const upgraded = hasDirectWebrtc(a) || hasDirectWebrtc(b);
						const noneStuck = a.stuckOnRelay === 0 && b.stuckOnRelay === 0;
						return upgraded && noneStuck;
					},
					{ timeout: 60_000, intervals: [1000, 2000, 3000, 5000, 5000, 5000] },
				)
				.toBe(true);

			// The upgraded webrtc path must be classified direct (not relayed) and the
			// relay must drop out of the pair's data path: the circuit connection
			// between the two browsers is torn down once the direct path forms, so the
			// relayed count trends to ~0. (The browser→relay reservation itself is a
			// direct websocket and never counts as relayed.)
			await expect
				.poll(
					async () => {
						const [a, b] = await Promise.all([
							getConnectionPaths(pageA),
							getConnectionPaths(pageB),
						]);
						return Math.max(a.relayed, b.relayed);
					},
					{ timeout: 60_000, intervals: [2000, 3000, 5000, 5000] },
				)
				.toBe(0);

			// Sanity: every direct webrtc path is well-formed — webrtc transport,
			// `/webrtc` in the remoteAddr, and not flagged stuck.
			const [finalA, finalB] = await Promise.all([
				getConnectionPaths(pageA),
				getConnectionPaths(pageB),
			]);
			const webrtcPaths = [...finalA.paths, ...finalB.paths].filter(
				(p) => p.transport === 'webrtc',
			);
			expect(webrtcPaths.length).toBeGreaterThanOrEqual(1);
			for (const p of webrtcPaths) {
				expect(p.kind).toBe('direct');
				expect(p.remoteAddr).toContain('/webrtc');
				expect(p.stuckOnRelay).toBe(false);
			}
		} finally {
			await ctxA.close();
			await ctxB.close();
		}
	});
});
