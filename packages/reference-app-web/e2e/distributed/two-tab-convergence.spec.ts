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

test.describe('Tier 2 / distributed / two-tab convergence (README acceptance)', () => {
	let bootstrapList: string[];

	test.beforeAll(({}, testInfo) => {
		const fixture = requireFixture(loadFixtureState(), testInfo);
		bootstrapList = collectBootstrapMultiaddrs(fixture);
	});

	test('A sends, B sees; B edits, A sees; A deletes, B sees', async ({ browser }) => {
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const pageA = await ctxA.newPage();
		const pageB = await ctxB.newPage();

		try {
			await connectToBootstrap(pageA, bootstrapList);
			await connectToBootstrap(pageB, bootstrapList);
			await gotoMessages(pageA);
			await gotoMessages(pageB);

			const tag = `conv-${Date.now()}`;
			const contentA = tag + '-from-A';

			const id = await sendOne(pageA, 'alice', contentA);

			// B should converge via the 4s poll within a few cycles.
			const rowOnB = pageB.locator(
				`[data-testid="message-row"][data-message-id="${id}"]`,
			);
			await expect(rowOnB).toBeVisible({ timeout: 20_000 });
			await expect(rowOnB.getByTestId('message-body')).toHaveText(contentA);

			// B edits, A sees.
			const editedByB = contentA + ' [edited-by-B]';
			await rowOnB.getByTestId('btn-edit').click();
			await rowOnB.getByTestId('edit-input').fill(editedByB);
			await rowOnB.getByTestId('btn-save').click();

			const rowOnA = pageA.locator(
				`[data-testid="message-row"][data-message-id="${id}"]`,
			);
			await expect(rowOnA.getByTestId('message-body')).toHaveText(editedByB, {
				timeout: 20_000,
			});

			// A deletes, B sees the row disappear.
			await rowOnA.getByTestId('btn-delete').click();
			await expect(rowOnB).toHaveCount(0, { timeout: 20_000 });
		} finally {
			await ctxA.close();
			await ctxB.close();
		}
	});
});
