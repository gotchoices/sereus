import { test, expect } from '@playwright/test';

test.describe('Tier 1 / solo / boot', () => {
	test('node boots, mode badge reads solo, peer ID becomes available', async ({ page }) => {
		await page.goto('/');
		await expect(page.getByTestId('mode-badge')).toHaveText('solo');
		await expect(page.getByTestId('home-status')).toHaveText('running', {
			timeout: 30_000,
		});
		await expect(page.getByTestId('home-mode')).toHaveText('solo');
		const peerId = await page.getByTestId('home-peer-id').textContent();
		expect(peerId, 'home-peer-id should be set once node is running').toBeTruthy();
		expect(peerId?.trim()).not.toBe('—');
	});

	test('peer ID persists across reload in the same context', async ({ page }) => {
		await page.goto('/');
		await expect(page.getByTestId('home-status')).toHaveText('running', {
			timeout: 30_000,
		});
		const before = (await page.getByTestId('home-peer-id').textContent())?.trim();
		expect(before).toBeTruthy();

		await page.reload();
		await expect(page.getByTestId('home-status')).toHaveText('running', {
			timeout: 30_000,
		});
		const after = (await page.getByTestId('home-peer-id').textContent())?.trim();
		expect(after, 'peer id should persist across reload').toBe(before);
	});

	test('fresh browser context generates a fresh peer ID', async ({ browser }) => {
		const ctxA = await browser.newContext();
		const pageA = await ctxA.newPage();
		await pageA.goto('/');
		await expect(pageA.getByTestId('home-status')).toHaveText('running', {
			timeout: 30_000,
		});
		const peerA = (await pageA.getByTestId('home-peer-id').textContent())?.trim();
		expect(peerA).toBeTruthy();
		await ctxA.close();

		const ctxB = await browser.newContext();
		const pageB = await ctxB.newPage();
		await pageB.goto('/');
		await expect(pageB.getByTestId('home-status')).toHaveText('running', {
			timeout: 30_000,
		});
		const peerB = (await pageB.getByTestId('home-peer-id').textContent())?.trim();
		expect(peerB).toBeTruthy();
		expect(peerB, 'fresh context should produce a different peer id').not.toBe(peerA);
		await ctxB.close();
	});
});
