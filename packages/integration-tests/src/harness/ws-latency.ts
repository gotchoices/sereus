/**
 * Per-frame outbound WebSocket latency injection — the knob that turns a loopback
 * scenario into a slow-link one — plus the frame counters needed to read the result.
 *
 * `@libp2p/websockets` dials with a bare `new WebSocket(uri)` against the global
 * constructor (`node_modules/@libp2p/websockets/dist/src/index.js`), and Node 22+
 * provides one, so replacing the global reaches every socket libp2p *dials* and
 * nothing else. The listening side is untouched: the listener wraps a socket from
 * the `ws` package (`toWebSocket`), which never goes through this constructor.
 *
 * Three things decide what a measured number here means:
 *
 * - **Outbound only.** Only frames leaving a *dialing* node are held. A round trip over
 *   a relay pays the delay on the client→relay legs and not on the relay→client ones,
 *   so the delay is one-way, not an RTT figure.
 * - **Process-wide.** The swap is on the global constructor, so EVERY node in the test
 *   process is delayed, not one of them. A scenario that wants a fast party and a slow
 *   party cannot get it from this module as written.
 * - **The mode is the whole result.** See `WS_SEND_DELAY_MODE` below. `pipelined` and
 *   `serial` produce thresholds an order of magnitude apart on the same scenario, so a
 *   number quoted without its mode says nothing. Quote `worst observed send wait` from
 *   the summary line alongside it — that is the delay a run actually experienced, which
 *   in `serial` mode is far above the configured one.
 *
 * Every knob is off by default, so a scenario can import this unconditionally:
 *
 *   WS_SEND_DELAY_MS=10       — hold each outbound frame; 0 (default) holds nothing
 *   WS_SEND_DELAY_MODE=serial — cumulative queueing instead of the default `pipelined`
 *   WS_FRAME_STATS=1          — count frames with no delay, for a baseline to compare against
 *
 *   WS_SEND_DELAY_MS=10 yarn workspace @serfab/integration-tests test <scenario>
 *
 * Import it BEFORE any libp2p node is constructed — the top of the scenario file.
 * The swap happens at module evaluation; `new WebSocket(...)` is called at dial time,
 * so a top-of-file import is early enough.
 *
 * NOTE: `close()` is NOT delayed, so a close issued immediately after a write can land
 * ahead of frames still waiting — something a real slow link would never do. Kept this
 * way on purpose: it matches the injector in gotchoices/sereus#13, so numbers measured
 * here stay comparable to the ones reported there. If a failure ever looks like a
 * truncated stream at teardown rather than a timeout, suspect this first and delay
 * `close()` too before concluding anything about the stack.
 */

/** Hold each outbound frame this many milliseconds. Zero sends straight through. */
const DELAY_MS = Number(process.env.WS_SEND_DELAY_MS ?? 0);
/** Count frames even at zero delay, so a passing run gives a baseline to compare against. */
const STATS_ONLY = process.env.WS_FRAME_STATS === '1';
/**
 * How the delay is applied. The two answer different questions and give very different
 * numbers, so a result is meaningless without saying which produced it.
 *
 * - `pipelined` (default) — each frame is released `DELAY_MS` after IT was written.
 *   Frames overlap in flight exactly as they do on a real link, and a constant delay
 *   preserves their order on its own. This is the honest model of network latency — and
 *   of latency ONLY: bandwidth stays unlimited, so a `pipelined` pass says delay alone
 *   does not break the scenario, not that a real slow mobile link would carry it.
 * - `serial` — frames queue on one chain per socket, so frame *k* waits for the k-1
 *   ahead of it and the added delay is cumulative. This models a per-socket frame-RATE
 *   cap (1000 / DELAY_MS frames per second), not latency. It is the shape the
 *   reproduction in gotchoices/sereus#13 uses, kept so those numbers stay reproducible.
 */
const MODE = process.env.WS_SEND_DELAY_MODE === 'serial' ? 'serial' : 'pipelined';

/** The argument type of `WebSocket.send`, without restating the DOM union. */
type WsSendData = Parameters<WebSocket['send']>[0];

function byteLengthOf(data: WsSendData): number {
	if (typeof data === 'string') return Buffer.byteLength(data);
	if (ArrayBuffer.isView(data)) return data.byteLength;
	// ArrayBuffer and SharedArrayBuffer both carry byteLength; Blob carries size.
	return 'byteLength' in data ? data.byteLength : data.size;
}

/** Process-wide totals, printed periodically while a run is in flight. */
const stats = { sockets: 0, frames: 0, maxFramesPerSocket: 0, maxWaitMs: 0 };

if ((DELAY_MS > 0 || STATS_ONLY) && typeof globalThis.WebSocket === 'function') {
	const Native = globalThis.WebSocket;

	class InstrumentedWebSocket extends Native {
		/** `serial` mode only: one chain per socket, so queued frames keep their order. */
		#chain: Promise<void> = Promise.resolve();
		/** Bytes handed to `send` that have not yet reached the native socket. */
		#queued = 0;
		/** Frames this socket has handed to `send`, for the summary line. */
		#frames = 0;

		constructor(...args: ConstructorParameters<typeof Native>) {
			super(...args);
			stats.sockets++;
		}

		override send(data: WsSendData): void {
			this.#frames++;
			stats.frames++;
			if (this.#frames > stats.maxFramesPerSocket) stats.maxFramesPerSocket = this.#frames;
			// At zero delay this module is a pure counter: sending straight through keeps the
			// baseline run's timing identical to an uninstrumented one, which is the only way
			// its frame count is comparable to a delayed run's.
			if (DELAY_MS <= 0) {
				super.send(data);
				return;
			}
			const bytes = byteLengthOf(data);
			const queuedAt = Date.now();
			this.#queued += bytes;
			const release = (): void => {
				const waited = Date.now() - queuedAt;
				if (waited > stats.maxWaitMs) stats.maxWaitMs = waited;
				try {
					// The socket can close while this frame waits its turn; a closed socket
					// is an ordinary outcome here, not a fault to surface.
					if (this.readyState === Native.OPEN) super.send(data);
				} catch (err) {
					console.warn('[ws-latency] delayed send failed - %s', err instanceof Error ? err.message : String(err));
				} finally {
					this.#queued -= bytes;
				}
			};
			if (MODE === 'pipelined') {
				// Equal delays expire in write order, so FIFO needs no chain — and without one
				// the frames stay overlapped in flight, which is what makes this latency rather
				// than a rate cap.
				setTimeout(release, DELAY_MS);
				return;
			}
			this.#chain = this.#chain
				.then(async () => { await new Promise<void>((resolve) => setTimeout(resolve, DELAY_MS)); })
				.then(release);
		}

		/**
		 * Truthful buffered byte count: what this shim is holding PLUS whatever the native
		 * socket has not flushed. `@libp2p/websockets` gates its own backpressure on this
		 * (`websocket-to-conn.ts` → `maxBufferedAmount`, and a poll that waits for it to
		 * reach zero before emitting `drain`), so a shim that reported only the native
		 * number would make libp2p believe an arbitrarily deep queue was empty — turning a
		 * latency experiment into an unbounded-buffering one and measuring the wrong thing.
		 */
		override get bufferedAmount(): number {
			return this.#queued + super.bufferedAmount;
		}
	}

	globalThis.WebSocket = InstrumentedWebSocket;
	console.log('[ws-latency] instrumenting dialed WebSockets (per-frame delay %d ms, mode %s)', DELAY_MS, MODE);
	// Periodic rather than at-exit: vitest runs scenarios in a forked worker that an aborted
	// or timed-out run may never let reach an exit handler, and the summary is most wanted
	// exactly on those runs. Unref'd, so it never holds the process open.
	setInterval(() => {
		console.log(
			'[ws-latency] %d dialed sockets, %d frames, busiest socket %d frames, worst observed send wait %d ms (delay %d ms, mode %s)',
			stats.sockets, stats.frames, stats.maxFramesPerSocket, stats.maxWaitMs, DELAY_MS, MODE,
		);
	}, 5_000).unref();
}

export {};
