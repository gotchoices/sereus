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

		// The cadre control network has a party id and a connected control node.
		const partyId = (await page.getByTestId('home-party-id').textContent())?.trim();
		expect(partyId, 'home-party-id should be set once the cadre is up').toBeTruthy();
		expect(partyId).not.toBe('—');
		await expect(page.getByTestId('home-control')).toHaveText('connected');
		// The signed open chat strand reaches `active` on a solo node (no peers).
		await expect(page.getByTestId('home-strand-status')).toContainText('active', {
			timeout: 30_000,
		});
	});

	test('peer ID and party ID persist across reload in the same context', async ({ page }) => {
		await page.goto('/');
		await expect(page.getByTestId('home-status')).toHaveText('running', {
			timeout: 30_000,
		});
		const peerBefore = (await page.getByTestId('home-peer-id').textContent())?.trim();
		const partyBefore = (await page.getByTestId('home-party-id').textContent())?.trim();
		expect(peerBefore).toBeTruthy();
		expect(partyBefore).toBeTruthy();

		await page.reload();
		await expect(page.getByTestId('home-status')).toHaveText('running', {
			timeout: 30_000,
		});
		const peerAfter = (await page.getByTestId('home-peer-id').textContent())?.trim();
		const partyAfter = (await page.getByTestId('home-party-id').textContent())?.trim();
		expect(peerAfter, 'peer id should persist across reload').toBe(peerBefore);
		expect(partyAfter, 'party id should persist across reload').toBe(partyBefore);
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
