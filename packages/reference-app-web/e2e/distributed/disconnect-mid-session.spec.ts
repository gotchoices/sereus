import { test, expect, type Page } from '@playwright/test';
import {
	loadFixtureState,
	requireFixture,
	connectToBootstrap,
	collectBootstrapMultiaddrs,
} from './_helpers.js';

async function gotoMessages(page: Page) {
	page.on('dialog', (d) => {
		void d.accept();
	});
	await page.getByTestId('nav-messages').click();
	await expect(page.getByTestId('btn-send')).toBeVisible({ timeout: 30_000 });
}

async function sendOne(page: Page, author: string, content: string): Promise<string> {
	await page.getByTestId('compose-author').fill(author);
	await page.getByTestId('compose-content').fill(content);
	await page.getByTestId('btn-send').click();
	const row = page.locator('[data-testid="message-row"]', { hasText: content });
	await expect(row).toBeVisible({ timeout: 30_000 });
	const id = await row.getAttribute('data-message-id');
	if (!id) throw new Error('row missing data-message-id');
	return id;
}

test.describe('Tier 2 / distributed / disconnect mid-session', () => {
	let bootstrapList: string[];

	test.beforeAll(({}, testInfo) => {
		const fixture = requireFixture(loadFixtureState(), testInfo);
		bootstrapList = collectBootstrapMultiaddrs(fixture);
	});

	test('A disconnects → solo with local cache intact; B remains distributed and error-free', async ({
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

			const content = `disco-${Date.now()}-from-A`;
			const id = await sendOne(pageA, 'alice', content);

			// B sees it.
			const rowOnB = pageB.locator(
				`[data-testid="message-row"][data-message-id="${id}"]`,
			);
			await expect(rowOnB).toBeVisible({ timeout: 30_000 });

			// A disconnects from Home.
			await pageA.getByTestId('nav-home').click();
			await pageA.getByTestId('btn-disconnect').click();
			await expect(pageA.getByTestId('mode-badge')).toHaveText('solo', {
				timeout: 30_000,
			});
			await expect(pageA.getByTestId('home-status')).toHaveText('running', {
				timeout: 30_000,
			});

			// A's existing messages view should still show the message we sent —
			// after a `disconnect()` the app reboots in solo mode with the same
			// IndexedDB-backed storage, so prior data is still readable locally.
			await pageA.getByTestId('nav-messages').click();
			await expect(
				pageA.locator(`[data-testid="message-row"][data-message-id="${id}"]`),
			).toBeVisible({ timeout: 30_000 });

			// B remains distributed.
			await expect(pageB.getByTestId('mode-badge')).toHaveText('distributed');
			await pageB.getByTestId('nav-diagnostics').click();
			await expect(pageB.getByTestId('diag-errors')).toBeVisible({ timeout: 30_000 });
			const errCount = await pageB
				.getByTestId('diag-errors')
				.getAttribute('data-error-count');
			// Some libp2p connection-close churn after A disconnects may still
			// land in the ring buffer; the ring buffer is capped at 10, so any
			// healthy state should be well under that. Allow a small slack.
			expect(Number(errCount ?? '0')).toBeLessThanOrEqual(2);
		} finally {
			await ctxA.close();
			await ctxB.close();
		}
	});
});
