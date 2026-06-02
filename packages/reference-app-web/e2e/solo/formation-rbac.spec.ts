import { test, expect } from '@playwright/test';

/**
 * Tier 1 / solo — strand-formation surface + the `CadreControl` authorization
 * gates ("RBAC"), exercised without a second party.
 *
 * What a SOLO tab can prove deterministically:
 *  - the formation panel is wired (create + join controls present);
 *  - the dialability guard: creating an invitation with no relay reservation is
 *    rejected with a clear error rather than silently failing;
 *  - the invalid-invitation guard: a malformed paste is rejected on join;
 *  - the authority gate: an unauthorized control write is rejected by the
 *    `CadreControl` constraints (the RBAC demonstration);
 *  - the diagnostics authorization surface reflects the genesis authority key and
 *    that no formation invites/usage exist yet.
 *
 * The happy-path two-party formation + cross-cohort convergence is **Tier 2**:
 * it needs a circuit-relay reservation + a second dialable cadre, and is deferred
 * (see `e2e/global-setup.ts` and the README).
 */

test.describe('Tier 1 / solo / formation + RBAC', () => {
	test('formation panel renders and the dialability guard fires without a relay', async ({
		page,
	}) => {
		await page.goto('/');
		await expect(page.getByTestId('home-status')).toHaveText('running', { timeout: 30_000 });

		// Solo e2e configures no relay, so the tab is not dialable.
		await expect(page.getByTestId('home-relay')).toContainText('none');
		await expect(page.getByTestId('formation-relay-warning')).toBeVisible();

		// Both formation controls are present (responder + initiator).
		await expect(page.getByTestId('btn-create-invitation')).toBeVisible();
		await expect(page.getByTestId('btn-join')).toBeVisible();

		// Creating an invitation needs a reservation → clear, surfaced error.
		await page.getByTestId('btn-create-invitation').click();
		await expect(page.getByTestId('formation-create-error')).toContainText('not dialable', {
			timeout: 15_000,
		});
	});

	test('a malformed invitation is rejected on join', async ({ page }) => {
		await page.goto('/');
		await expect(page.getByTestId('home-status')).toHaveText('running', { timeout: 30_000 });

		await page.getByTestId('invitation-in').fill('!!!not-a-valid-invitation!!!');
		await page.getByTestId('btn-join').click();
		await expect(page.getByTestId('formation-join-error')).toBeVisible({ timeout: 15_000 });
	});

	test('the authority gate rejects an unauthorized control write', async ({ page }) => {
		await page.goto('/#/diag');
		// The cadre boots on any route; wait for the genesis authority to appear.
		await expect(page.getByTestId('diag-authority-keys')).toHaveText(/[1-9]/, {
			timeout: 30_000,
		});

		await page.getByTestId('diag-verify-gate').click();
		await expect(page.getByTestId('diag-gate-result')).toContainText('rejected', {
			timeout: 15_000,
		});
	});

	test('the authorization surface reflects genesis authority and no formation rows', async ({
		page,
	}) => {
		await page.goto('/#/diag');
		await expect(page.getByTestId('diag-authority-keys')).toHaveText(/[1-9]/, {
			timeout: 30_000,
		});

		// A solo node has minted no invitations and consumed none.
		await expect(page.getByTestId('diag-formation-invites')).toHaveAttribute('data-count', '0');
		await expect(page.getByTestId('diag-formation-usage')).toHaveAttribute('data-count', '0');

		// `addStrand` launches the strand instance but inserts no control-DB Strand
		// row on a solo node, so the control authorization view shows none.
		await expect(page.getByTestId('diag-control-strands')).toHaveAttribute('data-count', '0');
	});
});
