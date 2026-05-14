import { test, expect, type Page } from '@playwright/test';
import { loadFixtureState, requireFixture, connectToBootstrap } from './_helpers.js';

async function gotoMessages(page: Page) {
	page.on('dialog', (d) => {
		void d.accept();
	});
	await page.getByTestId('nav-messages').click();
	await expect(page.getByTestId('btn-send')).toBeVisible({ timeout: 30_000 });
}

async function sendOne(page: Page, author: string, content: string): Promise<string> {
	await page.getByTestId('compose-author').fill(author);
	await page.getByTestId('compose-content').fill(content);
	await page.getByTestId('btn-send').click();
	const row = page.locator('[data-testid="message-row"]', { hasText: content });
	await expect(row).toBeVisible({ timeout: 30_000 });
	const id = await row.getAttribute('data-message-id');
	if (!id) throw new Error('row missing data-message-id');
	return id;
}

async function readMessageIds(page: Page): Promise<Set<string>> {
	const ids = await page
		.locator('[data-testid="message-row"]')
		.evaluateAll((nodes) =>
			nodes
				.map((n) => (n as HTMLElement).dataset.messageId ?? '')
				.filter((s) => s.length > 0),
		);
	return new Set(ids);
}

async function readActivityTimestamps(page: Page): Promise<number[]> {
	return page
		.locator('[data-testid="activity-row"]')
		.evaluateAll((nodes) =>
			nodes
				.map((n) => Number((n as HTMLElement).dataset.timestamp))
				.filter((n) => Number.isFinite(n)),
		);
}

test.describe('Tier 2 / distributed / cross-tab activity', () => {
	let multiaddr: string;

	test.beforeAll(({}, testInfo) => {
		const fixture = requireFixture(loadFixtureState(), testInfo);
		multiaddr = fixture.multiaddr;
	});

	test('concurrent writes converge as a set; per-side activity is newest-first', async ({ browser }) => {
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const pageA = await ctxA.newPage();
		const pageB = await ctxB.newPage();

		try {
			await connectToBootstrap(pageA, multiaddr);
			await connectToBootstrap(pageB, multiaddr);
			await gotoMessages(pageA);
			await gotoMessages(pageB);

			const tag = `xtab-${Date.now()}`;
			// Three writes from each side, fired in parallel. We serialize within
			// each page (fill+click can't truly overlap) but A and B run together.
			const writesA = (async () => {
				const ids: string[] = [];
				for (let i = 0; i < 3; i++) {
					ids.push(await sendOne(pageA, 'alice', `${tag}-A-${i}`));
				}
				return ids;
			})();
			const writesB = (async () => {
				const ids: string[] = [];
				for (let i = 0; i < 3; i++) {
					ids.push(await sendOne(pageB, 'bob', `${tag}-B-${i}`));
				}
				return ids;
			})();
			const [idsA, idsB] = await Promise.all([writesA, writesB]);
			const expected = new Set<string>([...idsA, ...idsB]);

			// Bounded poll until the message-row set on both sides equals the union.
			await expect
				.poll(async () => {
					const onA = await readMessageIds(pageA);
					return [...expected].every((id) => onA.has(id));
				}, { timeout: 30_000 })
				.toBe(true);
			await expect
				.poll(async () => {
					const onB = await readMessageIds(pageB);
					return [...expected].every((id) => onB.has(id));
				}, { timeout: 30_000 })
				.toBe(true);

			// Newest-first invariant per-side on activity diary.
			await pageA.getByTestId('nav-activity').click();
			await pageB.getByTestId('nav-activity').click();
			await expect(pageA.getByRole('heading', { name: 'Activity' })).toBeVisible();
			await expect(pageB.getByRole('heading', { name: 'Activity' })).toBeVisible();

			await expect
				.poll(async () => (await readActivityTimestamps(pageA)).length, { timeout: 30_000 })
				.toBeGreaterThanOrEqual(6);
			await expect
				.poll(async () => (await readActivityTimestamps(pageB)).length, { timeout: 30_000 })
				.toBeGreaterThanOrEqual(6);

			const tsA = await readActivityTimestamps(pageA);
			const tsB = await readActivityTimestamps(pageB);
			const sortedA = [...tsA].sort((a, b) => b - a);
			const sortedB = [...tsB].sort((a, b) => b - a);
			expect(tsA, 'A activity is newest-first').toEqual(sortedA);
			expect(tsB, 'B activity is newest-first').toEqual(sortedB);
		} finally {
			await ctxA.close();
			await ctxB.close();
		}
	});
});
