import { test, expect } from '@playwright/test';

test.describe('Tier 1 / solo / diagnostics surface', () => {
	test('transports, identity, crypto sanity, and recent errors look healthy after clean boot', async ({
		page,
	}) => {
		await page.goto('/#/diag');
		// Wait for the diagnostics tick to populate.
		await expect(page.getByTestId('diag-transports')).toBeVisible({ timeout: 30_000 });

		// Transports — the four-name browser bundle. Order-tolerant. The libp2p
		// package names changed at some point: older docs show
		// `WebSockets, circuit-relay-v2`, current builds emit
		// `@libp2p/websockets, @libp2p/circuit-relay-v2-transport`. Either
		// shape is accepted. The WebRTC ticket added `@libp2p/webrtc` and
		// `@libp2p/webrtc-direct` to the transports array (registered in solo as
		// well as distributed — only `listenAddrs` is mode-gated), so the healthy
		// bundle now carries four transports. What matters is that all four are
		// present and no TCP transport leaked into the browser bundle.
		const transportNames = await page
			.locator('[data-testid="diag-transports"] li')
			.evaluateAll((nodes) =>
				nodes.map((n) => ((n as HTMLElement).dataset.transportName ?? '').trim()),
			);
		expect(transportNames).toHaveLength(4);
		expect(
			transportNames.some((n) => /websockets/i.test(n)),
			`expected a websockets transport in ${JSON.stringify(transportNames)}`,
		).toBe(true);
		expect(
			transportNames.some((n) => /circuit[- ]?relay/i.test(n)),
			`expected a circuit-relay transport in ${JSON.stringify(transportNames)}`,
		).toBe(true);
		expect(
			transportNames.some((n) => /webrtc(?!-direct)/i.test(n)),
			`expected a webrtc transport in ${JSON.stringify(transportNames)}`,
		).toBe(true);
		expect(
			transportNames.some((n) => /webrtc-direct/i.test(n)),
			`expected a webrtc-direct transport in ${JSON.stringify(transportNames)}`,
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

		// Storage backend should be the stable, minification-safe label (the
		// control network's IndexedDBRawStorage).
		await expect(page.getByTestId('diag-storage-backend')).toHaveText(
			'IndexedDBRawStorage',
		);

		// Cadre surface — control network connected and the signed chat strand
		// reaches `active` on a solo node (no peers).
		await expect(page.getByTestId('diag-control-connected')).toHaveText(
			'connected ✓',
			{ timeout: 30_000 },
		);
		await expect(page.getByTestId('diag-strand-status')).toHaveText('active', {
			timeout: 30_000,
		});
		// Solo owner self-genesis must succeed (genesis on a fresh party,
		// existing on a warm reload) — never 'error'.
		await expect(page.getByTestId('diag-owner')).toHaveText(/genesis|existing/, {
			timeout: 30_000,
		});

		// Relay posture. No relay is configured in this suite, so the reservation
		// driver must take the empty-addrs path and report `none` — never `dialing`
		// (a drive that never started) and never `error` (a timeout nobody asked
		// for). Now sourced live from cadre-core, so it must also STAY `none` across
		// subsequent diagnostics ticks rather than drifting.
		await expect(page.getByTestId('diag-relay-status')).toHaveText('none', {
			timeout: 30_000,
		});

		// Recent errors list — after a clean boot we expect zero entries.
		const errCount = await page.getByTestId('diag-errors').getAttribute('data-error-count');
		expect(errCount).toBe('0');
	});
});
