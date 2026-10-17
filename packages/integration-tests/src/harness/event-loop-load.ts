/**
 * A busy event loop, for the phone-shaped arms: a phone whose JS thread is mostly occupied (a
 * Galaxy S7 profiled at 70% busy while serving a joiner). Process-wide, like `ws-latency.ts`, so
 * it slows every node in the test process and the relay alike.
 */

/** Keep the event loop busy `fraction` of every 100 ms until the returned stop is called. */
export function occupyEventLoop(fraction: number): () => void {
	const busyMs = Math.round(fraction * 100);
	const timer = setInterval(() => {
		const until = Date.now() + busyMs;
		while (Date.now() < until) { /* a phone's JS thread, busy elsewhere */ }
	}, 100);
	return () => clearInterval(timer);
}
