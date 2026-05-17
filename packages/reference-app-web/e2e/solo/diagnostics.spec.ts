import { test, expect } from '@playwright/test';

test.describe('Tier 1 / solo / diagnostics surface', () => {
	test('transports, identity, crypto sanity, and recent errors look healthy after clean boot', async ({
		page,
	}) => {
		await page.goto('/#/diag');
		// Wait for the diagnostics tick to populate.
		await expect(page.getByTestId('diag-transports')).toBeVisible({ timeout: 30_000 });

		// Transports — must be exactly the two-name browser bundle. Order-tolerant.
		// The libp2p package names changed at some point: older docs show
		// `WebSockets, circuit-relay-v2`, current builds emit
		// `@libp2p/websockets, @libp2p/circuit-relay-v2-transport`. Either
		// shape is accepted; what matters is that there are exactly two and
		// no TCP transport leaked into the browser bundle.
		const transportNames = await page
			.locator('[data-testid="diag-transports"] li')
			.evaluateAll((nodes) =>
				nodes.map((n) => ((n as HTMLElement).dataset.transportName ?? '').trim()),
			);
		expect(transportNames).toHaveLength(2);
		expect(
			transportNames.some((n) => /websockets/i.test(n)),
			`expected a websockets transport in ${JSON.stringify(transportNames)}`,
		).toBe(true);
		expect(
			transportNames.some((n) => /circuit[- ]?relay/i.test(n)),
			`expected a circuit-relay transport in ${JSON.stringify(transportNames)}`,
		).toBe(true);
		expect(
			transportNames.some((n) => /(^|[^a-z])tcp([^a-z]|$)/i.test(n)),
			`TCP transport must not be present in browser bundle: ${JSON.stringify(transportNames)}`,
		).toBe(false);

		// Identity persistence badge.
		await expect(page.getByTestId('diag-identity-persisted')).toHaveText(
			'persisted ✓',
			{ timeout: 30_000 },
		);

		// All seven crypto sanity checks should be true.
		await expect(page.locator('[data-testid="diag-crypto"] li')).toHaveCount(7);
		const cryptoOk = await page
			.locator('[data-testid="diag-crypto"] li')
			.evaluateAll((nodes) =>
				nodes.map((n) => (n as HTMLElement).dataset.ok === 'true'),
			);
		expect(cryptoOk).toEqual([true, true, true, true, true, true, true]);

		// Storage backend should be the stable, minification-safe label.
		await expect(page.getByTestId('diag-storage-backend')).toHaveText(
			'IndexedDBRawStorage',
		);

		// Recent errors list — after a clean boot we expect zero entries.
		const errCount = await page.getByTestId('diag-errors').getAttribute('data-error-count');
		expect(errCount).toBe('0');
	});
});
