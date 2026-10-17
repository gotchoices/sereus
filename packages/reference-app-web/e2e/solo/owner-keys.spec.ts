import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

test.describe('Tier 1 / solo / owner keys', () => {
	test('this tab\'s key is exported under a passphrase, shown once and downloaded', async ({ page }) => {
		await page.goto('/#/cadre');
		const card = page.getByTestId('owner-keys');
		const rows = card.getByTestId('owner-key-row');
		// The founding key the tab's owner genesis seated, under the tab's label.
		await expect(rows).toHaveCount(1, { timeout: 30_000 });
		await expect(rows.first()).toContainText('browser');
		await expect(rows.first()).toContainText('This tab');

		await card.getByTestId('btn-export-own-key').click();
		await expect(card.getByTestId('owner-key-label-in')).toHaveValue('browser');
		await card.getByTestId('owner-key-passphrase-in').fill('correct horse');
		await card.getByTestId('owner-key-passphrase-again-in').fill('correct horse');
		await card.getByTestId('btn-submit-owner-key-export').click();

		const shown = card.getByTestId('owner-key-export');
		await expect(shown).toContainText('Owner key browser (');
		await expect(shown).toContainText('Anyone who has this can control your cadre.');
		await expect(shown.getByTestId('qr-code')).toBeVisible();
		const text = (await shown.getByTestId('owner-key-export-text').locator('code').textContent())?.trim() ?? '';
		expect(text.startsWith('sereus-owner-key-locked:1.')).toBe(true);

		const downloading = page.waitForEvent('download');
		await shown.getByTestId('btn-download-owner-key').click();
		const download = await downloading;
		expect(download.suggestedFilename()).toMatch(/^sereus-owner-key-[\w-]{8}\.txt$/);
		expect((await readFile(await download.path(), 'utf8')).trim()).toBe(text);

		await shown.getByTestId('btn-owner-key-export-done').click();
		await expect(shown).toHaveCount(0);
	});
});
