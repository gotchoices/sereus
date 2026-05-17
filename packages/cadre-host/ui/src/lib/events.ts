/**
 * EventSource client for `/api/events` with exponential reconnect.
 *
 * The server's SSE stream sends a `retry: 5000` directive so the browser's
 * own reconnect kicks in, but we still need a layer above to:
 *   - retry indefinitely after total disconnects (browser stops after ~3 retries),
 *   - rebuild the EventSource on `error` even when the browser hasn't given up,
 *   - schedule with backoff (2s → 30s) so we don't hammer cadre-host on restart.
 *
 * Mirrors what `@microsoft/fetch-event-source` does in 20 KB — we just need
 * the basics, so it's hand-rolled.
 */

export type EventHandler = (event: { type: string; data: string }) => void;

const EVENT_TYPES = [
	'node-state-changed',
	'trust-circle-changed',
	'connectivity-changed',
	'update-available',
] as const;

const BACKOFF_SCHEDULE_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

export interface EventStreamOptions {
	/** EventSource URL. Defaults to `/api/events`. */
	url?: string;
	/** Override the backoff sequence (tests). */
	backoffSchedule?: number[];
	/** Test seam — defaults to `globalThis.EventSource`. */
	eventSourceCtor?: typeof EventSource;
	/** Called on the first successful 'open'. */
	onOpen?: () => void;
	/** Called on a transport error (every retry). */
	onError?: (attempt: number, nextDelayMs: number) => void;
}

export interface EventStreamHandle {
	close(): void;
}

/**
 * Subscribe to the SSE stream. Returns a handle whose `close()` stops all
 * reconnection attempts.
 */
export function subscribeEvents(handler: EventHandler, opts: EventStreamOptions = {}): EventStreamHandle {
	const url = opts.url ?? '/api/events';
	const ctor = opts.eventSourceCtor ?? (typeof EventSource !== 'undefined' ? EventSource : undefined);
	if (!ctor) {
		// SSR / test without EventSource — nothing to do.
		return { close() { /* noop */ } };
	}
	const schedule = opts.backoffSchedule ?? BACKOFF_SCHEDULE_MS;

	let closed = false;
	let attempt = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let source: EventSource | undefined;

	function delayFor(n: number): number {
		const idx = Math.min(n, schedule.length - 1);
		return schedule[idx] ?? schedule[schedule.length - 1]!;
	}

	function open(): void {
		if (closed) return;
		source = new ctor(url);
		const es = source;
		es.onopen = () => {
			if (closed) return;
			attempt = 0;
			opts.onOpen?.();
		};
		for (const type of EVENT_TYPES) {
			es.addEventListener(type, (ev) => {
				const messageEvent = ev as MessageEvent<string>;
				handler({ type, data: messageEvent.data ?? '' });
			});
		}
		es.onerror = () => {
			if (closed) return;
			// EventSource will retry on its own after `retry:`, but on hard
			// disconnects (server gone) it eventually gives up. Take over and
			// rebuild with our own backoff.
			try { es.close(); } catch { /* ignore */ }
			const delay = delayFor(attempt);
			opts.onError?.(attempt, delay);
			attempt += 1;
			timer = setTimeout(open, delay);
		};
	}

	open();

	return {
		close() {
			closed = true;
			if (timer) clearTimeout(timer);
			if (source) {
				try { source.close(); } catch { /* ignore */ }
			}
		},
	};
}

export const __test__ = { BACKOFF_SCHEDULE_MS, EVENT_TYPES };
