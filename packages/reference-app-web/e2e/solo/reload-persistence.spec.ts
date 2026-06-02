import { test, expect, type Page } from '@playwright/test';

/**
 * Strand DML persistence. On a solo node the chat strand runs in `bootstrap`
 * mode, so writes land on the strand's IndexedDB-backed local transactor. A
 * reload re-opens the same `sereus-strand-<id>` database and the strand
 * re-hydrates its catalog, so messages must survive.
 */

async function gotoMessages(page: Page) {
	await page.goto('/#/messages');
	await expect(page.getByTestId('btn-send')).toBeVisible({ timeout: 30_000 });
}

async function sendOne(page: Page, author: string, content: string) {
	await page.getByTestId('compose-author').fill(author);
	await page.getByTestId('compose-content').fill(content);
	await page.getByTestId('btn-send').click();
	const row = page.locator('[data-testid="message-row"]', { hasText: content });
	await expect(row).toBeVisible({ timeout: 15_000 });
}

test.describe('Tier 1 / solo / reload persistence', () => {
	test('messages survive a reload', async ({ page }) => {
		await gotoMessages(page);

		const tag = `persist-${Date.now()}`;
		const contents = [tag + '-first', tag + '-second'];
		for (const c of contents) {
			await sendOne(page, 'bob', c);
		}

		await page.reload();
		await expect(page.getByTestId('btn-send')).toBeVisible({ timeout: 30_000 });
		for (const c of contents) {
			await expect(
				page.locator('[data-testid="message-row"]', { hasText: c }),
			).toBeVisible({ timeout: 30_000 });
		}
	});
});
