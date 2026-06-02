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
 * Connection-path regression guard.
 *
 * After a two-browser NAT-to-NAT pair connects through the Tier-2 relay and one
 * tab drives a cross-browser dial (sending a message the other tab converges
 * on), assert that `window.__optimystic.getConnectionPaths()` returns a
 * well-formed summary and that any circuit connection is classified as
 * `relayed` (transport `circuit-relay`, `/p2p-circuit` in its remoteAddr).
 *
 * This spec is the **classification well-formedness guard**. With the WebRTC
 * transport now wired (see `webrtc-upgrade.spec.ts`), the pair starts on a
 * `/p2p-circuit` relay then upgrades to a direct `webrtc` connection, so the
 * cross-browser pairing is asserted as "reached over a relay **or** already
 * upgraded to webrtc" — relay-or-direct — to stay honest about that transition.
 * The direct-upgrade success criteria (`direct`/`webrtc` + `stuckOnRelay === 0`)
 * live in the dedicated `webrtc-upgrade.spec.ts`.
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

function assertWellFormed(summary: ConnectionPathSummaryShape): void {
	expect(typeof summary.total).toBe('number');
	expect(typeof summary.relayed).toBe('number');
	expect(typeof summary.direct).toBe('number');
	expect(typeof summary.stuckOnRelay).toBe('number');
	expect(Array.isArray(summary.paths)).toBe(true);
	expect(summary.paths.length).toBe(summary.total);
	// Invariants: relayed + direct == total; byTransport sums to total.
	expect(summary.relayed + summary.direct).toBe(summary.total);
	const transportSum = Object.values(summary.byTransport).reduce((a, b) => a + b, 0);
	expect(transportSum).toBe(summary.total);
	// paths[] counts agree with the scalar counts.
	expect(summary.paths.filter((p) => p.kind === 'relayed').length).toBe(summary.relayed);
}

test.describe('Tier 2 / distributed / connection-path classification', () => {
	let bootstrapList: string[];

	test.beforeAll(({}, testInfo) => {
		const fixture = requireFixture(loadFixtureState(), testInfo);
		bootstrapList = collectBootstrapMultiaddrs(fixture);
	});

	test('circuit connection is classified relayed after a cross-browser dial', async ({
		browser,
	}) => {
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const pageA = await ctxA.newPage();
		const pageB = await ctxB.newPage();

		try {
			await connectToBootstrap(pageA, bootstrapList);
			await connectToBootstrap(pageB, bootstrapList);
			await gotoMessages(pageA);
			await gotoMessages(pageB);

			// Drive a cross-browser dial: A writes, B converges. Browsers can only
			// reach each other through the relay, so this forces a /p2p-circuit
			// connection to exist somewhere in the pair.
			const tag = `cpath-${Date.now()}`;
			const id = await sendOne(pageA, 'alice', tag);
			const rowOnB = pageB.locator(
				`[data-testid="message-row"][data-message-id="${id}"]`,
			);
			await expect(rowOnB).toBeVisible({ timeout: 30_000 });

			// Both summaries must be well-formed regardless of which side holds the
			// circuit connection.
			const summaryA = await getConnectionPaths(pageA);
			const summaryB = await getConnectionPaths(pageB);
			assertWellFormed(summaryA);
			assertWellFormed(summaryB);

			// At least one side reaches the other over a relay, OR the pair has
			// already upgraded to a direct webrtc path. Poll because the circuit
			// dial may land slightly after convergence is visible, and because the
			// webrtc upgrade may have replaced the relay by the time we look. Either
			// outcome proves the cross-browser pairing converged; the dedicated
			// `webrtc-upgrade.spec.ts` asserts the upgrade specifically.
			await expect
				.poll(
					async () => {
						const [a, b] = await Promise.all([
							getConnectionPaths(pageA),
							getConnectionPaths(pageB),
						]);
						const relayed = Math.max(a.relayed, b.relayed);
						const webrtc = Math.max(a.byTransport.webrtc ?? 0, b.byTransport.webrtc ?? 0);
						return relayed >= 1 || webrtc >= 1;
					},
					{ timeout: 30_000, intervals: [1000, 2000, 3000] },
				)
				.toBe(true);

			// Sanity: any relayed path must be tagged with the circuit-relay transport.
			const relayedPaths = [...summaryA.paths, ...summaryB.paths].filter(
				(p) => p.kind === 'relayed',
			);
			for (const p of relayedPaths) {
				expect(p.transport).toBe('circuit-relay');
				expect(p.remoteAddr).toContain('/p2p-circuit');
			}
		} finally {
			await ctxA.close();
			await ctxB.close();
		}
	});
});
