import { test, expect, type Page } from '@playwright/test';

async function waitReady(page: Page) {
	await expect(page.getByTestId('home-status')).toHaveText('running', {
		timeout: 30_000,
	});
}

test.describe('Tier 1 / solo / routing', () => {
	test('nav clicks reach each route', async ({ page }) => {
		await page.goto('/');
		await waitReady(page);

		await page.getByTestId('nav-messages').click();
		await expect(page).toHaveURL(/#\/messages$/);
		await expect(page.getByRole('heading', { name: 'Messages' })).toBeVisible();

		await page.getByTestId('nav-activity').click();
		await expect(page).toHaveURL(/#\/log$/);
		await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();

		await page.getByTestId('nav-diagnostics').click();
		await expect(page).toHaveURL(/#\/diag$/);
		await expect(page.getByRole('heading', { name: 'Diagnostics' })).toBeVisible();

		await page.getByTestId('nav-home').click();
		await expect(page).toHaveURL(/#?\/?$/);
		await expect(page.getByTestId('home-status')).toBeVisible();
	});

	test('cold deep-link to #/diag renders Diagnostics directly', async ({ page }) => {
		await page.goto('/#/diag');
		await expect(page.getByRole('heading', { name: 'Diagnostics' })).toBeVisible();
	});

	test('cold deep-link to #/messages renders Messages directly', async ({ page }) => {
		await page.goto('/#/messages');
		await expect(page.getByRole('heading', { name: 'Messages' })).toBeVisible();
	});

	test('cold deep-link to #/log renders Activity directly', async ({ page }) => {
		await page.goto('/#/log');
		await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();
	});
});
