// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { subscribeEvents } from '../src/lib/events.js';

interface FakeEventSource {
	url: string;
	onopen: ((ev: Event) => void) | null;
	onerror: ((ev: Event) => void) | null;
	listeners: Map<string, Set<(ev: MessageEvent<string>) => void>>;
	closed: boolean;
	close(): void;
	addEventListener(name: string, cb: (ev: MessageEvent<string>) => void): void;
	dispatch(name: string, data: string): void;
}

let instances: FakeEventSource[] = [];

function makeFakeCtor(): typeof EventSource {
	function Ctor(this: FakeEventSource, url: string): void {
		this.url = url;
		this.onopen = null;
		this.onerror = null;
		this.listeners = new Map();
		this.closed = false;
		this.close = function close(this: FakeEventSource) { this.closed = true; };
		this.addEventListener = function addEventListener(this: FakeEventSource, name, cb) {
			let set = this.listeners.get(name);
			if (!set) {
				set = new Set();
				this.listeners.set(name, set);
			}
			set.add(cb);
		};
		this.dispatch = function dispatch(this: FakeEventSource, name, data) {
			const set = this.listeners.get(name);
			if (!set) return;
			const ev = new MessageEvent<string>(name, { data });
			for (const cb of set) cb(ev);
		};
		instances.push(this);
	}
	return Ctor as unknown as typeof EventSource;
}

describe('subscribeEvents', () => {
	beforeEach(() => {
		instances = [];
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('opens an EventSource and forwards named events', () => {
		const Ctor = makeFakeCtor();
		const got: Array<{ type: string; data: string }> = [];
		const handle = subscribeEvents((e) => got.push(e), {
			eventSourceCtor: Ctor,
		});
		expect(instances).toHaveLength(1);
		instances[0]!.dispatch(
			'node-state-changed',
			JSON.stringify({ type: 'node-state-changed', nodeId: 'a', status: 'running' }),
		);
		expect(got).toEqual([
			{
				type: 'node-state-changed',
				data: JSON.stringify({ type: 'node-state-changed', nodeId: 'a', status: 'running' }),
			},
		]);
		handle.close();
		expect(instances[0]!.closed).toBe(true);
	});

	it('reconnects on error with the configured backoff schedule', () => {
		const Ctor = makeFakeCtor();
		const schedule = [10, 20, 40, 80, 160];
		const observed: number[] = [];
		const handle = subscribeEvents(() => undefined, {
			eventSourceCtor: Ctor,
			backoffSchedule: schedule,
			onError: (_attempt, nextDelayMs) => observed.push(nextDelayMs),
		});

		// Simulate 6 errors → 5 delays from schedule then clamp to last.
		for (let i = 0; i < 6; i++) {
			const last = instances[instances.length - 1]!;
			last.onerror?.(new Event('error'));
			vi.advanceTimersByTime(1000);
		}

		expect(observed).toEqual([10, 20, 40, 80, 160, 160]);
		// One initial + six reconnect attempts = 7 EventSource instances.
		expect(instances).toHaveLength(7);

		handle.close();
	});

	it('resets the attempt counter after a successful open', () => {
		const Ctor = makeFakeCtor();
		const schedule = [10, 20, 40];
		const observed: number[] = [];
		const handle = subscribeEvents(() => undefined, {
			eventSourceCtor: Ctor,
			backoffSchedule: schedule,
			onError: (_a, nextDelayMs) => observed.push(nextDelayMs),
		});

		instances[0]!.onerror?.(new Event('error'));
		vi.advanceTimersByTime(10);
		instances[1]!.onerror?.(new Event('error'));
		vi.advanceTimersByTime(20);
		// Now an open succeeds before the next error.
		instances[2]!.onopen?.(new Event('open'));
		instances[2]!.onerror?.(new Event('error'));
		vi.advanceTimersByTime(10);

		expect(observed).toEqual([10, 20, 10]);
		handle.close();
	});

	it('stops attempts after close()', () => {
		const Ctor = makeFakeCtor();
		const handle = subscribeEvents(() => undefined, {
			eventSourceCtor: Ctor,
			backoffSchedule: [10],
		});
		handle.close();
		instances[0]!.onerror?.(new Event('error'));
		vi.advanceTimersByTime(100);
		expect(instances).toHaveLength(1);
	});
});
