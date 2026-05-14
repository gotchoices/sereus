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
 * Wait for the node to be `running` (solo, fresh boot), paste the bootstrap
 * multiaddr, click Connect, and wait for the mode badge to flip to
 * `distributed`. Used by every Tier 2 spec.
 */
export async function connectToBootstrap(page: Page, multiaddr: string): Promise<void> {
	await page.goto('/');
	await expect(page.getByTestId('home-status')).toHaveText('running', {
		timeout: 30_000,
	});
	await page.getByTestId('bootstrap-input').fill(multiaddr);
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
