import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { readFixtureState } from '../fixtures/state.js';
import { startCadreMember, type CadreMemberHandle } from '../fixtures/cadre-member.js';

/**
 * Tier 2 — a tab joins a cadre as an owner with an owner grant, then makes a backup there.
 *
 * The cadre (party A) is the in-process `fixtures/cadre-member.ts` node, A's one always-on
 * machine. It mints an owner grant, and the tab, which founded a party of its own on first load,
 * pastes it under "Join my existing cadre" and joins A as a machine and an owner
 * (docs/architecture.md → "An app joins an existing cadre", "Owner grants").
 *
 * The backup is the point of the second half: an owner grant names the addresses of the cadre's
 * machines, and a solo tab without a relay has none, so a tab can make a backup only in a cadre
 * with a machine a device can dial. Here that is A's member. The tab makes a backup on the Cadre
 * page's Owner keys card, sees it shown once and downloads it, finds it under Outstanding owner
 * grants, withdraws it, and sees the list empty.
 *
 * Process model, as `join-cadre.spec.ts`: the member boots in `beforeAll` (the worker).
 */

let member: CadreMemberHandle | undefined;
let skipReason: string | undefined;

function requireMember(): CadreMemberHandle {
	if (!member) throw new Error('cadre member not booted');
	return member;
}

test.describe('Tier 2 / owner grants', () => {
	test.beforeAll(async () => {
		const state = readFixtureState();
		if (!state.available) {
			skipReason = `distributed fixture unavailable: ${state.reason}`;
			return;
		}
		try {
			member = await startCadreMember();
		} catch (err) {
			// Fail-soft, as the formation tier: a member that cannot boot skips rather than errors.
			skipReason = `cadre member failed to boot: ${err instanceof Error ? err.message : String(err)}`;
		}
	});

	test.afterAll(async () => {
		await member?.stop();
		member = undefined;
	});

	test.beforeEach(() => {
		test.skip(Boolean(skipReason), skipReason ?? 'distributed tier unavailable');
	});

	test('a tab joins as an owner with an owner grant, then makes a backup, downloads it and withdraws it', async ({ page }) => {
		// Three node starts and a redemption over loopback WebSocket, as the join spec: widen the budget.
		test.setTimeout(180_000);
		const a = requireMember();

		// 1. The tab boots into the party it founds, then joins A with A's owner grant.
		await page.goto('/');
		await expect(page.getByTestId('home-status')).toHaveText('running', { timeout: 60_000 });
		const { encoded } = await a.mintOwnerGrant({ label: 'web tab' });

		await page.goto('/#/cadre');
		await expect(page.getByTestId('cadre-invitation-in')).toBeVisible({ timeout: 60_000 });
		await page.getByTestId('cadre-invitation-in').fill(encoded);
		await page.getByTestId('btn-join-cadre').click();
		await expect(page.getByTestId('join-flow-line')).toHaveText(/now part of your cadre, as an owner/, { timeout: 90_000 });

		// 2. The Owner keys card lists the tab's key under the grant's name. The grant it joined
		//    with is used up, so nothing is outstanding.
		const card = page.getByTestId('owner-keys');
		await expect(card.getByTestId('owner-key-row').filter({ hasText: 'web tab' })).toContainText('This tab', { timeout: 60_000 });
		await expect(card.getByTestId('no-owner-grants')).toBeVisible();

		// 3. Make a backup: shown once, with its warning, QR code and text, and downloaded.
		await card.getByTestId('btn-make-backup').click();
		await card.getByTestId('owner-grant-label-in').fill('paper backup');
		await card.getByTestId('btn-submit-owner-grant').click();

		const shown = card.getByTestId('owner-grant');
		await expect(shown).toContainText('Backup "paper backup"');
		await expect(shown).toContainText('Whoever holds this can become an owner of this cadre until it is used or withdrawn.');
		await expect(shown.getByTestId('qr-code')).toBeVisible();
		const text = (await shown.getByTestId('owner-grant-text').locator('code').textContent())?.trim() ?? '';
		expect(text.startsWith('sereus-owner-grant:1.')).toBe(true);

		const downloading = page.waitForEvent('download');
		await shown.getByTestId('btn-download-owner-grant').click();
		const download = await downloading;
		expect(download.suggestedFilename()).toBe('sereus-owner-grant-paper-backup.txt');
		expect((await readFile(await download.path(), 'utf8')).trim()).toBe(text);

		await shown.getByTestId('btn-owner-grant-done').click();
		await expect(shown).toHaveCount(0);

		// 4. Listed under Outstanding owner grants until withdrawn.
		const grants = card.getByTestId('owner-grant-row');
		await expect(grants).toHaveCount(1);
		await expect(grants.first()).toContainText('paper backup');
		await expect(grants.first()).toContainText('Never expires');
		await expect(grants.first()).toContainText('1 use left');

		page.once('dialog', (dialog) => void dialog.accept());
		await grants.first().getByTestId('btn-withdraw-owner-grant').click();
		await expect(grants).toHaveCount(0);
		await expect(card.getByTestId('no-owner-grants')).toBeVisible();
	});
});
