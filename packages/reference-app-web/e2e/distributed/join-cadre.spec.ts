import { test, expect, type Page } from '@playwright/test';
import { controlStorageScope } from '@serfab/cadre-core';
import { readFixtureState } from '../fixtures/state.js';
import { startCadreMember, type CadreMemberHandle } from '../fixtures/cadre-member.js';

/**
 * Tier 2 — a tab joins an existing cadre.
 *
 * The user's main cadre (party A) is an in-process headless `CadreNode`
 * (`fixtures/cadre-member.ts`): it founds A, listens on loopback WebSocket and is the one
 * always-on member the invitation names. The browser tab founds its own party (B) on first
 * load, as every tab does, and then joins A through the Cadre page's "Join my existing
 * cadre": A mints a **member** invitation targeted at the tab's peer id, the tab pastes it
 * and joins, and its one node moves from B to A (docs/architecture.md → "An app joins an
 * existing cadre"). The tab's chat strand has no control row, so B's export is empty and a
 * member invitation is allowed.
 *
 * The reload is the point. A party the tab JOINED must never run owner genesis: with the
 * saved start's `origin` ignored, every start would run `ensureOwnerKey` on A and wire the
 * tab's key as an owner, so Home would read `enrolled` instead of `member`, and
 * the tab could seat its own key as a founding `OwnerKey` row of a cadre it merely joined.
 * After the reload the tab must still be in A, still a `member`, with its key absent from A's
 * `OwnerKey` rows (`__cadre.isOwner()` false) and its start record saying `joined`.
 *
 * Admitted with nothing to move, the card goes on to remove B (architecture.md → "Dissolving the
 * party it left"): B holds no strand and no other machine, so its control block database goes
 * and the start record stops naming it as `formerPartyId`.
 *
 * Process model, as `formation-convergence.spec.ts`: the member boots in `beforeAll` (the
 * worker), `global-setup` only writes the coarse availability gate.
 */

/** The `__cadre` debug hook surface this spec drives (see src/lib/cadre-web.ts). */
interface CadreHooks {
	isOwner(): Promise<boolean>;
	/** The options the running node was started with (`EdgeNode.options`). */
	getPartyStart(): { partyId: string; origin?: 'founded' | 'joined'; formerPartyId?: string } | null;
}

async function isOwner(page: Page): Promise<boolean> {
	return page.evaluate(async () => {
		const hooks = (window as unknown as { __cadre?: CadreHooks }).__cadre;
		if (!hooks) throw new Error('__cadre hook not present on window');
		return hooks.isOwner();
	});
}

async function partyStart(page: Page): Promise<ReturnType<CadreHooks['getPartyStart']>> {
	return page.evaluate(() => {
		const hooks = (window as unknown as { __cadre?: CadreHooks }).__cadre;
		if (!hooks) throw new Error('__cadre hook not present on window');
		return hooks.getPartyStart();
	});
}

/** The names of the IndexedDB databases this page's origin holds. */
async function databaseNames(page: Page): Promise<string[]> {
	return page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name ?? ''));
}

async function homeText(page: Page, testId: string): Promise<string> {
	return ((await page.getByTestId(testId).textContent()) ?? '').trim();
}

let member: CadreMemberHandle | undefined;
let skipReason: string | undefined;

function requireMember(): CadreMemberHandle {
	if (!member) throw new Error('cadre member not booted');
	return member;
}

test.describe('Tier 2 / join an existing cadre', () => {
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

	test('a tab joins a cadre by invitation, removes the one it left, and stays a member after a reload', async ({ page }) => {
		// Four node starts, a redemption over loopback WebSocket and a reload: widen the budget.
		test.setTimeout(180_000);
		const a = requireMember();

		// 1. The tab boots into the party it founds (B) and shows its identity.
		await page.goto('/');
		await expect(page.getByTestId('home-status')).toHaveText('running', { timeout: 60_000 });
		const peerId = await homeText(page, 'home-peer-id');
		const partyB = await homeText(page, 'home-party-id');
		expect(peerId).toBeTruthy();
		expect(partyB).toBeTruthy();
		expect(partyB).not.toBe(a.partyId);
		await expect(page.getByTestId('home-owner')).toHaveText('enrolled');

		// 2. A mints a MEMBER invitation for this tab alone, as the owner's "Add a device or
		//    app" would from the tab's pasted request.
		const { encoded } = await a.mintInvitation({ peerId, grantsOwner: false });

		// 3. The tab pastes it under "Join my existing cadre" and joins; the done line shows only
		//    once B has been removed too.
		await page.goto('/#/cadre');
		await expect(page.getByTestId('cadre-invitation-in')).toBeVisible({ timeout: 60_000 });
		await page.getByTestId('cadre-invitation-in').fill(encoded);
		await page.getByTestId('btn-join-cadre').click();
		await expect(page.getByTestId('join-flow-line')).toHaveText(/now part of your cadre, as a member/, {
			timeout: 90_000,
		});

		// 4. Home shows A as the party and `member` as the owner standing; A lists the tab.
		await page.goto('/#/');
		await expect(page.getByTestId('home-status')).toHaveText('running', { timeout: 60_000 });
		await expect(page.getByTestId('home-party-id')).toHaveText(a.partyId);
		await expect(page.getByTestId('home-owner')).toHaveText('member');
		expect(await a.listMembers()).toContain(peerId);
		expect(await isOwner(page)).toBe(false);

		// 5. Reload: the saved start names A as joined, so the start wires no owner key and
		//    inserts none. `member`, not `enrolled`, is what tells the two apart.
		await page.reload();
		await expect(page.getByTestId('home-status')).toHaveText('running', { timeout: 60_000 });
		await expect(page.getByTestId('home-party-id')).toHaveText(a.partyId);
		await expect(page.getByTestId('home-owner')).toHaveText('member');
		expect(await isOwner(page)).toBe(false);
		const start = await partyStart(page);
		expect(start).toMatchObject({ partyId: a.partyId, origin: 'joined' });
		expect(start?.formerPartyId).toBeUndefined();

		// 6. B's control block database is gone; A's is not.
		const databases = await databaseNames(page);
		expect(databases).not.toContain(`sereus-strand-${controlStorageScope(partyB)}`);
		expect(databases).toContain(`sereus-strand-${controlStorageScope(a.partyId)}`);
	});
});
