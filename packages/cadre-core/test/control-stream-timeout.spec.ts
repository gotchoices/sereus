import { describe, it, expect, vi } from 'vitest';
import { withTimeout } from '../src/control-stream.js';

/**
 * `withTimeout` is the deadline primitive the formation, wake, and strand-addr
 * protocols hang their liveness on, and the one `control-database-solo.spec.ts`
 * relies on to turn a hung control call into a *named* failure. It had no direct
 * coverage, which means a regression in it would silently downgrade every caller
 * from "fails with a label" to "hangs until some outer timeout".
 *
 * These are unit tests over fake timers — no real waiting.
 */
describe('withTimeout', () => {
	/** Advance fake timers inside a test, so the timer callback runs deterministically. */
	async function runWithFakeTimers<T>(body: (advance: (ms: number) => void) => Promise<T>): Promise<T> {
		vi.useFakeTimers();
		try {
			return await body((ms) => void vi.advanceTimersByTime(ms));
		} finally {
			vi.useRealTimers();
		}
	}

	it('passes a resolution straight through', async () => {
		await expect(withTimeout(1_000, 'op', async () => 'done')).resolves.toBe('done');
	});

	it('passes a rejection straight through, without substituting the timeout error', async () => {
		const boom = new Error('operation failed on its own');
		await expect(withTimeout(1_000, 'op', () => Promise.reject(boom))).rejects.toBe(boom);
	});

	it('rejects with a message naming the label and the budget when the op never settles', async () => {
		await runWithFakeTimers(async (advance) => {
			const pending = withTimeout(15_000, 'solo control op ensureOwnerKey() (genesis)', () => new Promise<never>(() => { }));
			const assertion = expect(pending).rejects.toThrow(
				'solo control op ensureOwnerKey() (genesis) timed out after 15000ms'
			);
			advance(15_000);
			await assertion;
		});
	});

	it('does not fire early: still pending one tick before the deadline', async () => {
		await runWithFakeTimers(async (advance) => {
			let settled = false;
			const pending = withTimeout(1_000, 'op', () => new Promise<never>(() => { }))
				.catch(() => { settled = true; });
			advance(999);
			await Promise.resolve();
			expect(settled).toBe(false);
			advance(1);
			await pending;
			expect(settled).toBe(true);
		});
	});

	it('invokes onTimeout before rejecting, so the caller can abort the in-flight dial', async () => {
		await runWithFakeTimers(async (advance) => {
			const onTimeout = vi.fn();
			const assertion = expect(
				withTimeout(1_000, 'op', () => new Promise<never>(() => { }), onTimeout)
			).rejects.toThrow('op timed out after 1000ms');
			advance(1_000);
			await assertion;
			expect(onTimeout).toHaveBeenCalledTimes(1);
		});
	});

	it('swallows a throwing onTimeout so it cannot mask the timeout error', async () => {
		await runWithFakeTimers(async (advance) => {
			const assertion = expect(
				withTimeout(1_000, 'op', () => new Promise<never>(() => { }), () => {
					throw new Error('cleanup blew up');
				})
			).rejects.toThrow('op timed out after 1000ms');
			advance(1_000);
			await assertion;
		});
	});

	it('clears its timer once settled, so a completed op leaves no pending timeout', async () => {
		await runWithFakeTimers(async (advance) => {
			await withTimeout(1_000, 'op', async () => 'done');
			// `clearTimeout` runs in the implementation's trailing `.finally`, which is a
			// microtask *behind* the caller resuming — flush before counting. The timer
			// cannot fire in that gap (it is a 1000ms macrotask), so this is ordering, not
			// a leak; assert the guarantee that matters, not the stricter same-tick one.
			await Promise.resolve();
			expect(vi.getTimerCount()).toBe(0);
			// And advancing past the budget surfaces no late rejection.
			advance(5_000);
		});
	});
});
