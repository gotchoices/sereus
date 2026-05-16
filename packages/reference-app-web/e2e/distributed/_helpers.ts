import { expect, type Page, type TestInfo } from '@playwright/test';
import {
	readFixtureState,
	type FixtureState,
	type FixtureStateAvailable,
} from '../fixtures/state.js';

export function loadFixtureState(): FixtureState {
	return readFixtureState();
}

/**
 * Returns the multiaddr if Tier 2 is available; otherwise skips the calling
 * test. Tests in distributed/* call this in a `test.beforeAll` so the skip
 * shows up clearly per spec.
 */
export function requireFixture(state: FixtureState, testInfo: TestInfo): FixtureStateAvailable {
	if (!state.available) {
		testInfo.skip(true, `Tier 2 fixture unavailable: ${state.reason}`);
		// Unreachable — testInfo.skip throws — but the type narrowing helps callers.
		throw new Error('unreachable');
	}
	return state;
}

export function extractPeerIdFromMultiaddr(multiaddr: string): string {
	const match = multiaddr.match(/\/p2p\/([A-Za-z0-9]+)/);
	if (!match) throw new Error(`no /p2p/ component in multiaddr: ${multiaddr}`);
	return match[1];
}

/**
 * All bootstrap multiaddrs from the fixture — the primary multiaddr plus any
 * service-peer addresses spawned alongside it. Browsers paste the full
 * newline-separated list into the bootstrap textarea so libp2p dials all
 * mesh members up front, without waiting on FRET propagation.
 */
export function collectBootstrapMultiaddrs(fixture: FixtureStateAvailable): string[] {
	const extras = fixture.serviceMultiaddrs ?? [];
	return [fixture.multiaddr, ...extras];
}

/**
 * If `OPTIMYSTIC_E2E_DEBUG=1`, enable `localStorage.debug` so optimystic /
 * libp2p emit console traces — useful for inspecting quorum / dial paths
 * via Playwright's trace viewer. No-op otherwise.
 */
export async function maybeEnableBrowserDebug(page: Page): Promise<void> {
	if (process.env.OPTIMYSTIC_E2E_DEBUG !== '1') return;
	await page.addInitScript(() => {
		try {
			// The optimystic logger uses the namespace `optimystic:db-p2p:*`
			// (see `optimystic/packages/db-p2p/src/logger.ts`). Capture libp2p
			// dial + circuit-relay debug too so we can see who's reachable.
			window.localStorage.setItem('debug', 'optimystic:*,libp2p:dial*,libp2p:circuit*');
		} catch {
			// localStorage may be unavailable in some test contexts; ignore.
		}
	});
	page.on('console', (msg) => {
		const text = msg.text();
		if (text.includes('optimystic:') || text.includes('libp2p:circuit') || text.includes('libp2p:dial')) {
			// Strip ANSI / %c colour controls for readable test output.
			const clean = text.replace(/%c|color: [^;]+;?/g, '').trim();
			console.log(`[browser ${msg.type()}] ${clean}`);
		}
	});
}

/**
 * Wait for the node to be `running` (solo, fresh boot), paste the bootstrap
 * multiaddr(s), click Connect, and wait for the mode badge to flip to
 * `distributed`. Used by every Tier 2 spec.
 *
 * Accepts a single multiaddr (legacy callers) or an array — the array form
 * is the path taken by the 3-node mesh fixture, where the browser dials the
 * bootstrap plus both service peers immediately.
 */
export async function connectToBootstrap(page: Page, multiaddrs: string | string[]): Promise<void> {
	const list = Array.isArray(multiaddrs) ? multiaddrs : [multiaddrs];
	if (list.length === 0) throw new Error('connectToBootstrap: no multiaddrs provided');
	const textareaValue = list.join('\n');
	await maybeEnableBrowserDebug(page);
	await page.goto('/');
	await expect(page.getByTestId('home-status')).toHaveText('running', {
		timeout: 30_000,
	});
	await page.getByTestId('bootstrap-input').fill(textareaValue);
	await page.getByTestId('btn-connect').click();
	await expect(page.getByTestId('mode-badge')).toHaveText('distributed', {
		timeout: 60_000,
	});
	await expect(page.getByTestId('home-status')).toHaveText('running', {
		timeout: 60_000,
	});
	// Wait for the libp2p bootstrap dial to actually land. The mode badge
	// flips as soon as the node restarts with bootstrap args; it does NOT
	// imply a live connection yet — bootstrap discovery + noise handshake +
	// identify can take a few seconds. Poll Diagnostics for ≥ 1 connection.
	await page.goto('/#/diag');
	await expect(page.getByTestId('diag-transports')).toBeVisible({ timeout: 30_000 });
	await expect
		.poll(
			async () => page.locator('[data-testid="diag-connection-row"]').count(),
			{ timeout: 60_000, intervals: [1000, 2000, 3000] },
		)
		.toBeGreaterThanOrEqual(1);
	// Go back to home so subsequent tests can use the network panel.
	await page.goto('/#/');
}
