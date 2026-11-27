/**
 * The loader store: one load state machine for a cadre screen.
 *
 *   { state: 'loading' }                         nothing read yet
 *   { state: 'ready', value, error? }            read; `error` set when the LAST refresh
 *                                                failed and the value shown is the previous one
 *   { state: 'failed', error }                   the first read failed
 *
 * It reads when its first subscriber arrives, then again on each change signal it is
 * given — debounced, one read at a time, one more read if a change arrives during a
 * read — and on an optional backstop poll, for what no signal covers. It stops all of
 * that when its last subscriber leaves.
 */
import { describeThrown, type CadreError, type CadreResult } from './result.js';
import { writable, type Readable } from './store.js';

export type LoadState<T> =
	| { state: 'loading'; value?: undefined; error?: undefined; refreshing: boolean }
	| { state: 'ready'; value: T; error?: CadreError; refreshing: boolean }
	| { state: 'failed'; value?: undefined; error: CadreError; refreshing: boolean };

export interface LoaderOptions<T> {
	load: () => Promise<CadreResult<T>>;
	/** Subscribe to whatever should trigger a re-read; returns an unsubscribe. */
	changes?: (onChange: () => void) => () => void;
	/** Backstop poll, ms. */
	pollMs?: number;
	/** Coalesce a burst of change signals into one read. Default 500 ms. */
	debounceMs?: number;
}

export interface Loader<T> extends Readable<LoadState<T>> {
	/** Read now (coalesced with a read in flight). */
	reload(): void;
	/** Read now and resolve when that read has settled. */
	refresh(): Promise<void>;
}

export function loader<T>(opts: LoaderOptions<T>): Loader<T> {
	const debounceMs = opts.debounceMs ?? 500;
	let active = false;
	let inFlight: Promise<void> | null = null;
	let again = false;
	let debounce: ReturnType<typeof setTimeout> | null = null;
	let poll: ReturnType<typeof setTimeout> | null = null;
	let unsubscribeChanges: (() => void) | null = null;

	const store = writable<LoadState<T>>({ state: 'loading', refreshing: false }, () => {
		active = true;
		unsubscribeChanges = opts.changes?.(scheduleFromChange) ?? null;
		void run();
		return () => {
			active = false;
			unsubscribeChanges?.();
			unsubscribeChanges = null;
			if (debounce !== null) clearTimeout(debounce);
			if (poll !== null) clearTimeout(poll);
			debounce = poll = null;
		};
	});

	function scheduleFromChange() {
		if (!active || debounce !== null) return;
		debounce = setTimeout(() => { debounce = null; void run(); }, debounceMs);
	}

	function schedulePoll() {
		if (poll !== null) clearTimeout(poll);
		poll = null;
		if (active && opts.pollMs) poll = setTimeout(() => { poll = null; void run(); }, opts.pollMs);
	}

	function run(): Promise<void> {
		if (inFlight) { again = true; return inFlight; }
		store.update(s => (s.refreshing ? s : { ...s, refreshing: true }));
		inFlight = (async () => {
			let result: CadreResult<T>;
			try {
				result = await opts.load();
			} catch (err) {
				// Operations report failures as results; a throw is a defect, shown rather than lost.
				result = { ok: false, error: { kind: 'unexpected', retryable: false, message: describeThrown(err), cause: err } };
			}
			store.update(s => {
				if (result.ok) return { state: 'ready', value: result.value, refreshing: false };
				if (s.state === 'ready') return { state: 'ready', value: s.value, error: result.error, refreshing: false };
				return { state: 'failed', error: result.error, refreshing: false };
			});
		})().finally(() => {
			inFlight = null;
			if (again && active) { again = false; void run(); }
			else { again = false; schedulePoll(); }
		});
		return inFlight;
	}

	return {
		subscribe: store.subscribe,
		get: store.get,
		reload: () => { void run(); },
		refresh: () => run(),
	};
}
