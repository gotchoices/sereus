import { test, expect } from '@playwright/test';
import {
	loadFixtureState,
	requireFixture,
	connectToBootstrap,
	collectBootstrapMultiaddrs,
	extractPeerIdFromMultiaddr,
} from './_helpers.js';

test.describe('Tier 2 / distributed / mode flip', () => {
	let bootstrapList: string[];
	let bootstrapPeerId: string;

	test.beforeAll(({}, testInfo) => {
		const fixture = requireFixture(loadFixtureState(), testInfo);
		bootstrapList = collectBootstrapMultiaddrs(fixture);
		bootstrapPeerId = extractPeerIdFromMultiaddr(fixture.multiaddr);
	});

	test('Connect flips solo → distributed and lists the bootstrap peer', async ({ page }) => {
		await connectToBootstrap(page, bootstrapList);

		// The Diagnostics page should show at least one connection row, and at
		// least one of those rows should reference the bootstrap peer id.
		await page.getByTestId('nav-diagnostics').click();
		await expect(page.getByRole('heading', { name: 'Diagnostics' })).toBeVisible();
		await expect
			.poll(
				async () =>
					page.locator(`[data-testid="diag-connection-row"][data-peer-id="${bootstrapPeerId}"]`).count(),
				{ timeout: 30_000 },
			)
			.toBeGreaterThanOrEqual(1);
	});

	test('Disconnect snaps back to solo and empties the connection list', async ({ page }) => {
		await connectToBootstrap(page, bootstrapList);

		await page.getByTestId('btn-disconnect').click();
		await expect(page.getByTestId('mode-badge')).toHaveText('solo', {
			timeout: 30_000,
		});

		// Diagnostics should report no live connections after disconnect.
		await page.getByTestId('nav-diagnostics').click();
		await expect
			.poll(
				async () => page.locator('[data-testid="diag-connection-row"]').count(),
				{ timeout: 30_000 },
			)
			.toBe(0);
	});
});
