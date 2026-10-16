import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

test.describe('Tier 1 / solo / owner keys', () => {
	test('a backup key is made under a passphrase, shown once, downloaded, listed, then removed', async ({ page }) => {
		await page.goto('/#/cadre');
		const card = page.getByTestId('owner-keys');
		const rows = card.getByTestId('owner-key-row');
		// The founding key the tab's owner genesis seated, under the tab's label.
		await expect(rows).toHaveCount(1, { timeout: 30_000 });
		await expect(rows.first()).toContainText('browser');
		await expect(rows.first()).toContainText('This tab');

		await card.getByTestId('btn-make-backup-key').click();
		await card.getByTestId('owner-key-label-in').fill('paper backup');
		await card.getByTestId('owner-key-passphrase-in').fill('correct horse');
		await card.getByTestId('owner-key-passphrase-again-in').fill('correct horse');
		await card.getByTestId('btn-submit-owner-key-export').click();

		const shown = card.getByTestId('owner-key-export');
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

		const backup = rows.filter({ hasText: 'paper backup' });
		await expect(backup).toHaveCount(1);
		await backup.getByTestId('btn-remove-owner-key').click();
		const confirm = card.getByTestId('remove-owner-key-confirm');
		await expect(confirm).toContainText('Remove owner key paper backup');
		await confirm.getByTestId('btn-confirm-remove-owner-key').click();
		await expect(backup).toHaveCount(0);
		await expect(rows).toHaveCount(1);
	});
});
