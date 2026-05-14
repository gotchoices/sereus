import { test, expect, type Page } from '@playwright/test';

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
	test('messages and activity survive a reload', async ({ page }) => {
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
			).toBeVisible({ timeout: 15_000 });
		}

		// Activity entries rehydrate too.
		await page.getByTestId('nav-activity').click();
		await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();
		for (const _c of contents) {
			// We don't know message IDs here — just assert the diary contains
			// at least one created entry per sent message.
		}
		const createdCount = await page
			.locator('[data-testid="activity-row"][data-action="created"]')
			.count();
		expect(createdCount).toBeGreaterThanOrEqual(contents.length);
	});
});
