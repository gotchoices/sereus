import { describe, it, expect, vi } from 'vitest';
import { exchangeFrame, withDeadline, type ControlStream } from '../src/control-stream.js';
import { decodeFrames } from './wake-stream-helpers.js';

/**
 * `exchangeFrame` + `withDeadline` are the shared *sender* half of every control
 * protocol (seed delivery, push-wake, strand-addr): dial under a deadline, write
 * one frame, half-close, read one response, and reset the stream on any failure.
 * Each protocol's own spec exercises it through that protocol; these tests pin
 * the primitive itself — in particular the two leak paths that are awkward to
 * reach from a protocol spec: a deadline that fires *during* the dial, and a
 * response reader that rejects without aborting.
 */

/** A stream double that records every write, close, and reset. */
class RecordingStream implements ControlStream {
	readonly sent: Uint8Array[] = [];
	readonly aborts: Error[] = [];
	closed = false;

	send(data: Uint8Array): boolean {
		this.sent.push(data);
		return true;
	}

	async close(): Promise<void> {
		this.closed = true;
	}

	abort(err: Error): void {
		this.aborts.push(err);
	}

	[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
		// Immediate EOF: these tests drive the response through `readResponse`, not
		// through the iterator.
		return { next: async () => ({ value: undefined as unknown as Uint8Array, done: true }) };
	}
}

describe('exchangeFrame', () => {
	it('frames the request, half-closes the write end, and returns the response', async () => {
		const stream = new RecordingStream();
		const result = await exchangeFrame(
			stream,
			new AbortController().signal,
			{ hello: 'world' },
			async () => 'ack',
			'aborted',
		);

		expect(result).toBe('ack');
		expect(decodeFrames<{ hello: string }>(stream.sent)).toEqual({ hello: 'world' });
		expect(stream.closed).toBe(true);
		expect(stream.aborts).toEqual([]);
	});

	it('resets the stream when the response reader rejects', async () => {
		// `readStreamToEnd`'s size-cap path rejects WITHOUT aborting, so this is the
		// only thing standing between an oversized response and a leaked stream.
		const stream = new RecordingStream();
		const tooLarge = new Error('Seed ack message too large');

		await expect(exchangeFrame(
			stream,
			new AbortController().signal,
			{},
			() => Promise.reject(tooLarge),
			'aborted',
		)).rejects.toBe(tooLarge);
		expect(stream.aborts).toEqual([tooLarge]);
	});

	it('resets a stream that was dialed after the deadline already fired', async () => {
		// The dial won the race but the deadline had passed: without this path the
		// freshly-opened stream is never referenced again and leaks.
		const stream = new RecordingStream();
		const controller = new AbortController();
		controller.abort();
		const readResponse = vi.fn();

		await expect(exchangeFrame(stream, controller.signal, {}, readResponse, 'dial aborted by timeout'))
			.rejects.toThrow('dial aborted by timeout');
		expect(stream.aborts).toHaveLength(1);
		expect(readResponse).not.toHaveBeenCalled();
		// Nothing was written to a stream we already gave up on.
		expect(stream.sent).toEqual([]);
	});

	it('resets exactly once when the deadline fires and the read then rejects', async () => {
		// A real stream reset makes the parked read reject, so both the abort listener
		// and the catch fire for the same failure. The second reset must be a no-op.
		const stream = new RecordingStream();
		const controller = new AbortController();

		const pending = exchangeFrame(
			stream,
			controller.signal,
			{},
			(s) => new Promise<never>((_resolve, reject) => {
				// Reject only once the stream is reset, as a real read does.
				const poll = setInterval(() => {
					if ((s as RecordingStream).aborts.length > 0) {
						clearInterval(poll);
						reject(new Error('stream reset'));
					}
				}, 1);
			}),
			'aborted by timeout',
		);

		controller.abort();
		await expect(pending).rejects.toThrow('stream reset');
		expect(stream.aborts).toHaveLength(1);
		expect(stream.aborts[0]?.message).toBe('aborted by timeout');
	});

	it('stops listening to the signal once settled, so a later abort cannot reset a done stream', async () => {
		const stream = new RecordingStream();
		const controller = new AbortController();

		await exchangeFrame(stream, controller.signal, {}, async () => 'ack', 'aborted');
		controller.abort();

		expect(stream.aborts).toEqual([]);
	});
});

describe('withDeadline', () => {
	it('passes the result through with the signal un-aborted', async () => {
		let seen: AbortSignal | undefined;
		await expect(withDeadline(1_000, 'op', async (signal) => {
			seen = signal;
			return 'done';
		})).resolves.toBe('done');
		expect(seen?.aborted).toBe(false);
	});

	it('aborts the signal before rejecting, so the in-flight dial/stream is cancelled', async () => {
		vi.useFakeTimers();
		try {
			let seen: AbortSignal | undefined;
			const assertion = expect(withDeadline(1_000, 'Wake dial /ip4/1.2.3.4', (signal) => {
				seen = signal;
				return new Promise<never>(() => { });
			})).rejects.toThrow('Wake dial /ip4/1.2.3.4 timed out after 1000ms');
			vi.advanceTimersByTime(1_000);
			await assertion;
			expect(seen?.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});
