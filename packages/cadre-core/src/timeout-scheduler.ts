/**
 * The timer seam shared by the strand bring-up loops that re-arm themselves one step at a
 * time — the first-sync write gate's probe loop (`strand-first-sync-gate.ts`) and the
 * membership reconciler's retry ladder (`strand-membership-reconciler.ts`). `setTimeout`
 * rather than a repeating interval because the next step is armed only once the previous
 * one settles, so a slow network read never stacks steps behind it, and because the delay
 * can differ per step.
 *
 * Tests inject a hand-cranked clock; production omits it and gets real timers, `unref`'d so
 * a loop that is only waiting never holds a Node process open (the call is optional —
 * browsers and React Native return a plain handle with no `unref`).
 */

/** Timer seam for a self-rescheduling loop; omit for real (unref'd) timeouts. */
export interface TimeoutScheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Real timers, `unref`'d where the runtime supports it. */
export const defaultTimeoutScheduler: TimeoutScheduler = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0])
};
