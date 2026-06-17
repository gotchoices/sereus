import { test, expect, type Page } from '@playwright/test';
import { readFixtureState } from '../fixtures/state.js';
import {
	startFormationResponder,
	type FormationResponderHandle,
} from '../fixtures/formation-responder.js';

/**
 * Tier 2 — live formation→convergence.
 *
 * The capstone two-party test. A real in-process cadre **responder**
 * (`formation-responder.ts`) is the dialable second party; the browser tab is the
 * **initiator** (it only dials out, so it needs no relay). The browser redeems an
 * out-of-band `OpenInvitation` through the UI, forms a **closed** strand, wires the
 * strand cohort link by hand (control-network strand discovery is still TODO), and
 * then a message the responder writes converges to the browser through the cohort.
 *
 * Process model: Playwright runs `global-setup` in the main runner process and this
 * spec in a worker child process; they do NOT share `globalThis`/memory. So the
 * responder boots HERE (`beforeAll`, the worker) — only then are its live methods
 * (`readFormationUsage`/`readStrandMessages`/`seedMessage`, all reading in-memory
 * node state) reachable from the assertions. `global-setup` only writes the coarse
 * availability gate; this `beforeAll` does the real fail-soft (skip on boot failure).
 *
 * The valid invitation is **single-use**, so exactly one test may redeem it — the
 * happy path. The reverse (bidirectional) check therefore rides the happy path's
 * already-connected cohort rather than redeeming a second time. The expired-token
 * test redeems a distinct, deliberately-expired invitation.
 */

/** The `__cadre` debug hook surface this spec drives (see src/lib/cadre-web.ts). */
interface CadreHooks {
	getFormedStrands(): Array<{ strandId: string; memberKey: string; type: 'o' | 'c' }>;
	dialStrandPeer(strandId: string, addr: string): Promise<void>;
	getStrandConnectionCount(strandId: string): number;
	readChatMessages(strandId: string): Promise<Array<{ id: string; memberId: string; content: string }>>;
	writeChatMessage(strandId: string, message: { memberName: string; content: string }): Promise<string>;
}

type FormedStrandInfo = { strandId: string; memberKey: string; type: 'o' | 'c' };
type ChatRow = { id: string; memberId: string; content: string };

// `page.evaluate` callbacks run in the BROWSER, so each must resolve `window.__cadre`
// inline (it cannot close over a Node-side helper). These thin Node wrappers keep that
// repetition in one place per hook.

async function formedStrands(page: Page): Promise<FormedStrandInfo[]> {
	return page.evaluate(() => {
		const hooks = (window as unknown as { __cadre?: CadreHooks }).__cadre;
		return hooks ? hooks.getFormedStrands() : [];
	});
}

async function dialStrandPeer(page: Page, strandId: string, addr: string): Promise<void> {
	await page.evaluate(async ([sid, a]) => {
		const hooks = (window as unknown as { __cadre?: CadreHooks }).__cadre;
		if (!hooks) throw new Error('__cadre hook not present on window');
		await hooks.dialStrandPeer(sid, a);
	}, [strandId, addr] as const);
}

async function strandConnectionCount(page: Page, strandId: string): Promise<number> {
	return page.evaluate((sid) => {
		const hooks = (window as unknown as { __cadre?: CadreHooks }).__cadre;
		if (!hooks) throw new Error('__cadre hook not present on window');
		return hooks.getStrandConnectionCount(sid);
	}, strandId);
}

async function readChatMessages(page: Page, strandId: string): Promise<ChatRow[]> {
	return page.evaluate(async (sid) => {
		const hooks = (window as unknown as { __cadre?: CadreHooks }).__cadre;
		if (!hooks) throw new Error('__cadre hook not present on window');
		return hooks.readChatMessages(sid);
	}, strandId);
}

async function writeChatMessage(
	page: Page,
	strandId: string,
	message: { memberName: string; content: string },
): Promise<void> {
	await page.evaluate(async ([sid, m]) => {
		const hooks = (window as unknown as { __cadre?: CadreHooks }).__cadre;
		if (!hooks) throw new Error('__cadre hook not present on window');
		await hooks.writeChatMessage(sid, m);
	}, [strandId, message] as const);
}

let responder: FormationResponderHandle | undefined;
let skipReason: string | undefined;

function requireResponder(): FormationResponderHandle {
	if (!responder) throw new Error('formation responder not booted');
	return responder;
}

/** Bring the browser cadre node up and navigate to Home, ready to redeem an invite. */
async function bootBrowserNode(page: Page): Promise<void> {
	await page.goto('/');
	await expect(page.getByTestId('home-status')).toHaveText('running', { timeout: 60_000 });
}

test.describe('Tier 2 / formation → convergence', () => {
	test.beforeAll(async () => {
		const state = readFixtureState();
		if (!state.available) {
			skipReason = `formation fixture unavailable: ${state.reason}`;
			return;
		}
		try {
			responder = await startFormationResponder();
		} catch (err) {
			// Fail-soft: a responder that cannot boot skips the tier rather than erroring
			// the whole run (mirrors the retired tier's behaviour, now in-worker).
			skipReason = `formation responder failed to boot: ${err instanceof Error ? err.message : String(err)}`;
		}
	});

	test.afterAll(async () => {
		await responder?.stop();
		responder = undefined;
	});

	test.beforeEach(() => {
		test.skip(Boolean(skipReason), skipReason ?? 'formation tier unavailable');
	});

	test('happy path: a redeemed invitation forms a closed strand and the responder seed converges to the browser', async ({ page }) => {
		// Formation + cohort connect + quorum commit over loopback WS take several
		// seconds each; widen the 60s default per-test budget for this spec.
		test.setTimeout(180_000);
		const r = requireResponder();

		// Baseline consent rows — the post-redemption assertion is order-independent
		// against this (the tier shares one responder across tests).
		const usageBefore = await r.readFormationUsage();

		// 1. Boot the browser cadre node (the initiator — no relay).
		await bootBrowserNode(page);

		// 2. Redeem the valid invitation through the UI; wait for the formed strand.
		await page.getByTestId('invitation-in').fill(r.encoded);
		await page.getByTestId('btn-join').click();
		await expect(page.getByTestId('formation-joined')).toBeVisible({ timeout: 60_000 });

		await expect
			.poll(async () => (await formedStrands(page)).length, {
				timeout: 30_000,
				intervals: [500, 1000, 2000],
			})
			.toBeGreaterThanOrEqual(1);

		const strands = await formedStrands(page);
		const formed = strands.find((s) => s.strandId === r.strandId) ?? strands[0];
		// The browser's formed strand IS the responder's host strand (the invite binds
		// to it; provision-then-record returns its id from formStrand).
		expect(formed.strandId).toBe(r.strandId);
		// Closed-strand membership (light / documented): the formed strand is closed
		// (`type:'c'`) and carries the minted member key. The deeper "a read is
		// unauthorized WITHOUT the minted member key" assertion depends on the schema's
		// "member key only if closed" CHECK, still a TODO (control-schema.ts:56, parked
		// in the backlog ticket `control-strand-closed-member-key-constraint`); this
		// tier asserts only at the membership-metadata level.
		expect(formed.type).toBe('c');
		expect(formed.memberKey).toBeTruthy();
		const strandId = formed.strandId;

		// 3. Wire the strand cohort link (control-network strand discovery is TODO) and
		//    wait for the connection — connect MUST land before the seed can replicate
		//    (a 2-member cohort commit needs a super-majority of 2). `strandMultiaddrs`
		//    is the responder's STRAND addr, distinct from the control addr in `encoded`.
		await dialStrandPeer(page, strandId, r.strandMultiaddrs[0]);
		await expect
			.poll(async () => strandConnectionCount(page, strandId), {
				timeout: 60_000,
				intervals: [500, 1000, 2000, 3000],
			})
			.toBeGreaterThanOrEqual(1);

		// 4. Responder seeds its known message (deterministic; needs the cohort up);
		//    poll the browser until that message replicates in. This is the cross-cohort
		//    convergence assertion: a write on the responder reached the browser through
		//    the strand cohort.
		const seed = await r.seedMessage();
		await expect
			.poll(
				async () => {
					const rows = await readChatMessages(page, strandId);
					return rows.some((row) => row.content === seed.content);
				},
				{ timeout: 60_000, intervals: [1000, 2000, 3000] },
			)
			.toBe(true);

		// 5. The responder recorded consent: at least one FormationUsage row, bound to
		//    the host strand id, was added by the redemption.
		const usageAfter = await r.readFormationUsage();
		expect(usageAfter.length).toBeGreaterThan(usageBefore.length);
		expect(usageAfter.some((u) => u.strandId === r.strandId)).toBe(true);

		// Bidirectional (best-effort). Rides the already-connected cohort (the valid
		// invite is single-use, so a separate test cannot re-redeem). This reverse path
		// is the most likely flaky point inside the per-test window; if it proves flaky
		// it should be downgraded to `test.fixme`. Over loopback with a connected
		// 2-member cohort it exercises the same commit path the forward step proved.
		const browserMessageContent = `browser-${seed.id.slice(0, 8)}`;
		await writeChatMessage(page, strandId, { memberName: 'initiator', content: browserMessageContent });
		await expect
			.poll(
				async () => {
					const rows = await r.readStrandMessages();
					return rows.some((row) => row.content === browserMessageContent);
				},
				{ timeout: 30_000, intervals: [1000, 2000, 3000] },
			)
			.toBe(true);
	});

	test('an expired invitation is rejected: no formed strand and no consent recorded', async ({ page }) => {
		const r = requireResponder();

		// Capture consent rows up front so the "no new row" assertion is order-independent.
		const usageBefore = await r.readFormationUsage();

		await bootBrowserNode(page);

		// Redeem the deliberately-expired invitation. It is well-formed (a real
		// FormationInvite row, decodes cleanly) but past expiry — this exercises the
		// live expiry branch, NOT the malformed-paste decode case (covered by the solo
		// formation-rbac spec).
		await page.getByTestId('invitation-in').fill(r.expiredEncoded);
		await page.getByTestId('btn-join').click();

		await expect(page.getByTestId('formation-join-error')).toBeVisible({ timeout: 60_000 });

		// No formed strand was gained.
		expect((await formedStrands(page)).length).toBe(0);

		// No new consent row was recorded on the responder (a rejected redemption must
		// not consume the invite).
		const usageAfter = await r.readFormationUsage();
		expect(usageAfter.length).toBe(usageBefore.length);
	});
});
