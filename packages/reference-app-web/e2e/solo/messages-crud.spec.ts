import { test, expect, type Page } from '@playwright/test';

async function gotoMessages(page: Page) {
	// Auto-accept the delete confirm dialog used by Messages.svelte's delete flow.
	page.on('dialog', (d) => {
		void d.accept();
	});
	await page.goto('/#/messages');
	await expect(page.getByTestId('btn-send')).toBeVisible({ timeout: 30_000 });
}

async function composeMessage(page: Page, author: string, content: string) {
	await page.getByTestId('compose-author').fill(author);
	await page.getByTestId('compose-content').fill(content);
	await page.getByTestId('btn-send').click();
	const row = page.locator('[data-testid="message-row"]', { hasText: content });
	await expect(row).toBeVisible({ timeout: 15_000 });
	return row;
}

test.describe('Tier 1 / solo / messages CRUD', () => {
	test('compose → edit → delete round-trip; activity diary records each step', async ({ page }) => {
		await gotoMessages(page);

		const initialContent = 'Hello solo ' + Date.now();
		const firstRow = await composeMessage(page, 'alice', initialContent);
		const messageId = await firstRow.getAttribute('data-message-id');
		expect(messageId, 'new row should have a data-message-id').toBeTruthy();
		// Re-locate by id from here on — the row's textContent changes when we
		// enter edit mode, which would invalidate the hasText filter.
		const row = page.locator(`[data-testid="message-row"][data-message-id="${messageId}"]`);

		// Edit.
		const editedContent = initialContent + ' (edited)';
		await row.getByTestId('btn-edit').click();
		await row.getByTestId('edit-input').fill(editedContent);
		await row.getByTestId('btn-save').click();
		await expect(row.getByTestId('message-body')).toHaveText(editedContent, {
			timeout: 15_000,
		});

		// Activity diary reflects create + update.
		await page.getByTestId('nav-activity').click();
		await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();
		const activityRows = page.locator(`[data-testid="activity-row"][data-message-id="${messageId}"]`);
		await expect(activityRows).toHaveCount(2, { timeout: 15_000 });
		const actions = await activityRows.evaluateAll((nodes) =>
			nodes.map((n) => (n as HTMLElement).dataset.action),
		);
		// Render order is newest-first, so the freshest action is at index 0.
		expect(actions[0]).toBe('updated');
		expect(actions).toContain('created');

		// Newest-first invariant on the full diary so far.
		const timestamps = await page
			.locator('[data-testid="activity-row"]')
			.evaluateAll((nodes) => nodes.map((n) => Number((n as HTMLElement).dataset.timestamp)));
		const sorted = [...timestamps].sort((a, b) => b - a);
		expect(timestamps).toEqual(sorted);

		// Back to messages and delete.
		await page.getByTestId('nav-messages').click();
		const sameRow = page.locator(`[data-testid="message-row"][data-message-id="${messageId}"]`);
		await sameRow.getByTestId('btn-delete').click();
		await expect(sameRow).toHaveCount(0, { timeout: 15_000 });

		// Activity now records create + update + delete.
		await page.getByTestId('nav-activity').click();
		const activityRowsAfterDelete = page.locator(
			`[data-testid="activity-row"][data-message-id="${messageId}"]`,
		);
		await expect(activityRowsAfterDelete).toHaveCount(3, { timeout: 15_000 });
		const actionsAfter = await activityRowsAfterDelete.evaluateAll((nodes) =>
			nodes.map((n) => (n as HTMLElement).dataset.action),
		);
		expect(actionsAfter[0]).toBe('deleted');
		expect(new Set(actionsAfter)).toEqual(new Set(['created', 'updated', 'deleted']));
	});
});
