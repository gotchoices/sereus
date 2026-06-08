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

		// The row carries the text (UUID) Message.Id and shows the member name + body.
		const id = await row.getAttribute('data-message-id');
		expect(id, 'message row should carry data-message-id').toBeTruthy();
		await expect(row.getByTestId('message-body')).toHaveText(tag + '-hello');
		await expect(row).toContainText('alice');
	});

	test('multiple messages all render with distinct collision-free ids', async ({ page }) => {
		await gotoMessages(page);

		const tag = `order-${Date.now()}`;
		const contents = [tag + '-1', tag + '-2', tag + '-3'];
		for (const c of contents) {
			await sendOne(page, 'bob', c);
		}

		// Message.Id is now a locally-generated text UUID, so two messages can no
		// longer collide on the integer primary key — every send surfaces as its
		// own row. Ordering is by second-resolution Timestamp with the UUID as a
		// tiebreak, so strict insertion order is intentionally NOT asserted (a
		// sub-second tie resolves by UUID, not arrival order).
		for (const c of contents) {
			await expect(
				page.locator('[data-testid="message-row"]', { hasText: c }),
			).toHaveCount(1);
		}

		// Every rendered row carries a distinct, non-empty text id.
		const ids = await page
			.locator('[data-testid="message-row"]')
			.evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.messageId));
		expect(ids.every((id) => Boolean(id))).toBe(true);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
