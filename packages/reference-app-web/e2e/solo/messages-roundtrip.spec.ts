import { test, expect, type Page } from '@playwright/test';

/**
 * Chat strand round-trip. The chat sApp (Member + Message) is append-only — the
 * old edit/delete CRUD belonged to the `@optimystic/demo` MessageApp, which the
 * cadre strand replaced. This spec covers register-member-on-first-send →
 * insert message → it renders in the list.
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
	return row;
}

test.describe('Tier 1 / solo / chat strand round-trip', () => {
	test('send a message and see it in the list with its author', async ({ page }) => {
		await gotoMessages(page);

		const tag = `solo-${Date.now()}`;
		const row = await sendOne(page, 'alice', tag + '-hello');

		// The row carries the integer Message.Id and shows the member name + body.
		const id = await row.getAttribute('data-message-id');
		expect(id, 'message row should carry data-message-id').toBeTruthy();
		await expect(row.getByTestId('message-body')).toHaveText(tag + '-hello');
		await expect(row).toContainText('alice');
	});

	test('multiple messages keep ascending order', async ({ page }) => {
		await gotoMessages(page);

		const tag = `order-${Date.now()}`;
		const contents = [tag + '-1', tag + '-2', tag + '-3'];
		for (const c of contents) {
			await sendOne(page, 'bob', c);
		}

		const ids = await page
			.locator('[data-testid="message-row"]')
			.evaluateAll((nodes) =>
				nodes.map((n) => Number((n as HTMLElement).dataset.messageId)),
			);
		const sorted = [...ids].sort((a, b) => a - b);
		expect(ids).toEqual(sorted);
	});
});
