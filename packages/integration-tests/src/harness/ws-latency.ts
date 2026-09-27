/**
 * Per-frame outbound WebSocket latency injection — what turns a loopback scenario into a
 * slow-link one — plus the frame counters needed to read the result.
 *
 * `@libp2p/websockets` dials with a bare `new WebSocket(uri)` against the global
 * constructor (`node_modules/@libp2p/websockets/dist/src/index.js`), and Node 22+
 * provides one, so replacing the global reaches every socket libp2p *dials* and
 * nothing else. The listening side is untouched: the listener wraps a socket from
 * the `ws` package (`toWebSocket`), which never goes through this constructor.
 *
 * Two ways in, and they do not compete: `installWsLatency({ delayMs, mode })` is what a
 * committed scenario calls, and the environment variables below are the ad-hoc override an
 * investigation uses. When `WS_SEND_DELAY_MS` is set it PINS the configuration for the whole
 * process and a scenario's own request is logged and ignored, so a measurement run can sweep
 * a scenario across delays without editing it.
 *
 * Three things decide what a measured number here means:
 *
 * - **Outbound only.** Only frames leaving a *dialing* node are held. A round trip over
 *   a relay pays the delay on the client→relay legs and not on the relay→client ones,
 *   so the delay is one-way, not an RTT figure.
 * - **Process-wide.** The swap is on the global constructor, so EVERY node in the test
 *   process is delayed, not one of them. A scenario that wants a fast party and a slow
 *   party cannot get it from this module as written; see the module's "per-node" note below.
 * - **The mode is the whole result.** See `WsLatencyMode` below. `pipelined` and `serial`
 *   produce thresholds an order of magnitude apart on the same scenario, so a number quoted
 *   without its mode says nothing. Quote `worst observed send wait` from the summary line
 *   alongside it — that is the delay a run actually experienced, which in `serial` mode is
 *   far above the configured one.
 *
 * Environment overrides, every one off by default:
 *
 *   WS_SEND_DELAY_MS=10       — hold each outbound frame; pins the delay process-wide
 *   WS_SEND_DELAY_MODE=serial — cumulative queueing instead of the default `pipelined`
 *   WS_FRAME_STATS=1          — count frames with no delay, for a baseline to compare against
 *
 *   WS_SEND_DELAY_MS=10 yarn workspace @serfab/integration-tests test <scenario>
 *
 * Install BEFORE any libp2p node is constructed — the swap must be in place when
 * `new WebSocket(...)` is called at dial time, and a node dials during `start()`.
 *
 * NOTE: per-node delay is not offered. The global-constructor swap cannot tell one node's
 * sockets from another's, so "a slow phone talking to a fast desktop" is out of reach here;
 * everything-is-slow is the harsher and simpler case. The asymmetric shape stays on the
 * board as `backlog/debt-relay-scenarios-never-see-link-latency`, whose recommended design
 * is to give the dedicated relay one listen address per node and key the delay by the
 * destination port in the dial URI — which this shim already sees.
 *
 * NOTE: `close()` is NOT delayed, so a close issued immediately after a write can land
 * ahead of frames still waiting — something a real slow link would never do. Kept this
 * way on purpose: it matches the injector in gotchoices/sereus#13, so numbers measured
 * here stay comparable to the ones reported there. If a failure ever looks like a
 * truncated stream at teardown rather than a timeout, suspect this first and delay
 * `close()` too before concluding anything about the stack.
 */

/**
 * How the delay is applied. The two answer different questions and give very different
 * numbers, so a result is meaningless without saying which produced it.
 *
 * - `pipelined` — each frame is released `delayMs` after IT was written. Frames overlap in
 *   flight exactly as they do on a real link, and a constant delay preserves their order on
 *   its own. This is the honest model of network latency — and of latency ONLY: bandwidth
 *   stays unlimited, so a `pipelined` pass says delay alone does not break the scenario, not
 *   that a real slow mobile link would carry it.
 * - `serial` — frames queue on one chain per socket, so frame *k* waits for the k-1 ahead of
 *   it and the added delay is cumulative. This models a per-socket frame-RATE cap
 *   (1000 / delayMs frames per second), not latency. It is the shape the reproduction in
 *   gotchoices/sereus#13 uses, kept so those numbers stay reproducible.
 */
export type WsLatencyMode = 'pipelined' | 'serial';

export interface WsLatencyOptions {
	/** Hold each outbound frame this many milliseconds. Zero sends straight through. */
	readonly delayMs: number;
	/** Defaults to `pipelined` — see `WsLatencyMode`, the two are not comparable. */
	readonly mode?: WsLatencyMode;
}

/** What an install hands back: the configuration actually in force, and how to undo it. */
export interface WsLatencyHandle {
	readonly delayMs: number;
	readonly mode: WsLatencyMode;
	/** True when `WS_SEND_DELAY_MS` pinned the configuration and the requested one was ignored. */
	readonly pinnedByEnv: boolean;
	/**
	 * Unwrap the global constructor and print a final summary. Safe to call more than once,
	 * and a no-op once this particular install is no longer the one in force — or for an
	 * environment-pinned install, which is deliberately process-wide.
	 */
	restore(): void;
}

const ENV_DELAY = process.env.WS_SEND_DELAY_MS;
/** An explicit `WS_SEND_DELAY_MS` — including `0` — is an override; absent is not. */
const ENV_PINS_DELAY = ENV_DELAY !== undefined && ENV_DELAY !== '';
/** Count frames even at zero delay, so a passing run gives a baseline to compare against. */
const STATS_ONLY = process.env.WS_FRAME_STATS === '1';
const ENV_MODE: WsLatencyMode = process.env.WS_SEND_DELAY_MODE === 'serial' ? 'serial' : 'pipelined';

function envDelayMs(): number {
	const parsed = Number(ENV_DELAY);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`[ws-latency] WS_SEND_DELAY_MS must be a non-negative number, got ${JSON.stringify(ENV_DELAY)}`);
	}
	return parsed;
}

/** Live configuration. The shim reads these per frame, so an install needs no re-wrap. */
let delayMs = ENV_PINS_DELAY ? envDelayMs() : 0;
let mode: WsLatencyMode = ENV_MODE;

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
/** `stats.frames` as of the last line printed, so the same totals are never reported twice. */
let reportedAtFrames = -1;

function summaryLine(): string {
	return `[ws-latency] ${stats.sockets} dialed sockets, ${stats.frames} frames, `
		+ `busiest socket ${stats.maxFramesPerSocket} frames, worst observed send wait ${stats.maxWaitMs} ms `
		+ `(delay ${delayMs} ms, mode ${mode})`;
}

function reportSummary(): void {
	reportedAtFrames = stats.frames;
	console.log(summaryLine());
}

/** Start a fresh measurement window, so one install's totals never include another's. */
function resetStats(): void {
	stats.sockets = 0;
	stats.frames = 0;
	stats.maxFramesPerSocket = 0;
	stats.maxWaitMs = 0;
	reportedAtFrames = -1;
}

interface ActiveShim {
	readonly Native: typeof WebSocket;
	readonly Shim: typeof WebSocket;
}

/** Progress cadence while a run is in flight. */
const REPORT_EVERY_MS = 5_000;

let progressTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Report while a run is in flight. Periodic rather than at the end, because there is no
 * end-of-run hook to lean on: vitest runs scenarios in forked workers that are recycled
 * rather than exited, so neither `exit` nor `beforeExit` output ever reaches the terminal
 * (verified), and an aborted or timed-out run reaches no hook at all — which is when the
 * summary is wanted most. A tick with no new frames is skipped, so an idle process stays
 * quiet.
 *
 * NOTE: that leaves the ENVIRONMENT path with no closing line — a scenario that finishes
 * inside one tick prints no totals at all, and a longer one's last tick is a subtotal. The
 * accurate totals come from a boundary something in the process actually declares:
 * `installWsLatency` prints the running totals before it zeros them, and its `restore()`
 * prints that install's final line. For a `WS_FRAME_STATS=1` baseline that is the line the
 * committed latency arm's install emits — see docs/testing.md → "Where measurements live".
 * If a scenario ever needs a total with no such boundary in it, give the module an explicit
 * `reportWsFrameStats()` for the scenario to call rather than trying to infer the end.
 */
function startReporting(): void {
	progressTimer = setInterval(() => {
		if (stats.frames !== reportedAtFrames) reportSummary();
	}, REPORT_EVERY_MS);
	// Unref'd, so reporting never holds the process open.
	progressTimer.unref();
}

function stopReporting(): void {
	if (progressTimer !== undefined) clearInterval(progressTimer);
	progressTimer = undefined;
}

let active: ActiveShim | undefined;
/**
 * Identity of the install currently in force, between an `installWsLatency` call and its
 * `restore()` — both the double-install guard and what makes a handle's `restore()` refer to
 * ITS OWN install. A plain boolean would let a stale handle restored a second time tear down
 * a later arm's install, which is the silently-wrong-delay failure this fixture exists to
 * rule out.
 */
let activeInstall: object | undefined;

/**
 * Swap the global constructor for one that holds outbound frames. Idempotent by design —
 * a second wrap over an already-wrapped constructor would make `bufferedAmount` and the
 * frame counters double-count, and the callers that could reach it (two scenario arms, a
 * scenario plus the environment override) are exactly the ones whose numbers must stay
 * readable.
 */
function wrapGlobalWebSocket(): void {
	if (active !== undefined) return;
	if (typeof globalThis.WebSocket !== 'function') {
		throw new Error('[ws-latency] no global WebSocket constructor to instrument (Node 22+ provides one)');
	}
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
			if (delayMs <= 0) {
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
			if (mode === 'pipelined') {
				// Equal delays expire in write order, so FIFO needs no chain — and without one
				// the frames stay overlapped in flight, which is what makes this latency rather
				// than a rate cap.
				setTimeout(release, delayMs);
				return;
			}
			this.#chain = this.#chain
				.then(async () => { await new Promise<void>((resolve) => setTimeout(resolve, delayMs)); })
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
	console.log('[ws-latency] instrumenting dialed WebSockets (per-frame delay %d ms, mode %s)', delayMs, mode);
	startReporting();
	active = { Native, Shim: InstrumentedWebSocket };
}

function unwrapGlobalWebSocket(): void {
	if (active === undefined) return;
	stopReporting();
	if (globalThis.WebSocket === active.Shim) {
		globalThis.WebSocket = active.Native;
	} else {
		// Someone else swapped the global after this install; putting the native constructor
		// back would silently discard their shim, so leave it and say so.
		console.warn('[ws-latency] global WebSocket was replaced after install; leaving it alone');
	}
	active = undefined;
}

/**
 * Undo one `installWsLatency`. `unwrap` is false when `WS_FRAME_STATS=1` had already
 * instrumented the process for counting: the delay goes away, the counters stay, because
 * the run asked for them across every scenario and not just this one.
 *
 * Sockets constructed under the shim keep it either way, but they read the live delay, so
 * after this they send straight through.
 */
function restoreInstall(token: object, unwrap: boolean): void {
	if (activeInstall !== token) return;
	activeInstall = undefined;
	reportSummary();
	delayMs = 0;
	mode = ENV_MODE;
	if (unwrap) unwrapGlobalWebSocket();
}

/**
 * Add per-frame outbound latency to every WebSocket this process dials, until `restore()`.
 *
 * Throws on a second install rather than re-wrapping or quietly inheriting the first one's
 * delay: a scenario arm measuring a delay nobody asked for is the failure this fixture
 * exists to rule out, and it would show up as a passing test.
 */
export function installWsLatency(options: WsLatencyOptions): WsLatencyHandle {
	if (ENV_PINS_DELAY) {
		// The ad-hoc override deliberately wins, so sweeping a scenario across delays needs no
		// edit to it. Loud, because the run is not measuring what the scenario asked for.
		console.log(
			'[ws-latency] WS_SEND_DELAY_MS=%s pins this process; ignoring requested %d ms (%s)',
			ENV_DELAY, options.delayMs, options.mode ?? 'pipelined',
		);
		return { delayMs, mode, pinnedByEnv: true, restore: () => {} };
	}
	if (activeInstall !== undefined) {
		throw new Error(
			`[ws-latency] already installed at ${delayMs} ms (${mode}); restore() it before installing ${options.delayMs} ms`,
		);
	}
	if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
		throw new Error(`[ws-latency] delayMs must be a non-negative number, got ${String(options.delayMs)}`);
	}
	const wrappedForStats = active !== undefined;
	// Counting already under way (WS_FRAME_STATS over a whole run): report what it has seen
	// before zeroing, or the totals of everything up to this install are silently lost.
	if (stats.frames > 0) reportSummary();
	delayMs = options.delayMs;
	mode = options.mode ?? 'pipelined';
	resetStats();
	wrapGlobalWebSocket();
	const token = {};
	activeInstall = token;
	return { delayMs, mode, pinnedByEnv: false, restore: () => { restoreInstall(token, !wrappedForStats); } };
}

// The environment overrides install at module evaluation, so `WS_SEND_DELAY_MS=... yarn test
// <scenario>` instruments a scenario that never calls `installWsLatency` — including the
// zero-delay arm of one that does. With neither variable set this module does nothing at
// import, which is what lets the harness barrel re-export it.
if (ENV_PINS_DELAY || STATS_ONLY) {
	wrapGlobalWebSocket();
}
