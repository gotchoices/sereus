import { test, expect } from '@playwright/test';
import { loadFixtureState, requireFixture, connectToBootstrap } from './_helpers.js';

test.describe('Tier 2 / distributed / bootstrap persistence', () => {
	let multiaddr: string;

	test.beforeAll(({}, testInfo) => {
		const fixture = requireFixture(loadFixtureState(), testInfo);
		multiaddr = fixture.multiaddr;
	});

	test('bootstrap input is pre-filled with the last-used multiaddr after reload', async ({
		page,
	}) => {
		await connectToBootstrap(page, multiaddr);

		// Reload and verify the bootstrap textarea contains the previous value.
		await page.reload();
		await expect(page.getByTestId('home-status')).toHaveText('running', {
			timeout: 30_000,
		});
		// Network.svelte.hydrate() reads from IndexedDB asynchronously after the
		// node finishes booting — give it a window to populate.
		await expect
			.poll(async () => (await page.getByTestId('bootstrap-input').inputValue()).trim(), {
				timeout: 15_000,
			})
			.toBe(multiaddr);

		// Current behaviour: reload boots fresh in solo mode (Network.connect()
		// is not re-invoked automatically). Document that here so a regression
		// to either "auto-reconnect" or "input cleared" is caught.
		await expect(page.getByTestId('mode-badge')).toHaveText('solo');

		// Reconnect must succeed with the prefilled value.
		await page.getByTestId('btn-connect').click();
		await expect(page.getByTestId('mode-badge')).toHaveText('distributed', {
			timeout: 60_000,
		});
	});
});
